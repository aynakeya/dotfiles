import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDiff, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	applyParsedPatch,
	formatApplyPatchSummary,
	getTouchedAbsolutePaths,
	parsePatch,
	type AppliedPatchChange,
	type AppliedPatchResult,
} from "./applyPatchCore.ts";

interface ApplyPatchDetails {
	changes: AppliedPatchChange[];
	touchedPaths: string[];
	diff: string;
}

const applyPatchParameters = Type.Object(
	{
		patch: Type.String({
			description:
				"Full raw Codex apply_patch text, beginning with *** Begin Patch and ending with *** End Patch. Put the patch text directly in this JSON field; do not wrap it in a shell command or markdown code fence.",
		}),
	},
	{ additionalProperties: false },
);

const description = `Apply a Codex-style apply_patch envelope to files under the current working directory.

Patch grammar:
*** Begin Patch
*** Add File: <relative path>
+new file line
*** Update File: <relative path>
*** Move to: <new relative path>
@@ optional anchor
 old context line
-old line
+new line
*** Delete File: <relative path>
*** End Patch

Rules:
- The patch argument must contain the full raw patch text; pi passes it as JSON, not as a shell command.
- Include one or more file headers: *** Add File, *** Delete File, or *** Update File.
- File paths must be relative to the current working directory, never absolute.
- Add File requires every content line to start with +.
- Update File may be followed immediately by *** Move to: <new relative path> for renames.
- Update File hunks start with @@ (optionally followed by an anchor such as a class/function name). Hunk lines must start with space for context, - for old/deleted lines, or + for new/added lines.
- For update hunks, include enough context to identify the target uniquely: normally 3 lines before and after each change. If nearby changes are within 3 lines, do not duplicate context between them.
- If ordinary context is ambiguous, use one or more @@ anchors to narrow to the containing class/function/block.
- The tool rejects paths outside cwd, duplicate/conflicting file operations, existing Add File targets, and missing Update/Delete targets.`;

export default function applyPatchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description,
		promptSnippet: "Apply a Codex-style patch envelope to add, update, delete, or move files.",
		promptGuidelines: [
			"Use apply_patch for structured multi-file edits when a patch is clearer than separate edit/write calls.",
			"The apply_patch tool takes one JSON field named patch whose value is the raw patch text from *** Begin Patch through *** End Patch; do not wrap it in a shell command or markdown fence.",
			"apply_patch paths must be relative to the current working directory; never use absolute paths or parent-directory traversal.",
			"For apply_patch Update File hunks, include about 3 lines of surrounding context and use @@ class/function/block anchors when needed to make the target unique.",
			"Every apply_patch hunk line must be prefixed with a space, -, or +; every Add File content line must be prefixed with +.",
		],
		parameters: applyPatchParameters,
		renderShell: "self",
		executionMode: "sequential",
		prepareArguments(args) {
			if (typeof args === "string") return { patch: args };
			if (!args || typeof args !== "object") return args as any;
			const input = args as { patch?: unknown; command?: unknown; input?: unknown };
			if (typeof input.patch === "string") return { patch: input.patch };
			if (typeof input.command === "string") return { patch: input.command };
			if (typeof input.input === "string") return { patch: input.input };
			return args as any;
		},
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const parsed = parsePatch(params.patch);
			const touchedPaths = getTouchedAbsolutePaths(parsed, ctx.cwd);
			const result = await withPatchQueues(touchedPaths, () =>
				applyParsedPatch(parsed, { cwd: ctx.cwd, signal }),
			);
			return {
				content: [{ type: "text", text: formatApplyPatchSummary(result) }],
				details: { changes: result.changes, touchedPaths, diff: result.diff } satisfies ApplyPatchDetails,
			};
		},
		renderCall(args, theme, context) {
			const component = getApplyPatchCallRenderComponent(context.state, context.lastComponent);
			const patch = getPatchArg(args);
			if (component.argsKey !== patch) {
				component.result = undefined;
				component.argsKey = patch;
			}
			return buildApplyPatchCallComponent(component, patch, theme);
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) {
				return new Text(theme.fg("warning", "Applying patch..."), 0, 0);
			}

			const component =
				(context.state?.callComponent as ApplyPatchCallRenderComponent | undefined) ??
				createApplyPatchCallRenderComponent();
			const patch = getPatchArg(context.args);

			if (context.isError) {
				component.result = { error: firstTextContent(result.content) || "apply_patch failed" };
			} else {
				const details = result.details as ApplyPatchDetails | undefined;
				component.result = details?.changes?.length
					? { changes: details.changes, diff: details.diff }
					: { error: firstTextContent(result.content) || "apply_patch produced no changes" };
			}

			buildApplyPatchCallComponent(component, patch, theme);
			return context.state?.callComponent ? new Container() : component;
		},
	});
}

type ApplyPatchRenderResult = AppliedPatchResult | { error: string };

type ApplyPatchCallRenderComponent = Container & {
	argsKey?: string;
	result?: ApplyPatchRenderResult;
};

interface ChangeCounts {
	add: number;
	update: number;
	delete: number;
	move: number;
}

function createApplyPatchCallRenderComponent(): ApplyPatchCallRenderComponent {
	return Object.assign(new Container(), { argsKey: undefined, result: undefined as ApplyPatchRenderResult | undefined });
}

function getApplyPatchCallRenderComponent(state: any, lastComponent: unknown): ApplyPatchCallRenderComponent {
	if (lastComponent instanceof Container && "result" in lastComponent) {
		state.callComponent = lastComponent;
		return lastComponent as ApplyPatchCallRenderComponent;
	}
	if (state.callComponent) return state.callComponent;
	const component = createApplyPatchCallRenderComponent();
	state.callComponent = component;
	return component;
}

function getPatchArg(args: unknown): string {
	return args && typeof args === "object" && typeof (args as { patch?: unknown }).patch === "string"
		? (args as { patch: string }).patch
		: "";
}

function buildApplyPatchCallComponent(component: ApplyPatchCallRenderComponent, patch: string, theme: any): ApplyPatchCallRenderComponent {
	component.clear();

	const bgFn = getApplyPatchBg(component.result, theme);
	component.addChild(renderBox(renderHeader(component.result, patch, theme), bgFn));

	if (component.result) {
		if ("error" in component.result) {
			component.addChild(renderBox(theme.fg("error", `✗ ${firstLine(component.result.error)}`), bgFn));
		} else {
			for (const section of splitPatchDiff(component.result.diff)) {
				component.addChild(renderFileSection(section, theme, bgFn));
			}
		}
	}

	return component;
}

function renderHeader(result: ApplyPatchRenderResult | undefined, patch: string, theme: any): string {
	let header = theme.fg("toolTitle", theme.bold("apply_patch "));
	if (result && !("error" in result)) {
		header += theme.fg("success", `✓ ${summarizeAppliedPatch(result)}`);
	} else {
		const summary = summarizePatchInput(patch);
		header += theme.fg(summary.valid ? "accent" : "muted", summary.headline);
		if (summary.paths.length > 0) header += theme.fg("dim", ` ${formatPathList(summary.paths, 4)}`);
	}
	return header;
}

function renderFileSection(section: PatchDiffSection, theme: any, bgFn: (text: string) => string): Box {
	const body = section.body.trim() ? `\n\n${renderPatchDiff(section.body)}` : "";
	return renderBox(`${theme.fg("toolTitle", section.header)}${body}`, bgFn);
}

function renderBox(text: string, bgFn: (text: string) => string): Box {
	const box = new Box(1, 1, bgFn);
	box.addChild(new Text(text, 0, 0));
	return box;
}

interface PatchDiffSection {
	header: string;
	body: string;
}

function splitPatchDiff(diff: string): PatchDiffSection[] {
	const sections: PatchDiffSection[] = [];
	let current: { header: string; lines: string[] } | undefined;
	for (const line of diff.split("\n")) {
		if (line.startsWith("*** Add File:") || line.startsWith("*** Delete File:") || line.startsWith("*** Update File:")) {
			if (current) sections.push({ header: current.header, body: current.lines.join("\n") });
			current = { header: line, lines: [] };
		} else if (current) {
			current.lines.push(line);
		}
	}
	if (current) sections.push({ header: current.header, body: current.lines.join("\n") });
	return sections.length > 0 ? sections : [{ header: "*** Patch", body: diff }];
}

function getApplyPatchBg(result: ApplyPatchRenderResult | undefined, theme: any): (text: string) => string {
	const bg = typeof theme.bg === "function" ? theme.bg.bind(theme) : undefined;
	const color = result && "error" in result ? "toolErrorBg" : result ? "toolSuccessBg" : "toolPendingBg";
	return (text: string) => (bg ? bg(color, text) : text);
}

function renderPatchDiff(diff: string): string {
	try {
		return renderDiff(diff);
	} catch {
		// Tests load the extension outside pi's TUI theme initialization.
		return diff;
	}
}

function summarizeAppliedPatch(result: AppliedPatchResult): string {
	const counts = countAppliedChanges(result.changes);
	const countText = formatChangeCounts(counts);
	return `${result.changes.length} ${plural(result.changes.length, "file")}${countText ? ` (${countText})` : ""}`;
}

function summarizePatchInput(patch: string): { valid: boolean; headline: string; paths: string[] } {
	if (!patch.trim()) return { valid: false, headline: "waiting for patch", paths: [] };

	try {
		const parsed = parsePatch(patch);
		const counts: ChangeCounts = { add: 0, update: 0, delete: 0, move: 0 };
		const paths: string[] = [];
		for (const operation of parsed.operations) {
			if (operation.type === "add") counts.add += 1;
			else if (operation.type === "delete") counts.delete += 1;
			else if (operation.moveTo) counts.move += 1;
			else counts.update += 1;
			paths.push(operation.type === "update" && operation.moveTo ? `${operation.path} -> ${operation.moveTo}` : operation.path);
		}
		const countText = formatChangeCounts(counts);
		return {
			valid: true,
			headline: `${parsed.operations.length} ${plural(parsed.operations.length, "file op")}${countText ? ` (${countText})` : ""}`,
			paths,
		};
	} catch {
		const paths = extractPatchHeaderPaths(patch);
		return {
			valid: false,
			headline: paths.length > 0 ? `${paths.length} ${plural(paths.length, "file op")} draft` : "draft patch",
			paths,
		};
	}
}

function extractPatchHeaderPaths(patch: string): string[] {
	const matches = patch.matchAll(/^\*\*\* (?:Add File|Delete File|Update File|Move to):\s*(.+)$/gm);
	return [...matches].map((match) => match[1].trim()).filter(Boolean);
}

function countAppliedChanges(changes: AppliedPatchChange[]): ChangeCounts {
	const counts: ChangeCounts = { add: 0, update: 0, delete: 0, move: 0 };
	for (const change of changes) counts[change.action] += 1;
	return counts;
}

function formatChangeCounts(counts: ChangeCounts): string {
	return [
		counts.add ? `${counts.add} add` : "",
		counts.update ? `${counts.update} update` : "",
		counts.delete ? `${counts.delete} delete` : "",
		counts.move ? `${counts.move} move` : "",
	]
		.filter(Boolean)
		.join(", ");
}

function formatPathList(paths: string[], max: number): string {
	const shown = paths.slice(0, max).join(", ");
	const remaining = paths.length - max;
	return remaining > 0 ? `[${shown}, +${remaining} more]` : `[${shown}]`;
}

function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	const first = content.find((item) => item && typeof item === "object" && (item as any).type === "text");
	return typeof (first as any)?.text === "string" ? (first as any).text : undefined;
}

function firstLine(text: string): string {
	return text.split(/\r?\n/)[0] ?? text;
}

function plural(count: number, noun: string): string {
	return `${noun}${count === 1 ? "" : "s"}`;
}

async function withPatchQueues<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
	const unique = [...new Set(paths)].sort();
	let run = fn;
	for (const path of unique.slice().reverse()) {
		const next = run;
		run = () => withFileMutationQueue(path, next);
	}
	return run();
}
