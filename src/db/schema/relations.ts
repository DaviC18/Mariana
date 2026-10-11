import { defineRelations } from "drizzle-orm";

import {
	appointments,
	consultants,
	conversations,
	googleCalendarConnections,
	leads,
	messages,
	schedulingSessions,
	schedulingSlots,
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
		schedulingSlots,
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
			schedulingSlots: r.many.schedulingSlots(),
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
			slots: r.many.schedulingSlots(),
		},

		schedulingSlots: {
			consultant: r.one.consultants({
				from: r.schedulingSlots.consultantId,
				to: r.consultants.id,
			}),
			schedulingSession: r.one.schedulingSessions({
				from: r.schedulingSlots.schedulingSessionId,
				to: r.schedulingSessions.id,
			}),
		},
	})
);
