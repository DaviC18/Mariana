import assert from "node:assert/strict";
import test from "node:test";

import { envSchema, parseEnv } from "../env";

const MISSING_GEMINI_ERROR =
	/Invalid environment configuration[\s\S]*GEMINI_API_KEY/;
const NON_POSTGRES_DATABASE_URL_ERROR =
	/DATABASE_URL should start with postgresql:\/\//;
const SCHEDULE_CONFIRMATION_ERROR = /SCHEDULE_CONFIRMATION_MINUTES/;

const VALID_SOURCE = {
	DATABASE_URL: "postgresql://user:password@localhost:5432/mariana",
	GEMINI_API_KEY: "gemini-api-key",
	GOOGLE_ACCOUNT_EMAIL: "consultant@example.com",
	GOOGLE_ADS_WEBHOOK_KEY: "google-ads-webhook-key",
	GOOGLE_CLIENT_ID: "google-client-id",
	GOOGLE_CLIENT_SECRET: "google-client-secret",
	GOOGLE_REDIRECT_URI: "https://example.com/auth/google/callback",
	META_ADS_APP_SECRET: "meta-ads-app-secret",
	META_ADS_GRAPH_API_VERSION: "v23.0",
	META_ADS_VERIFY_TOKEN: "meta-ads-verify-token",
	WHATSAPP_ACCESS_TOKEN: "whatsapp-access-token",
	WHATSAPP_APP_SECRET: "whatsapp-app-secret",
	WHATSAPP_GRAPH_API_VERSION: "v23.0",
	WHATSAPP_PHONE_NUMBER_ID: "whatsapp-phone-number-id",
	WHATSAPP_VERIFY_TOKEN: "whatsapp-verify-token",
	WHATSAPP_WABA_ID: "whatsapp-waba-id",
} as NodeJS.ProcessEnv;

test("parseEnv aceita uma configuração válida e aplica os defaults", () => {
	const parsed = parseEnv(VALID_SOURCE);

	assert.equal(parsed.NODE_ENV, "development");
	assert.equal(parsed.PORT, 3252);
	assert.equal(parsed.MESSAGE_DEBOUNCE_MS, 15_000);
	assert.equal(parsed.SCHEDULE_CONFIRMATION_MINUTES, 60);
	assert.equal(
		parsed.DATABASE_URL,
		"postgresql://user:password@localhost:5432/mariana"
	);
});

test("parseEnv lança erro acionável quando uma variável obrigatória está ausente", () => {
	assert.throws(
		() => parseEnv({ ...VALID_SOURCE, GEMINI_API_KEY: undefined }),
		MISSING_GEMINI_ERROR
	);
});

test("parseEnv rejeita DATABASE_URL que não seja postgresql://", () => {
	assert.throws(
		() =>
			parseEnv({
				...VALID_SOURCE,
				DATABASE_URL: "mysql://user:password@localhost:3306/mariana",
			}),
		NON_POSTGRES_DATABASE_URL_ERROR
	);
});

test("parseEnv rejeita SCHEDULE_CONFIRMATION_MINUTES fora do intervalo permitido", () => {
	assert.throws(
		() =>
			parseEnv({
				...VALID_SOURCE,
				SCHEDULE_CONFIRMATION_MINUTES: "10",
			}),
		SCHEDULE_CONFIRMATION_ERROR
	);
});

test("envSchema não marca META_ADS_ACCESS_TOKEN como obrigatório", () => {
	assert.equal(Object.hasOwn(envSchema.shape, "META_ADS_ACCESS_TOKEN"), false);
});
