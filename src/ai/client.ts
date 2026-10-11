import { GoogleGenAI, type HttpRetryOptions } from "@google/genai";
import { env } from "../env";

export const GEMINI_RETRY_OPTIONS = {
	attempts: 3,
	expBase: 2,
	httpStatusCodes: [408, 429, 500, 502, 503, 504],
	initialDelay: 0.5,
	jitter: 1,
	maxDelay: 4,
} satisfies HttpRetryOptions;

export const ai = new GoogleGenAI({
	apiKey: env.GEMINI_API_KEY,
	httpOptions: {
		retryOptions: GEMINI_RETRY_OPTIONS,
	},
});
