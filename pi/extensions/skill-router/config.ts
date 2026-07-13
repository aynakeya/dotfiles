import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaultSkillsetsConfig, normalizeSkillsetsConfig, type SkillsetsConfig } from "./state.ts";

export function loadSkillsetsConfig(path: string): SkillsetsConfig {
	try {
		return normalizeSkillsetsConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if (isMissingFile(error)) return defaultSkillsetsConfig();
		throw new Error(`Cannot load ${path}: ${errorMessage(error)}`);
	}
}

export function saveSkillsetsConfig(path: string, config: SkillsetsConfig): void {
	const normalized = normalizeSkillsetsConfig(config);
	mkdirSync(dirname(path), { recursive: true });

	const temporaryPath = `${path}.${process.pid}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
	renameSync(temporaryPath, path);
}

function isMissingFile(error: unknown): boolean {
	return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}