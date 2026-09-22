import { defineRelations } from "drizzle-orm";

import {
	appointments,
	consultants,
	conversations,
	googleCalendarConnections,
	leads,
	messages,
	schedulingSessions,
} from "./index";

export const relations = defineRelations(
	{
		appointments,
		consultants,
		conversations,
		googleCalendarConnections,
		leads,
		messages,
		schedulingSessions,
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
			schedulingSessions: r.many.schedulingSessions(),
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
			schedulingSessions: r.many.schedulingSessions(),
		},

		messages: {
			conversation: r.one.conversations({
				from: r.messages.conversationId,
				to: r.conversations.id,
			}),
		},

		schedulingSessions: {
			conversation: r.one.conversations({
				from: r.schedulingSessions.conversationId,
				to: r.conversations.id,
			}),
			lead: r.one.leads({
				from: r.schedulingSessions.leadId,
				to: r.leads.id,
			}),
		},
	})
);
