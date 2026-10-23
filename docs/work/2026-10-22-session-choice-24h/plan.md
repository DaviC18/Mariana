Status: APPROVED by Davi on 2026-10-22 — "aprovo"

# Escolha de sessão após 24h de inatividade

Task id: `2026-10-22-session-choice-24h` · Base: `develop` @ `595db13` · Cruza `docs/specs/2026-10-17-scheduling-and-session-flow.md` **D6** e `docs/specs/ROADMAP-2026-10-22.md` **pacote D / WP-4**.

## Summary

Quando o cliente volta a escrever depois de ≥ 24h sem mensagem dele, Mariana pergunta se ele quer **continuar** a conversa anterior (mesmo `conversationId`, mesmo histórico e mesmo estado comercial) ou **começar uma conversa nova** (novo `conversationId` para o mesmo `lead`, contexto comercial independente). A pergunta é feita **antes** de `lastCustomerMessageAt` ser atualizado e antes de qualquer tarefa conversacional ou de agendamento rodar.

O ponto central: criar uma `conversations` nova **não isola nada**, porque `objective`, `consortiumType`, `interestedInConsultant`, `status`, `commercialApproach`, `currentSituation`, `painPoint` e `urgency` vivem em `leads` e são lidos direto no prompt e na etapa. O plano, portanto, faz *snapshot + reset* desses campos ao criar a conversa B, sem apagar A e sem migration.

Não há migration neste plano. O estado pendente é durável numa linha `completed` de `autonomous_tasks` (decisão Q1). Se Davi recusar essa opção, o passo 2 fica **BLOCKED** até a migration do pacote G.

## Limitações conhecidas (verificadas)

- `docs/specs/MARIANA_BEHAVIOR_SPEC.md` **não existe** no repositório (`ls docs/specs/` só lista `2026-10-17-scheduling-and-session-flow.md` e `ROADMAP-2026-10-22.md`). Nenhuma regra `R-SES-*` foi inventada aqui. Os critérios deste plano derivam do brief do Davi + D6 do spec existente. Se o texto v1.1 existir, Davi deve indicar caminho/versão antes da aceitação final.
- `superpowers:*` citado em `.claude/agents/planner.md` **não está instalado**; este subagente não tem ferramenta `Skill`. Usei grep/leitura manual com `file:line`, desenho de teste TDD (vermelho → verde) e matriz adversarial. `npx skills find` localizou, **sem instalar**: `pandoscope/skills@tdd`, `obra/superpowers-skills` (TDD), `bobmatnyc/systematic-debugging`, `jeffallan/code-reviewer`, `github/awesome-copilot security-review`, `getsentry/find-bugs`. Nenhuma foi usada.
- Nenhum teste foi executado pelo planner. Nenhuma escrita fora de `docs/work/2026-10-22-session-choice-24h/`.

## Root causes (CONFIRMED / REFUTED / UNCLEAR)

| # | Afirmação | Status | Evidência |
|---|---|---|---|
| RC-1 | A regra de 24h não existe: nada compara `lastCustomerMessageAt` com a mensagem atual, e o campo é atualizado antes de qualquer decisão | **CONFIRMED** | `src/routes/whatsapp/webhook-whatsapp.ts:436-443` grava `lastCustomerMessageAt: new Date()` logo depois de inserir a mensagem (`:414-424`) e antes de `enqueueTask` (`:449-466`). No ramo de botão, `:380-386` grava antes de rotear. Não há leitura do valor anterior. |
| RC-2 | Nenhum mecanismo fecha conversa por inatividade; D6 é só planejado | **CONFIRMED** | `conversations.status` só é escrito como `closed` em `src/services/agent/execute-next-action.ts:178-195` e `:343-349` (ação `close` pedida pelo modelo). `grep` por `24`/`inactiv` em `src/` não encontra fechamento. `ROADMAP-2026-10-22.md:29` lista WP-4 como pacote futuro. |
| RC-3 | “No máximo uma conversa ativa por lead” não é garantido pelo banco | **CONFIRMED** | `src/db/schema/conversations.ts:27-30` só tem índices comuns `leadId`/`status`; nenhum índice único parcial. `drizzle/*/snapshot.json` confirma que só existe `scheduling_sessions_one_active_lead_unique`, não equivalente em `conversations`. A criação é check-then-insert sem lock: webhook `:352-368`, rota `src/routes/conversations/create-conversations.ts:46-77`. |
| RC-4 | Uma `conversations` nova não isola o estado comercial | **CONFIRMED** | Campos em `src/db/schema/leads.ts:51-68` (`objective`, `consortiumType`, `interestedInConsultant`, `status`, `commercialApproach`, `currentSituation`, `painPoint`, `urgency`, `qualifiedAt`). `generateMarianaResponse.ts:517-570` lê tudo do lead e monta `qualificationInput`, `stageLead` e `agentLead`; `conversation-stage.ts:134-194` decide perguntas e “não pergunte” por esses campos; `qualification-gaps.ts:6-15` exige `objective` + `interestedInConsultant`; `update-lead-from-agent.ts:305-315` grava no lead. Histórico é o único dado escopado por conversa (`generateMarianaResponse.ts:452-463`, `:494-504`). |
| RC-5 | O histórico enviado ao Gemini é o da conversa ativa, ordenado por `createdAt`, sem limite | **CONFIRMED** | `generateMarianaResponse.ts:452-463` busca a conversa `active`; `:494-504` filtra por `conversationId` e ordena `asc(messages.createdAt)`; `src/ai/agent.ts:267` concatena `history + currentMessages` sem `slice`/limite. Logo B com histórico vazio é limpo, mas o lead continua contaminado. |
| RC-6 | O roteamento de botões é só por prefixo e não tem família de escolha de sessão | **CONFIRMED** | `webhook-whatsapp.ts:388-401` reconhece `pref:`, `consultant:`, `confirm:`/`cancel:` e UUID de slot; qualquer outro cai em `PROCESS_BUTTON_REPLY_TASK`. IDs gerados em `autonomous-task-handlers.ts:572,576,735` e `scheduling-confirmation-service.ts:131-135`; slot = UUID (`webhook-whatsapp.ts:31,399`). Um toque inválido pode terminar em `resolveChoice` sem resposta (`autonomous-task-handlers.ts:444-465`) ou em `skipped` silencioso (`:654`, `:861`, `:997`). |
| RC-7 | Não existe lugar persistente pronto para “escolha pendente” sem migration | **CONFIRMED** | `conversations` não tem coluna JSON/metadata (`conversations.ts:10-26`); `scheduling_sessions.workflowStage` é enum fechado sem estado de escolha (`scheduling-sessions.ts:22-33`); a tabela de tasks é a única estrutura genérica com `jsonb` e unicidade (`autonomous-tasks.ts:41,56`). Uma task pendente normal não serve: ela é reclamada e concluída, e bloquearia a própria tarefa da escolha pela ordenação (`autonomous-task-executor.ts:82-101`). |
| RC-8 | Texto livre durante a pendência hoje seria processado normalmente | **CONFIRMED** | `webhook-whatsapp.ts:414-474` sempre insere a mensagem e enfileira `process_inbound_message`; não há estado que impeça `generateMarianaResponse`. |
| RC-9 | A janela de 24h do WhatsApp é outro mecanismo | **CONFIRMED** | `src/services/conversations/whatsapp-compliance.ts:6` (`WHATSAPP_CUSTOMER_WINDOW_MS`), `:23-56` (envio proativo/template). Usa o mesmo campo, mas para decidir **envio**, não sessão. O plano não altera essa regra. |
| RC-10 | `status = scheduled` é pegajoso e vaza para uma conversa nova | **CONFIRMED** | `conversation-stage.ts:211-217` devolve `confirmation` sempre que `lead.status === "scheduled"`; `lead-status.ts:10-18` só permite `scheduled → scheduled`; `update-lead-from-agent.ts:305-315` rejeita outras transições. Sem regra por data da reunião (WP-5), B nasceria em `confirmation`. Isto é decisão Q2. |
| RC-11 | Sessões de agendamento são por lead e podem bloquear B | **CONFIRMED** | `scheduling-sessions.ts:73-75` índice único parcial por `leadId` com `status='active'`. Se A tem sessão ativa, criar/abrir sessão em B falha. É preciso encerrar a sessão de A ao criar B. |
| RC-12 | `MARIANA_BEHAVIOR_SPEC.md` ausente | **CONFIRMED** | `ls docs/specs/` (somente 2 arquivos). Não há `R-SES-01…05` em texto. |
| RC-13 | O executor serializa por conversa, mas não entre conversas do mesmo lead | **CONFIRMED** | `autonomous-task-executor.ts:59-122`: `NOT EXISTS` de task `processing` e de task `pending` mais antiga na **mesma conversa**, `FOR UPDATE SKIP LOCKED`. Duas conversas do mesmo lead podem rodar em paralelo; a proteção tem de ser o lock do lead + estado durável. |

Nada em RC-1…RC-13 foi refutado. `UNCLEAR`: se a produção já tem, fora do schema versionado, um índice único de conversa ativa — não posso consultar Neon; o plano não depende disso, mas o passo 3 é obrigatório de qualquer forma.

## Design

### 1. Constantes, textos e fronteira de 24h

Novo módulo puro `src/services/conversations/session-choice-policy.ts`:

- `SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000` — **não** reutilizar `WHATSAPP_CUSTOMER_WINDOW_MS`; são regras diferentes (RC-9).
- `isSessionInactivityGap({ lastCustomerMessageAt, now })`: `true` somente se `lastCustomerMessageAt` é `Date` válido e `now.getTime() - lastCustomerMessageAt.getTime() >= SESSION_INACTIVITY_MS`. `null`/data inválida ⇒ `false` (sem prova de 24h, não pergunta; segue o fluxo normal). Exatamente 24h ⇒ `true`; 24h − 1 ms ⇒ `false`.
- Um único relógio por mensagem: o webhook calcula `receivedAt = new Date()` uma vez e passa para a decisão e para todas as gravações daquele evento. Não se usa `message.timestamp` do provedor nesta tarefa (evita misturar relógios); consequência conservadora: webhook atrasado atrasa a pergunta, nunca a antecipa.
- Textos exatos (pinados em teste para qualquer mudança ser consciente):
  - pergunta: `Oi! Já passou mais de 24 horas desde a nossa última conversa. Você prefere continuar de onde paramos ou começar uma conversa nova?`
  - lembrete: `Só para eu não misturar os assuntos: você quer continuar a conversa anterior ou começar uma nova?`
  - confirmação de conversa nova: `Pronto, comecei uma conversa nova. Pode me contar o que você procura agora.`
  - pendência + toque inválido: `Antes de seguir, preciso da sua escolha: continuar a conversa anterior ou começar uma nova?`
  - toque repetido/fora de ordem: `Sua escolha já foi registrada. Vou seguir por ela.`
- IDs: `sessao:continuar`, `sessao:nova`. Títulos de botão: `Continuar`, `Nova conversa` (≤ 20 caracteres, limite do Cloud API). Prefixo `sessao:` não colide com `pref:`, `consultant:`, `confirm:`, `cancel:` nem com UUID.

A pergunta só é feita se existir **mensagem de cliente anterior** na conversa (evita perguntar em conversa vazia/seed). A checagem de 24h é feita com o valor **antigo** de `lastCustomerMessageAt`; a gravação do novo valor vem depois.

### 2. Estado pendente durável sem migration

Uma linha em `autonomous_tasks`, usada como registro de estado (não como tarefa executável):

```
taskType       = "session_choice_state"
idempotencyKey = `session-choice-state:${conversationId}`
status         = "completed"
payload = {
  kind: "session_choice",
  state: "pending" | "continue" | "new",
  leadId, previousConversationId,
  askedAt, triggerExternalId, triggerMessageId,
  questionMessageId, questionOutboundId?,
  discardButtonId?,
  snapshot?: { objective, consortiumType, interestedInConsultant, commercialApproach,
               currentSituation, painPoint, urgency, status, qualifiedAt },
  resolvedAt?, newConversationId?
}
```

- `status = completed` ⇒ nunca é reclamada (`claimNextTask` só considera `pending`, `autonomous-task-executor.ts:78`), não tem lease e não bloqueia a ordenação.
- Leitura: `readPendingSessionChoice(conversationId)` filtra `idempotencyKey` + `taskType` + `payload->>'state' = 'pending'`.
- Criação: `INSERT ... ON CONFLICT (idempotencyKey) DO NOTHING`; não reabre estado já resolvido.
- Resolução atômica: `UPDATE ... SET payload = payload || {...}, updatedAt = now() WHERE idempotencyKey = $1 AND payload->>'state' = 'pending' RETURNING *`. Um vencedor; os demais toques veem zero linhas e recebem o texto de “já registrada”.
- **Honestidade:** isto é durável e sobrevive a restart (commit no Postgres), mas é uso semântico indevido de `autonomous_tasks` como chave-valor. Não tem FK para a mensagem, não tem TTL e qualquer rotina futura que apague tasks concluídas destruiria o estado. Hoje não existe purge de produção (grep só encontra deletes em testes). A alternativa correta é uma coluna `jsonb` em `conversations`, que exige migration e está **BLOCKED** pelo congelamento (`CLAUDE.md`). Decisão Q1.

### 3. Roteamento da entrada (webhook)

Dentro de uma transação, com `SELECT id FROM leads WHERE id = $1 FOR UPDATE` antes de criar conversa:

1. `previousLastCustomerMessageAt` = valor lido da conversa ativa (ou `null` se acabou de ser criada).
2. `pending` = `readPendingSessionChoice(conversation.id)`.
3. `gap` = `isSessionInactivityGap({ lastCustomerMessageAt: previousLastCustomerMessageAt, now: receivedAt })`.
4. Persistir mensagem/evento e atualizar `lastCustomerMessageAt = receivedAt` (e `optOutAt` se opt-out).
5. Rotear:
   - opt-out ⇒ fluxo normal atual (nunca pergunta escolha);
   - `buttonId.startsWith("sessao:")` ⇒ task `process_session_choice`;
   - `pending` e botão de outra família ⇒ task `process_session_choice` com `kind: "invalid"` (não agenda, não chama Gemini);
   - `pending` e texto ⇒ task `remind_session_choice` (um por evento), mensagem fica `processedAt = null`, **sem** task `process_inbound_message`;
   - `!pending` e `gap` ⇒ cria estado pendente + task `ask_session_choice`; mensagem/evento ficam sem task de inbound; botão antigo, se houver, é registrado em `discardButtonId` e descartado;
   - caso contrário ⇒ comportamento atual (`process_inbound_message`).
6. Tudo numa transação: estado + task + mensagem/evento. Se o processo morrer, ou tudo existe ou nada existe; o evento `whatsapp_webhook_events` em `failed` é reclamado e repete.

Enquanto pendente, nenhuma mensagem é processada e nenhuma resposta gerada; só os textos determinísticos acima. Não há resposta que assuma continuação.

### 4. Handlers novos

- `ask_session_choice` (`ask` e `remind`): lê o estado pendente; grava a mensagem assistant (texto exato), o outbox com botões e o `questionMessageId` na mesma transação. Se o estado já não estiver pendente, não envia nada.
- `process_session_choice`:
  - lê o estado pendente da conversa; sem estado ⇒ texto de “já registrada” (dedup por `session-choice-reply:${conversationId}:${externalId}`);
  - `sessao:continuar`: claim atômico `pending → continue`; enfileira uma task `process_inbound_message` por mensagem não processada de A (mesmo `batchCutoffAt = resolvedAt + env.MESSAGE_DEBOUNCE_MS`), com `createdAt` da task = `createdAt` da mensagem para preservar ordem;
  - `sessao:nova`: claim `pending → new`; snapshot do lead; fecha A; cria B sob lock do lead; move mensagens não processadas para B; expira sessão de agendamento ativa de A; herda `optOutAt` e `lastCustomerMessageAt`; reseta campos comerciais; enfileira as tasks em B; envia a confirmação de conversa nova;
  - `kind: "invalid"`: reenvia pergunta + botões, sem ação.
- Texto livre enquanto pendente **não** é interpretado (Q4): só lembrete + botões. Isso evita que “quero começar um consórcio novo” seja lido como “nova conversa” por engano.

### 5. Conversa nova: isolamento comercial exato

Na mesma transação:

- `snapshot` = valores atuais de `objective`, `consortiumType`, `interestedInConsultant`, `commercialApproach`, `currentSituation`, `painPoint`, `urgency`, `status`, `qualifiedAt` do lead, gravado no `payload` do estado (recuperável; A nunca é apagada).
- Reset no lead: `objective = null`, `consortiumType = null`, `interestedInConsultant = false`, `commercialApproach = null`, `currentSituation = null`, `painPoint = null`, `urgency = null`, `qualifiedAt = null`.
- **Mantidos** (fatos duráveis/identidade): `name`, `phone`, `email`, `birthDate`, `source`, `sourceLeadId`, `adId`/`adSetId`/`campaignId`/`gclid`.
- `status`: decisão Q2. Recomendado: `scheduled` **somente** se existir appointment futuro em `confirmed`/`scheduled`; senão `new`. Como `lead-status.ts` não permite `scheduled → new`, esse reset é update direto e logado, restrito ao caminho de conversa nova (passo 9; Q2 aprovada, ver Decision log).
- A fica `closed`, com histórico e mensagens intactos. B nasce `active`, mesmo `leadId`, `lastCustomerMessageAt = receivedAt`, `optOutAt` copiado de A. Nenhuma exclusão.
- Sessão de agendamento ativa de A vira `expired` (predicado `status='active'`), preservando `selectedSlotId` para auditoria. Appointments não são tocados.
- Recuperar A: o snapshot permite reconstruir o estado comercial; o fluxo de reabrir A **não** entra nesta tarefa (Q7).

### 6. Uma conversa ativa por lead, inclusive em corrida

Novo helper `getOrCreateActiveConversation(tx, leadId)`:

1. `SELECT id FROM leads WHERE id = $1 FOR UPDATE` dentro da transação;
2. `SELECT ... conversations WHERE leadId AND status='active' LIMIT 1`;
3. cria só se não existir.

Usado no webhook, no handler de conversa nova e na rota `POST /conversations` (passo 3). O lock do lead serializa: duas mensagens simultâneas, toque + mensagem, dois toques, e criação de B contra uma mensagem concorrente. Sem índice único, esta é a única garantia; qualquer novo writer de conversa deve usar o helper.

### 7. Bloqueio de agendamento enquanto pendente

Três camadas:

1. **Roteamento**: qualquer botão que não seja `sessao:` enquanto pendente vira `process_session_choice` inválido; nenhuma task de agendamento é criada.
2. **Claim**: `claimNextTask` deixa de reclamar tasks que não sejam `session_choice_*` quando a conversa tem estado pendente (`NOT EXISTS` sobre a linha de estado). Assim uma task antiga enfileirada não roda.
3. **Handler**: ao abrir a pendência, tasks `pending` antigas da conversa são marcadas `completed` com `result = { supersededBy: "session_choice" }` (auditável, não apagadas); os handlers de agendamento (`process_button_reply`, `process_consultant_preference_reply`, `process_consultant_selection`, `send_confirmation_request`) rechecam `readPendingSessionChoice` antes de qualquer efeito e devolvem o texto de pendência. Uma task que já está `processing` quando a pendência abre não pode ser interrompida; a rechecagem no handler é a barreira para os efeitos externos.

### 8. Fora do mecanismo

- A janela de envio de 24h (`whatsapp-compliance.ts`) não muda.
- `message-debounce.ts` (rota legada em memória) não governa a pendência; o caminho durável é `inbound-message-batch.ts`.
- O fechamento automático de conversas por inatividade do WP-4 é **substituído** pela pergunta; não se fecha A sem escolha.
- Não se cria fluxo de reabrir A, nem de “voltar para a conversa anterior” dentro de B.

## Steps

Ordem de implementação em lotes de 1–3 passos. Nenhum passo toca `drizzle/`.

### Step 0 — BLOCKED (alternativa com migration; não executar)

- **Se Q1 for “não”**: adicionar `sessionChoice jsonb` + `sessionChoiceUpdatedAt` em `conversations`, índice único parcial `conversations_one_active_lead_unique` e backfill. Exige migration; `CLAUDE.md:38-41` congela `drizzle/`. Fica **BLOCKED** até o pacote G. Sem aprovação, os passos 2, 4–12 não têm base.

### Step 1 — política de tempo, textos e IDs (sem comportamento)

- Files: new `src/services/conversations/session-choice-policy.ts`; `docs/CODEMAP.md`.
- Change: constantes, textos, IDs, `isSessionInactivityGap`, helper `hasPreviousCustomerMessage` (puro, recebe a lista/contagem). Sem DB.
- Acceptance tests — new unit `src/tests/session-choice-policy.test.ts`, add to `package.json` → `test:unit`:
  - `"24h exatas contam como inatividade, 24h menos 1 ms não"` — given `lastCustomerMessageAt = now - 24h` / `now - 24h + 1ms`; when `isSessionInactivityGap`; then `true` / `false`. **Red first** (função não existe).
  - `"timestamp nulo ou inválido não prova inatividade"` — given `null`, `Invalid Date`; then `false` e nenhum throw. **Red first.**
  - `"textos e IDs da escolha são estáveis e curtos"` — pin exato dos 5 textos, IDs `sessao:continuar`/`sessao:nova`, títulos ≤ 20 chars. **Red first.**
  - `"a janela de sessão não reutiliza a janela do WhatsApp"` — assert `SESSION_INACTIVITY_MS` é exportado por este módulo e não é importado de `whatsapp-compliance.ts`. **Red first.**
- Invariantes: RC-9 (janelas distintas). Dependência: nenhuma.

### Step 2 — armazenamento durável do estado pendente

- Files: new `src/services/conversations/session-choice-store.ts`; `src/services/conversations/autonomous-task-handlers.ts` (só a constante `SESSION_CHOICE_STATE_TASK`, sem handler); `docs/CODEMAP.md`.
- Change: `openSessionChoice`, `readPendingSessionChoice`, `claimSessionChoice`, `setQuestionMessage`, `markSupersededTasks`. Tudo em `autonomous_tasks`, `status: "completed"`, chaves descritas no Design §2. Nenhuma migration.
- Acceptance tests — new DB `src/tests/reliability/session-choice-store.test.ts`:
  - `"o estado pendente sobrevive a uma nova leitura como se o processo tivesse reiniciado"` — given `openSessionChoice`; when uma nova chamada (sem cache) lê; then `state === "pending"` e o payload traz `previousConversationId`. **Red first.**
  - `"dois claims concorrentes têm exatamente um vencedor"` — given estado pendente; when `Promise.all([claim("continue"), claim("new")])`; then um retorna estado resolvido, o outro `null`, e o payload final tem um único `state`. **Red first.**
  - `"a linha de estado não é reclamada pelo executor"` — given estado `completed`; when `runNextAutonomousTask` com handler que falharia; then `status === "idle"` e o estado continua. **Red first.**
  - `"não existe task de inbound criada pela abertura do estado"` — given uma mensagem não processada; when abre estado; then zero tasks `process_inbound_message` para a conversa. **Red first.**
- Invariantes: “duplicate inbound event never processed twice” (estado é idempotente por chave) e “no máx. uma conversa ativa” (não toca). Dependência: Step 1.

### Step 3 — conversa ativa única sob lock do lead

- Files: new `src/services/conversations/active-conversation.ts`; `src/routes/whatsapp/webhook-whatsapp.ts:352-368`; `src/routes/conversations/create-conversations.ts:46-77`; `docs/CODEMAP.md`.
- Change: helper com `SELECT ... FROM leads ... FOR UPDATE` e check-then-insert; webhook e rota passam a usá-lo. Sem alteração de resposta HTTP.
- Acceptance tests — DB `src/tests/reliability/active-conversation.test.ts`:
  - `"duas criações concorrentes para o mesmo lead produzem uma única conversa ativa"` — given lead sem conversa; when duas transações concorrentes chamam o helper; then exatamente 1 `active`, a outra transação recebe a mesma. **Red first.**
  - `"o helper devolve a conversa ativa existente sem criar outra"` — green antes e depois. **Regressão.**
  - `"a rota POST /conversations continua idempotente"` — given duas chamadas; then mesmo id e 1 ativa. **Regressão.**
- Invariantes: “a lead has at most one active conversation”. Dependência: nenhuma; pode rodar em paralelo com Step 1.

### Step 4 — webhook: decidir 24h antes de gravar `lastCustomerMessageAt`

- Files: `src/routes/whatsapp/webhook-whatsapp.ts` (resolução `:352-368`, ramo botão `:375-413`, ramo texto `:414-475`); `enqueueTask` `:129-177` (aceitar `executor` e `createdAt` opcionais); imports das constantes.
- Change: capturar valor antigo, `receivedAt`, pendência; persistir+atualizar na mesma transação; rotas do Design §3. Nenhuma task de inbound quando há gap ou pendência. Não alterar HMAC/dedup.
- Acceptance tests — `src/tests/routes/webhook-whatsapp.test.ts`:
  - `"mensagem 24h-1ms depois da última não pergunta e processa normalmente"` — given conversa ativa com `lastCustomerMessageAt = now - (24h - 1ms)`; when POST texto; then 1 task `process_inbound_message`, 0 `ask_session_choice`, nenhum botão `sessao:`. **Red first.**
  - `"mensagem com 24h exatas pergunta antes de processar"` — given gap de 24h; when POST; then 1 estado pendente, 1 task `ask_session_choice`, 0 `process_inbound_message`, e `lastCustomerMessageAt` já é o novo `receivedAt`. **Red first** (hoje processa).
  - `"timestamp nulo não pergunta"` — given `lastCustomerMessageAt = null` e mensagem anterior existente; then fluxo normal. **Red first** para o caso de seed; regressão para conversa recém-criada.
  - `"mensagem durante a pendência não enfileira processamento nem chama o modelo"` — given estado pendente; when POST texto; then 1 `remind_session_choice`, 0 `process_inbound_message`, 0 outbound gerado por Gemini, mensagem `processedAt = null`. **Red first.**
  - `"webhook duplicado durante a pendência não duplica lembrete"` — given mesmo `externalId` entregue 2×; then 1 task/1 outbound. **Red first** (dedup existente + chave).
  - `"toque de slot antigo após 24h não agenda; pergunta a escolha"` — given botão UUID e gap; then 1 `ask_session_choice`, 0 `send_confirmation_request`, 0 appointment. **Red first.**
- Invariantes: “duplicate inbound event never processed twice”; ordem “24h antes de atualizar o campo”; “no scheduling action before choice”. Dependência: Steps 1–3.

### Step 5 — handlers `ask` e `remind`

- Files: `src/services/conversations/autonomous-task-handlers.ts` (novos handlers + constantes `ASK_SESSION_CHOICE_TASK`, `REMIND_SESSION_CHOICE_TASK`); `createAutonomousTaskHandlers` `:1087-1101`.
- Change: Design §4. Transação: mensagem assistant + outbox (botões) + `questionMessageId` no estado. Sem estado pendente ⇒ `{ skipped: true, reason: "no_pending_session_choice" }` sem envio.
- Acceptance tests — DB `src/tests/reliability/session-choice-handlers.test.ts`:
  - `"a pergunta é enviada uma vez com os dois botões e fica no histórico"` — given estado pendente e task `ask`; when handler executa 2×; then 1 `outbound_messages` com `payload.kind === "buttons"`, IDs exatos, 1 mensagem assistant, `questionMessageId` preenchido. **Red first.**
  - `"lembrete não cria pergunta duplicada nem processa a mensagem"` — given task `remind`; then 1 outbound com os mesmos botões, 0 `process_inbound_message`, mensagem segue não processada. **Red first.**
  - `"sem estado pendente o handler não envia nada"` — then `skipped` e 0 outbound. **Red first.**
- Invariantes: “outbound possível-aceito nunca volta a pending” (não altera outbox); “duplicate event nunca processado duas vezes”. Dependência: Steps 2, 4.

### Step 6 — handler `continuar`

- Files: `src/services/conversations/autonomous-task-handlers.ts` (`handleProcessSessionChoice`, ramo continue); `enqueueTask`/helper de liberação.
- Change: claim atômico; enfileirar uma task de inbound por mensagem não processada de A, com o mesmo `batchCutoffAt` e `createdAt = messages.createdAt`. Nenhuma mensagem movida, nenhum campo do lead alterado, nenhuma confirmação extra (a resposta normal vem do fluxo existente).
- Acceptance tests — DB `src/tests/reliability/session-choice-continue.test.ts`:
  - `"continuar mantém o mesmo conversationId e enfileira todas as mensagens pendentes em ordem"` — given A com 3 mensagens não processadas; when toque `sessao:continuar`; then 1 conversa ativa (a mesma A), 3 tasks, ordem por `messages.createdAt`, `processedAt` ainda nulo. **Red first.**
  - `"continuar preserva histórico e estado comercial"` — given lead com `objective = "carro"` e histórico de 2 turnos; when continua; then lead inalterado e o próximo `generateMarianaResponse` recebe histórico de A (stub captura `history`). **Red first.**
  - `"continuar não repete a pergunta de 24h"` — given continua; when chega a próxima mensagem; then 0 novos `ask_session_choice` (porque `lastCustomerMessageAt` avançou e o estado está resolvido). **Red first.**
- Invariantes: “a lead has at most one active conversation”; não duplicar processamento. Dependência: Steps 2, 4, 5.

### Step 7 — handler `nova conversa`: B, movimentação e fechamento de A

- Files: `src/services/conversations/autonomous-task-handlers.ts` (ramo new); `src/services/conversations/active-conversation.ts`.
- Change: na transação — snapshot (Step 8), `claim new`, fechar A (`status=closed`), criar B via helper sob lock, mover `messages` com `processedAt IS NULL` de A para B, expirar sessão ativa de A, copiar `optOutAt` e `lastCustomerMessageAt`, enfileirar tasks em B, enviar confirmação. Eventos `whatsapp_webhook_events` permanecem apontando para A (histórico de auditoria).
- Acceptance tests — DB `src/tests/reliability/session-choice-new.test.ts`:
  - `"nova conversa cria B com o mesmo lead, fecha A sem apagar nada"` — given A com histórico; when `sessao:nova`; then A `closed` com as mesmas mensagens, B `active` mesmo `leadId`, ids diferentes, 1 ativa. **Red first.**
  - `"mensagens pendentes são movidas para B e processadas lá"` — given 2 mensagens não processadas; then `conversationId === B` nas duas, tasks em B, 0 tasks de inbound em A. **Red first.**
  - `"a confirmação de conversa nova é enviada e não assume continuação"` — then 1 outbound com o texto pinado e 0 ocorrências da pergunta de 24h. **Red first.**
  - `"sessão de agendamento ativa de A é expirada e o appointment não é apagado"` — given sessão ativa + appointment; then sessão `expired`, appointment intacto. **Red first.**
  - `"B herda opt-out e janela do cliente"` — given A com `optOutAt`; then B tem o mesmo `optOutAt`; nenhum envio a lead opt-out. **Red first.**
- Invariantes: “a lead has at most one active conversation”; nenhuma exclusão de histórico. Dependência: Steps 3, 6 (claim), 8 (snapshot/reset).

### Step 8 — snapshot e reset dos campos comerciais

- Files: `src/services/conversations/session-choice-store.ts` (snapshot), `autonomous-task-handlers.ts` (reset), `src/services/conversations/generateMarianaResponse.ts` (nenhuma mudança de leitura; apenas confirmar).
- Change: gravar snapshot no estado **antes** do reset, na mesma transação; resetar somente os 8 campos comerciais + `qualifiedAt` do Design §5; manter identidade. Sem alterar `status` (Step 9).
- Acceptance tests — `src/tests/reliability/session-choice-new.test.ts` (mesmo arquivo):
  - `"o estado guarda o snapshot comercial de A antes do reset"` — given A `objective="consórcio de carro"`, `consortiumType="veículo"`, `interestedInConsultant=true`, `painPoint="trocar o carro"`; when nova; then snapshot contém exatamente esses valores. **Red first.**
  - `"B não herda nenhum campo comercial de A"` — then `objective`, `consortiumType`, `commercialApproach`, `currentSituation`, `painPoint`, `urgency` são `null`; `interestedInConsultant === false`; `qualifiedAt === null`; `name`/`phone`/`birthDate` mantidos. **Red first.**
  - `"pergunta de imóvel em B não recebe estado de veículo"` — given A sobre carro, B recebe `"quero consórcio de imóvel"`; when `generateMarianaResponse` com `generateMarianaReplyFn` stub; then `lead.objective === ""`, `consortiumType === ""`, `history` contém só mensagens de B e a pergunta de etapa é a de objetivo, não “não pergunte o tipo”. **Red first** (hoje B herdaria carro).
- Invariantes: “AI never authority on IDs/availability”; isolamento comercial da spec. Dependência: Steps 2, 7.

### Step 9 — status de B pela data da reunião

- Files: `src/services/conversations/session-choice-store.ts` (ou helper `resolveLeadStatusForNewConversation`); `src/services/conversations/autonomous-task-handlers.ts`; possivelmente `src/services/leads/lead-status.ts` (somente se Davi autorizar `scheduled → new`).
- Change: se existe appointment futuro com `status IN ('confirmed','scheduled')` ⇒ manter `scheduled`; senão `status = "new"` e `qualifiedAt = null`. Update direto, com log `session_choice_lead_status_reset`, porque a máquina de estados atual proíbe a transição. Sem tocar appointments.
- Acceptance tests — `src/tests/reliability/session-choice-new.test.ts`:
  - `"lead scheduled com reunião passada volta a new na conversa nova"` — given appointment `scheduled` com `startAt` no passado; when nova; then `status === "new"` e o stage de B é `greeting`/`reason`, não `confirmation`. **Red first.**
  - `"reunião futura confirmada mantém scheduled e não é apagada"` — given appointment futuro; then `status === "scheduled"`, appointment intacto, e B não perde o dado. **Red first.**
  - `"reunião futura cancelada não mantém scheduled"` — given `cancelled`; then `status === "new"`. **Red first.**
- Invariantes: “confirming a slot requires selectedSlotId”; status só `scheduled` com reunião futura (D6). Q2 aprovada (ver Decision log); sem essa regra o Step 7 fica com B possivelmente em `confirmation`.

### Step 10 — bloqueio de agendamento enquanto pendente

- Files: `src/routes/whatsapp/webhook-whatsapp.ts:388-401`; `src/services/conversations/autonomous-task-executor.ts:59-122`; `src/services/conversations/autonomous-task-handlers.ts` (4 handlers de agendamento); `session-choice-store.ts` (`markSupersededTasks`).
- Change: Design §7 (roteamento inválido, `NOT EXISTS` no claim, supersessão de tasks antigas, rechecagem nos handlers). Textos determinísticos; nenhum `skipped` silencioso.
- Acceptance tests — DB `src/tests/reliability/session-choice-gate.test.ts`:
  - `"toque Confirmar durante a pendência não cria appointment"` — given estado pendente + slot selecionado; when handler `process_button_reply` com `confirm:<slot>`; then 0 appointments, 1 resposta de pendência, slot intacto. **Red first.**
  - `"toque de preferência/consultor/slot durante a pendência não muda a sessão"` — three subcases; then `workflowStage` inalterado, 0 tasks de agendamento, 1 resposta determinística por toque. **Red first.**
  - `"uma task de agendamento já enfileirada não é reclamada enquanto a pendência existe"` — given task `send_confirmation_request` pending + estado; when executor roda; then `idle`, task continua `pending`. **Red first.**
  - `"ao abrir a pendência, tasks antigas ficam superseded e auditáveis"` — given 2 tasks pending; then `status=completed`, `result.supersededBy === "session_choice"`, nenhuma apagada. **Red first.**
  - `"depois de resolver, o fluxo de agendamento volta a funcionar"` — given escolha continue; when nova oferta válida; then a task roda normalmente. **Regressão.**
- Invariantes: “AI never authority on availability/authorization”; “confirm requires selectedSlotId”; “no scheduling before choice”. Dependência: Steps 5–7.

### Step 11 — respostas inválidas, duplicadas e fora de ordem

- Files: `autonomous-task-handlers.ts` (`process_session_choice` ramo `invalid`/repetido); `webhook-whatsapp.ts` (chaves de idempotência).
- Change: dois toques distintos (continuar e nova) ⇒ o segundo recebe “já registrada” e não muda nada. Toque `sessao:` desconhecido (ex. `sessao:xyz`) ⇒ inválido. Botão de outra família enquanto pendente ⇒ inválido. Texto livre ⇒ lembrete (sem interpretar). Duplicata do mesmo `externalId` ⇒ dedup do webhook, sem segundo envio.
- Acceptance tests — `src/tests/reliability/session-choice-adversarial.test.ts`:
  - `"continuar e depois nova: a primeira escolha vence e a segunda não cria B"` — then 1 ativa, 0 B extra, 1 texto “já registrada”. **Red first.**
  - `"nova e depois continuar: B é a única conversa ativa e A continua fechada"` — then 1 ativa (B), A fechada, segundo toque só informa. **Red first.**
  - `"toque sessao:desconhecido e toque de slot antigo durante a pendência reenviam a pergunta"` — then 0 appointments, 0 mudanças de sessão, 2 respostas com botões. **Red first.**
  - `"texto livre 'quero começar do zero' não cria B; recebe lembrete"` — then 0 B, 1 lembrete, mensagem não processada. **Red first** (Q4). Se Davi escolher interpretar, este teste muda.
  - `"a mesma entrega repetida pelo Meta não gera segunda resposta"` — then 1 outbound. **Red first.**
- Invariantes: “duplicate inbound event never processed twice”; “outbound possível-aceito nunca volta a pending”. Dependência: Steps 6–10.

### Step 12 — restart, concorrência e duas conversas ativas

- Files: new DB tests; nenhuma mudança de produção, exceto correções que os testes revelarem (dentro do desenho).
- Change: provar o desenho sob falha/paralelismo.
- Acceptance tests — `src/tests/reliability/session-choice-concurrency.test.ts`:
  - `"estado pendente sobrevive a restart e a escolha ainda é aplicada"` — given estado pendente criado numa “execução”, when nova instância de serviço lê e processa `sessao:continuar`; then A continua ativa e mensagens são liberadas. **Red first.**
  - `"mensagem concorrente ao toque não cria duas conversas ativas"` — given toque `nova` e POST de texto simultâneos; then 1 ativa, mensagem do POST está na conversa vencedora. **Red first.**
  - `"dois toques concorrentes não criam duas B"` — then 1 B, 1 A fechada, 1 ativa. **Red first.**
  - `"choice handler concorrente com task que tem lease não executa efeito de agendamento"` — given task `processing` e pendência aberta; when handler de agendamento roda; then 0 appointments/0 mudança de estágio. **Red first.**
  - `"três mensagens seguidas dentro de 24h continuam na mesma conversa"` — regression (AC12). **Green antes e depois.**
  - `"a mesma mensagem com externalId repetido não é processada duas vezes"` — regression. **Green antes e depois.**
- Invariantes: todas as de concorrência/idempotência. Dependência: Steps 4–11.

### Step 13 — documentação e mapa

- Files: `docs/specs/2026-10-17-scheduling-and-session-flow.md` (§D6 e AC11), `docs/specs/ROADMAP-2026-10-22.md:29` (WP-4), `docs/CODEMAP.md`, `CLAUDE.md` (invariantes, somente com Q6).
- Change (texto exato proposto):
  - D6, substituir “A conversation is closed after 24 hours without client messages (inactivity), and only then. The next message opens a fresh conversation.” por: “Após ≥ 24h sem mensagem do cliente, a próxima mensagem pergunta se ele quer continuar a conversa (mesmo `conversationId`, histórico e estado) ou começar uma nova (novo `conversationId`, mesmo lead, estado comercial zerado). A conversa anterior nunca é apagada. A pergunta é feita antes de atualizar `lastCustomerMessageAt`.”
  - AC11 reescrito para os dois ramos + isolamento comercial; novo AC15 para “nenhuma ação de agendamento antes da escolha”.
  - ROADMAP WP-4: “fechar a conversa após 24h” → “perguntar continuar/nova após 24h; fechar A só na escolha ‘nova’”.
  - `CLAUDE.md` invariantes: “at most one active conversation per lead” (já existe), adicionar “at most one pending session choice per conversation” e “uma conversa nova nunca herda estado comercial da anterior”. Requer aprovação Q6.
  - `MARIANA_BEHAVIOR_SPEC.md`: **não editar** (arquivo ausente); registrar pendência.
- Acceptance: `grep` mostra as novas frases; nenhum outro trecho do spec alterado; `git diff --check`. Sem teste automatizado.
- Dependência: Steps 1–12; Q6.

### Step 14 — verificação final (tester)

- Files: `docs/work/2026-10-22-session-choice-24h/test-report.md`.
- Change: nenhuma. Rodar suítes completas, `tsc`, build, biome nos arquivos alterados, `git diff --check`; mapear cada critério abaixo para teste.
- Acceptance: PASS/FAIL por critério, com evidência de vermelho antes/verde depois de cada passo; nenhuma chamada real a WhatsApp/Gemini/Calendar.

## Matriz de regressão e adversarial (obrigatória)

| Caso | Onde é provado |
|---|---|
| < 24h não pergunta; processa normal | Step 4 |
| ≥ 24h pergunta antes de processar | Step 4 |
| Exatamente 24h; 24h − 1 ms | Steps 1, 4 |
| `lastCustomerMessageAt` nulo/inválido | Steps 1, 4 |
| Continuar: mesmo id, histórico e estado | Step 6 |
| Nova: id novo, mesmo lead, isolamento carro → imóvel | Steps 7, 8 |
| A nunca apagada; appointments preservados | Step 7 |
| Mensagens durante a pendência: ordem, processamento único | Steps 4, 6 |
| Webhook/toque duplicado; toque fora de ordem | Steps 4, 11 |
| Texto livre durante a pendência | Steps 4, 11 |
| Restart com pendência | Step 12 |
| Concorrência mensagem/toque/B | Steps 3, 12 |
| Nunca duas conversas ativas | Steps 3, 7, 12 |
| Nenhuma ação de agendamento antes da escolha | Step 10 |
| Confirmação/cancelamento/consultor/slots preservados | Step 10 + suítes existentes |
| Batching/debounce, idempotência, outbox | Steps 5–7, 11, 12 |
| Opt-out e janela de envio preservados | Steps 7, 8, 11 |
| Sem serviços externos reais | Todos: Gemini/Calendar/WhatsApp mockados |

## Out of scope

- Reabrir a conversa A ou alternar B → A pelo cliente (Q7).
- Fechamento automático por inatividade do WP-4 (substituído pela pergunta).
- WP-5 completo (status por data da reunião, saída de `scheduled`, dados da reunião no prompt). O Step 9 é o mínimo necessário para B; o restante continua no pacote D.
- Lembrete proativo depois de 24h sem resposta à pergunta (exigiria template/consentimento).
- Migration, `drizzle/`, seeds, `db:push`, consolidação.
- Limpeza de dados no Neon.
- Mudança de textos de agendamento existentes.
- Interpretar texto livre como escolha (Q4).
- Limitar o histórico enviado ao Gemini (pacote C2).
- Admin API para reabrir/inspecionar conversas.

## Questions for the owner (Davi)

1. **Q1 — estado sem migration.** Aceita guardar a escolha pendente numa linha `completed` de `autonomous_tasks` (`session_choice_state`), descrita no Design §2? **Recomendado: sim.** É durável e atômico, mas é uso indevido da tabela. A alternativa correta (`jsonb` em `conversations`) exige migration e deixa o Step 2 **BLOCKED** até o pacote G.
2. **Q2 — status de B.** Se A terminou com `scheduled`, o que B herda? **Recomendado:** `scheduled` só se houver reunião futura `confirmed`/`scheduled`; senão `new` e `qualifiedAt = null`. Isso exige update direto `scheduled → new`, proibido pela máquina atual, e invade o WP-5. Step 9 **BLOCKED** até a resposta. A alternativa (manter `scheduled`) faz B nascer em `confirmation` e repetir o bug da “memória da quinta-feira”.
3. **Q3 — mensagens durante a pendência.** **Recomendado:** um lembrete determinístico por mensagem recebida, com os mesmos botões, sem Gemini e sem processar. Alternativa: silêncio até o toque (mais barato, pior UX).
4. **Q4 — texto livre.** **Recomendado:** não interpretar (“continuar”, “nova conversa” digitados não decidem); só botões decidem, e texto livre recebe lembrete. Alternativa: interpretar frases explícitas, com risco de zerar contexto por engano. Step 11 depende da resposta.
5. **Q5 — textos.** Aprova os 5 textos do Design §1 e os botões `Continuar` / `Nova conversa`? **Recomendado: sim**, pinados em teste.
6. **Q6 — documentação e invariantes.** Aprova que o implementer edite D6/AC11, a linha WP-4 do ROADMAP e acrescente os dois invariantes ao `CLAUDE.md`? **Recomendado: sim**, no mesmo change. Sem o texto do `MARIANA_BEHAVIOR_SPEC.md` v1.1, a aceitação final contra a spec fica pendente (indique caminho/versão).
7. **Q7 — recuperar A.** Confirma que “recuperar A” nesta tarefa significa apenas **preservar** histórico + snapshot, sem fluxo de reabertura? **Recomendado: sim**; reabertura fica para um pacote futuro.
8. **Q8 — rollback.** Não haverá feature flag. Se for preciso reverter depois de haver escolha pendente em produção, as mensagens ficam sem task de inbound; o rollback exige drenar/limpar o estado manualmente (Davi executa). Aceita esse custo, ou quer um flag `SESSION_CHOICE_ENABLED` (mais superfície, mesmo problema de estado)? **Recomendado:** sem flag; validar em teste controlado antes de liberar.

## Risks

- **Estado em `autonomous_tasks`**: sem TTL/FK; purge futuro quebra a pendência. Mitigação: chave e `taskType` dedicados, teste de restart, documentação; Q1.
- **Reset do lead**: se o snapshot falhar, perda de contexto de A. Mitigação: snapshot + reset + criação de B na mesma transação; teste de falha injetada.
- **Status `scheduled`**: sem Step 9, B nasce em `confirmation`. Mitigação: Q2 aprovada e Step 9 implementado.
- **24h por relógio de recebimento**: webhook atrasado retarda a pergunta; nunca a antecipa. Aceito e documentado.
- **Concorrência**: sem índice único, a garantia é o lock do lead; qualquer writer novo que não use o helper reintroduz a corrida. Mitigação: helper único + teste concorrente + nota no CODEMAP.
- **Ruído de lembretes**: uma resposta por mensagem durante a pendência. Q3; limite simples se Davi preferir.
- **Rollback**: estado pendente órfão se o código for revertido. Q8.
- **Spec ausente**: critérios não podem ser declarados aceitos contra `R-SES-*`; aceitação final pendente.

## Rollback

- **Por passo**: cada passo é um commit lógico separado (Davi commita). Reverter o passo reverte só o comportamento; nenhuma migration, nenhum dado de negócio é apagado.
- **Steps 1–3**: puramente aditivos/refactor; reverter não deixa estado.
- **Steps 4–12**: se já houver estado pendente em produção, reverter o código deixa mensagens com `processedAt = null` e sem task. Antes do revert, drenar (aplicar a escolha) ou, com autorização do Davi, apagar as linhas `session_choice_state` e reenfileirar as mensagens manualmente. Nada disso é automático.
- **Dados**: conversas A nunca são apagadas; B, se criada, pode ser fechada manualmente. Appointments nunca são apagados por este plano.
- **Migration**: não há; nada a reverter em `drizzle/`.

## Revision history

- Revision 1 (2026-10-22): DRAFT inicial. Nenhuma revisão anterior.
- 2026-10-22: APPROVED by Davi — exact words: "aprovo". No extra conditions given. Q1–Q8 remain unanswered explicitly; Step 2 (Q1) and Step 9 (Q2) stay blocked until Davi answers. (Answered 2026-10-22 — see Decision log.)

## Decision log

- 2026-10-22 — Davi approved all recommended options for Q1–Q8, exact words: "Sim, todas as recomendadas (Recomendado)".
- Q1 = yes: pending state in `autonomous_tasks` (`status: completed`, `session_choice_state`), no migration. Step 2 unblocked.
- Q2 = recommended: B keeps `scheduled` only with a future confirmed/scheduled appointment; otherwise `new` + `qualifiedAt = null`. Step 9 unblocked.
- Q3 = reminder per inbound message while pending, deterministic.
- Q4 = free text does not decide; only `sessao:*` buttons.
- Q5 = texts/buttons approved as written.
- Q6 = implementer may update D6/AC11, ROADMAP WP-4 and add the two invariants to `CLAUDE.md`.
- Q7 = recover A means preserve history + snapshot only; no reopen flow.
- Q8 = no feature flag; documented rollback.
