/** biome-ignore-all assist/source/organizeImports: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
import fastify from "fastify";
import { env } from "./env";
import { loggerConfig } from "./lib/logger";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import fastifyMultipart from "@fastify/multipart";
import { createLeads } from "./routes/leads/createLeads";
import { getLeads } from "./routes/leads/getLeads";

const app = fastify({
	logger: loggerConfig,
}).withTypeProvider<ZodTypeProvider>();

app.addHook("onResponse", async (request, reply) => {
	app.log.info({
		method: request.method,
		url: request.url,
		statusCode: reply.statusCode,
	});
});

app.register(fastifyMultipart);
app.register(createLeads);
app.register(getLeads);

app.get("/", async (request) => {
	request.log.info("something");
	return "ok";
});

const host = "0.0.0.0";
const port = Number(env.PORT) || 3252;

const listen = async () => {
	try {
		const address = await app.listen({
			port,
			host,
		});
		app.log.info(`Server running at ${address}`);
		console.log(`[BOOT] Server running at ${address}`);
	} catch (err) {
		app.log.error(err);
		console.error("[BOOT] Failed to start server:", err);
		process.exit(1);
	}
};

listen();
