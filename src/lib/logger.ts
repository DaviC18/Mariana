import { env } from "../env";

export const loggerConfig = {
	level: "info",

	redact: ["req.headers.authorization", "password", "token"],

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
