import assert from "node:assert/strict";
import test from "node:test";
import {
	isAtLeast18,
	isLeadQualified,
} from "../services/leads/lead-qualification";
import {
	canTransitionLeadStatus,
	isLeadStatus,
} from "../services/leads/lead-status";
import { updateLeadFromAgent } from "../services/leads/update-lead-from-agent";

test("canTransitionLeadStatus aceita transições válidas", () => {
	assert.equal(canTransitionLeadStatus("new", "new"), true);
	assert.equal(canTransitionLeadStatus("new", "qualifying"), true);
	assert.equal(canTransitionLeadStatus("qualifying", "qualified"), true);
	assert.equal(canTransitionLeadStatus("qualified", "scheduled"), true);
	assert.equal(canTransitionLeadStatus("scheduled", "scheduled"), true);
});

test("canTransitionLeadStatus rejeita transições inválidas", () => {
	assert.equal(canTransitionLeadStatus("new", "scheduled"), false);
	assert.equal(canTransitionLeadStatus("qualifying", "scheduled"), false);
	assert.equal(canTransitionLeadStatus("qualified", "qualifying"), false);
	assert.equal(canTransitionLeadStatus("scheduled", "new"), false);
});

test("isLeadStatus reconhece valores permitidos", () => {
	assert.equal(isLeadStatus("new"), true);
	assert.equal(isLeadStatus("qualifying"), true);
	assert.equal(isLeadStatus("qualified"), true);
	assert.equal(isLeadStatus("scheduled"), true);
	assert.equal(isLeadStatus("banana"), false);
});

test("idade mínima de 18 anos é calculada pela data de nascimento", () => {
	const referenceDate = new Date("2026-09-16T00:00:00.000Z");

	assert.equal(isAtLeast18("2008-09-16", referenceDate), true);
	assert.equal(isAtLeast18("2008-09-17", referenceDate), false);
});

test("lead menor de idade não pode ser qualificado", () => {
	assert.equal(
		isLeadQualified({
			birthDate: "2010-01-01",
			consortiumType: "Veículo",
			currentSituation: "Uso carro antigo",
			interestedInConsultant: true,
			objective: "Comprar um carro",
			painPoint: "Quero reduzir custos",
		}),
		false
	);
});

test("updateLeadFromAgent rejeita data de nascimento menor de idade", async () => {
	await assert.rejects(
		() =>
			updateLeadFromAgent({
				currentStatus: "qualifying",
				leadId: "lead-underage",
				leadUpdate: {
					birthDate: new Date("2010-01-01"),
					status: "qualifying",
				},
			}),
		{ message: "Lead must be at least 18 years old" }
	);
});

test("updateLeadFromAgent rejeita agendamento sem confirmação de appointment", async () => {
	await assert.rejects(
		() =>
			updateLeadFromAgent({
				appointmentCreated: false,
				currentStatus: "qualified",
				leadId: "lead-123",
				leadUpdate: {
					consortiumType: "Imóvel",
					objective: "Comprar imóvel",
					status: "scheduled",
				},
			}),
		{
			message:
				"Lead cannot be scheduled without an explicit appointment confirmation",
		}
	);
});

test("updateLeadFromAgent preserva objective e consortiumType nulos e aplica status válido", async () => {
	let persisted: {
		leadId: string;
		values: {
			status: string;
			updatedAt: Date;
			consortiumType?: string;
			objective?: string;
		};
	} | null = null;

	const updated = await updateLeadFromAgent({
		appointmentCreated: true,
		currentStatus: "qualified",
		leadId: "lead-456",
		leadUpdate: {
			consortiumType: null,
			objective: null,
			status: "scheduled",
		},
		persistLead: ({ leadId, values }) => {
			persisted = { leadId, values };
			return Promise.resolve({ id: leadId });
		},
	});

	assert.deepEqual(updated, { id: "lead-456" });
	if (persisted === null) {
		throw new Error("Expected persisted lead state to be set");
	}
	const persistedLead = persisted as {
		leadId: string;
		values: {
			status: string;
			updatedAt: Date;
			consortiumType?: string;
			objective?: string;
		};
	};
	assert.equal(persistedLead.leadId, "lead-456");
	assert.equal(persistedLead.values.status, "scheduled");
	assert.ok(persistedLead.values.updatedAt instanceof Date);
	assert.equal("consortiumType" in persistedLead.values, false);
	assert.equal("objective" in persistedLead.values, false);
});

const validQualificationPayload = {
	consortiumType: "Veículo",
	currentSituation:
		"Tenho um carro usado e quero trocar por algo mais econômico",
	objective: "Comprar um carro",
	painPoint: "Vejo altos custos de manutenção e quero reduzir a conta",
	status: "qualifying",
} as const;

test("lead sem objective não pode ser qualified", () => {
	assert.equal(
		isLeadQualified({
			...validQualificationPayload,
			interestedInConsultant: true,
			objective: "",
		}),
		false
	);
});

test("lead sem consortiumType não pode ser qualified", () => {
	assert.equal(
		isLeadQualified({
			...validQualificationPayload,
			consortiumType: "",
			interestedInConsultant: true,
		}),
		false
	);
});

test("lead sem painPoint ou motivation não pode ser qualified", () => {
	assert.equal(
		isLeadQualified({
			...validQualificationPayload,
			interestedInConsultant: true,
			painPoint: "",
		}),
		false
	);
});

test("lead sem currentSituation não pode ser qualified", () => {
	assert.equal(
		isLeadQualified({
			...validQualificationPayload,
			currentSituation: "",
			interestedInConsultant: true,
		}),
		false
	);
});

test("lead sem interesse em consultor não pode ser qualified", () => {
	assert.equal(
		isLeadQualified({
			...validQualificationPayload,
			interestedInConsultant: false,
		}),
		false
	);
});

test("lead com todos os requisitos pode ser qualified", () => {
	assert.equal(
		isLeadQualified({
			...validQualificationPayload,
			interestedInConsultant: true,
		}),
		true
	);
});

test("updateLeadFromAgent rejeita qualified sem interesse explícito", async () => {
	const createQualificationAttempt = (
		interestedInConsultant: boolean | undefined
	) =>
		updateLeadFromAgent({
			currentStatus: "qualifying",
			leadId: "lead-explicit-interest",
			leadUpdate: {
				consortiumType: "Veículo",
				currentSituation: "Uso carro antigo",
				interestedInConsultant,
				objective: "Comprar um carro",
				painPoint: "Quero reduzir custos",
				status: "qualified",
			},
		});

	await Promise.all([
		assert.rejects(createQualificationAttempt(undefined), {
			message:
				"Lead cannot be qualified without objective, consortiumType, painPoint or motivation, currentSituation, and explicit interest in consultant",
		}),
		assert.rejects(createQualificationAttempt(false), {
			message:
				"Lead cannot be qualified without objective, consortiumType, painPoint or motivation, currentSituation, and explicit interest in consultant",
		}),
	]);
});

test("updateLeadFromAgent aceita qualified com interesse explícito e requisitos completos", async () => {
	await assert.doesNotReject(() =>
		updateLeadFromAgent({
			currentStatus: "qualifying",
			leadId: "lead-explicit-interest-true",
			leadUpdate: {
				consortiumType: "Veículo",
				currentSituation: "Uso carro antigo",
				interestedInConsultant: true,
				objective: "Comprar um carro",
				painPoint: "Quero reduzir custos",
				status: "qualified",
			},
			persistLead: ({ leadId }) => Promise.resolve({ id: leadId }),
		})
	);
});

test("qualificação combina dados existentes com dados novos", async () => {
	await assert.doesNotReject(() =>
		updateLeadFromAgent({
			currentStatus: "qualifying",
			existingLead: {
				consortiumType: "Veículo",
				objective: "Comprar um carro",
			},
			leadId: "lead-existing-core",
			leadUpdate: {
				currentSituation: "Uso carro antigo",
				interestedInConsultant: true,
				painPoint: "Quero reduzir custos",
				status: "qualified",
			},
			persistLead: ({ leadId }) => Promise.resolve({ id: leadId }),
		})
	);
});

test("qualificação preserva requisitos existentes ao receber null", async () => {
	let persistedValues: Record<string, unknown> | undefined;

	await updateLeadFromAgent({
		currentStatus: "qualifying",
		existingLead: {
			consortiumType: "Veículo",
			currentSituation: "Uso carro antigo",
			objective: "Comprar um carro",
			painPoint: "Quero reduzir custos",
		},
		leadId: "lead-preserve-existing",
		leadUpdate: {
			consortiumType: null,
			currentSituation: null,
			interestedInConsultant: true,
			objective: null,
			painPoint: null,
			status: "qualified",
		},
		persistLead: ({ leadId, values }) => {
			persistedValues = values;
			return Promise.resolve({ id: leadId });
		},
	});

	assert.equal("consortiumType" in (persistedValues ?? {}), false);
	assert.equal("currentSituation" in (persistedValues ?? {}), false);
	assert.equal("objective" in (persistedValues ?? {}), false);
	assert.equal("painPoint" in (persistedValues ?? {}), false);
});

test("painPoint e currentSituation existentes continuam válidos com dados complementares", async () => {
	await assert.doesNotReject(() =>
		updateLeadFromAgent({
			currentStatus: "qualifying",
			existingLead: {
				consortiumType: "Veículo",
				currentSituation: "Uso carro antigo",
				objective: "Comprar um carro",
				painPoint: "Quero reduzir custos",
			},
			leadId: "lead-existing-commercial-data",
			leadUpdate: {
				interestedInConsultant: true,
				status: "qualified",
			},
			persistLead: ({ leadId }) => Promise.resolve({ id: leadId }),
		})
	);
});

test("qualifiedAt é preenchido quando ocorre a promoção real", async () => {
	let persisted: { leadId: string; values: Record<string, unknown> } | null =
		null;

	await updateLeadFromAgent({
		appointmentCreated: false,
		currentStatus: "qualifying",
		interestedInConsultant: true,
		leadId: "lead-qualified-at",
		leadUpdate: {
			consortiumType: "Veículo",
			currentSituation: "Tenho um carro usado e quero trocar",
			objective: "Comprar um carro",
			painPoint: "Estou cansado dos altos custos",
			status: "qualified",
		},
		persistLead: ({ leadId, values }) => {
			persisted = { leadId, values };
			return Promise.resolve({ id: leadId });
		},
	});

	if (!persisted) {
		throw new Error("Expected persisted lead state to be set");
	}
	const persistedLead = persisted as {
		leadId: string;
		values: {
			qualifiedAt?: Date;
			status?: string;
		};
	};
	assert.ok(persistedLead.values.qualifiedAt instanceof Date);
	assert.equal(persistedLead.values.status, "qualified");
});

test("qualifiedAt não é sobrescrito desnecessariamente", async () => {
	let persisted: { leadId: string; values: Record<string, unknown> } | null =
		null;
	const existingQualifiedAt = new Date("2024-01-01T00:00:00.000Z");

	await updateLeadFromAgent({
		appointmentCreated: false,
		currentStatus: "qualified",
		interestedInConsultant: true,
		leadId: "lead-qualified-preserve",
		leadUpdate: {
			consortiumType: "Veículo",
			currentSituation: "Tenho um carro usado e quero trocar",
			objective: "Comprar um carro",
			painPoint: "Estou cansado dos altos custos",
			status: "qualified",
		},
		persistLead: ({ leadId, values }) => {
			persisted = { leadId, values };
			return Promise.resolve({ id: leadId });
		},
		qualifiedAt: existingQualifiedAt,
	});

	if (!persisted) {
		throw new Error("Expected persisted lead state to be set");
	}
	const persistedLead = persisted as {
		leadId: string;
		values: {
			qualifiedAt?: Date;
		};
	};
	assert.equal(persistedLead.values.qualifiedAt, existingQualifiedAt);
});

test("campos opcionais podem permanecer null quando a motivação principal for informado", () => {
	assert.equal(
		isLeadQualified({
			consortiumType: "Veículo",
			currentSituation: "Uso carro antigo",
			interestedInConsultant: true,
			motivation: "Quero reduzir custos",
			objective: "Comprar um carro",
		}),
		true
	);
	assert.equal(
		isLeadQualified({
			consortiumType: "Veículo",
			currentSituation: "Uso carro antigo",
			interestedInConsultant: true,
			objective: "Comprar um carro",
			painPoint: "Quero reduzir custos",
		}),
		true
	);
});

test("urgency inválida é rejeitada", async () => {
	await assert.rejects(
		() =>
			updateLeadFromAgent({
				appointmentCreated: false,
				currentStatus: "qualifying",
				interestedInConsultant: true,
				leadId: "lead-urgency",
				leadUpdate: {
					consortiumType: "Veículo",
					currentSituation: "Uso carro antigo",
					objective: "Comprar um carro",
					painPoint: "Quero reduzir custos",
					status: "qualified",
					urgency: "invalid" as never,
				},
			}),
		{ message: "Invalid value: invalid" }
	);
});

test("commercialApproach inválida é rejeitada", async () => {
	await assert.rejects(
		() =>
			updateLeadFromAgent({
				appointmentCreated: false,
				currentStatus: "qualifying",
				interestedInConsultant: true,
				leadId: "lead-approach",
				leadUpdate: {
					commercialApproach: "invalid" as never,
					consortiumType: "Veículo",
					currentSituation: "Uso carro antigo",
					objective: "Comprar um carro",
					painPoint: "Quero reduzir custos",
					status: "qualified",
				},
			}),
		{ message: "Invalid value: invalid" }
	);
});
