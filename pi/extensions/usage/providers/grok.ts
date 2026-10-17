import { getJson, readNumber, type UsageProvider } from "../provider.ts";

interface CreditsResponse {
	config: {
		creditUsagePercent?: number;
		currentPeriod?: { type?: string; end?: string };
	};
}

export default {
	id: "grok",
	provider: "xai",
	name: "Grok",
	async query(token, signal) {
		const data = await getJson("https://cli-chat-proxy.grok.com/v1/billing?format=credits", token, signal, {
			"X-XAI-Token-Auth": "xai-grok-cli",
		}) as CreditsResponse;
		const period = data?.config?.currentPeriod;
		const label = period?.type === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly"
			: period?.type === "USAGE_PERIOD_TYPE_MONTHLY" ? "monthly" : "quota";
		const resetsAt = period?.end ? new Date(period.end).toISOString() : undefined;
		const percent = data?.config?.creditUsagePercent;
		// Grok's client treats omitted usage as zero; require a dated credits period, not an empty response.
		const used = readNumber(percent === undefined && label !== "quota" && resetsAt ? 0 : percent);
		if (used < 0 || used > 100) throw new Error("Invalid Grok usage percentage");
		const remainingPercent = 100 - used;
		const value = `${Math.round(remainingPercent)}% left`;
		return [{ label, value, status: `${label} ${value}`, remainingPercent, resetsAt }];
	},
} satisfies UsageProvider;
