import { db } from "./connections";
import {
	appointments,
	consultants,
	conversations,
	leads,
	messages,
} from "./schema";

async function main() {
	console.log("🌱 Starting database seed...");

	// 1. Create consultants
	const [consultant1, consultant2, consultant3] = await db
		.insert(consultants)
		.values([
			{
				calendarId: "calendar-joao",
				email: "joao@consorcio.test",
				name: "João Silva",
			},
			{
				calendarId: "calendar-maria",
				email: "maria@consorcio.test",
				name: "Maria Souza",
			},
			{
				calendarId: "calendar-carlos",
				email: "carlos@consorcio.test",
				name: "Carlos Oliveira",
			},
		])
		.returning();

	console.log("✅ Consultants created");

	// 2. Create leads
	const [lead1, lead2] = await db
		.insert(leads)
		.values([
			{
				consortiumType: "Imóvel",
				name: "Davi Teste",
				objective: "Comprar um imóvel",
				phone: "5521999999999",
				status: "new",
			},
			{
				consortiumType: "Veículo",
				name: "Ana Teste",
				objective: "Comprar um carro",
				phone: "5521988888888",
				status: "qualified",
			},
		])
		.returning();

	console.log("✅ Leads created");

	// 3. Create conversations
	const [conversation1, conversation2] = await db
		.insert(conversations)
		.values([
			{
				leadId: lead1.id,
				status: "active",
			},
			{
				leadId: lead2.id,
				status: "closed",
			},
		])
		.returning();

	console.log("✅ Conversations created");

	// 4. Create messages
	await db.insert(messages).values([
		{
			content: "Olá, gostaria de saber como funciona o consórcio.",
			conversationId: conversation1.id,
			externalId: "test-message-001",
			role: "user",
		},
		{
			content:
				"Olá! Posso explicar como funciona e também verificar uma reunião com um consultor.",
			conversationId: conversation1.id,
			externalId: "test-message-002",
			role: "assistant",
		},
		{
			content: "Quero falar com um consultor.",
			conversationId: conversation2.id,
			externalId: "test-message-003",
			role: "user",
		},
	]);

	console.log("✅ Messages created");

	// 5. Create appointments
	const now = new Date();

	const start1 = new Date(now);
	start1.setDate(start1.getDate() + 1);
	start1.setHours(14, 0, 0, 0);

	const end1 = new Date(start1);
	end1.setMinutes(end1.getMinutes() + 30);

	const start2 = new Date(now);
	start2.setDate(start2.getDate() + 2);
	start2.setHours(10, 0, 0, 0);

	const end2 = new Date(start2);
	end2.setMinutes(end2.getMinutes() + 30);

	await db.insert(appointments).values([
		{
			consultantId: consultant1.id,
			endAt: end1,
			externalEventId: "test-event-001",
			leadId: lead1.id,
			startAt: start1,
			status: "scheduled",
		},
		{
			consultantId: consultant2.id,
			endAt: end2,
			externalEventId: "test-event-002",
			leadId: lead2.id,
			startAt: start2,
			status: "scheduled",
		},
		{
			consultantId: consultant3.id,
			endAt: end2,
			externalEventId: "test-event-003",
			leadId: lead2.id,
			startAt: start2,
			status: "scheduled",
		},
	]);

	console.log("✅ Appointments created");

	console.log("🎉 Database seed completed successfully!");
}

main().catch((error) => {
	console.error("❌ Database seed failed:");
	console.error(error);
	process.exit(1);
});
