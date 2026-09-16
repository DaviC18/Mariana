export const CONFIRMED_APPOINTMENT_STATUSES = [
	"confirmed",
	"scheduled",
] as const;

export function isConfirmedAppointmentStatus(
	status: string
): status is (typeof CONFIRMED_APPOINTMENT_STATUSES)[number] {
	return CONFIRMED_APPOINTMENT_STATUSES.includes(
		status as (typeof CONFIRMED_APPOINTMENT_STATUSES)[number]
	);
}
