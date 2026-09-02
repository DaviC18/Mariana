/** biome-ignore-all assist/source/organizeImports: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
import fastify from "fastify";
import { env } from "./env";
import { loggerConfig } from "./lib/logger";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";
import fastifyMultipart from "@fastify/multipart";
import { createLeads } from "./routes/leads/createLeads";
import { getIdLeads } from "./routes/leads/getIdLeads";
import { getLeads } from "./routes/leads/getLeads";
import { getConversatios } from "./routes/conversations/getConversations";
import { getIdConversations } from "./routes/conversations/getIdConversations";
import { createConversations } from "./routes/conversations/createConversations";

const app = fastify({
	logger: loggerConfig,
}).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.addHook("onResponse", async (request, reply) => {
	app.log.info({
		method: request.method,
		url: request.url,
		statusCode: reply.statusCode,
	});
});

app.register(fastifyMultipart);
app.register(createLeads);
app.register(getIdLeads);
app.register(getLeads);
app.register(getConversatios);
app.register(getIdConversations);
app.register(createConversations);

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
