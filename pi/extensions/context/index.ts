import { getCurrentTools } from "@earendil-works/pi-ai";
import {
	convertToLlm, estimateTokens, SettingsManager,
	type ExtensionAPI, type ExtensionCommandContext, type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";

interface Part { label: string; tokens: number; color: ThemeColor; fill?: string }
interface Report {
	model: string;
	window: number;
	used: number;
	estimated: boolean;
	parts: Part[];
	reserve: number;
}

const tokens = (text: string) => estimateTokens({ role: "user", content: text, timestamp: 0 });
const format = (value: number) => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m`
	: value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));

function collect(pi: ExtensionAPI, ctx: ExtensionCommandContext, window: number): Report {
	const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages);
	let prompt = ctx.getSystemPrompt();
	// These are Pi's named prompt sections, including their wrappers.
	const section = (name: string) => {
		let count = 0;
		prompt = prompt.replace(new RegExp(`^<${name}>\\n[\\s\\S]*?^</${name}>$`, "gm"), (text) => {
			count += tokens(text);
			return "";
		});
		return count;
	};
	const files = section("project_context"), skills = section("skills");
	const active = new Set(pi.getActiveTools());
	const hidden = new Set(ctx.getSystemPromptOptions().hiddenTools);
	// Recorded declarations include codemode's generated descriptions. Before the
	// first request, registered definitions are the available approximation.
	const recorded = new Map(getCurrentTools(messages).map((tool) => [tool.name, tool]));
	const tools = pi.getAllTools().filter((tool) => active.has(tool.name) && !hidden.has(tool.name))
		.map((tool) => recorded.get(tool.name) ?? {
			name: tool.name, description: tool.description, parameters: tool.parameters,
		});
	let conversation = 0, results = 0;
	for (const message of messages) {
		if (message.role === "system") continue;
		if (message.role === "toolResult") results += estimateTokens(message);
		else conversation += estimateTokens(message);
	}
	const parts: Part[] = [
		{ label: "System", tokens: tokens(prompt), color: "muted" },
		{ label: "Tools", tokens: tools.length ? tokens(JSON.stringify(tools)) : 0, color: "accent" },
		{ label: "Files", tokens: files, color: "mdHeading" },
		{ label: "Skills", tokens: skills, color: "syntaxKeyword" },
		{ label: "Messages", tokens: conversation, color: "success" },
		{ label: "Tool results", tokens: results, color: "warning" },
	];
	const sum = parts.reduce((total, part) => total + part.tokens, 0);
	const usage = ctx.getContextUsage();
	const estimated = !usage?.tokens;
	const used = estimated ? sum : usage.tokens!;
	// Only the total can be anchored to API usage. The breakdown is an estimate
	// of its distribution, not provider-supplied per-category token accounting.
	if (sum > 0) for (const part of parts) part.tokens *= used / sum;
	const settings = SettingsManager.inMemory(pi.getSettings()).getCompactionSettings(ctx.model);
	const reserve = settings.enabled ? settings.reserveTokens : 0;
	const remaining = Math.max(0, window - used);
	parts.push(
		{ label: "Free", tokens: Math.max(0, remaining - reserve), color: "dim", fill: "░" },
		{ label: "Reserve", tokens: Math.min(remaining, reserve), color: "muted", fill: "▒" },
	);
	return { model: `${ctx.model!.provider}/${ctx.model!.id}`, window, used, estimated, parts, reserve };
}

export default function contextExtension(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<Report>("context", (entry, _options, theme) => ({
		invalidate() {},
		render(width) {
			const report = entry.data!;
			const cells = Math.max(1, Math.min(60, width - 2));
			const scale = Math.max(report.window, report.used);
			let position = 0, total = 0;
			const bar = report.parts.map((part) => {
				total += part.tokens;
				const end = Math.round(total / scale * cells);
				const text = theme.fg(part.color, (part.fill ?? "█").repeat(end - position));
				position = end;
				return text;
			}).join("");
			const legend: string[] = [];
			for (const part of report.parts.filter((part) => part.tokens > 0)) {
				const text = theme.fg(part.color, `${part.label} ${format(part.tokens)} (${(part.tokens / report.window * 100).toFixed(1)}%)`);
				const last = legend.at(-1);
				if (last && visibleWidth(last) + 3 + visibleWidth(text) <= width) legend[legend.length - 1] += ` · ${text}`;
				else legend.push(text);
			}
			const lines = [
				theme.fg("accent", `Context · ${report.model}`),
				`${report.estimated ? "~" : ""}${format(report.used)} / ${format(report.window)} tokens (${(report.used / report.window * 100).toFixed(1)}%)`,
				`[${bar}]`,
				...legend,
				theme.fg("dim", report.estimated ? "Estimated from text; API usage unavailable."
					: "Categories estimated from text, scaled to Pi's total."),
			];
			if (report.reserve > 0 && report.used > report.window - report.reserve) {
				lines.push(theme.fg("warning", `Compaction threshold reached (reserve ${format(report.reserve)}).`));
			}
			return new Text(lines.join("\n"), 0, 0).render(width);
		},
	}));
	pi.registerCommand("context", {
		description: "Show context usage and an estimated breakdown",
		handler: async (_args, ctx) => {
			const window = ctx.getContextUsage()?.contextWindow ?? ctx.model?.contextWindow;
			if (!ctx.model || !window || window <= 0) {
				ctx.ui.notify("Select a model with a known context window first.", "warning");
				return;
			}
			pi.appendEntry<Report>("context", collect(pi, ctx, window));
		},
	});
}
