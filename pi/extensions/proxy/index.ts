import { join } from "node:path";
import { Input, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	getAgentDir, SettingsManager,
	type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadRouter, readConfigText, Router, saveConfig } from "./config.ts";
import { startTransport } from "./transport.ts";

const MODES = ["global", "rule", "direct"] as const;

export default function proxyExtension(pi: ExtensionAPI): void {
	const path = join(getAgentDir(), "proxy.json");
	let runtime: ReturnType<typeof startTransport> | undefined;

	async function activate(router: Router, ctx: ExtensionContext) {
		const timeout = SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getHttpIdleTimeoutMs();
		await runtime?.stop();
		runtime = startTransport(router, timeout);
		ctx.ui.setStatus("proxy", `proxy:${runtime.config.mode}`);
	}
	pi.on("session_start", async (_event, ctx) => {
		await activate(loadRouter(path), ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		await runtime?.stop();
		runtime = undefined;
		ctx.ui.setStatus("proxy", undefined);
	});
	pi.registerCommand("proxy", {
		description: "Proxy mode: global / rule / direct; set proxy URL or reload config",
		getArgumentCompletions: (prefix) => [...MODES, "set", "reload"]
			.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			try {
				let command = args.trim();
				if (!command) {
					const current = runtime?.config.mode ?? "not active";
					if (!ctx.hasUI) { ctx.ui.notify(`Proxy: ${current}; ${path}`, "info"); return; }
					command = await ctx.ui.select(`Proxy · ${current}`, [...MODES, "set", "reload"]) ?? "";
					if (!command) return;
				}
				let router: Router;
				if (command === "set") {
					if (ctx.mode !== "tui") throw new Error(`Set proxyUrl in ${path}, then run /proxy reload`);
					const updated = await ctx.ui.custom<Router | undefined>((tui, theme, _kb, done) => {
						let error: string | undefined;
						const input = new class extends Input {
							handleInput(data: string) {
								if (matchesKey(data, "ctrl+c")) { done(undefined); return; }
								error = undefined;
								if (matchesKey(data, "escape")) {
									try {
										// Keep any rules or mode another Pi process saved while editing.
										done(new Router({ ...JSON.parse(readConfigText(path)), proxyUrl: this.getValue() }));
									} catch (e) { error = e instanceof Error ? e.message : String(e); }
								} else super.handleInput(data);
								tui.requestRender();
							}
							render(width: number) {
								return ["", theme.fg("accent", "Proxy URL · HTTP/HTTPS"), ...super.render(width),
									...(error ? [theme.fg("error", error)] : []),
									theme.fg("muted", "Esc save & close · Ctrl+C cancel"), "",
								].map((line) => truncateToWidth(line, width));
							}
						}();
						input.setValue(JSON.parse(readConfigText(path)).proxyUrl);
						return input;
					});
					if (!updated) return;
					router = updated;
				} else if (command === "reload") {
					router = loadRouter(path);
				} else if (MODES.includes(command as typeof MODES[number])) {
					// Reread shared rules rather than overwriting edits from another Pi process.
					router = new Router({ ...JSON.parse(readConfigText(path)), mode: command });
				} else throw new Error("Usage: /proxy [global|rule|direct|set|reload]");
				await ctx.waitForIdle();
				if (command !== "reload") saveConfig(path, router.config);
				await activate(router, ctx);
				ctx.ui.notify(`Proxy: ${router.config.mode} · ${path}`, "info");
			} catch (error) {
				ctx.ui.notify(`Proxy: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
