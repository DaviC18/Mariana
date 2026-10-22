/**
 * Aviso enviado ao cliente quando o modelo falha (`ModelUnavailableError`),
 * em vez de deixá-lo sem resposta.
 *
 * Texto aprovado por Davi exatamente como está e fixado por um teste de texto
 * exato: qualquer edição exige nova aprovação dele.
 *
 * Três propriedades foram verificadas contra o código, de propósito:
 * - não contém marcador de oferta de consultor, então `detectPendingOffer`
 *   devolve `null` no turno seguinte e a invariante da oferta pendente do
 *   `CLAUDE.md` não pode ser armada por ele;
 * - não casa com nenhum `SCHEDULING_COMMITMENT_PATTERNS`, então não carrega
 *   promessa de agendamento;
 * - pede para o cliente reenviar, que é a única afirmação verdadeira
 *   disponível: a task é concluída, então nada vai tentar de novo sozinho.
 */
export const MODEL_FAILURE_NOTICE =
	"Desculpe, tive uma falha técnica aqui e não consegui processar sua mensagem agora. Pode me enviar de novo em alguns instantes?";
