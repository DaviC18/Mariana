import { generateMarianaResponse } from "./agente";

async function main() {
	const response = await generateMarianaResponse({
		message: "Oi, quero saber sobre consórcio de imóvel.",
	});

	console.log("\nMariana:\n");
	console.log(response);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
