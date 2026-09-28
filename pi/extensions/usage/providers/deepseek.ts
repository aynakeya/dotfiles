import { getJson, readNumber, type UsageItem, type UsageProvider } from "../provider.ts";

interface BalanceResponse {
	is_available: boolean;
	balance_infos: { currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }[];
}

export default {
	id: "deepseek",
	provider: "deepseek",
	name: "DeepSeek",
	async query(token, signal) {
		const data = await getJson("https://api.deepseek.com/user/balance", token, signal) as BalanceResponse;
		if (typeof data?.is_available !== "boolean" || !Array.isArray(data.balance_infos) || !data.balance_infos.length) {
			throw new Error("Invalid DeepSeek balance response");
		}
		const items: UsageItem[] = [];
		for (const balance of data.balance_infos) {
			if (balance.currency !== "CNY" && balance.currency !== "USD") throw new Error("Unknown DeepSeek currency");
			for (const [field, label] of [["total_balance", "balance"], ["granted_balance", "granted"], ["topped_up_balance", "topped up"]] as const) {
				readNumber(balance[field]);
				const value = `${balance.currency} ${balance[field]}`;
				items.push({ label, value, status: field === "total_balance" ? value : undefined });
			}
		}
		if (!data.is_available) items.push({ label: "API access", value: "unavailable" });
		return items;
	},
} satisfies UsageProvider;
