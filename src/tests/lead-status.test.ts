import assert from "node:assert/strict";
import test from "node:test";
import { isLeadQualified } from "../services/leads/lead-qualification";
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
