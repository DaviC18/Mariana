import { defineRelations } from "drizzle-orm";

import {
	appointments,
	consultants,
	conversations,
	leads,
	messages,
} from "./index";

export const relations = defineRelations(
	{
		appointments,
		consultants,
		conversations,
		leads,
		messages,
	},
	(r) => ({
		appointments: {
			consultant: r.one.consultants({
				from: r.appointments.consultantId,
				to: r.consultants.id,
			}),
			lead: r.one.leads({
				from: r.appointments.leadId,
				to: r.leads.id,
			}),
		},

		consultants: {
			appointments: r.many.appointments(),
		},

		conversations: {
			lead: r.one.leads({
				from: r.conversations.leadId,
				to: r.leads.id,
			}),

			messages: r.many.messages(),
		},
		leads: {
			appointments: r.many.appointments(),
			conversations: r.many.conversations(),
		},

		messages: {
			conversation: r.one.conversations({
				from: r.messages.conversationId,
				to: r.conversations.id,
			}),
		},
	})
);
