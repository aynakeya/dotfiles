import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, win32 } from "node:path";

const BEGIN_PATCH = "*** Begin Patch";
const END_PATCH = "*** End Patch";
const END_FILE = "*** End of File";
const ADD_FILE = "*** Add File: ";
const DELETE_FILE = "*** Delete File: ";
const UPDATE_FILE = "*** Update File: ";
const MOVE_TO = "*** Move to: ";
const ENVIRONMENT_ID = "*** Environment ID: ";

export type PatchOperation =
	| { type: "add"; path: string; lines: string[] }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; moveTo?: string; diffLines: string[] };

export interface ParsedPatch {
	operations: PatchOperation[];
}

export type AppliedPatchChange =
	| { action: "add"; path: string; lineCount: number }
	| { action: "delete"; path: string }
	| { action: "update"; path: string; lineCount: number }
	| { action: "move"; path: string; moveTo: string; lineCount: number };

export interface AppliedPatchResult {
	changes: AppliedPatchChange[];
	/** Display-oriented line diff for TUI rendering. */
	diff: string;
}

interface ApplyPatchOptions {
	cwd: string;
	signal?: AbortSignal;
}

interface ResolvedPatchPath {
	path: string;
	absolutePath: string;
}

interface PreparedChangeBase {
	path: string;
	absolutePath: string;
}

type PreparedChange =
	| (PreparedChangeBase & { action: "add"; oldContent: ""; newContent: string })
	| (PreparedChangeBase & { action: "delete"; oldContent: string; newContent: "" })
	| (PreparedChangeBase & {
			action: "update";
			oldContent: string;
			newContent: string;
			chunks: Chunk[];
			moveTo?: string;
			absoluteMoveTo?: string;
		});

/**
 * Parse a Codex apply_patch envelope.
 *
 * Pi custom tools use JSON parameters, so the extension exposes the patch as a
 * string field, but the string itself follows the Codex apply_patch grammar.
 */
export function parsePatch(patchText: string): ParsedPatch {
	const lines = normalizePatchText(patchText).split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	let index = 0;
	if (lines[index] !== BEGIN_PATCH) {
		throw new Error(`apply_patch verification failed: expected \"${BEGIN_PATCH}\"`);
	}
	index += 1;

	if (lines[index]?.startsWith(ENVIRONMENT_ID)) {
		throw new Error("apply_patch environment selection is unavailable in pi");
	}

	const operations: PatchOperation[] = [];
	while (index < lines.length) {
		const line = lines[index];
		if (line === END_PATCH) {
			index += 1;
			break;
		}

		if (line.startsWith(ADD_FILE)) {
			const path = readRequiredHeaderValue(line, ADD_FILE);
			index += 1;
			const addLines: string[] = [];
			while (index < lines.length && !isFileOpHeaderOrEnd(lines[index])) {
				const addLine = lines[index];
				if (!addLine.startsWith("+")) {
					throw new Error(`Invalid Add File Line: ${addLine}`);
				}
				addLines.push(addLine.slice(1));
				index += 1;
			}
			if (addLines.length === 0) {
				throw new Error(`Add File requires at least one + line: ${path}`);
			}
			operations.push({ type: "add", path, lines: addLines });
			continue;
		}

		if (line.startsWith(DELETE_FILE)) {
			const path = readRequiredHeaderValue(line, DELETE_FILE);
			index += 1;
			operations.push({ type: "delete", path });
			continue;
		}

		if (line.startsWith(UPDATE_FILE)) {
			const path = readRequiredHeaderValue(line, UPDATE_FILE);
			index += 1;
			let moveTo: string | undefined;
			if (index < lines.length && lines[index].startsWith(MOVE_TO)) {
				moveTo = readRequiredHeaderValue(lines[index], MOVE_TO);
				index += 1;
			}
			const diffLines: string[] = [];
			while (index < lines.length && !isFileOpHeaderOrEnd(lines[index])) {
				diffLines.push(lines[index]);
				index += 1;
			}
			if (!moveTo && diffLines.length === 0) {
				throw new Error(`Update File requires a move or hunk lines: ${path}`);
			}
			operations.push({ type: "update", path, moveTo, diffLines });
			continue;
		}

		throw new Error(`Invalid patch header: ${line}`);
	}

	if (operations.length === 0) {
		throw new Error("apply_patch verification failed: patch contains no file operations");
	}
	if (index === 0 || lines[index - 1] !== END_PATCH) {
		throw new Error(`apply_patch verification failed: expected \"${END_PATCH}\"`);
	}
	if (index < lines.length) {
		const extra = lines.slice(index).join("\n").trim();
		if (extra) throw new Error(`Unexpected content after ${END_PATCH}: ${extra}`);
	}

	return { operations };
}

export function getTouchedAbsolutePaths(parsed: ParsedPatch, cwd: string): string[] {
	const paths: string[] = [];
	for (const op of parsed.operations) {
		const source = resolvePatchPath(cwd, op.path);
		paths.push(source.absolutePath);
		if (op.type === "update" && op.moveTo) {
			const destination = resolvePatchPath(cwd, op.moveTo);
			if (destination.absolutePath !== source.absolutePath) paths.push(destination.absolutePath);
		}
	}
	return [...new Set(paths)].sort();
}

export async function applyPatchText(patchText: string, options: ApplyPatchOptions): Promise<AppliedPatchResult> {
	const parsed = parsePatch(patchText);
	return applyParsedPatch(parsed, options);
}

export async function applyParsedPatch(parsed: ParsedPatch, options: ApplyPatchOptions): Promise<AppliedPatchResult> {
	const prepared = await preparePatchChanges(parsed, options);

	for (const change of prepared) {
		throwIfAborted(options.signal);
		if (change.action === "add") {
			await mkdir(dirname(change.absolutePath), { recursive: true });
			await writeFile(change.absolutePath, change.newContent, { encoding: "utf8", flag: "wx" });
			continue;
		}

		if (change.action === "delete") {
			await unlink(change.absolutePath);
			continue;
		}

		if (change.absoluteMoveTo && change.moveTo) {
			await mkdir(dirname(change.absoluteMoveTo), { recursive: true });
			await rename(change.absolutePath, change.absoluteMoveTo);
			await writeFile(change.absoluteMoveTo, change.newContent, "utf8");
			continue;
		}

		await writeFile(change.absolutePath, change.newContent, "utf8");
	}

	return buildAppliedPatchResult(prepared);
}

async function preparePatchChanges(parsed: ParsedPatch, options: ApplyPatchOptions): Promise<PreparedChange[]> {
	throwIfAborted(options.signal);
	const cwdAbs = resolve(options.cwd);
	const cwdReal = await realpath(cwdAbs).catch(() => cwdAbs);

	validateNoConflictingPaths(parsed, cwdAbs);

	const prepared: PreparedChange[] = [];
	for (const op of parsed.operations) {
		throwIfAborted(options.signal);
		if (op.type === "add") {
			const target = resolvePatchPath(cwdAbs, op.path);
			await ensurePathDoesNotExist(target.absolutePath, target.path);
			await ensureParentDirectorySafe(target.absolutePath, cwdAbs, cwdReal);
			prepared.push({
				action: "add",
				path: target.path,
				absolutePath: target.absolutePath,
				oldContent: "",
				newContent: op.lines.join("\n"),
			});
			continue;
		}

		if (op.type === "delete") {
			const target = resolvePatchPath(cwdAbs, op.path);
			await ensureExistingTargetSafe(target.absolutePath, target.path, cwdReal, { allowSymlink: true });
			const stat = await lstat(target.absolutePath);
			const oldContent = stat.isSymbolicLink() ? "" : await readFile(target.absolutePath, "utf8");
			prepared.push({
				action: "delete",
				path: target.path,
				absolutePath: target.absolutePath,
				oldContent,
				newContent: "",
			});
			continue;
		}

		const source = resolvePatchPath(cwdAbs, op.path);
		await ensureExistingTargetSafe(source.absolutePath, source.path, cwdReal, { allowSymlink: false });
		const oldContent = await readFile(source.absolutePath, "utf8");
		throwIfAborted(options.signal);
		const diffResult =
			op.diffLines.length > 0
				? applyDiffWithChunks(oldContent, op.diffLines.join("\n"))
				: { output: oldContent, chunks: [] as Chunk[] };
		const newContent = diffResult.output;

		if (op.moveTo) {
			const destination = resolvePatchPath(cwdAbs, op.moveTo);
			if (destination.absolutePath !== source.absolutePath) {
				await ensurePathDoesNotExist(destination.absolutePath, destination.path);
				await ensureParentDirectorySafe(destination.absolutePath, cwdAbs, cwdReal);
				prepared.push({
					action: "update",
					path: source.path,
					absolutePath: source.absolutePath,
					moveTo: destination.path,
					absoluteMoveTo: destination.absolutePath,
					oldContent,
					newContent,
					chunks: diffResult.chunks,
				});
				continue;
			}
		}

		prepared.push({
			action: "update",
			path: source.path,
			absolutePath: source.absolutePath,
			oldContent,
			newContent,
			chunks: diffResult.chunks,
		});
	}

	return prepared;
}

function buildAppliedPatchResult(prepared: PreparedChange[]): AppliedPatchResult {
	const changes: AppliedPatchChange[] = prepared.map((change) => {
		if (change.action === "add") return { action: "add", path: change.path, lineCount: countLines(change.newContent) };
		if (change.action === "delete") return { action: "delete", path: change.path };
		if (change.absoluteMoveTo && change.moveTo) {
			return { action: "move", path: change.path, moveTo: change.moveTo, lineCount: countLines(change.newContent) };
		}
		return { action: "update", path: change.path, lineCount: countLines(change.newContent) };
	});

	return { changes, diff: generatePreparedDiff(prepared) };
}

function generatePreparedDiff(prepared: PreparedChange[]): string {
	const sections: string[] = [];
	for (const change of prepared) {
		if (change.action === "add") {
			sections.push(`*** Add File: ${change.path}`);
			sections.push(formatWholeFileDiff("add", change.newContent));
			continue;
		}

		if (change.action === "delete") {
			sections.push(`*** Delete File: ${change.path}`);
			const deleteDiff = formatWholeFileDiff("delete", change.oldContent);
			if (deleteDiff) sections.push(deleteDiff);
			continue;
		}

		sections.push(change.moveTo ? `*** Update File: ${change.path} -> ${change.moveTo}` : `*** Update File: ${change.path}`);
		if (change.chunks.length > 0) {
			sections.push(formatChunkDiff(change.oldContent, change.newContent, change.chunks));
		} else if (change.moveTo) {
			sections.push(` ${"".padStart(String(countLines(change.newContent)).length, " ")} moved without content changes`);
		}
	}
	return sections.filter(Boolean).join("\n");
}

function formatWholeFileDiff(kind: "add" | "delete", content: string): string {
	const lines = splitDisplayLines(content);
	const width = String(Math.max(1, lines.length)).length;
	return lines
		.map((line, index) => {
			const lineNumber = String(index + 1).padStart(width, " ");
			return `${kind === "add" ? "+" : "-"}${lineNumber} ${line}`;
		})
		.join("\n");
}

function formatChunkDiff(oldContent: string, newContent: string, chunks: Chunk[], contextLines = 4): string {
	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const width = String(Math.max(oldLines.length, newLines.length, 1)).length;
	const output: string[] = [];
	let delta = 0;
	let lastOldShown = 0;

	for (const chunk of chunks) {
		const newIndex = chunk.origIndex + delta;
		const contextStartOld = Math.max(lastOldShown, chunk.origIndex - contextLines);
		const contextStartNew = contextStartOld + delta;

		if (contextStartOld > lastOldShown && output.length > 0) {
			output.push(` ${"".padStart(width, " ")} ...`);
		}

		for (let oldIndex = contextStartOld; oldIndex < chunk.origIndex; oldIndex += 1) {
			const newLineNumber = contextStartNew + (oldIndex - contextStartOld) + 1;
			output.push(` ${String(newLineNumber).padStart(width, " ")} ${oldLines[oldIndex] ?? ""}`);
		}

		for (let i = 0; i < chunk.delLines.length; i += 1) {
			output.push(`-${String(chunk.origIndex + i + 1).padStart(width, " ")} ${chunk.delLines[i]}`);
		}

		for (let i = 0; i < chunk.insLines.length; i += 1) {
			output.push(`+${String(newIndex + i + 1).padStart(width, " ")} ${chunk.insLines[i]}`);
		}

		const oldAfterStart = chunk.origIndex + chunk.delLines.length;
		const oldAfterEnd = Math.min(oldLines.length, oldAfterStart + contextLines);
		const newAfterStart = newIndex + chunk.insLines.length;
		for (let oldIndex = oldAfterStart; oldIndex < oldAfterEnd; oldIndex += 1) {
			const newLineNumber = newAfterStart + (oldIndex - oldAfterStart) + 1;
			output.push(` ${String(newLineNumber).padStart(width, " ")} ${oldLines[oldIndex] ?? ""}`);
		}

		lastOldShown = oldAfterEnd;
		delta += chunk.insLines.length - chunk.delLines.length;
	}

	if (lastOldShown < oldLines.length) {
		output.push(` ${"".padStart(width, " ")} ...`);
	}

	return output.join("\n");
}

function splitDisplayLines(content: string): string[] {
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

export function formatApplyPatchSummary(result: AppliedPatchResult): string {
	const count = result.changes.length;
	const noun = count === 1 ? "file" : "files";
	const lines = [`Success. Applied patch to ${count} ${noun}.`];
	for (const change of result.changes) {
		if (change.action === "add") lines.push(`- Added ${change.path} (${formatLineCount(change.lineCount)})`);
		else if (change.action === "delete") lines.push(`- Deleted ${change.path}`);
		else if (change.action === "move") {
			lines.push(`- Updated and moved ${change.path} -> ${change.moveTo} (${formatLineCount(change.lineCount)})`);
		} else {
			lines.push(`- Updated ${change.path} (${formatLineCount(change.lineCount)})`);
		}
	}
	return lines.join("\n");
}

function formatLineCount(count: number): string {
	return `${count} ${count === 1 ? "line" : "lines"}`;
}

function normalizePatchText(input: string): string {
	let text = input.replace(/^\uFEFF/, "");
	const trimmed = text.trim();
	const fenced = trimmed.match(/^```(?:[\w.-]+)?\s*\n([\s\S]*?)\n```$/);
	text = fenced ? fenced[1] : trimmed;
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function readRequiredHeaderValue(line: string, prefix: string): string {
	const value = line.slice(prefix.length).trim();
	if (!value) throw new Error(`Missing path in patch header: ${line}`);
	return value;
}

function isFileOpHeaderOrEnd(line: string | undefined): boolean {
	return (
		line === undefined ||
		line === END_PATCH ||
		line.startsWith(ADD_FILE) ||
		line.startsWith(DELETE_FILE) ||
		line.startsWith(UPDATE_FILE)
	);
}

function resolvePatchPath(cwd: string, rawPath: string): ResolvedPatchPath {
	let path = rawPath.trim();
	if (path.startsWith("@")) path = path.slice(1);
	if (!path) throw new Error("Patch paths must not be empty");
	if (path.includes("\0")) throw new Error(`Patch path contains a NUL byte: ${rawPath}`);
	if (isAbsolute(path) || win32.isAbsolute(path)) throw new Error(`Patch paths must be relative, not absolute: ${rawPath}`);
	if (/^~(?:$|[\\/])/.test(path)) throw new Error(`Patch paths must be relative, not home-relative: ${rawPath}`);
	if (/[\\/]$/.test(path)) throw new Error(`Patch path must refer to a file, not a directory: ${rawPath}`);

	const pathForChecks = path.replace(/\\/g, "/");
	if (pathForChecks.split("/").includes("..")) {
		throw new Error(`Patch paths must stay within the current working directory: ${rawPath}`);
	}

	const cwdAbs = resolve(cwd);
	const absolutePath = resolve(cwdAbs, path);
	assertInside(absolutePath, cwdAbs, `Patch path escapes current working directory: ${rawPath}`);
	return { path, absolutePath };
}

function validateNoConflictingPaths(parsed: ParsedPatch, cwd: string): void {
	const seen = new Map<string, string>();
	for (const op of parsed.operations) {
		const source = resolvePatchPath(cwd, op.path);
		rememberTouchedPath(seen, source.absolutePath, source.path);
		if (op.type === "update" && op.moveTo) {
			const destination = resolvePatchPath(cwd, op.moveTo);
			if (destination.absolutePath !== source.absolutePath) {
				rememberTouchedPath(seen, destination.absolutePath, destination.path);
			}
		}
	}
}

function rememberTouchedPath(seen: Map<string, string>, absolutePath: string, displayPath: string): void {
	const previous = seen.get(absolutePath);
	if (previous !== undefined) {
		throw new Error(`Conflicting patch operations touch the same path more than once: ${previous} and ${displayPath}`);
	}
	seen.set(absolutePath, displayPath);
}

async function ensurePathDoesNotExist(absolutePath: string, displayPath: string): Promise<void> {
	try {
		await lstat(absolutePath);
	} catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
	throw new Error(`File already exists: ${displayPath}`);
}

async function ensureExistingTargetSafe(
	absolutePath: string,
	displayPath: string,
	cwdReal: string,
	options: { allowSymlink: boolean },
): Promise<void> {
	let stat;
	try {
		stat = await lstat(absolutePath);
	} catch (error: any) {
		if (error?.code === "ENOENT") throw new Error(`File does not exist: ${displayPath}`);
		throw error;
	}
	if (stat.isDirectory()) throw new Error(`Patch path refers to a directory, not a file: ${displayPath}`);
	if (stat.isSymbolicLink() && !options.allowSymlink) {
		throw new Error(`Refusing to update symbolic link target: ${displayPath}`);
	}
	if (!stat.isSymbolicLink()) {
		const targetReal = await realpath(absolutePath);
		assertInside(targetReal, cwdReal, `Patch path resolves outside current working directory: ${displayPath}`);
	}
}

async function ensureParentDirectorySafe(absolutePath: string, cwdAbs: string, cwdReal: string): Promise<void> {
	let current = dirname(absolutePath);
	while (true) {
		try {
			const stat = await lstat(current);
			if (!stat.isDirectory()) throw new Error(`Parent path is not a directory: ${current}`);
			const currentReal = await realpath(current);
			assertInside(currentReal, cwdReal, `Patch destination parent resolves outside current working directory: ${current}`);
			return;
		} catch (error: any) {
			if (error?.code !== "ENOENT") throw error;
			const parent = dirname(current);
			if (parent === current) throw error;
			assertInside(parent, cwdAbs, `Patch destination escapes current working directory: ${absolutePath}`);
			current = parent;
		}
	}
}

function assertInside(pathToCheck: string, root: string, message: string): void {
	const rel = relative(root, pathToCheck);
	if (rel === "") return;
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(message);
}

function countLines(content: string): number {
	if (content.length === 0) return 0;
	return content.split("\n").length;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = (signal as any).reason;
	if (reason instanceof Error) throw reason;
	throw new Error("apply_patch cancelled");
}

/**
 * Applies a headerless V4A diff to the provided file content.
 *
 * This is adapted from the Codex apply_patch algorithm in this directory. It
 * supports @@ anchors, context/add/delete lines, whitespace-fuzzy matching, and
 * *** End of File markers.
 */
export function applyDiff(input: string, diff: string): string {
	return applyDiffWithChunks(input, diff).output;
}

function applyDiffWithChunks(input: string, diff: string): { output: string; chunks: Chunk[] } {
	const diffLines = normalizeDiffLines(diff);
	const { chunks } = parseUpdateDiff(diffLines, input);
	return { output: applyChunks(input, chunks), chunks };
}

type Chunk = { origIndex: number; delLines: string[]; insLines: string[] };

type ParserState = { lines: string[]; index: number; fuzz: number };

const END_SECTION_MARKERS = [END_PATCH, UPDATE_FILE, DELETE_FILE, ADD_FILE, END_FILE];

function normalizeDiffLines(diff: string): string[] {
	return diff
		.split(/\r?\n/)
		.map((line) => line.replace(/\r$/, ""))
		.filter((line, idx, arr) => !(idx === arr.length - 1 && line === ""));
}

function isDone(state: ParserState, prefixes: string[]): boolean {
	if (state.index >= state.lines.length) return true;
	return prefixes.some((prefix) => state.lines[state.index]?.startsWith(prefix));
}

function readStr(state: ParserState, prefix: string): string {
	const current = state.lines[state.index];
	if (typeof current === "string" && current.startsWith(prefix)) {
		state.index += 1;
		return current.slice(prefix.length);
	}
	return "";
}

function parseUpdateDiff(diffLines: string[], input: string): { chunks: Chunk[]; fuzz: number } {
	const parser: ParserState = {
		lines: [...diffLines, END_PATCH],
		index: 0,
		fuzz: 0,
	};
	const inputLines = input.split("\n");
	const chunks: Chunk[] = [];
	let cursor = 0;

	while (!isDone(parser, END_SECTION_MARKERS)) {
		const anchor = readStr(parser, "@@ ");
		const hasBareAnchor = !anchor && parser.lines[parser.index] === "@@";
		if (hasBareAnchor) parser.index += 1;

		if (!(anchor || hasBareAnchor || cursor === 0)) {
			throw new Error(`Invalid Line:\n${parser.lines[parser.index]}`);
		}

		if (anchor.trim()) {
			cursor = advanceCursorToAnchor(anchor, inputLines, cursor, parser);
			// Codex apply_patch grammar allows multiple @@ context anchors before
			// the actual +/-/space lines. Each anchor narrows the cursor.
			if (parser.lines[parser.index]?.startsWith("@@")) continue;
		}

		const { nextContext, sectionChunks, endIndex, eof } = readSection(parser.lines, parser.index);
		const nextContextText = nextContext.join("\n");
		const { newIndex, fuzz } = findContext(inputLines, nextContext, cursor, eof);

		if (newIndex === -1) {
			if (eof) throw new Error(`Invalid EOF Context ${cursor}:\n${nextContextText}`);
			throw new Error(`Invalid Context ${cursor}:\n${nextContextText}`);
		}

		parser.fuzz += fuzz;
		for (const chunk of sectionChunks) {
			chunks.push({ ...chunk, origIndex: chunk.origIndex + newIndex });
		}

		cursor = newIndex + nextContext.length;
		parser.index = endIndex;
	}

	if (chunks.length === 0) {
		throw new Error("Update File requires at least one changed line");
	}

	return { chunks, fuzz: parser.fuzz };
}

function advanceCursorToAnchor(anchor: string, inputLines: string[], cursor: number, parser: ParserState): number {
	let found = false;

	if (!inputLines.slice(0, cursor).some((line) => line === anchor)) {
		for (let i = cursor; i < inputLines.length; i += 1) {
			if (inputLines[i] === anchor) {
				cursor = i + 1;
				found = true;
				break;
			}
		}
	}

	if (!found && !inputLines.slice(0, cursor).some((line) => line.trim() === anchor.trim())) {
		for (let i = cursor; i < inputLines.length; i += 1) {
			if (inputLines[i].trim() === anchor.trim()) {
				cursor = i + 1;
				parser.fuzz += 1;
				found = true;
				break;
			}
		}
	}

	return cursor;
}

function readSection(
	lines: string[],
	startIndex: number,
): { nextContext: string[]; sectionChunks: Chunk[]; endIndex: number; eof: boolean } {
	const context: string[] = [];
	let delLines: string[] = [];
	let insLines: string[] = [];
	const sectionChunks: Chunk[] = [];
	let mode: "keep" | "add" | "delete" = "keep";
	let index = startIndex;
	const origIndex = index;

	while (index < lines.length) {
		const raw = lines[index];
		if (
			raw.startsWith("@@") ||
			raw.startsWith(END_PATCH) ||
			raw.startsWith(UPDATE_FILE) ||
			raw.startsWith(DELETE_FILE) ||
			raw.startsWith(ADD_FILE) ||
			raw.startsWith(END_FILE)
		) {
			break;
		}
		if (raw === "***") break;
		if (raw.startsWith("***")) throw new Error(`Invalid Line: ${raw}`);

		index += 1;
		const lastMode: "keep" | "add" | "delete" = mode;
		let line = raw;
		if (line === "") line = " ";

		if (line[0] === "+") mode = "add";
		else if (line[0] === "-") mode = "delete";
		else if (line[0] === " ") mode = "keep";
		else throw new Error(`Invalid Line: ${line}`);

		line = line.slice(1);

		const switchingToContext = mode === "keep" && lastMode !== mode;
		if (switchingToContext && (insLines.length || delLines.length)) {
			sectionChunks.push({ origIndex: context.length - delLines.length, delLines, insLines });
			delLines = [];
			insLines = [];
		}

		if (mode === "delete") {
			delLines.push(line);
			context.push(line);
		} else if (mode === "add") {
			insLines.push(line);
		} else {
			context.push(line);
		}
	}

	if (insLines.length || delLines.length) {
		sectionChunks.push({ origIndex: context.length - delLines.length, delLines, insLines });
	}

	if (index < lines.length && lines[index] === END_FILE) {
		index += 1;
		return { nextContext: context, sectionChunks, endIndex: index, eof: true };
	}

	if (index === origIndex) throw new Error(`Nothing in this section - index=${index} ${lines[index]}`);
	return { nextContext: context, sectionChunks, endIndex: index, eof: false };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): { newIndex: number; fuzz: number } {
	if (eof) {
		const endStart = Math.max(0, lines.length - context.length);
		const endMatch = findContextCore(lines, context, endStart);
		if (endMatch.newIndex !== -1) return endMatch;
		const fallback = findContextCore(lines, context, start);
		return { newIndex: fallback.newIndex, fuzz: fallback.fuzz + 10000 };
	}
	return findContextCore(lines, context, start);
}

function findContextCore(lines: string[], context: string[], start: number): { newIndex: number; fuzz: number } {
	if (!context.length) return { newIndex: start, fuzz: 0 };
	for (let i = start; i < lines.length; i += 1) {
		if (equalsSlice(lines, context, i, (value) => value)) return { newIndex: i, fuzz: 0 };
	}
	for (let i = start; i < lines.length; i += 1) {
		if (equalsSlice(lines, context, i, (value) => value.trimEnd())) return { newIndex: i, fuzz: 1 };
	}
	for (let i = start; i < lines.length; i += 1) {
		if (equalsSlice(lines, context, i, (value) => value.trim())) return { newIndex: i, fuzz: 100 };
	}
	return { newIndex: -1, fuzz: 0 };
}

function equalsSlice(source: string[], target: string[], start: number, mapFn: (value: string) => string): boolean {
	if (start + target.length > source.length) return false;
	for (let i = 0; i < target.length; i += 1) {
		if (mapFn(source[start + i]) !== mapFn(target[i])) return false;
	}
	return true;
}

function applyChunks(input: string, chunks: Chunk[]): string {
	const origLines = input.split("\n");
	const destLines: string[] = [];
	let origIndex = 0;

	for (const chunk of chunks) {
		if (chunk.origIndex > origLines.length) {
			throw new Error(`applyDiff: chunk.origIndex ${chunk.origIndex} > input length ${origLines.length}`);
		}
		if (origIndex > chunk.origIndex) {
			throw new Error(`applyDiff: overlapping chunk at ${chunk.origIndex} (cursor ${origIndex})`);
		}

		destLines.push(...origLines.slice(origIndex, chunk.origIndex));
		origIndex = chunk.origIndex;
		if (chunk.insLines.length) destLines.push(...chunk.insLines);
		origIndex += chunk.delLines.length;
	}

	destLines.push(...origLines.slice(origIndex));
	return destLines.join("\n");
}
