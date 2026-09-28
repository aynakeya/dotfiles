import { getJson, readNumber, type UsageItem, type UsageProvider } from "../provider.ts";

interface QuotaResponse {
	usages: Record<string, { used_ratio: number; reset_time?: string } | undefined>;
}

export default {
	id: "kimi",
	provider: "kimi-coding",
	name: "Kimi",
	async query(token, signal) {
		const data = await getJson("https://api.kimi.com/coding/v1/usages", token, signal) as QuotaResponse;
		if (!data?.usages || typeof data.usages !== "object") throw new Error("Invalid Kimi quota response");
		const items: UsageItem[] = [];
		for (const [key, label] of [["limit_5h", "5 hour"], ["limit_7d", "weekly"]]) {
			const quota = data.usages[key];
			if (!quota) continue;
			const remainingPercent = (1 - readNumber(quota.used_ratio)) * 100;
			const value = `${Math.round(remainingPercent)}% left`;
			items.push({
				label, value, status: `${label} ${value}`, remainingPercent,
				resetsAt: quota.reset_time ? new Date(quota.reset_time).toISOString() : undefined,
			});
		}
		if (!items.length) throw new Error("No supported Kimi quota windows returned");
		return items;
	},
} satisfies UsageProvider;
