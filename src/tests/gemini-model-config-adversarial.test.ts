// Testes adversariais do tester para o Batch A de `2026-10-22-pkg-A`.
// Nenhum teste aqui abre rede ou banco: só funções puras e leitura de arquivo.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { ThinkingLevel } from "@google/genai";

import { buildModelRequestConfig, resolveModelName } from "../ai/agent";
import { env, envSchema, parseEnv } from "../env";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const AGENT_SOURCE = readFileSync(
	path.join(REPO_ROOT, "src", "ai", "agent.ts"),
	"utf8"
);
const ENV_EXAMPLE = readFileSync(path.join(REPO_ROOT, ".env.example"), "utf8");

// Qualquer literal de modelo no código-fonte do agente, não só `const MODEL =`.
const ANY_MODEL_LITERAL = /["'`]gemini-[0-9]/;
const ENV_EXAMPLE_GEMINI_NAMES = /^(GEMINI_[A-Z_]+)=/gm;
const MODEL_DEFAULT_LINE = /^GEMINI_MODEL=gemini-3\.5-flash-lite$/m;
const TEMPERATURE_DEFAULT_LINE = /^GEMINI_TEMPERATURE=0\.3$/m;
const THINKING_LEVEL_DEFAULT_LINE = /^GEMINI_THINKING_LEVEL=LOW$/m;
const MAX_OUTPUT_TOKENS_DEFAULT_LINE = /^GEMINI_MAX_OUTPUT_TOKENS=1024$/m;
const ENV_MODEL_READ = /env\.GEMINI_MODEL/;
const ENV_TEMPERATURE_READ = /env\.GEMINI_TEMPERATURE/;
const ENV_MAX_OUTPUT_TOKENS_READ = /env\.GEMINI_MAX_OUTPUT_TOKENS/;
const ENV_THINKING_LEVEL_READ = /env\.GEMINI_THINKING_LEVEL/;

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

const INVALID_VALUES: [keyof typeof envSchema.shape, string][] = [
	// Nome de modelo: a classe de erro de digitação do incidente N6.
	["GEMINI_MODEL", "gpt-4o"],
	["GEMINI_MODEL", "gemini-3.6-flahs-lite"],
	["GEMINI_MODEL", "gemini-flash-lite"],
	["GEMINI_MODEL", "gemini-3.5-ultra"],
	["GEMINI_MODEL", "GEMINI-3.5-FLASH-LITE"],
	["GEMINI_MODEL", " gemini-3.5-flash-lite"],
	["GEMINI_MODEL", "gemini-3.5-flash-lite "],
	["GEMINI_MODEL", "models/gemini-3.5-flash-lite"],
	// Temperatura fora de 0..2 ou não numérica.
	["GEMINI_TEMPERATURE", "-0.1"],
	["GEMINI_TEMPERATURE", "2.1"],
	["GEMINI_TEMPERATURE", "quente"],
	["GEMINI_TEMPERATURE", "0,3"],
	["GEMINI_TEMPERATURE", "NaN"],
	// Nível de raciocínio: só os quatro nomes, em maiúsculas.
	["GEMINI_THINKING_LEVEL", "ULTRA"],
	["GEMINI_THINKING_LEVEL", "low"],
	["GEMINI_THINKING_LEVEL", "Low"],
	["GEMINI_THINKING_LEVEL", "LOW "],
	["GEMINI_THINKING_LEVEL", "THINKING_LEVEL_UNSPECIFIED"],
	["GEMINI_THINKING_LEVEL", "1"],
	// Limite de saída: inteiro entre 128 e 8192.
	["GEMINI_MAX_OUTPUT_TOKENS", "10"],
	["GEMINI_MAX_OUTPUT_TOKENS", "127"],
	["GEMINI_MAX_OUTPUT_TOKENS", "8193"],
	["GEMINI_MAX_OUTPUT_TOKENS", "1024.5"],
	["GEMINI_MAX_OUTPUT_TOKENS", "-1024"],
	["GEMINI_MAX_OUTPUT_TOKENS", "muitos"],
];

test("um valor inválido do Gemini falha a validação, nunca cai no default", () => {
	for (const [name, value] of INVALID_VALUES) {
		assert.throws(
			() => parseEnv({ ...VALID_SOURCE, [name]: value }),
			(error: unknown) =>
				error instanceof Error && error.message.includes(name),
			`${name}="${value}" deveria falhar a validação nomeando a variável`
		);
	}
});

test("um valor válido fora do default é respeitado, não sobrescrito pelo default", () => {
	const parsed = parseEnv({
		...VALID_SOURCE,
		GEMINI_MAX_OUTPUT_TOKENS: "4096",
		GEMINI_MODEL: "gemini-2.5-pro",
		GEMINI_TEMPERATURE: "1.7",
		GEMINI_THINKING_LEVEL: "HIGH",
	});

	assert.equal(parsed.GEMINI_MODEL, "gemini-2.5-pro");
	assert.equal(parsed.GEMINI_TEMPERATURE, 1.7);
	assert.equal(parsed.GEMINI_THINKING_LEVEL, "HIGH");
	assert.equal(parsed.GEMINI_MAX_OUTPUT_TOKENS, 4096);
});

test("os defaults do dono são os do envSchema, com uma fonte sem as variáveis", () => {
	const parsed = parseEnv(VALID_SOURCE);

	assert.equal(parsed.GEMINI_MODEL, "gemini-3.5-flash-lite");
	assert.equal(parsed.GEMINI_TEMPERATURE, 0.3);
	assert.equal(parsed.GEMINI_THINKING_LEVEL, "LOW");
	assert.equal(parsed.GEMINI_MAX_OUTPUT_TOKENS, 1024);
});

test("o enum ThinkingLevel do SDK tem exatamente os mesmos textos do env", () => {
	// É o que sustenta `ThinkingLevel[env.GEMINI_THINKING_LEVEL]` e a
	// asserção `thinkingLevel === "LOW"`.
	for (const level of ["MINIMAL", "LOW", "MEDIUM", "HIGH"] as const) {
		assert.equal(ThinkingLevel[level], level);
		assert.equal(typeof ThinkingLevel[level], "string");
	}
});

test("a configuração espelha o ambiente ativo, não números literais", () => {
	const config = buildModelRequestConfig({ systemInstruction: "prompt" });

	assert.equal(config.temperature, env.GEMINI_TEMPERATURE);
	assert.equal(config.maxOutputTokens, env.GEMINI_MAX_OUTPUT_TOKENS);
	assert.equal(
		config.thinkingConfig?.thinkingLevel,
		ThinkingLevel[env.GEMINI_THINKING_LEVEL]
	);
	assert.equal(resolveModelName(), env.GEMINI_MODEL);
	// Gemini 3.5 rejeita thinkingBudget com erro de usuário: nunca enviar.
	assert.equal(config.thinkingConfig?.thinkingBudget, undefined);
});

test("nenhum nome de modelo literal volta ao agent.ts, de nenhuma forma", () => {
	// Mais forte que `const MODEL = "gemini-…"`: pega também um
	// `return "gemini-3.5-flash-lite"` dentro de resolveModelName.
	assert.equal(
		ANY_MODEL_LITERAL.test(AGENT_SOURCE),
		false,
		"src/ai/agent.ts voltou a ter um nome de modelo escrito no código"
	);
	assert.match(AGENT_SOURCE, ENV_MODEL_READ);
	assert.match(AGENT_SOURCE, ENV_TEMPERATURE_READ);
	assert.match(AGENT_SOURCE, ENV_MAX_OUTPUT_TOKENS_READ);
	assert.match(AGENT_SOURCE, ENV_THINKING_LEVEL_READ);
});

test("montar a configuração não abre conexão de rede nem de banco", () => {
	const originalConnect = net.Socket.prototype.connect;
	const originalFetch = globalThis.fetch;
	const attempts: string[] = [];

	net.Socket.prototype.connect = function connect() {
		attempts.push("net.Socket.connect");
		return this;
	};
	globalThis.fetch = (() => {
		attempts.push("fetch");
		return Promise.reject(new Error("rede bloqueada no teste"));
	}) as typeof fetch;

	try {
		buildModelRequestConfig({ systemInstruction: "prompt" });
		resolveModelName();
		parseEnv(VALID_SOURCE);
	} finally {
		net.Socket.prototype.connect = originalConnect;
		globalThis.fetch = originalFetch;
	}

	assert.deepEqual(attempts, []);
});

test(".env.example documenta as quatro variáveis com os defaults aprovados", () => {
	assert.match(ENV_EXAMPLE, MODEL_DEFAULT_LINE);
	assert.match(ENV_EXAMPLE, TEMPERATURE_DEFAULT_LINE);
	assert.match(ENV_EXAMPLE, THINKING_LEVEL_DEFAULT_LINE);
	assert.match(ENV_EXAMPLE, MAX_OUTPUT_TOKENS_DEFAULT_LINE);

	const documented = [...ENV_EXAMPLE.matchAll(ENV_EXAMPLE_GEMINI_NAMES)]
		.map((match) => match[1])
		.sort();
	const declared = Object.keys(envSchema.shape)
		.filter((key) => key.startsWith("GEMINI_"))
		.sort();

	assert.deepEqual(documented, declared);
});
