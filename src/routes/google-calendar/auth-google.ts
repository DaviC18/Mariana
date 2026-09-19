import { randomBytes } from "node:crypto";
import type { FastifyPluginCallback } from "fastify";

import {
	GOOGLE_CALENDAR_SCOPES,
	googleOAuth2Client,
} from "../../integrations/google-calendar/oauth";

export const authGoogle: FastifyPluginCallback = (app, _options, done) => {
	app.get("/auth/google", (_request, reply) => {
		const state = randomBytes(32).toString("hex");

		const authorizationUrl = googleOAuth2Client.generateAuthUrl({
			access_type: "offline",
			include_granted_scopes: true,
			scope: GOOGLE_CALENDAR_SCOPES,
			state,
		});

		return reply.redirect(authorizationUrl);
	});

	app.get("/auth/google/callback", async (request, reply) => {
		const { code, error } = request.query as {
			code?: string;
			error?: string;
		};

		if (error) {
			return reply.status(400).send({
				error: "google_oauth_denied",
				message: error,
			});
		}

		if (!code) {
			return reply.status(400).send({
				error: "google_oauth_missing_code",
			});
		}

		const { tokens } = await googleOAuth2Client.getToken(code);

		googleOAuth2Client.setCredentials(tokens);

		return reply.send({
			hasAccessToken: Boolean(tokens.access_token),
			hasRefreshToken: Boolean(tokens.refresh_token),
			message: "Google Calendar autorizado com sucesso.",
			success: true,
		});
	});

	done();
};
