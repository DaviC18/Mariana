export const APPOINTMENT_STATUSES = [
	"pending_confirmation",
	"confirmed",
	"expired",
	"cancelled",
	"completed",
	"scheduled",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

// `scheduled` is kept only so records created before v1 still reserve a slot.
export const AGENDA_OCCUPYING_APPOINTMENT_STATUSES = [
	"pending_confirmation",
	"confirmed",
	"scheduled",
] as const;

export const CONFIRMED_APPOINTMENT_STATUSES = [
	"confirmed",
	"scheduled",
] as const;

export const APPOINTMENT_STATUS_TRANSITIONS: Record<
	AppointmentStatus,
	readonly AppointmentStatus[]
> = {
	cancelled: ["cancelled"],
	completed: ["completed"],
	confirmed: ["confirmed", "cancelled", "completed"],
	expired: ["expired"],
	pending_confirmation: [
		"pending_confirmation",
		"confirmed",
		"expired",
		"cancelled",
	],
	// No new appointment is created with this legacy status.
	scheduled: ["scheduled", "cancelled", "completed"],
};

export function isAppointmentStatus(value: string): value is AppointmentStatus {
	return APPOINTMENT_STATUSES.includes(value as AppointmentStatus);
}

export function occupiesAgenda(status: string): boolean {
	return AGENDA_OCCUPYING_APPOINTMENT_STATUSES.includes(
		status as (typeof AGENDA_OCCUPYING_APPOINTMENT_STATUSES)[number]
	);
}

export function canTransitionAppointmentStatus(
	currentStatus: string,
	nextStatus: string
): boolean {
	return (
		isAppointmentStatus(currentStatus) &&
		isAppointmentStatus(nextStatus) &&
		APPOINTMENT_STATUS_TRANSITIONS[currentStatus].includes(nextStatus)
	);
}

export function isConfirmedAppointmentStatus(
	status: string
): status is (typeof CONFIRMED_APPOINTMENT_STATUSES)[number] {
	return CONFIRMED_APPOINTMENT_STATUSES.includes(
		status as (typeof CONFIRMED_APPOINTMENT_STATUSES)[number]
	);
}
