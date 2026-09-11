export const LEAD_STATUSES = [
	"new",
	"qualifying",
	"qualified",
	"scheduled",
] as const;

export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_TRANSITIONS: Record<
	LeadStatus,
	readonly LeadStatus[]
> = {
	new: ["new", "qualifying"],
	qualified: ["qualified", "scheduled"],
	qualifying: ["qualifying", "qualified"],
	scheduled: ["scheduled"],
} as const;

export function isLeadStatus(value: string): value is LeadStatus {
	return LEAD_STATUSES.includes(value as LeadStatus);
}

export function canTransitionLeadStatus(
	currentStatus: string,
	nextStatus: string
): boolean {
	if (!(isLeadStatus(currentStatus) && isLeadStatus(nextStatus))) {
		return false;
	}

	return LEAD_STATUS_TRANSITIONS[currentStatus].includes(nextStatus);
}
