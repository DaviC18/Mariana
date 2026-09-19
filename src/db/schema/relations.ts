import { defineRelations } from "drizzle-orm";

import {
	appointments,
	consultants,
	conversations,
	googleCalendarConnections,
	leads,
	messages,
} from "./index";

export const relations = defineRelations(
	{
		appointments,
		consultants,
		conversations,
		googleCalendarConnections,
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
			googleCalendarConnection: r.one.googleCalendarConnections({
				from: r.consultants.id,
				to: r.googleCalendarConnections.consultantId,
			}),
		},

		conversations: {
			lead: r.one.leads({
				from: r.conversations.leadId,
				to: r.leads.id,
			}),
			messages: r.many.messages(),
		},

		googleCalendarConnections: {
			consultant: r.one.consultants({
				from: r.googleCalendarConnections.consultantId,
				to: r.consultants.id,
			}),
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
