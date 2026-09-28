import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { UsageItem, UsageProvider } from "./provider.ts";
import deepseek from "./providers/deepseek.ts";
import kimi from "./providers/kimi.ts";
import { formatDetails, formatStatus } from "./ui.ts";

const PROVIDERS: UsageProvider[] = [deepseek, kimi];
const USAGE = `Usage: /usage ${PROVIDERS.map((provider) => provider.id).join(" | ")}`;
interface Result { items: UsageItem[]; error?: string }
interface Report { provider: string; result: Result }

export default function usageExtension(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let active: UsageProvider | undefined;
	let controller = new AbortController();
	let timer: ReturnType<typeof setInterval> | undefined;
	const results = new Map<string, Result>();
	const pending = new Map<string, Promise<Result | undefined>>();
	const configured = (ctx: ExtensionContext, provider: UsageProvider) => ctx.modelRegistry.getProviderAuthStatus(provider.provider).configured;

	function updateStatus() {
		if (context?.mode !== "tui") return;
		if (!active || !configured(context, active)) { context.ui.setStatus("usage", undefined); return; }
		const result = results.get(active.id);
		const theme = context.ui.theme;
		const text = result?.error ? "usage unavailable" : result ? formatStatus(result.items) : "loading…";
		context.ui.setStatus("usage", theme.fg("muted", `${active.id}:`)
			+ theme.fg(result?.error ? "warning" : "accent", text));
	}

	function query(provider: UsageProvider, ctx: ExtensionContext): Promise<Result | undefined> {
		const existing = pending.get(provider.id);
		if (existing) return existing;
		const sessionSignal = controller.signal;
		const signal = AbortSignal.any([sessionSignal, AbortSignal.timeout(15_000)]);
		const request = (async () => {
			let result: Result;
			try {
				const resolved = await ctx.modelRegistry.getProviderAuth(provider.provider);
				signal.throwIfAborted();
				const auth = resolved?.auth;
				const authorization = auth?.headers?.Authorization ?? auth?.headers?.authorization;
				const token = auth?.apiKey ?? authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
				if (!token) throw new Error(`No credentials configured for ${provider.name}`);
				result = { items: await provider.query(token, signal) };
			} catch (error) {
				result = { items: [], error: error instanceof Error ? error.message : String(error) };
			}
			if (sessionSignal.aborted) return;
			results.set(provider.id, result);
			updateStatus();
			return result;
		})().finally(() => { if (pending.get(provider.id) === request) pending.delete(provider.id); });
		pending.set(provider.id, request);
		return request;
	}

	function refreshCurrent() {
		updateStatus();
		if (context?.mode === "tui" && active && configured(context, active)) void query(active, context);
	}

	function stop() {
		controller.abort();
		clearInterval(timer);
		timer = undefined;
		context?.ui.setStatus("usage", undefined);
		context = undefined;
		active = undefined;
		results.clear();
		pending.clear();
	}
	pi.on("session_start", (_event, ctx) => {
		stop();
		controller = new AbortController();
		context = ctx;
		active = PROVIDERS.find((provider) => provider.provider === ctx.model?.provider);
		refreshCurrent();
		if (ctx.mode === "tui") timer = setInterval(refreshCurrent, 5 * 60_000);
	});
	pi.on("model_select", (event, ctx) => {
		context = ctx;
		const next = PROVIDERS.find((provider) => provider.provider === event.model.provider);
		if (active === next) return;
		active = next;
		refreshCurrent();
	});
	pi.on("session_shutdown", stop);

	pi.registerEntryRenderer<Report>("usage", (entry, _options, theme) => {
		const { provider, result } = entry.data!;
		const body = result.error ? theme.fg("error", result.error) : formatDetails(result.items);
		return new Text(`${theme.fg("accent", theme.bold(`${provider} usage`))}\n${body}`, 0, 0);
	});
	pi.registerCommand("usage", {
		description: "Show provider quota and balance",
		getArgumentCompletions: (prefix) => PROVIDERS.filter((provider) => provider.id.startsWith(prefix))
			.map((provider) => ({ value: provider.id, label: provider.name })),
		handler: async (args, ctx) => {
			let id = args.trim().toLowerCase();
			if (!id) {
				const choices = PROVIDERS.filter((provider) => configured(ctx, provider));
				if (!choices.length) { ctx.ui.notify("No supported providers configured", "warning"); return; }
				if (!ctx.hasUI) { ctx.ui.notify(USAGE, "info"); return; }
				id = await ctx.ui.select("Usage · select provider", choices.map((provider) => provider.id)) ?? "";
				if (!id) return;
			}
			const provider = PROVIDERS.find((provider) => provider.id === id || provider.provider === id);
			if (!provider) { ctx.ui.notify(USAGE, "error"); return; }
			const result = await query(provider, ctx);
			if (result) pi.appendEntry<Report>("usage", { provider: provider.name, result });
		},
	});
}
