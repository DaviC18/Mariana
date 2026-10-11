import { createHmac, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginCallback } from "fastify";
import { db } from "../../db/connections";
import { consultants, googleCalendarConnections } from "../../db/schema";
import { env } from "../../env";
import {
	GOOGLE_CALENDAR_SCOPES,
	googleOAuth2Client,
} from "../../integrations/google-calendar/oauth";

const createOAuthState = (consultantId: string) => {
	const nonce = randomBytes(32).toString("hex");
	const payload = `${consultantId}.${nonce}`;

	const signature = createHmac("sha256", env.GOOGLE_CLIENT_SECRET)
		.update(payload)
		.digest("hex");

	return `${payload}.${signature}`;
};

const verifyOAuthState = (state: string) => {
	const parts = state.split(".");

	if (parts.length !== 3) {
		return null;
	}

	const [consultantId, nonce, signature] = parts;

	if (!(consultantId && nonce && signature)) {
		return null;
	}

	const payload = `${consultantId}.${nonce}`;

	const expectedSignature = createHmac("sha256", env.GOOGLE_CLIENT_SECRET)
		.update(payload)
		.digest("hex");

	if (signature !== expectedSignature) {
		return null;
	}

	return consultantId;
};

export const authGoogle: FastifyPluginCallback = (app, _options, done) => {
	app.get("/auth/google", async (request, reply) => {
		const { consultantId } = request.query as {
			consultantId?: string;
		};

		if (!consultantId) {
			return reply.status(400).send({
				error: "consultant_id_required",
			});
		}

		const consultant = await db
			.select({
				id: consultants.id,
			})
			.from(consultants)
			.where(eq(consultants.id, consultantId))
			.limit(1);

		if (!consultant[0]) {
			return reply.status(404).send({
				error: "consultant_not_found",
			});
		}

		const state = createOAuthState(consultant[0].id);

		const authorizationUrl = googleOAuth2Client.generateAuthUrl({
			access_type: "offline",
			include_granted_scopes: true,
			prompt: "consent",
			scope: GOOGLE_CALENDAR_SCOPES,
			state,
		});

		return reply.redirect(authorizationUrl);
	});

	app.get("/auth/google/callback", async (request, reply) => {
		const {
			code,
			error: oauthError,
			state,
		} = request.query as {
			code?: string;
			error?: string;
			state?: string;
		};

		if (oauthError) {
			return reply.status(400).send({
				message: `Autorização Google recusada: ${oauthError}`,
				success: false,
			});
		}

		if (!(code && state)) {
			return reply.status(400).send({
				message: "Código ou state de autorização não encontrado.",
				success: false,
			});
		}

		const consultantId = verifyOAuthState(state);

		if (!consultantId) {
			return reply.status(400).send({
				message: "State OAuth inválido.",
				success: false,
			});
		}

		try {
			const [consultant] = await db
				.select({
					id: consultants.id,
					name: consultants.name,
				})
				.from(consultants)
				.where(eq(consultants.id, consultantId))
				.limit(1);

			if (!consultant) {
				return reply.status(404).send({
					message: "Consultor não encontrado.",
					success: false,
				});
			}

			const { tokens } = await googleOAuth2Client.getToken(code);

			if (!tokens.refresh_token) {
				return reply.status(400).send({
					message:
						"Google não retornou refresh token. Revogue a autorização anterior e autorize novamente.",
					success: false,
				});
			}

			googleOAuth2Client.setCredentials(tokens);

			await db
				.insert(googleCalendarConnections)
				.values({
					consultantId: consultant.id,
					googleAccountEmail: env.GOOGLE_ACCOUNT_EMAIL,
					refreshToken: tokens.refresh_token,
				})
				.onConflictDoUpdate({
					set: {
						googleAccountEmail: env.GOOGLE_ACCOUNT_EMAIL,
						refreshToken: tokens.refresh_token,
						updatedAt: new Date(),
					},
					target: googleCalendarConnections.consultantId,
				});

			return reply.send({
				consultant: consultant.name,
				hasAccessToken: Boolean(tokens.access_token),
				hasRefreshToken: Boolean(tokens.refresh_token),
				message: "Google Calendar autorizado e conexão salva.",
				success: true,
			});
		} catch (catchError) {
			request.log.error(catchError);

			return reply.status(500).send({
				message: "Erro ao concluir autorização do Google Calendar.",
				success: false,
			});
		}
	});

	done();
};
