import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

interface Config {
	prompts: Record<string, string>;
	models: Record<string, string>;
}

const help = [
	"/model-prompt add <name>",
	"/model-prompt edit|delete [name]",
	"/model-prompt set [name] [provider/model]",
	"/model-prompt unset [provider/model]",
].join("\n");
const validName = (name: string) => /^\S+$/u.test(name);
const validModel = (model: string) => /^[^/\s]+\/\S+$/u.test(model);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
// Pi sorts status keys alphabetically: proxy < proxy:model-prompt < usage.
const statusKey = "proxy:model-prompt";

function readConfig(path: string): Config {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { prompts: {}, models: {} };
		throw error;
	}
	const config: unknown = JSON.parse(text);
	if (!isRecord(config) || !isRecord(config.prompts) || !isRecord(config.models)) {
		throw new Error(`${path}: expected prompts and models objects.`);
	}
	for (const [name, prompt] of Object.entries(config.prompts)) {
		if (!validName(name) || typeof prompt !== "string" || !prompt.trim()) {
			throw new Error(`${path}: prompt names cannot contain whitespace; content must be non-empty text.`);
		}
	}
	for (const [model, name] of Object.entries(config.models)) {
		if (!validModel(model) || typeof name !== "string" || !Object.hasOwn(config.prompts, name)) {
			throw new Error(`${path}: each model must use provider/model and reference an existing prompt.`);
		}
	}
	return config as unknown as Config;
}

function saveConfig(path: string, config: Config): void {
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.tmp`;
	writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, path);
}

function resolveModel(input: string | undefined, ctx: ExtensionCommandContext): string {
	if (!input) {
		if (!ctx.model) throw new Error("Select a model first or specify provider/model.");
		return `${ctx.model.provider}/${ctx.model.id}`;
	}
	if (validModel(input)) return input;
	const matches = ctx.modelRegistry.getAll().filter((model) => model.id === input);
	if (matches.length !== 1) throw new Error(`Unknown or ambiguous model: ${input}. Use provider/model.`);
	return `${matches[0].provider}/${matches[0].id}`;
}

export default function modelPromptExtension(pi: ExtensionAPI): void {
	const path = join(getAgentDir(), "model-prompts.json");
	let context: ExtensionContext;
	function loadConfig(ctx: ExtensionContext): Config {
		ctx.ui.setStatus(statusKey, undefined);
		const config = readConfig(path);
		const name = ctx.model && config.models[`${ctx.model.provider}/${ctx.model.id}`];
		if (name) ctx.ui.setStatus(statusKey, ctx.ui.theme.fg("muted", "prompt:") + ctx.ui.theme.fg("accent", name));
		return config;
	}
	pi.on("session_start", (_event, ctx) => { context = ctx; loadConfig(ctx); });
	pi.on("model_select", (_event, ctx) => { loadConfig(ctx); });
	pi.on("session_shutdown", (_event, ctx) => { ctx.ui.setStatus(statusKey, undefined); });
	pi.on("before_agent_start", (event, ctx) => {
		delete event.systemPromptOptions.sections.model_prompt;
		const config = loadConfig(ctx);
		const name = ctx.model && config.models[`${ctx.model.provider}/${ctx.model.id}`];
		if (name) event.systemPromptOptions.sections.model_prompt = config.prompts[name];
	});

	pi.registerCommand("model-prompt", {
		description: "Manage named prompts and bind them to models",
		getArgumentCompletions: (prefix) => {
			try {
				const parts = prefix.trimStart().split(/\s+/u);
				const query = parts.pop()!.toLowerCase();
				let choices: string[];
				if (!parts.length) choices = ["add", "edit", "delete", "set", "unset"];
				else if (parts.length === 1 && ["set", "edit", "delete"].includes(parts[0])) {
					choices = Object.keys(readConfig(path).prompts);
				} else if ((parts.length === 2 && parts[0] === "set") || (parts.length === 1 && parts[0] === "unset")) {
					choices = [...new Set([
						...context.modelRegistry.getAll().map((model) => `${model.provider}/${model.id}`),
						...Object.keys(readConfig(path).models),
					])];
				} else return null;
				return choices.filter((name) => name.toLowerCase().includes(query))
					.map((name) => ({ value: [...parts, name].join(" "), label: name }));
			} catch (error) {
				context.ui.notify(`Cannot complete model-prompt arguments (${path}): ${error instanceof Error ? error.message : String(error)}`, "error");
				return null;
			}
		},
		handler: async (args, ctx) => {
			try {
				let [action, name, model, ...extra] = args.trim().split(/\s+/u);
				let config = loadConfig(ctx);
				if (!action) {
					const current = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
					const lines = Object.keys(config.prompts).map((prompt) => {
						const models = Object.entries(config.models).filter(([, value]) => value === prompt).map(([key]) => key);
						return `${prompt}: ${models.join(", ") || "unbound"}`;
					});
					ctx.ui.notify([
						`Current: ${current ?? "no model"} → ${current && config.models[current] || "none"}`,
						...lines,
					].join("\n"), "info");
					return;
				}
				if (extra.length || (action !== "set" && model)) throw new Error(help);
				if (action === "unset") {
					const target = resolveModel(name, ctx);
					delete config.models[target];
					saveConfig(path, config);
					loadConfig(ctx);
					ctx.ui.notify(`${target} → none (next run)`, "info");
					return;
				}
				if (!name && ["set", "edit", "delete"].includes(action)) {
					if (!ctx.hasUI) throw new Error(help);
					const names = Object.keys(config.prompts);
					if (!names.length) {
						ctx.ui.notify("No prompts yet. Use /model-prompt add <name> first.", "warning");
						return;
					}
					name = await ctx.ui.select(`Model prompt · ${action}`, names) ?? "";
					if (!name) return;
					config = loadConfig(ctx);
				}
				if (!["add", "edit", "delete", "set"].includes(action) || !name) throw new Error(help);
				const exists = Object.hasOwn(config.prompts, name);
				if (action === "add" ? exists : !exists) {
					throw new Error(`Prompt ${name} ${exists ? "already exists" : "does not exist"}.`);
				}
				if (action === "add" || action === "edit") {
					if (!ctx.hasUI) throw new Error("Editing prompts requires an interactive UI.");
					const previous = exists ? config.prompts[name] : undefined;
					const content = await ctx.ui.editor(`${action === "add" ? "Add" : "Edit"} prompt: ${name}`,
						previous);
					if (content === undefined) return;
					if (!content.trim()) throw new Error("Prompt cannot be empty; nothing saved.");
					// Keep changes made by other Pi sessions while the editor was open.
					config = loadConfig(ctx);
					if (Object.hasOwn(config.prompts, name) !== exists || (exists && config.prompts[name] !== previous)) {
						throw new Error("Prompt changed while editing; try again.");
					}
					config.prompts = { ...config.prompts, [name]: content };
				} else if (action === "delete") {
					delete config.prompts[name];
					for (const [target, prompt] of Object.entries(config.models)) {
						if (prompt === name) delete config.models[target];
					}
				} else {
					const target = resolveModel(model, ctx);
					config.models[target] = name;
					saveConfig(path, config);
					loadConfig(ctx);
					ctx.ui.notify(`${target} → ${name} (next run)`, "info");
					return;
				}
				saveConfig(path, config);
				loadConfig(ctx);
				ctx.ui.notify(`Prompt ${name} ${action === "delete" ? "and its bindings deleted" : "saved"} (next run).`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
