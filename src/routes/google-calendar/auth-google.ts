import { randomBytes } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";

import {
	GOOGLE_CALENDAR_SCOPES,
	googleOAuth2Client,
} from "../../integrations/google-calendar/oauth";

export const authGoogle: FastifyPluginAsync = async (app) => {
	app.get("/auth/google", async (_request, reply) => {
		const state = randomBytes(32).toString("hex");

		const authorizationUrl = googleOAuth2Client.generateAuthUrl({
			access_type: "offline",
			include_granted_scopes: true,
			scope: GOOGLE_CALENDAR_SCOPES,
			state,
		});

		return reply.redirect(authorizationUrl);
	});
};
