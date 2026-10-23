// Regra de sessão (spec D6): ≥ 24h sem mensagem do cliente na conversa ativa
// dispara a pergunta "continuar ou começar uma nova". Deliberadamente separada
// de WHATSAPP_CUSTOMER_WINDOW_MS (whatsapp-compliance.ts): aquela janela decide
// envio, esta decide sessão. As duas regras podem evoluir em ritmos diferentes.
export const SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000;

export function isSessionInactivityGap({
	lastCustomerMessageAt,
	now,
}: {
	lastCustomerMessageAt: Date | null | undefined;
	now: Date;
}): boolean {
	if (!(lastCustomerMessageAt instanceof Date && now instanceof Date)) {
		return false;
	}
	const last = lastCustomerMessageAt.getTime();
	const current = now.getTime();
	if (!(Number.isFinite(last) && Number.isFinite(current))) {
		return false;
	}
	return current - last >= SESSION_INACTIVITY_MS;
}

// A pergunta só faz sentido quando o cliente já escreveu antes. Contagem pura:
// conversa vazia ou de seed não recebe a pergunta.
export function hasPreviousCustomerMessage({
	customerMessageCount,
}: {
	customerMessageCount: number | null | undefined;
}): boolean {
	return (
		typeof customerMessageCount === "number" &&
		Number.isFinite(customerMessageCount) &&
		customerMessageCount > 0
	);
}

export const SESSION_CHOICE_QUESTION_TEXT =
	"Oi! Já passou mais de 24 horas desde a nossa última conversa. Você prefere continuar de onde paramos ou começar uma conversa nova?";

export const SESSION_CHOICE_REMINDER_TEXT =
	"Só para eu não misturar os assuntos: você quer continuar a conversa anterior ou começar uma nova?";

export const SESSION_CHOICE_NEW_CONVERSATION_CONFIRMATION_TEXT =
	"Pronto, comecei uma conversa nova. Pode me contar o que você procura agora.";

export const SESSION_CHOICE_PENDING_INVALID_REPLY_TEXT =
	"Antes de seguir, preciso da sua escolha: continuar a conversa anterior ou começar uma nova?";

export const SESSION_CHOICE_ALREADY_RECORDED_TEXT =
	"Sua escolha já foi registrada. Vou seguir por ela.";

// Prefixo `sessao:` não colide com `pref:`, `consultant:`, `confirm:`,
// `cancel:` nem com UUID de slot. Títulos ≤ 20 caracteres (limite do Cloud API).
export const SESSION_CHOICE_CONTINUE_BUTTON_ID = "sessao:continuar";
export const SESSION_CHOICE_NEW_BUTTON_ID = "sessao:nova";
export const SESSION_CHOICE_CONTINUE_BUTTON_TITLE = "Continuar";
export const SESSION_CHOICE_NEW_BUTTON_TITLE = "Nova conversa";
