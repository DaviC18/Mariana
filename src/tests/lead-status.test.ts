import assert from "node:assert/strict";
import test from "node:test";

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
