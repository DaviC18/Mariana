/** biome-ignore-all assist/source/organizeImports: <> */
/** biome-ignore-all lint/correctness/noUndeclaredVariables: <> */
/** biome-ignore-all assist/source/useSortedKeys: <> */
/** biome-ignore-all lint/suspicious/useAwait: <> */
/** biome-ignore-all lint/correctness/noUnusedVariables: <> */
import fastify from "fastify";
import { env } from "./env";
import { loggerConfig, redactSensitiveQuery } from "./lib/logger";
import {
	serializerCompiler,
	validatorCompiler,
	type ZodTypeProvider,
} from "fastify-type-provider-zod";
import fastifyMultipart from "@fastify/multipart";
import { createAppointments } from "./routes/appointments/create-appointments";
import { getAppointments } from "./routes/appointments/get-appointments";
import { getIdAppointments } from "./routes/appointments/get-id-appointments";
import { getAppointmentAvailability } from "./routes/appointments/get-availability";

import { createConversations } from "./routes/conversations/create-conversations";
import { getIdConversations } from "./routes/conversations/get-id-conversations";

import { createLeads } from "./routes/leads/create-leads";
import { getIdLeads } from "./routes/leads/get-id-leads";
import { getLeads } from "./routes/leads/get-leads";

import { createMessages } from "./routes/messages/create-messages";
import { getConversationMessages } from "./routes/messages/get-conversation-messages";
import { getIdMessages } from "./routes/messages/get-id-messages";
import { getMessages } from "./routes/messages/get-messages";
import { getConversatios } from "./routes/conversations/get-conversations";
import { authGoogle } from "./routes/google-calendar/auth-google";
import { webhookWhatsApp } from "./routes/whatsapp/webhook-whatsapp";
import { googleAdsWebhookRoutes } from "./routes/google-ads/webhook-google-ads";
import { metaAdsWebhookRoutes } from "./routes/meta-ads/webhook-meta-ads";
import {
	startReliabilityWorkers,
	stopReliabilityWorkers,
} from "./services/reliability/background-workers";

const app = fastify({
	logger: loggerConfig,
}).withTypeProvider<ZodTypeProvider>();

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

app.addHook("onResponse", async (request, reply) => {
	app.log.info({
		method: request.method,
		url: redactSensitiveQuery(request.url),
		statusCode: reply.statusCode,
	});
});

app.register(fastifyMultipart);
app.register(webhookWhatsApp);
app.register(createLeads);
app.register(getIdLeads);
app.register(getLeads);
app.register(getConversatios);
app.register(getIdConversations);
app.register(createConversations);
app.register(createMessages);
app.register(getIdMessages);
app.register(getMessages);
app.register(getConversationMessages);
app.register(createAppointments);
app.register(getAppointmentAvailability);
app.register(getIdAppointments);
app.register(getAppointments);
app.register(authGoogle);
app.register(googleAdsWebhookRoutes);
app.register(metaAdsWebhookRoutes);

app.get("/", async (request) => {
	request.log.info("something");
	return "ok";
});

const host = "0.0.0.0";
const port = Number(env.PORT) || 3252;

let shuttingDown = false;

const shutdown = async (signal: string) => {
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;

	app.log.info({ event: "shutdown_started", signal });
	console.log(`[BOOT] Received ${signal}, shutting down...`);

	try {
		await stopReliabilityWorkers();
		await app.close();
		app.log.info({ event: "shutdown_complete", signal });
		process.exit(0);
	} catch (err) {
		app.log.error({ err, event: "shutdown_failed" });
		process.exit(1);
	}
};

process.on("SIGINT", () => {
	shutdown("SIGINT").catch(() => undefined);
});
process.on("SIGTERM", () => {
	shutdown("SIGTERM").catch(() => undefined);
});

const listen = async () => {
	try {
		const address = await app.listen({
			port,
			host,
		});
		app.log.info(`Server running at ${address}`);
		console.log(`[BOOT] Server running at ${address}`);

		if (env.RELIABILITY_WORKERS_ENABLED === "true") {
			const { started } = startReliabilityWorkers({ logger: app.log });
			app.log.info({ event: "reliability_workers_started", workers: started });
			console.log(`[BOOT] Reliability workers started: ${started.join(", ")}`);
		}
	} catch (err) {
		app.log.error(err);
		console.error("[BOOT] Failed to start server:", err);
		process.exit(1);
	}
};

listen();
