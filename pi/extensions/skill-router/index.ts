import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Skill,
} from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	formatSkillsForPrompt,
	getAgentDir,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { loadSkillsetsConfig, saveSkillsetsConfig } from "./config.ts";
import {
	activateSkillset,
	defaultSessionState,
	isSkillEnabled,
	isValidSkillsetName,
	materializeActiveSkillset,
	normalizeSessionState,
	parseNameList,
	parseSkillInvocation,
	replaceLast,
	SESSION_ENTRY_TYPE,
	setSkillEnabled,
	type SessionSkillState,
	type SkillsetsConfig,
} from "./state.ts";

const CONFIG_FILE = "skillsets.json";
const LIVE = "● live";
const MUTED = "○ muted";
const IN_SET = "● in";
const OUT_OF_SET = "○ out";

export default function skillRouterExtension(pi: ExtensionAPI) {
	pi.registerFlag("skillset", {
		description: "Activate a skillset for the initial session",
		type: "string",
	});

	const configPath = join(getAgentDir(), CONFIG_FILE);
	let state = defaultSessionState();
	let config: SkillsetsConfig = { version: 1, skillsets: {} };
	let configError: string | undefined;

	function loadConfig(ctx?: ExtensionContext): void {
		try {
			config = loadSkillsetsConfig(configPath);
			configError = undefined;
		} catch (error) {
			config = { version: 1, skillsets: {} };
			configError = errorMessage(error);
			ctx?.ui.notify(configError, "error");
		}
	}

	function persistState(): void {
		pi.appendEntry<SessionSkillState>(SESSION_ENTRY_TYPE, state);
	}

	function restoreState(ctx: ExtensionContext): boolean {
		state = defaultSessionState();
		let foundState = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== SESSION_ENTRY_TYPE) continue;
			const restored = normalizeSessionState(entry.data);
			if (restored) {
				state = restored;
				foundState = true;
			}
		}
		if (state.activeSkillset && !config.skillsets[state.activeSkillset]) {
			state = { version: 1, disabledSkills: state.disabledSkills };
		}
		updateStatus(ctx);
		return foundState;
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (state.activeSkillset) {
			ctx.ui.setStatus("skill-router", ctx.ui.theme.fg("accent", `set:${state.activeSkillset}`));
			return;
		}
		if (state.disabledSkills.length > 0) {
			ctx.ui.setStatus("skill-router", ctx.ui.theme.fg("muted", "skills:custom"));
			return;
		}
		ctx.ui.setStatus("skill-router", undefined);
	}

	function loadedSkills(ctx: ExtensionCommandContext): Skill[] {
		return ctx.getSystemPromptOptions().skills ?? [];
	}

	function skillIsEnabled(skillName: string): boolean {
		const activeMembers = state.activeSkillset ? config.skillsets[state.activeSkillset] : undefined;
		return activeMembers ? activeMembers.includes(skillName) : isSkillEnabled(state, skillName);
	}

	function materializeState(skills: readonly Skill[]): SessionSkillState {
		return materializeActiveSkillset(state, config.skillsets, skills.map((skill) => skill.name));
	}

	function setOneSkill(skillName: string, enabled: boolean, skills: readonly Skill[], ctx: ExtensionContext): boolean {
		if (!skills.some((skill) => skill.name === skillName)) {
			ctx.ui.notify(`Unknown skill "${skillName}"`, "error");
			return false;
		}
		state = setSkillEnabled(materializeState(skills), skillName, enabled);
		persistState();
		updateStatus(ctx);
		ctx.ui.notify(`${skillName} ${enabled ? "enabled" : "disabled"} for this session`, "info");
		return true;
	}

	function activateSet(name: string, skills: readonly Skill[], ctx: ExtensionContext): boolean {
		const members = config.skillsets[name];
		if (!members) {
			ctx.ui.notify(`Unknown skillset "${name}"`, "error");
			return false;
		}

		const availableNames = skills.map((skill) => skill.name);
		const available = new Set(availableNames);
		const missing = members.filter((member) => !available.has(member));
		const activeMembers = members.filter((member) => available.has(member));

		state = activateSkillset(name, activeMembers, availableNames);
		persistState();
		updateStatus(ctx);
		ctx.ui.notify(`Skillset "${name}" enabled for this session`, "info");
		if (missing.length > 0) ctx.ui.notify(`Not loaded: ${missing.join(", ")}`, "warning");
		return true;
	}

	function resetSkills(ctx: ExtensionContext): void {
		state = defaultSessionState();
		persistState();
		updateStatus(ctx);
		ctx.ui.notify("All loaded skills enabled for this session", "info");
	}

	function setDefaultSkillset(name: string | undefined, ctx: ExtensionContext): boolean {
		if (configError) {
			ctx.ui.notify(`Fix ${configPath} before saving: ${configError}`, "error");
			return false;
		}
		if (name && !config.skillsets[name]) {
			ctx.ui.notify(`Unknown skillset "${name}"`, "error");
			return false;
		}

		const { defaultSkillset: _currentDefault, ...baseConfig } = config;
		const nextConfig: SkillsetsConfig = {
			...baseConfig,
			...(name ? { defaultSkillset: name } : {}),
		};
		try {
			saveSkillsetsConfig(configPath, nextConfig);
			config = nextConfig;
			ctx.ui.notify(
				name
					? `Default skillset set to "${name}"; current session unchanged`
					: "Default skillset cleared; current session unchanged",
				"info",
			);
			return true;
		} catch (error) {
			ctx.ui.notify(errorMessage(error), "error");
			return false;
		}
	}

	async function showSkillsManager(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The interactive skill router requires TUI mode", "error");
			return;
		}

		const skills = loadedSkills(ctx);
		if (skills.length === 0) {
			ctx.ui.notify("No skills are loaded", "warning");
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const items: SettingItem[] = skills.map((skill) => ({
				id: skill.name,
				label: skill.name,
				description: `${skill.description} · ${skill.sourceInfo.scope}${skill.disableModelInvocation ? " · manual invocation only" : ""}`,
				currentValue: skillIsEnabled(skill.name) ? LIVE : MUTED,
				values: [LIVE, MUTED],
			}));
			const border = new DynamicBorder((text: string) => theme.fg("borderAccent", text));
			const settings = new SettingsList(
				items,
				Math.min(items.length + 2, 16),
				getSettingsListTheme(),
				(skillName, value) => {
					state = setSkillEnabled(materializeState(skills), skillName, value === LIVE);
					persistState();
					updateStatus(ctx);
					tui.requestRender();
				},
				() => done(undefined),
				{ enableSearch: true },
			);

			return {
				render(width: number) {
					const enabledCount = skills.filter((skill) => skillIsEnabled(skill.name)).length;
					const profile = state.activeSkillset ?? (state.disabledSkills.length > 0 ? "custom" : "all");
					const members = state.activeSkillset ? config.skillsets[state.activeSkillset] ?? [] : [];
					const route = members.length > 0 ? `SET → ${members.join(" + ")}` : "Toggle a route to customize this session";
					return [
						...border.render(width),
						truncateToWidth(` ${theme.fg("accent", theme.bold("SKILL ROUTER"))}  ${theme.fg("dim", `profile ${profile} · ${enabledCount}/${skills.length} live`)}`, width),
						truncateToWidth(` ${theme.fg("muted", route)}`, width),
						"",
						...settings.render(width),
						truncateToWidth(` ${theme.fg("dim", "Changes follow this session branch · esc closes")}`, width),
						...border.render(width),
					];
				},
				invalidate() {
					border.invalidate();
					settings.invalidate();
				},
				handleInput(data: string) {
					settings.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	async function showSkillsetSelector(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The interactive skillset selector requires TUI mode", "error");
			return;
		}

		const names = Object.keys(config.skillsets).sort();
		if (names.length === 0) {
			ctx.ui.notify("No skillsets defined. Use /skillset create <name>", "warning");
			return;
		}

		const items: SelectItem[] = [
			{
				value: "__all__",
				label: state.activeSkillset ? "Enable all skills" : "Enable all skills (current)",
				description: "Clear the session skillset",
			},
			...names.map((name) => {
				const markers = [
					...(name === state.activeSkillset ? ["current"] : []),
					...(name === config.defaultSkillset ? ["default"] : []),
				];
				return {
					value: name,
					label: markers.length > 0 ? `${name} (${markers.join(", ")})` : name,
					description: config.skillsets[name].join(" + "),
				};
			}),
		];

		const selected = await ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const border = new DynamicBorder((text: string) => theme.fg("borderAccent", text));
			const list = new SelectList(items, Math.min(items.length, 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);

			return {
				render(width: number) {
					return [
						...border.render(width),
						truncateToWidth(` ${theme.fg("accent", theme.bold("ROUTE A SKILLSET"))}`, width),
						truncateToWidth(` ${theme.fg("dim", "One set becomes the session's complete live skill list")}`, width),
						"",
						...list.render(width),
						truncateToWidth(` ${theme.fg("dim", "↑↓ navigate · enter route · esc cancel")}`, width),
						...border.render(width),
					];
				},
				invalidate() {
					border.invalidate();
					list.invalidate();
				},
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (selected === "__all__") resetSkills(ctx);
		else if (selected) activateSet(selected, loadedSkills(ctx), ctx);
	}

	async function showDefaultSkillsetSelector(ctx: ExtensionCommandContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Use /skillset default <name> or /skillset clear-default", "error");
			return;
		}

		const names = Object.keys(config.skillsets).sort();
		if (names.length === 0) {
			ctx.ui.notify("No skillsets defined", "warning");
			return;
		}

		const labels = [
			config.defaultSkillset ? "No default" : "No default (current)",
			...names.map((name) => (name === config.defaultSkillset ? `${name} (current)` : name)),
		];
		const selected = await ctx.ui.select("Select default skillset", labels);
		if (!selected) return;
		if (selected === "No default" || selected === "No default (current)") {
			setDefaultSkillset(undefined, ctx);
			return;
		}
		setDefaultSkillset(selected.replace(/ \(current\)$/, ""), ctx);
	}

	async function showSkillsetEditor(
		name: string,
		members: readonly string[],
		mode: "create" | "edit",
		ctx: ExtensionCommandContext,
	): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`Use /skillset ${mode} ${name} in TUI mode`, "error");
			return;
		}
		if (configError) {
			ctx.ui.notify(`Fix ${configPath} before saving: ${configError}`, "error");
			return;
		}

		const skills = loadedSkills(ctx);
		const skillByName = new Map(skills.map((skill) => [skill.name, skill]));
		const names = [...new Set([...skills.map((skill) => skill.name), ...members])].sort();
		const selected = new Set(members);

		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			const items: SettingItem[] = names.map((skillName) => {
				const skill = skillByName.get(skillName);
				return {
					id: skillName,
					label: skillName,
					description: skill
						? `${skill.description} · ${skill.sourceInfo.scope}`
						: "Not currently loaded · retained until toggled out",
					currentValue: selected.has(skillName) ? IN_SET : OUT_OF_SET,
					values: [IN_SET, OUT_OF_SET],
				};
			});
			const border = new DynamicBorder((text: string) => theme.fg("borderAccent", text));
			const baseListTheme = getSettingsListTheme();
			const listTheme = {
				...baseListTheme,
				hint: (text: string) => baseListTheme.hint(text.replace("Esc to cancel", "Esc to save & close")),
			};
			const settings = new SettingsList(
				items,
				Math.min(items.length + 2, 16),
				listTheme,
				(skillName, value) => {
					if (value === IN_SET) selected.add(skillName);
					else selected.delete(skillName);
					tui.requestRender();
				},
				() => {
					const nextConfig: SkillsetsConfig = {
						...config,
						skillsets: { ...config.skillsets, [name]: [...selected].sort() },
					};
					try {
						saveSkillsetsConfig(configPath, nextConfig);
						config = nextConfig;
						updateStatus(ctx);
						ctx.ui.notify(`Skillset "${name}" ${mode === "create" ? "created" : "updated"}`, "info");
						done(undefined);
					} catch (error) {
						ctx.ui.notify(errorMessage(error), "error");
					}
				},
				{ enableSearch: true },
			);

			return {
				render(width: number) {
					return [
						...border.render(width),
						truncateToWidth(` ${theme.fg("accent", theme.bold(`${mode === "create" ? "CREATE" : "EDIT"} SKILLSET · ${name}`))}`, width),
						truncateToWidth(` ${theme.fg("dim", `${selected.size}/${names.length} selected · changes save on exit`)}`, width),
						"",
						...settings.render(width),
						...border.render(width),
					];
				},
				invalidate() {
					border.invalidate();
					settings.invalidate();
				},
				handleInput(data: string) {
					settings.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	pi.registerCommand("skills", {
		description: "Manage session skill routes: /skills [enable|disable|reset] [skill]",
		getArgumentCompletions: (prefix) => completeSkillsArguments(prefix, pi, skillIsEnabled),
		handler: async (args, ctx) => {
			const [action, skillName, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (!action) {
				await showSkillsManager(ctx);
				return;
			}

			const skills = loadedSkills(ctx);
			if (action === "reset" && !skillName) {
				resetSkills(ctx);
				return;
			}
			if ((action === "enable" || action === "disable") && skillName && extra.length === 0) {
				setOneSkill(skillName, action === "enable", skills, ctx);
				return;
			}
			ctx.ui.notify("Usage: /skills | /skills enable <skill> | /skills disable <skill> | /skills reset", "warning");
		},
	});

	pi.registerCommand("skillset", {
		description: "Create, activate, and choose a default skillset",
		getArgumentCompletions: (prefix) => completeSkillsetArguments(prefix, config),
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const [action, name, ...memberParts] = parts;
			if (!action) {
				await showSkillsetSelector(ctx);
				return;
			}

			if (action === "set" && name && memberParts.length === 0) {
				activateSet(name, loadedSkills(ctx), ctx);
				return;
			}
			if (action === "reset" && !name) {
				resetSkills(ctx);
				return;
			}
			if (action === "default" && !name) {
				await showDefaultSkillsetSelector(ctx);
				return;
			}
			if (action === "default" && name && memberParts.length === 0) {
				setDefaultSkillset(name, ctx);
				return;
			}
			if (action === "clear-default" && !name) {
				setDefaultSkillset(undefined, ctx);
				return;
			}
			if (action === "create" && name && memberParts.length === 0) {
				if (!isValidSkillsetName(name)) {
					ctx.ui.notify("Skillset names use lowercase letters, numbers, and single hyphens", "error");
					return;
				}
				if (config.skillsets[name]) {
					ctx.ui.notify(`Skillset "${name}" already exists`, "error");
					return;
				}
				await showSkillsetEditor(name, [], "create", ctx);
				return;
			}
			if (action === "edit" && memberParts.length === 0) {
				if (configError) {
					ctx.ui.notify(`Fix ${configPath} before saving: ${configError}`, "error");
					return;
				}
				let selectedName: string | undefined = name || undefined;
				if (!selectedName) {
					if (ctx.mode !== "tui") {
						ctx.ui.notify("Use /skillset edit <name>", "error");
						return;
					}
					const names = Object.keys(config.skillsets).sort();
					if (names.length === 0) {
						ctx.ui.notify("No skillsets defined", "warning");
						return;
					}
					selectedName = await ctx.ui.select("Select skillset to edit", names);
					if (!selectedName) return;
				}
				const members = config.skillsets[selectedName];
				if (!members) {
					ctx.ui.notify(`Unknown skillset "${selectedName}"`, "error");
					return;
				}
				await showSkillsetEditor(selectedName, members, "edit", ctx);
				return;
			}
			if (action === "create" && name && memberParts.length > 0) {
				if (configError) {
					ctx.ui.notify(`Fix ${configPath} before saving: ${configError}`, "error");
					return;
				}
				if (!isValidSkillsetName(name)) {
					ctx.ui.notify("Skillset names use lowercase letters, numbers, and single hyphens", "error");
					return;
				}
				if (config.skillsets[name]) {
					ctx.ui.notify(`Skillset "${name}" already exists`, "error");
					return;
				}

				const members = parseNameList(memberParts);
				if (members.length === 0) {
					ctx.ui.notify("A skillset needs at least one skill", "error");
					return;
				}
				const available = new Set(loadedSkills(ctx).map((skill) => skill.name));
				const unknown = members.filter((member) => !available.has(member));
				if (unknown.length > 0) {
					ctx.ui.notify(`Unknown skills: ${unknown.join(", ")}`, "error");
					return;
				}

				const nextConfig = { ...config, skillsets: { ...config.skillsets, [name]: members } };
				try {
					saveSkillsetsConfig(configPath, nextConfig);
					config = nextConfig;
					ctx.ui.notify(`Skillset "${name}" created`, "info");
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}
			if (action === "delete" && name && memberParts.length === 0) {
				if (configError) {
					ctx.ui.notify(`Fix ${configPath} before saving: ${configError}`, "error");
					return;
				}
				if (!config.skillsets[name]) {
					ctx.ui.notify(`Unknown skillset "${name}"`, "error");
					return;
				}
				const preservedState = state.activeSkillset === name ? materializeState(loadedSkills(ctx)) : undefined;
				const deletingDefault = config.defaultSkillset === name;
				const { [name]: _removed, ...remaining } = config.skillsets;
				const { defaultSkillset: _currentDefault, ...baseConfig } = config;
				const nextConfig: SkillsetsConfig = {
					...baseConfig,
					...(!deletingDefault && config.defaultSkillset ? { defaultSkillset: config.defaultSkillset } : {}),
					skillsets: remaining,
				};
				try {
					saveSkillsetsConfig(configPath, nextConfig);
					config = nextConfig;
					if (preservedState) {
						state = { version: 1, disabledSkills: preservedState.disabledSkills };
						persistState();
						updateStatus(ctx);
					}
					ctx.ui.notify(
						`Skillset "${name}" deleted${deletingDefault ? "; default cleared" : ""}${preservedState ? "; current session preserved as custom" : ""}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(errorMessage(error), "error");
				}
				return;
			}

			ctx.ui.notify(
				"Usage: /skillset | /skillset create <name> [skills...] | /skillset edit [name] | /skillset delete <name> | /skillset set <name> | /skillset reset | /skillset default [name] | /skillset clear-default",
				"warning",
			);
		},
	});

	pi.on("session_start", (event, ctx) => {
		loadConfig(ctx);
		const hasSessionState = restoreState(ctx);

		if (event.reason === "startup") {
			const skillsetFlag = pi.getFlag("skillset");
			if (typeof skillsetFlag === "string" && skillsetFlag.trim().length > 0) {
				const name = skillsetFlag.trim();
				if (!config.skillsets[name]) {
					ctx.ui.notify(`Unknown startup skillset "${name}"; keeping the session's existing skill state`, "error");
					return;
				}

				state = { version: 1, disabledSkills: [], activeSkillset: name };
				persistState();
				updateStatus(ctx);
				ctx.ui.notify(`Skillset "${name}" enabled from --skillset`, "info");
				return;
			}
		}

		if (hasSessionState || !config.defaultSkillset) return;
		const contextEntryTypes = new Set(["message", "custom_message", "compaction", "branch_summary"]);
		const isNewSession =
			event.reason === "new" ||
			(event.reason === "startup" &&
				!ctx.sessionManager.getEntries().some((entry) => contextEntryTypes.has(entry.type)));
		if (!isNewSession) return;

		state = { version: 1, disabledSkills: [], activeSkillset: config.defaultSkillset };
		persistState();
		updateStatus(ctx);
		ctx.ui.notify(`Default skillset "${config.defaultSkillset}" enabled for this session`, "info");
	});

	pi.on("session_tree", (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("input", (event, ctx) => {
		const skillName = parseSkillInvocation(event.text);
		if (!skillName || skillIsEnabled(skillName)) return;
		ctx.ui.notify(`Skill "${skillName}" is disabled in this session. Use /skills enable ${skillName}.`, "warning");
		return { action: "handled" };
	});

	pi.on("before_agent_start", (event, ctx) => {
		const skills = event.systemPromptOptions.skills ?? [];
		updateStatus(ctx);
		if (event.systemPromptOptions.selectedTools && !event.systemPromptOptions.selectedTools.includes("read")) return;

		const disabledVisibleSkills = skills.filter(
			(skill) => !skill.disableModelInvocation && !skillIsEnabled(skill.name),
		);
		if (disabledVisibleSkills.length === 0) return;

		const originalBlock = formatSkillsForPrompt(skills);
		const enabledBlock = formatSkillsForPrompt(skills.filter((skill) => skillIsEnabled(skill.name)));
		const systemPrompt = replaceLast(event.systemPrompt, originalBlock, enabledBlock);
		if (systemPrompt === undefined) {
			ctx.ui.notify("Skill Router could not locate Pi's skill prompt block; no skills were filtered", "error");
			return;
		}
		return { systemPrompt };
	});
}

function completeSkillsArguments(prefix: string, pi: ExtensionAPI, isEnabled: (skillName: string) => boolean) {
	const parts = prefix.split(/\s+/);
	if (parts.length === 1) {
		return ["enable", "disable", "reset"]
			.filter((action) => action.startsWith(parts[0]))
			.map((action) => ({ value: action, label: action }));
	}
	if (parts.length === 2 && (parts[0] === "enable" || parts[0] === "disable")) {
		const shouldBeEnabled = parts[0] === "enable";
		return pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => command.name.replace(/^skill:/, ""))
			.filter((name) => isEnabled(name) !== shouldBeEnabled && name.startsWith(parts[1]))
			.map((name) => ({ value: `${parts[0]} ${name}`, label: name }));
	}
	return null;
}

function completeSkillsetArguments(prefix: string, config: SkillsetsConfig) {
	const parts = prefix.split(/\s+/);
	if (parts.length === 1) {
		return ["create", "edit", "delete", "set", "reset", "default", "clear-default"]
			.filter((action) => action.startsWith(parts[0]))
			.map((action) => ({ value: action, label: action }));
	}
	if (parts.length === 2 && (parts[0] === "edit" || parts[0] === "set" || parts[0] === "default" || parts[0] === "delete")) {
		return Object.keys(config.skillsets)
			.filter((name) => name.startsWith(parts[1]))
			.sort()
			.map((name) => ({ value: `${parts[0]} ${name}`, label: name }));
	}
	return null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}