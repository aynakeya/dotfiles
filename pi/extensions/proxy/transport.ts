import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Socket, LookupFunction } from "node:net";
import type { EventEmitter } from "node:events";
import type { Client, buildConnector } from "undici";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import { normalizeHost, type Router } from "./config.ts";

// Use the same undici version as Pi, without installing a second copy.
const undici = createRequire(join(getPackageDir(), "package.json"))("undici") as typeof import("undici");

function clientErrors<T extends EventEmitter>(client: T): T {
	// Like Pi: request/stream errors still reach callers; internal Client error
	// events must not become unhandled EventEmitter errors that terminate Pi.
	client.on("error", () => {});
	return client;
}

export function startTransport(router: Router, timeout: number) {
	const previous = {
		fetch: globalThis.fetch, WebSocket: globalThis.WebSocket,
		http: http.globalAgent, https: https.globalAgent,
		dispatcher: undici.getGlobalDispatcher(),
	};
	const sockets = new Set<Socket>();
	const controller = new AbortController();
	const clientFactory = (origin: URL, options: Client.Options) => clientErrors(new undici.Client(origin, options));
	const options = {
		allowH2: false, headersTimeout: timeout, bodyTimeout: timeout,
		factory: clientFactory,
	};
	const proxy = router.config.proxyUrl ? new URL(router.config.proxyUrl) : undefined;
	const upstream = proxy ? clientErrors(new undici.Pool(proxy.origin, {
		...options, connect: { autoSelectFamilyAttemptTimeout: 2_000 },
	})) : undefined;
	const proxyHeaders = proxy && (proxy.username || proxy.password) ? {
		"proxy-authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
	} : {};

	// Both fetch/WebSocket and Node HTTP(S) use this connection hook. There is
	// no local server, response forwarding, or change to child-process env vars.
	async function open(target: buildConnector.Options): Promise<Socket> {
		const route = await router.route(target.hostname);
		controller.signal.throwIfAborted();
		let httpSocket: Socket | undefined;
		if (route.action === "proxy") {
			const host = normalizeHost(target.hostname);
			const authority = `${host.includes(":") ? `[${host}]` : host}:${target.port || (target.protocol === "https:" ? 443 : 80)}`;
			const tunnel = await upstream!.connect({
				path: authority, headers: { ...proxyHeaders, host: authority }, signal: controller.signal,
			}).catch((error: Error) => {
				// UND_ERR_SOCKET denotes an established origin connection to undici;
				// strip that code so a failed CONNECT cannot cause endless retries.
				throw new Error(`Proxy connection failed: ${error.message}`, { cause: error });
			});
			httpSocket = tunnel.socket as Socket; // HTTP/1 CONNECT returns a TCP/TLS socket.
			if (tunnel.statusCode !== 200) {
				httpSocket.destroy();
				throw new Error(`Proxy CONNECT failed: HTTP ${tunnel.statusCode}`);
			}
		}
		const addresses = route.addresses;
		const lookup: LookupFunction | undefined = addresses ? (_host, options, cb) => cb(null,
			options.all ? addresses : addresses[0].address, addresses[0].family) : undefined;
		const socket = httpSocket && target.protocol !== "https:" ? httpSocket
			: await promisify(undici.buildConnector({
				allowH2: false, autoSelectFamilyAttemptTimeout: 2_000, signal: controller.signal, lookup,
			}))({ ...target, httpSocket }) as Socket;
		if (controller.signal.aborted) {
			socket.destroy();
			controller.signal.throwIfAborted();
		}
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		return socket;
	}
	const connect: buildConnector.connector = (target, callback) => {
		void open(target).then((socket) => callback(null, socket), (error) => callback(error, null));
	};
	const dispatcher = clientErrors(new undici.Agent({
		...options, connect,
		factory: (origin, options) => clientErrors(new undici.Pool(origin, { ...options, factory: clientFactory })),
	}));
	const httpAgent = new http.Agent({ keepAlive: true, proxyEnv: {} });
	const httpsAgent = new https.Agent({ keepAlive: true, proxyEnv: {} });
	for (const agent of [httpAgent, httpsAgent]) {
		agent.createConnection = (options, callback) => {
			const host = options.hostname || options.host!;
			connect({
				hostname: normalizeHost(host), host, port: String(options.port),
				protocol: agent === httpsAgent ? "https:" : "http:",
				servername: (options as https.RequestOptions).servername,
			}, callback as buildConnector.Callback);
			return undefined;
		};
	}
	// Pi replaces its global dispatcher after TUI /reload and /settings. Pass
	// ours explicitly so those operations cannot silently disable routing.
	const fetch: typeof globalThis.fetch = (input, init) => previous.fetch(input, { ...init, dispatcher } as typeof init);
	class WebSocket extends undici.WebSocket {
		constructor(url: string | URL, protocols?: ConstructorParameters<typeof undici.WebSocket>[1]) {
			super(url, { ...(typeof protocols === "object" && !Array.isArray(protocols) ? protocols : { protocols }), dispatcher });
		}
	}
	globalThis.fetch = fetch;
	globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
	http.globalAgent = httpAgent;
	https.globalAgent = httpsAgent;
	syncBuiltinESMExports();
	undici.setGlobalDispatcher(dispatcher);

	return {
		config: router.config,
		async stop() {
			if (globalThis.fetch === fetch) globalThis.fetch = previous.fetch;
			if (globalThis.WebSocket === WebSocket) globalThis.WebSocket = previous.WebSocket;
			if (http.globalAgent === httpAgent) http.globalAgent = previous.http;
			if (https.globalAgent === httpsAgent) https.globalAgent = previous.https;
			if (undici.getGlobalDispatcher() === dispatcher) undici.setGlobalDispatcher(previous.dispatcher);
			syncBuiltinESMExports();
			controller.abort();
			// Upgraded WebSocket sockets have left the HTTP pool, so close them too.
			for (const socket of sockets) socket.destroy();
			httpAgent.destroy();
			httpsAgent.destroy();
			await Promise.all([dispatcher.destroy(), upstream?.destroy()]);
		},
	};
}
