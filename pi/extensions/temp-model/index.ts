import { SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ModelLike = ReturnType<ExtensionCommandContext["modelRegistry"]["getAvailable"]>[number];

type SettingsManagerPrototype = typeof SettingsManager.prototype;

let suppressDepth = 0;
let originalSetDefaultModelAndProvider: SettingsManagerPrototype["setDefaultModelAndProvider"] | undefined;
let originalSetDefaultThinkingLevel: SettingsManagerPrototype["setDefaultThinkingLevel"] | undefined;

export default function tempModelExtension(pi: ExtensionAPI) {
	let completionValues: string[] = [];

	pi.on("session_start", (_event, ctx) => {
		completionValues = listAvailableModels(ctx).map(formatModelRef);
	});

	pi.registerCommand("tmodel", {
		description: "Temporarily switch model for this session without changing default settings",
		getArgumentCompletions(prefix) {
			const query = prefix.trim().toLowerCase();
			const matches = completionValues
				.filter((value) => !query || value.toLowerCase().includes(query))
				.slice(0, 30);
			return matches.length > 0
				? matches.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const models = listAvailableModels(ctx);
			completionValues = models.map(formatModelRef);
			if (models.length === 0) {
				ctx.ui.notify("No authenticated models available. Use /login or configure an API key first.", "error");
				return;
			}

			const query = args.trim();
			const model = query ? await resolveModelFromQuery(query, models, ctx) : await chooseModel(models, ctx);
			if (!model) return;

			await suppressDefaultModelPersistence(async () => {
				const ok = await pi.setModel(model);
				if (!ok) throw new Error(`No API key for ${formatModelRef(model)}`);
			});

			ctx.ui.notify(`Temporary model: ${formatModelRef(model)}`, "info");
		},
	});
}

function listAvailableModels(ctx: Pick<ExtensionCommandContext, "modelRegistry">): ModelLike[] {
	ctx.modelRegistry.refresh();
	return ctx.modelRegistry.getAvailable().sort((a, b) => formatModelRef(a).localeCompare(formatModelRef(b)));
}

async function resolveModelFromQuery(
	query: string,
	models: ModelLike[],
	ctx: ExtensionCommandContext,
): Promise<ModelLike | undefined> {
	const exact = findExactModel(query, models);
	if (exact) return exact;

	const matches = findMatchingModels(query, models);
	if (matches.length === 0) {
		ctx.ui.notify(`No model matches: ${query}`, "error");
		return undefined;
	}
	if (matches.length === 1) return matches[0];
	return chooseModel(matches, ctx, `Select temporary model matching "${query}"`);
}

async function chooseModel(
	models: ModelLike[],
	ctx: Pick<ExtensionCommandContext, "ui">,
	title = "Select temporary model",
): Promise<ModelLike | undefined> {
	const byRef = new Map(models.map((model) => [formatModelRef(model), model]));
	const choice = await ctx.ui.select(title, [...byRef.keys()]);
	return choice ? byRef.get(choice) : undefined;
}

function findExactModel(reference: string, models: ModelLike[]): ModelLike | undefined {
	const query = reference.trim().toLowerCase();
	if (!query) return undefined;

	const canonicalMatches = models.filter((model) => formatModelRef(model).toLowerCase() === query);
	if (canonicalMatches.length === 1) return canonicalMatches[0];

	const idMatches = models.filter((model) => model.id.toLowerCase() === query);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

function findMatchingModels(query: string, models: ModelLike[]): ModelLike[] {
	const needle = query.trim().toLowerCase();
	return models.filter((model) => {
		const ref = formatModelRef(model).toLowerCase();
		const name = model.name?.toLowerCase() ?? "";
		return ref.includes(needle) || model.id.toLowerCase().includes(needle) || name.includes(needle);
	});
}

function formatModelRef(model: Pick<ModelLike, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

async function suppressDefaultModelPersistence<T>(fn: () => Promise<T>): Promise<T> {
	const proto = SettingsManager.prototype;
	if (suppressDepth === 0) {
		originalSetDefaultModelAndProvider = proto.setDefaultModelAndProvider;
		originalSetDefaultThinkingLevel = proto.setDefaultThinkingLevel;
		proto.setDefaultModelAndProvider = function (_provider: string, _modelId: string): void {};
		proto.setDefaultThinkingLevel = function (
			_level: Parameters<SettingsManagerPrototype["setDefaultThinkingLevel"]>[0],
		): void {};
	}

	suppressDepth += 1;
	try {
		return await fn();
	} finally {
		suppressDepth -= 1;
		if (suppressDepth === 0 && originalSetDefaultModelAndProvider && originalSetDefaultThinkingLevel) {
			proto.setDefaultModelAndProvider = originalSetDefaultModelAndProvider;
			proto.setDefaultThinkingLevel = originalSetDefaultThinkingLevel;
			originalSetDefaultModelAndProvider = undefined;
			originalSetDefaultThinkingLevel = undefined;
		}
	}
}
