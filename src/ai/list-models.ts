import { ai } from "./client";

async function main() {
	const pager = await ai.models.list();

	for await (const model of pager) {
		console.log(model.name);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
