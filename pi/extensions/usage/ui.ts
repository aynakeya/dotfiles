import type { UsageItem } from "./provider.ts";

export function formatStatus(items: UsageItem[]): string {
	return items.map((item) => item.status).filter(Boolean).join(" · ");
}

export function formatDetails(items: UsageItem[]): string {
	const width = Math.max(...items.map((item) => item.label.length));
	return items.map((item) => {
		let bar = "";
		if (item.remainingPercent !== undefined) {
			const filled = Math.round(Math.max(0, Math.min(100, item.remainingPercent)) / 5);
			bar = `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] `;
		}
		let reset = "";
		if (item.resetsAt) {
			const date = new Date(item.resetsAt);
			const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
			const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
			reset = ` (resets ${time} on ${day})`;
		}
		return `${`${item.label}:`.padEnd(width + 2)}${bar}${item.value}${reset}`;
	}).join("\n");
}
