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

const envSchema = z.object({
	DATABASE_URL: z
		.string()
		.min(1)
		.url()
		.refine((v) => v.startsWith("postgresql://"), {
			message: "DATABSE_URL It should start with postgresql://",
		}),
	GEMINI_API_KEY: z.string().min(1),
	GOOGLE_ACCOUNT_EMAIL: z.string().email().min(1),
	GOOGLE_CLIENT_ID: z.string().min(1),
	GOOGLE_CLIENT_SECRET: z.string().min(1),
	GOOGLE_REDIRECT_URI: z.string().min(1),
	MESSAGE_DEBOUNCE_MS: z.coerce.number().int().positive().default(15_000),
	NODE_ENV: z
		.enum(["development", "production", "test"])
		.default("development"),
	PORT: z.coerce.number().default(3252),
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

export const env = envSchema.parse({
	DATABASE_URL: process.env.DATABASE_URL,
	GEMINI_API_KEY: process.env.GEMINI_API_KEY,
	GOOGLE_ACCOUNT_EMAIL: process.env.GOOGLE_ACCOUNT_EMAIL,
	GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
	GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
	GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
	MESSAGE_DEBOUNCE_MS: parseIntegerEnv(process.env.MESSAGE_DEBOUNCE_MS, 15_000),
	NODE_ENV: process.env.NODE_ENV,
	PORT: parseIntegerEnv(process.env.PORT, 3252),
	SCHEDULE_CONFIRMATION_MINUTES: parseIntegerEnv(
		process.env.SCHEDULE_CONFIRMATION_MINUTES,
		60
	),
	WHATSAPP_ACCESS_TOKEN: process.env.WHATSAPP_ACCESS_TOKEN,
	WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
	WHATSAPP_GRAPH_API_VERSION: process.env.WHATSAPP_GRAPH_API_VERSION,
	WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID,
	WHATSAPP_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN,
	WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID,
});
