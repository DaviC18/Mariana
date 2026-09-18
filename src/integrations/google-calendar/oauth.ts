import { google } from "googleapis";
import { env } from "../../env";

export const GOOGLE_CALENDAR_SCOPES = [
	"https://www.googleapis.com/auth/calendar.freebusy",
	"https://www.googleapis.com/auth/calendar.events",
];

export const googleOAuth2Client = new google.auth.OAuth2(
	env.GOOGLE_CLIENT_ID,
	env.GOOGLE_CLIENT_SECRET,
	env.GOOGLE_REDIRECT_URI
);
