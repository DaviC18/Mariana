import { OAuth2Client } from "google-auth-library";

import { env } from "../../env";

export const GOOGLE_CALENDAR_SCOPES = [
	"https://www.googleapis.com/auth/calendar.freebusy",
	"https://www.googleapis.com/auth/calendar.events",
];

export const googleOAuth2Client = new OAuth2Client(
	env.GOOGLE_CLIENT_ID,
	env.GOOGLE_CLIENT_SECRET,
	env.GOOGLE_REDIRECT_URI
);
