/** biome-ignore-all lint/style/useFilenamingConvention: <> */

import { occupiesAgenda } from "../appointments/appointment-status";

export interface ConsultantCandidate {
	active: boolean;
	id: string;
	name: string;
}

export interface FindConsultantLoadInput {
	activeLoads: Record<string, number>;
	compatibility?: (consultant: ConsultantCandidate) => boolean;
	consultants: ConsultantCandidate[];
	random?: () => number;
}

export function findConsultantWithLowestLoad({
	activeLoads,
	compatibility = () => true,
	consultants,
	random = Math.random,
}: FindConsultantLoadInput): ConsultantCandidate | undefined {
	const eligible = consultants.filter(
		(consultant) => consultant.active && compatibility(consultant)
	);

	if (eligible.length === 0) {
		return undefined;
	}

	const minimumLoad = Math.min(
		...eligible.map((consultant) => activeLoads[consultant.id] ?? 0)
	);
	const tied = eligible.filter(
		(consultant) => (activeLoads[consultant.id] ?? 0) === minimumLoad
	);

	if (tied.length === 1) {
		return tied[0];
	}

	return tied[Math.floor(random() * tied.length)] ?? tied[0];
}

export function buildConsultantLoads(
	appointments: Array<{ consultantId: string; status: string }>
): Record<string, number> {
	return appointments.reduce<Record<string, number>>((loads, appointment) => {
		if (occupiesAgenda(appointment.status)) {
			loads[appointment.consultantId] =
				(loads[appointment.consultantId] ?? 0) + 1;
		}

		return loads;
	}, {});
}

// Compatibility with the name used by the v1 tests.
export const findMentorWithLowestLoad = findConsultantWithLowestLoad;
