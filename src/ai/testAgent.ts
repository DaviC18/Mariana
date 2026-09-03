import { generateMarianaResponse } from "./agent";

async function main() {
	const response = await generateMarianaResponse({
		currentMessage: "Quero entender melhor como funciona.",
		lead: {
			consortiumType: "Imóveis",
			id: "lead-001",
			name: "João Silva",
			objective: "Comprar um imóvel",
			phone: "5521999999999",
			status: "qualifying",
		},
		messages: [
			{
				content: "Oi, quero comprar minha casa.",
				createdAt: new Date("2026-09-03T12:00:00Z"),
				role: "user",
			},
			{
				content:
					"Claro! Posso te ajudar. Você já tem uma faixa de valor em mente?",
				createdAt: new Date("2026-09-03T12:01:00Z"),
				role: "assistant",
			},
			{
				content: "Algo em torno de 300 mil.",
				createdAt: new Date("2026-09-03T12:02:00Z"),
				role: "user",
			},
		],
	});

	console.log("\nMariana:\n");
	console.log(response);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
