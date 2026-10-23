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
	// A resposta é JSON (reply + leadUpdate + evidenceUsed) e os tokens de
	// raciocínio são cobrados como saída: um limite apertado trunca o JSON.
	GEMINI_MAX_OUTPUT_TOKENS: z.coerce
		.number()
		.int()
		.min(128)
		.max(8192)
		.default(1024),
	GEMINI_MODEL: z
		.string()
		.min(1)
		.regex(
			/^gemini-[0-9]+(?:\.[0-9]+)?-(?:flash|flash-lite|pro)(?:-[a-z0-9.-]+)?$/,
			{
				message:
					"GEMINI_MODEL deve seguir o formato gemini-<versão>-<flash|flash-lite|pro>",
			}
		)
		.default("gemini-3.5-flash-lite"),
	GEMINI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
	// A partir do Gemini 3.5 o thinkingBudget é rejeitado pela API: a
	// profundidade de raciocínio se controla por thinkingLevel.
	GEMINI_THINKING_LEVEL: z
		.enum(["MINIMAL", "LOW", "MEDIUM", "HIGH"])
		.default("LOW"),
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
	// Bem abaixo do lease de 60s do outbox: o worker precisa ser liberado e
	// marcar o envio como incerto antes que o lease expire.
	WHATSAPP_SEND_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.min(1000)
		.max(45_000)
		.default(15_000),
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
		// Valor inválido falha na validação em vez de cair no default.
		GEMINI_MAX_OUTPUT_TOKENS: source.GEMINI_MAX_OUTPUT_TOKENS || undefined,
		// Só o modelo e o nível são comparados como texto, então espaços neles
		// devem falhar. Aqui o `trim` é obrigatório: `Number("   ")` é 0, que
		// passa por `min(0)` e viraria uma temperatura 0 silenciosa.
		GEMINI_MODEL: source.GEMINI_MODEL || undefined,
		GEMINI_TEMPERATURE: source.GEMINI_TEMPERATURE?.trim() || undefined,
		GEMINI_THINKING_LEVEL: source.GEMINI_THINKING_LEVEL || undefined,
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
		// Valor inválido falha na validação em vez de cair no default.
		WHATSAPP_SEND_TIMEOUT_MS: source.WHATSAPP_SEND_TIMEOUT_MS || undefined,
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
