import crypto from "node:crypto";

const HEX_64_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Validates a Meta webhook X-Hub-Signature-256 header against the raw request body.
 *
 * Contract:
 * - Header format: "sha256=<64 hexadecimal characters>"
 * - Uses HMAC-SHA256 with the provided secret (e.g. META_ADS_APP_SECRET or WHATSAPP_APP_SECRET)
 * - Safe against timing attacks via crypto.timingSafeEqual
 * - Returns false for missing, malformed, non-hex, length mismatched or invalid signatures without throwing.
 */
export function verifyWebhookSignature({
	rawBody,
	secret,
	signatureHeader,
}: {
	rawBody: string | Buffer;
	secret: string;
	signatureHeader: string | undefined;
}): boolean {
	if (!signatureHeader || typeof signatureHeader !== "string") {
		return false;
	}

	if (!signatureHeader.startsWith("sha256=")) {
		return false;
	}

	const receivedHex = signatureHeader.slice("sha256=".length);

	// Meta SHA-256 signatures are exactly 64 hexadecimal characters (32 bytes)
	if (receivedHex.length !== 64 || !HEX_64_REGEX.test(receivedHex)) {
		return false;
	}

	try {
		const expectedHex = crypto
			.createHmac("sha256", secret)
			.update(rawBody)
			.digest("hex");

		const receivedBuffer = Buffer.from(receivedHex, "hex");
		const expectedBuffer = Buffer.from(expectedHex, "hex");

		if (receivedBuffer.length !== expectedBuffer.length) {
			return false;
		}

		return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
	} catch {
		return false;
	}
}
