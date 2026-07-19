export const SESSION_ENTRY_TYPE = "skill-router-state";

export interface SessionSkillState {
	version: 1;
	disabledSkills: string[];
	activeSkillset?: string;
}

export interface SkillsetsConfig {
	version: 1;
	defaultSkillset?: string;
	skillsets: Record<string, string[]>;
}

export function defaultSessionState(): SessionSkillState {
	return { version: 1, disabledSkills: [] };
}

export function defaultSkillsetsConfig(): SkillsetsConfig {
	return { version: 1, skillsets: {} };
}

export function normalizeSessionState(value: unknown): SessionSkillState | undefined {
	if (!value || typeof value !== "object") return undefined;

	const candidate = value as Partial<SessionSkillState>;
	if (!Array.isArray(candidate.disabledSkills)) return undefined;

	const disabledSkills = uniqueNames(candidate.disabledSkills.filter((name): name is string => typeof name === "string"));
	const activeSkillset =
		typeof candidate.activeSkillset === "string" && candidate.activeSkillset.length > 0
			? candidate.activeSkillset
			: undefined;

	return { version: 1, disabledSkills, ...(activeSkillset ? { activeSkillset } : {}) };
}

export function normalizeSkillsetsConfig(value: unknown): SkillsetsConfig {
	if (!value || typeof value !== "object") {
		throw new Error("config must be a JSON object");
	}

	const candidate = value as { defaultSkillset?: unknown; skillsets?: unknown };
	if (!candidate.skillsets || typeof candidate.skillsets !== "object" || Array.isArray(candidate.skillsets)) {
		throw new Error('config must contain a "skillsets" object');
	}

	const skillsets: Record<string, string[]> = {};
	for (const [name, skills] of Object.entries(candidate.skillsets)) {
		if (!isValidSkillsetName(name)) {
			throw new Error(`invalid skillset name: ${name}`);
		}
		if (!Array.isArray(skills) || !skills.every((skill) => typeof skill === "string")) {
			throw new Error(`skillset "${name}" must be an array of skill names`);
		}
		skillsets[name] = uniqueNames(skills);
	}

	if (candidate.defaultSkillset !== undefined) {
		if (typeof candidate.defaultSkillset !== "string" || !isValidSkillsetName(candidate.defaultSkillset)) {
			throw new Error("default skillset must be a valid skillset name");
		}
		if (!skillsets[candidate.defaultSkillset]) {
			throw new Error(`default skillset "${candidate.defaultSkillset}" does not exist`);
		}
	}

	return {
		version: 1,
		...(candidate.defaultSkillset ? { defaultSkillset: candidate.defaultSkillset } : {}),
		skillsets,
	};
}

export function isSkillEnabled(state: SessionSkillState, skillName: string): boolean {
	return !state.disabledSkills.includes(skillName);
}

export function setSkillEnabled(
	state: SessionSkillState,
	skillName: string,
	enabled: boolean,
): SessionSkillState {
	const disabled = new Set(state.disabledSkills);
	if (enabled) disabled.delete(skillName);
	else disabled.add(skillName);

	return {
		version: 1,
		disabledSkills: [...disabled].sort(),
	};
}

export function activateSkillset(
	skillsetName: string,
	members: readonly string[],
	availableSkills: readonly string[],
): SessionSkillState {
	const enabled = new Set(members);
	return {
		version: 1,
		disabledSkills: uniqueNames(availableSkills.filter((name) => !enabled.has(name))).sort(),
		activeSkillset: skillsetName,
	};
}

export function materializeActiveSkillset(
	state: SessionSkillState,
	skillsets: Readonly<Record<string, readonly string[]>>,
	availableSkills: readonly string[],
): SessionSkillState {
	if (!state.activeSkillset) return state;
	const members = skillsets[state.activeSkillset];
	if (!members) return { version: 1, disabledSkills: state.disabledSkills };
	return activateSkillset(state.activeSkillset, members, availableSkills);
}

export function replaceLast(haystack: string, needle: string, replacement: string): string | undefined {
	if (!needle) return undefined;
	const index = haystack.lastIndexOf(needle);
	if (index < 0) return undefined;
	return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}

export function parseSkillInvocation(text: string): string | undefined {
	const match = text.match(/^\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s|$)/);
	return match?.[1];
}

export function parseNameList(parts: readonly string[]): string[] {
	return uniqueNames(
		parts
			.flatMap((part) => part.split(","))
			.map((part) => part.trim())
			.filter(Boolean),
	);
}

export function isValidSkillsetName(name: string): boolean {
	return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64;
}

function uniqueNames(names: readonly string[]): string[] {
	return [...new Set(names)];
}