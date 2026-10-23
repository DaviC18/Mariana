/**
 * Credenciais falsas para todo processo de teste. Sobrescrevem as do `.env`,
 * então uma chamada real esquecida para Gemini, WhatsApp, Meta ou Google
 * falha na autenticação em vez de usar a conta de produção.
 */
export const FAKE_EXTERNAL_ENV = {
	GEMINI_API_KEY: "test-gemini-api-key",
	GOOGLE_ACCOUNT_EMAIL: "test-account@example.test",
	GOOGLE_ADS_WEBHOOK_KEY: "test-google-ads-webhook-key",
	GOOGLE_CLIENT_ID: "test-google-client-id",
	GOOGLE_CLIENT_SECRET: "test-google-client-secret",
	GOOGLE_REDIRECT_URI: "http://localhost/auth/google/callback",
	META_ADS_ACCESS_TOKEN: "test-meta-ads-access-token",
	META_ADS_APP_SECRET: "test-meta-ads-app-secret",
	META_ADS_GRAPH_API_VERSION: "v23.0",
	META_ADS_VERIFY_TOKEN: "test-meta-ads-verify-token",
	WHATSAPP_ACCESS_TOKEN: "test-whatsapp-access-token",
	WHATSAPP_APP_SECRET: "test-whatsapp-app-secret",
	WHATSAPP_GRAPH_API_VERSION: "v23.0",
	WHATSAPP_PHONE_NUMBER_ID: "test-whatsapp-phone-number-id",
	WHATSAPP_VERIFY_TOKEN: "test-whatsapp-verify-token",
	WHATSAPP_WABA_ID: "test-whatsapp-waba-id",
} as const;
