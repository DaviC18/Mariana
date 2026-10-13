import "dotenv/config";
import z from "zod";

const parseIntegerEnv = (value: string | undefined, fallback: number) => {
	if (value === undefined || value === "") {
		return fallback;
	}

	const normalized = value.replace(/_/g, "");
	const parsed = Number(normalized);

	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	return parsed;
};

export const envSchema = z.object({
	AUTONOMOUS_TASK_POLL_MS: z.coerce.number().int().positive().default(2000),
	DATABASE_URL: z
		.string()
		.min(1)
		.url()
		.refine((v) => v.startsWith("postgresql://"), {
			message: "DATABASE_URL should start with postgresql://",
		}),
	GEMINI_API_KEY: z.string().min(1),
	GOOGLE_ACCOUNT_EMAIL: z.string().email().min(1),
	GOOGLE_ADS_WEBHOOK_KEY: z.string().min(1),
	GOOGLE_CLIENT_ID: z.string().min(1),
	GOOGLE_CLIENT_SECRET: z.string().min(1),
	GOOGLE_REDIRECT_URI: z.string().min(1),
	MESSAGE_DEBOUNCE_MS: z.coerce.number().int().positive().default(15_000),
	META_ADS_APP_SECRET: z.string().min(1),
	META_ADS_GRAPH_API_VERSION: z.string().min(1),
	META_ADS_VERIFY_TOKEN: z.string().min(1),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	OUTBOUND_MESSAGE_POLL_MS: z.coerce.number().int().positive().default(2000),
	PORT: z.coerce.number().default(3252),
	RELIABILITY_WORKERS_ENABLED: z.enum(["true", "false"]).default("true"),
	SCHEDULE_CONFIRMATION_MINUTES: z.coerce
		.number()
		.int()
		.min(30)
		.max(60)
		.default(60),
	WHATSAPP_ACCESS_TOKEN: z.string().min(1),
	WHATSAPP_APP_SECRET: z.string().min(1),
	WHATSAPP_GRAPH_API_VERSION: z.string().min(1),
	WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),
	WHATSAPP_VERIFY_TOKEN: z.string().min(1),
	WHATSAPP_WABA_ID: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function buildEnvInput(source: NodeJS.ProcessEnv) {
	return {
		AUTONOMOUS_TASK_POLL_MS: parseIntegerEnv(
			source.AUTONOMOUS_TASK_POLL_MS,
			2000
		),
		DATABASE_URL: source.DATABASE_URL,
		GEMINI_API_KEY: source.GEMINI_API_KEY,
		GOOGLE_ACCOUNT_EMAIL: source.GOOGLE_ACCOUNT_EMAIL,
		GOOGLE_ADS_WEBHOOK_KEY: source.GOOGLE_ADS_WEBHOOK_KEY,
		GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID,
		GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET,
		GOOGLE_REDIRECT_URI: source.GOOGLE_REDIRECT_URI,
		MESSAGE_DEBOUNCE_MS: parseIntegerEnv(source.MESSAGE_DEBOUNCE_MS, 15_000),
		META_ADS_APP_SECRET: source.META_ADS_APP_SECRET,
		META_ADS_GRAPH_API_VERSION: source.META_ADS_GRAPH_API_VERSION,
		META_ADS_VERIFY_TOKEN: source.META_ADS_VERIFY_TOKEN,
		NODE_ENV: source.NODE_ENV,
		OUTBOUND_MESSAGE_POLL_MS: parseIntegerEnv(
			source.OUTBOUND_MESSAGE_POLL_MS,
			2000
		),
		PORT: parseIntegerEnv(source.PORT, 3252),
		RELIABILITY_WORKERS_ENABLED: source.RELIABILITY_WORKERS_ENABLED,
		SCHEDULE_CONFIRMATION_MINUTES: parseIntegerEnv(
			source.SCHEDULE_CONFIRMATION_MINUTES,
			60
		),
		WHATSAPP_ACCESS_TOKEN: source.WHATSAPP_ACCESS_TOKEN,
		WHATSAPP_APP_SECRET: source.WHATSAPP_APP_SECRET,
		WHATSAPP_GRAPH_API_VERSION: source.WHATSAPP_GRAPH_API_VERSION,
		WHATSAPP_PHONE_NUMBER_ID: source.WHATSAPP_PHONE_NUMBER_ID,
		WHATSAPP_VERIFY_TOKEN: source.WHATSAPP_VERIFY_TOKEN,
		WHATSAPP_WABA_ID: source.WHATSAPP_WABA_ID,
	};
}

export function parseEnv(source: NodeJS.ProcessEnv): Env {
	const result = envSchema.safeParse(buildEnvInput(source));

	if (!result.success) {
		const issues = result.error.issues
			.map(
				(issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`
			)
			.join("\n");

		throw new Error(`Invalid environment configuration:\n${issues}`);
	}

	return result.data;
}

export const env = parseEnv(process.env);
