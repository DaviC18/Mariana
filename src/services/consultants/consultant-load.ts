/** biome-ignore-all lint/style/useFilenamingConvention: <> */

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

export function findMentorWithLowestLoad({
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
