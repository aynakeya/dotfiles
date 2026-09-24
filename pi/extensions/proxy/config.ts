import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { domainToASCII } from "node:url";

export type Action = "proxy" | "direct";
export type Mode = "global" | "rule" | "direct";
export interface Group {
	name: string;
	action: Action;
	matches: string[];
}
export interface Config {
	mode: Mode;
	proxyUrl: string;
	fallback: Action;
	groups: Group[];
}
export const DEFAULT_CONFIG: Config = { mode: "direct", proxyUrl: "", fallback: "direct", groups: [] };

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
	for (const key of Object.keys(value)) {
		if (!keys.includes(key)) throw new Error(`${label}: unknown field "${key}"`);
	}
	return value as Record<string, unknown>;
}

function action(value: unknown, label: string): Action {
	if (value !== "proxy" && value !== "direct") throw new Error(`${label}: expected proxy or direct`);
	return value;
}

function strings(value: unknown, label: string): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
		throw new Error(`${label}: expected an array of non-empty strings`);
	}
	return value.map((v: string) => v.trim());
}

export function normalizeHost(host: string): string {
	return host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function hostPattern(value: string): string {
	const wildcard = value.startsWith("*.");
	const host = normalizeHost(wildcard ? value.slice(2) : value);
	const ascii = domainToASCII(host);
	if (!ascii || !/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(ascii) || (wildcard && isIP(ascii))) {
		throw new Error(`Invalid host pattern: ${value}. Use a hostname, *.example.com or an IP range in CIDR notation.`);
	}
	return wildcard ? `*.${ascii}` : ascii;
}

function subnets(cidrs: string[]): BlockList {
	const list = new BlockList();
	for (const cidr of cidrs) {
		const parts = cidr.split("/");
		const family = isIP(parts[0]);
		const prefix = Number(parts[1]);
		if (parts.length !== 2 || !family || !/^\d+$/.test(parts[1]) || prefix > (family === 4 ? 32 : 128)) {
			throw new Error(`Invalid CIDR: ${cidr}`);
		}
		list.addSubnet(parts[0], prefix, family === 4 ? "ipv4" : "ipv6");
	}
	return list;
}

export class Router {
	readonly config: Config;
	private groups: { group: Group; hosts: string[]; ranges: BlockList | undefined }[];

	constructor(value: unknown) {
		const raw = object(value, ["mode", "proxyUrl", "fallback", "groups"], "proxy config");
		if (raw.mode !== "global" && raw.mode !== "rule" && raw.mode !== "direct") {
			throw new Error("mode: expected global, rule or direct");
		}
		if (typeof raw.proxyUrl !== "string") throw new Error("proxyUrl: expected a string");
		const proxyUrl = raw.proxyUrl.trim();
		if (proxyUrl) {
			let url: URL;
			try { url = new URL(proxyUrl); } catch { throw new Error("proxyUrl: invalid URL"); }
			if (!["http:", "https:"].includes(url.protocol)
				|| !url.hostname || url.port === "0" || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
				throw new Error("proxyUrl: use an HTTP or HTTPS proxy URL without a path, query or fragment");
			}
			try { decodeURIComponent(url.username); decodeURIComponent(url.password); }
			catch { throw new Error("proxyUrl: invalid credential encoding"); }
		}
		if (!Array.isArray(raw.groups)) throw new Error("groups: expected an array");
		const names = new Set<string>();
		this.groups = raw.groups.map((value, index) => {
			const g = object(value, ["name", "action", "matches"], `groups[${index}]`);
			if (typeof g.name !== "string" || !g.name.trim() || names.has(g.name.trim())) {
				throw new Error(`groups[${index}]: name must be non-empty and unique`);
			}
			const name = g.name.trim();
			names.add(name);
			const group: Group = {
				name, action: action(g.action, `${name}.action`),
				matches: strings(g.matches, `${name}.matches`).map((v) => v.includes("/") ? v : hostPattern(v)),
			};
			if (!group.matches.length) throw new Error(`${name}.matches: add at least one host or CIDR`);
			const cidrs = group.matches.filter((v) => v.includes("/"));
			return { group, hosts: group.matches.filter((v) => !v.includes("/")), ranges: cidrs.length ? subnets(cidrs) : undefined };
		});
		this.config = { mode: raw.mode, proxyUrl, fallback: action(raw.fallback, "fallback"), groups: this.groups.map((g) => g.group) };
		if (!proxyUrl && (raw.mode === "global" || (raw.mode === "rule"
			&& (this.config.fallback === "proxy" || this.config.groups.some((g) => g.action === "proxy"))))) {
			throw new Error("Set proxyUrl before enabling proxy routing (/proxy set)");
		}
	}

	async route(hostname: string): Promise<{ action: Action; addresses?: LookupAddress[] }> {
		if (this.config.mode !== "rule") return { action: this.config.mode === "global" ? "proxy" : "direct" };
		const host = normalizeHost(hostname);
		const family = isIP(host);
		let addresses: LookupAddress[] | undefined = family ? [{ address: host, family }] : undefined;
		for (const { group, hosts, ranges } of this.groups) {
			if (hosts.some((pattern) => pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern)) {
				return { action: group.action, addresses };
			}
			if (ranges) {
				// Resolve only when an IP rule needs it. DNS failure is an error, not a silent fallback.
				addresses ??= await lookup(host, { all: true });
				const matching = addresses.filter((ip) => ranges.check(ip.address, ip.family === 4 ? "ipv4" : "ipv6"));
				if (matching.length) return { action: group.action, addresses: matching };
			}
		}
		return { action: this.config.fallback, addresses };
	}
}

export function readConfigText(path: string): string {
	try { return readFileSync(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
	}
}

export function loadRouter(path: string): Router {
	return new Router(JSON.parse(readConfigText(path)));
}

export function saveConfig(path: string, config: Config): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}
