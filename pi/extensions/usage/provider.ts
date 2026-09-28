export interface UsageItem {
	label: string;
	value: string;
	status?: string;
	remainingPercent?: number;
	resetsAt?: string;
}

export interface UsageProvider {
	id: string;
	provider: string;
	name: string;
	query(token: string, signal: AbortSignal): Promise<UsageItem[]>;
}

export async function getJson(url: string, token: string, signal: AbortSignal): Promise<unknown> {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal,
	});
	if (!response.ok) throw new Error(`Usage request failed: HTTP ${response.status}`);
	return response.json();
}

export function readNumber(value: unknown): number {
	if ((typeof value !== "number" && typeof value !== "string")
		|| (typeof value === "string" && !value.trim()) || !Number.isFinite(Number(value))) {
		throw new Error("Invalid number in usage response");
	}
	return Number(value);
}
