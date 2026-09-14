/** biome-ignore-all lint/style/useFilenamingConvention: <> */

export interface WaitlistEntry {
	leadId: string;
	requestedAt: Date;
}

export function createAvailabilityWaitlist(
	entries: WaitlistEntry[]
): WaitlistEntry[] {
	return [...entries].sort(
		(left, right) => left.requestedAt.getTime() - right.requestedAt.getTime()
	);
}
