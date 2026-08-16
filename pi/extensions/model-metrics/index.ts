import { estimateTokens, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const WORKING_UPDATE_INTERVAL_MS = 1000;

export default function modelMetricsExtension(pi: ExtensionAPI) {
	let agentStartedAt = 0;
	let timing: { requestStartedAt: number; firstOutputAt?: number } | undefined;
	let ttftMs: number | undefined;
	let tokensPerSecond = 0;
	let liveOutputTokens = 0;
	let workingTimer: ReturnType<typeof setInterval> | undefined;

	const restoreWorkingMessage = (ctx: ExtensionContext): void => {
		clearInterval(workingTimer);
		workingTimer = undefined;
		ctx.ui.setWorkingMessage();
	};

	const updateWorkingMessage = (ctx: ExtensionContext): void => {
		if (ctx.mode !== "tui") return;

		const now = performance.now();
		if (timing?.firstOutputAt !== undefined && liveOutputTokens > 0) {
			tokensPerSecond = (liveOutputTokens * 1000) / (now - timing.firstOutputAt);
		}

		const elapsedSeconds = Math.floor((now - agentStartedAt) / 1000);
		let elapsed = `${elapsedSeconds % 60}s`;
		if (elapsedSeconds >= 60) elapsed = `${Math.floor(elapsedSeconds / 60) % 60}m ${elapsed}`;
		if (elapsedSeconds >= 3600) elapsed = `${Math.floor(elapsedSeconds / 3600) % 24}h ${elapsed}`;
		if (elapsedSeconds >= 86_400) elapsed = `${Math.floor(elapsedSeconds / 86_400)}d ${elapsed}`;
		const ttft =
			ttftMs === undefined
				? "—"
				: ttftMs < 1000
					? `${Math.round(ttftMs)}ms`
					: `${(ttftMs / 1000).toFixed(ttftMs < 10_000 ? 2 : 1)}s`;

		ctx.ui.setWorkingMessage(`Working (${elapsed} · TTFT ${ttft} · TPS ${tokensPerSecond.toFixed(1)})`);
	};

	pi.on("agent_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		agentStartedAt = performance.now();
		timing = undefined;
		ttftMs = undefined;
		tokensPerSecond = 0;
		liveOutputTokens = 0;
		updateWorkingMessage(ctx);
		workingTimer = setInterval(() => updateWorkingMessage(ctx), WORKING_UPDATE_INTERVAL_MS);
	});

	pi.on("before_provider_request", () => {
		timing = { requestStartedAt: performance.now() };
		liveOutputTokens = 0;
	});

	pi.on("message_update", (event, ctx) => {
		if (!timing || event.message.role !== "assistant") return;

		const streamEvent = event.assistantMessageEvent;
		const hasOutput =
			(streamEvent.type === "text_delta" ||
				streamEvent.type === "thinking_delta" ||
				streamEvent.type === "toolcall_delta") &&
			streamEvent.delta.length > 0;

		if (hasOutput && timing.firstOutputAt === undefined) {
			timing.firstOutputAt = performance.now();
			ttftMs = timing.firstOutputAt - timing.requestStartedAt;
			updateWorkingMessage(ctx);
		}
		if (timing.firstOutputAt !== undefined) {
			liveOutputTokens = event.message.usage.output || estimateTokens(event.message);
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!timing || event.message.role !== "assistant") return;

		const firstOutputAt = timing.firstOutputAt;
		timing = undefined;
		liveOutputTokens = 0;
		if (firstOutputAt === undefined) return;

		tokensPerSecond = (event.message.usage.output * 1000) / (performance.now() - firstOutputAt);
		updateWorkingMessage(ctx);
	});

	pi.on("agent_end", (_event, ctx) => restoreWorkingMessage(ctx));
	pi.on("session_shutdown", (_event, ctx) => restoreWorkingMessage(ctx));
}
