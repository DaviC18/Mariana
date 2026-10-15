import type { FastifyRequest } from "fastify";

import { env } from "../env";

const SENSITIVE_QUERY_KEY = /(token|secret|key|signature|password)$/i;
const SENSITIVE_QUERY_NAMES = new Set(["code", "state"]);
const QUERY_PARAM = /([?&])([^=&\s#?]+)=([^&\s#]*)/g;
const REDACTED = encodeURIComponent("[Redacted]");

function isSensitiveQueryName(rawName: string): boolean {
	let name = rawName;
	try {
		name = decodeURIComponent(rawName);
	} catch {
		// Nome malformado: avalia como veio.
	}
	return SENSITIVE_QUERY_KEY.test(name) || SENSITIVE_QUERY_NAMES.has(name);
}

/**
 * Mascara valores sensíveis de query string (verify tokens dos webhooks,
 * `code` do OAuth etc.) em URLs ou mensagens de log. Trabalha sobre o texto,
 * sem `new URL`, então nunca lança com caminhos malformados.
 */
export function redactSensitiveQuery(text: string): string {
	if (!text.includes("?")) {
		return text;
	}
	return text.replace(QUERY_PARAM, (match, separator: string, name: string) =>
		isSensitiveQueryName(name) ? `${separator}${name}=${REDACTED}` : match
	);
}

export const baseLoggerOptions = {
	// Mensagens em texto também carregam a URL crua, por exemplo o aviso
	// "Route GET:/x?... not found" do Fastify.
	hooks: {
		logMethod(
			this: unknown,
			args: unknown[],
			method: (...methodArgs: unknown[]) => void
		) {
			method.apply(
				this,
				args.map((arg) =>
					typeof arg === "string" ? redactSensitiveQuery(arg) : arg
				)
			);
		},
	},
	level: "info",

	redact: ["req.headers.authorization", "password", "token"],

	serializers: {
		req(request: FastifyRequest) {
			return {
				host: request.host,
				method: request.method,
				remoteAddress: request.ip,
				remotePort: request.socket?.remotePort,
				url: redactSensitiveQuery(request.url),
			};
		},
	},
};

export const loggerConfig = {
	...baseLoggerOptions,

	transport:
		env.NODE_ENV === "production"
			? undefined
			: {
					options: {
						colorize: true,
					},
					target: "pino-pretty",
				},
};
