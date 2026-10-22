# Pacote A — explicação para o Davi

Tarefa: `2026-10-22-pkg-A`. Plano completo: `docs/work/2026-10-22-pkg-A/plan.md` (está como **DRAFT**, esperando a sua aprovação).

## 0. Antes de tudo: a spec v1.1 desapareceu

A sua orientação diz que a régua é `docs/specs/MARIANA_BEHAVIOR_SPEC.md` **v1.1**. Esse arquivo não existe. A auditoria leu a spec na **raiz do repositório** (`MARIANA_BEHAVIOR_SPEC.md`, versão 1.0, 9182 bytes, **sem versionamento no git** — está registrado no `audit-report.md:38` e na finding F-01). Hoje esse arquivo também não está mais na raiz, e como ele nunca foi commitado, **o git não consegue recuperá-lo**: não há blob, não há histórico, não há `git checkout` possível.

As consequências práticas:

- As regras `R-REL-07` (rastro do turno) e `S-17` (cenário de falha do modelo) aparecem no repositório apenas como **siglas** dentro da tabela do roteiro. A redação delas está perdida.
- Então, no plano, cada critério de aceite que deveria citar `R-REL-07` ou `S-17` está escrito a partir da **sua orientação** e marcado com a frase *"redação de R-REL-07/S-17 não disponível — critério derivado do brief, pendente de confirmação"*.
- Eu **não** reconstruí a spec e **não** escrevi nenhum arquivo de spec. Isso é decisão sua, não minha.

**Primeira pergunta, e a mais importante:** você consegue colar ou restaurar o `MARIANA_BEHAVIOR_SPEC.md` v1.1 em `docs/specs/` e commitar? Isso não impede começar o Pacote A, mas impede dar o pacote como "aceito contra a spec" no fim.

## 1. O que eu entendi do problema

Hoje ninguém consegue saber se a Mariana raciocina mal ou se nós apagamos o raciocínio dela. O texto que o modelo escreve é descartado na linha 250 do `src/ai/agent.ts`, as métricas do turno (latência, modelo, tokens) são calculadas, devolvidas e nunca registradas, e existem **onze camadas** que podem reescrever, cortar ou substituir a resposta antes de ela chegar ao cliente — nenhuma delas deixa rastro. Além disso, o modelo é chamado no tier mais barato, com o nome fixo no código, sem temperatura, sem raciocínio configurado e sem limite de saída. Quando o nome do modelo estava errado, em 13 e 14 de outubro, **19 clientes simplesmente não receberam resposta nenhuma** (N6), porque um erro 404 derruba a task e a task não manda nada para o cliente. Por fim, o `vitest` está instalado como dependência de produção, sem configuração e sem uso, e um `npx vitest` rodaria a suíte inteira contra o Neon — foi exatamente assim que ~330 leads de teste chegaram à produção em outubro.

## 2. O que eu vou fazer, passo a passo

São **15 passos obrigatórios e 1 opcional**, em 5 lotes de 1 a 3 passos, para o implementer pegar um lote por vez.

### Lote A — tirar a configuração do modelo do código (passos 1 a 3)

- **O que muda:** `src/env.ts` passa a validar quatro variáveis novas (`GEMINI_MODEL`, `GEMINI_TEMPERATURE`, `GEMINI_THINKING_LEVEL`, `GEMINI_MAX_OUTPUT_TOKENS`), com padrões seguros; o `src/ai/agent.ts` para de usar a constante da linha 36 e passa a montar a configuração da chamada a partir do ambiente; o `.env.example` ganha a documentação. O `.env` de verdade **não** é tocado pelo implementer: os valores são seus.
- **Por que muda:** hoje trocar o modelo exige um deploy e não dá para voltar atrás por configuração (causa direta do N6). E o modelo nunca foi instruído a raciocinar: sem `thinkingLevel`, um tier *flash-lite* roda no mínimo de raciocínio possível.
- **O que o cliente percebe no WhatsApp:** com `temperature = 0.3` as respostas ficam mais previsíveis e repetem menos o cumprimento; com `thinkingLevel = LOW` as respostas tendem a respeitar melhor as regras. A resposta deve demorar entre 0,5 e 2 segundos a mais, o que é invisível perto do debounce de 15 segundos que já existe hoje.

### Lote B — o rastro do turno (passos 4 a 6)

- **O que muda:** um módulo novo, `src/lib/turn-trace.ts`, com o formato do rastro, a função de hash e a função que emite a linha; o `agent.ts` passa a devolver o hash e o tamanho da resposta crua, o `finishReason`, os tokens (inclusive os de raciocínio) e o registro das camadas L0 a L4; o `composeStageReply` ganha uma versão irmã, `composeStageReplyWithTrace`, que devolve também o que foi cortado (camadas L6 a L9). O `composeStageReply` antigo continua existindo e devolvendo exatamente a mesma string, então nenhum teste e nenhum chamador atual muda.
- **Por que muda:** é o passo zero da auditoria. Sem isso, toda afirmação sobre a qualidade da Mariana é anedota, e os pacotes B, C1 e C2 seriam avaliados no escuro.
- **O que o cliente percebe:** **nada**. Nenhum texto muda neste lote.

### Lote C — juntar e registrar (passos 7 e 8)

- **O que muda:** o `generateMarianaResponse.ts` junta os registros de todas as camadas (incluindo a L5, a L10 e a L11, que é a substituição pela lista de horários) e emite **uma única linha** por turno. O `turnId` vem do id da task âncora, para dar para cruzar a linha com a task e com o evento do webhook.
- **Por que muda:** é a linha que responde, para cada turno, "o modelo escreveu o quê, nós entregamos o quê, e quem mexeu no meio".
- **O que o cliente percebe:** **nada**.

**O formato da linha**, em resumo: um JSON por turno, com `event: "mariana_turn"` para você achar com `grep`. Campos: ids (`turnId`, `conversationId`, `leadId`), resultado do turno (`outcome`), configuração usada (`model`, `modelVersionReturned`, `temperature`, `thinkingLevel`, `maxOutputTokens`), desempenho (`latencyMs`, `usage.promptTokens`, `usage.candidatesTokens`, `usage.thoughtsTokens`, `usage.totalTokens`, `finishReason`), estado (`stage`, `postTurnStage`, `questionKey`, `commercialAccessLevel`), ação **pedida pelo modelo** contra ação **executada pelo backend** (`requestedNextAction`, `executedAction`, `actionBlockedReason`), e por fim o que interessa mais: `rawReplyLength`, `rawReplyHash`, `sentReplyLength`, `sentReplyHash`, `pureBackendText` e a lista `rewrites` — uma entrada por camada que **alterou** o texto, com o nome da camada, o tamanho antes e depois, o hash antes e depois, e uma contagem (quantas perguntas foram apagadas, quantas frases foram cortadas, qual fallback entrou).

**A regra de privacidade é mecânica, não é disciplina.** O tipo `TurnTrace` não tem **nenhum campo cujo tipo aceite texto livre**: todo texto é reduzido a um número (o comprimento) e a um hash de 12 caracteres hexadecimais, calculado na hora de montar o rastro. O telefone nunca é passado para o rastro — só o `leadId`. Ou seja: mensagem do cliente, resposta da Mariana, prompt do sistema e base de conhecimento não podem aparecer na linha nem por descuido, porque não existe campo que os aceite. E o texto do cliente não é nem sequer "hasheado": o único texto que passa pelo hash é o que a própria Mariana (ou o backend) escreveu.

**Qual hash e por quê:** SHA-256 do `node:crypto`, em hexadecimal, cortado nos 12 primeiros caracteres (48 bits). As únicas perguntas que eu faço ao hash são "o texto entregue é a mesma string que o modelo escreveu?" e "esse texto é o mesmo texto fixo daquele outro turno?". Para isso, 48 bits sobram: a chance de dois textos diferentes colidirem fica em torno de 1 em 100 mil mesmo com um milhão de turnos. Um hash completo de 64 caracteres triplicaria o tamanho da linha sem responder nada a mais. Sem salt, porque o que é hasheado é texto da própria Mariana, que já fica salvo na tabela `messages` — não há segredo a proteger ali.

**Exemplo de linha, com dados falsos:**

```
{"event":"mariana_turn","turnId":"0f3c5a21-0000-4000-8000-000000000001","conversationId":"...002","leadId":"...003","outcome":"replied","model":"gemini-3.5-flash-lite","temperature":0.3,"thinkingLevel":"LOW","maxOutputTokens":1024,"latencyMs":1432,"usage":{"promptTokens":5871,"candidatesTokens":96,"thoughtsTokens":212,"totalTokens":6179},"finishReason":"STOP","stage":"info","postTurnStage":"consultant_offer","questionKey":"consultantOffer","requestedNextAction":"continue_qualification","executedAction":"continue_qualification","commercialAccessLevel":1,"rawReplyLength":268,"rawReplyHash":"9f2b7c41ad03","sentReplyLength":191,"sentReplyHash":"41d8ee0b7c92","pureBackendText":false,"rewrites":[{"layer":"L6_dropped_questions","lengthBefore":268,"lengthAfter":214,"detail":{"questionsDropped":1}},{"layer":"L8_sentence_cap","lengthBefore":214,"lengthAfter":129,"detail":{"sentencesTruncated":1,"cap":2}}]}
```

Lido em português: nesse turno o modelo escreveu 268 caracteres, a camada L6 apagou 1 pergunta, a L8 cortou 1 frase, e o cliente recebeu 191 caracteres — dos quais parte é texto do backend.

### Lote D — falha do modelo nunca mais deixa o cliente no vácuo (passos 9 a 11)

- **O que muda:** um erro novo, `ModelUnavailableError`, cobre exatamente três casos: a chamada ao Gemini falhar depois das 3 tentativas que já existem no `src/ai/client.ts`, a resposta vir vazia, e a resposta não ser JSON válido. No handler da mensagem recebida (`autonomous-task-handlers.ts:190`), esse erro passa a ser capturado: a Mariana grava uma mensagem de assistente com o aviso, enfileira o aviso no outbox **com a mesma chave de idempotência que já era usada** (`runKey`), marca as mensagens e o evento como processados, registra o erro no log e a **task termina com sucesso**. Ou seja: o cliente recebe uma resposta honesta em vez de silêncio, e a task não fica girando até virar `failed`.
- **Por que muda:** é a causa dos 19 clientes sem resposta do N6. Com o nome do modelo no `.env` (lote A) o erro fica raro, e com este lote ele deixa de ser invisível para o cliente.
- **O que o cliente percebe no WhatsApp:** em vez de nada, ele recebe, uma única vez:

> **"Desculpe, tive uma falha técnica aqui e não consegui processar sua mensagem agora. Pode me enviar de novo em alguns instantes?"**

Eu escolhi esse texto com três cuidados verificados no código: (a) ele **não** contém a frase da oferta de consultor, então o `detectPendingOffer` não arma uma oferta pendente no turno seguinte — isso protege o invariante do `CLAUDE.md` sobre o "sim" que autoriza oferecer horários; (b) ele não casa com nenhum dos seis padrões de compromisso de agendamento, então não promete horário nem reunião; (c) ele pede para reenviar, que é a única coisa verdadeira a dizer, já que a task foi concluída e nada vai tentar de novo sozinho.

**O que este lote cobre e o que não cobre.** Cobre a falha do modelo no caminho da mensagem de texto recebida (404 de nome errado, timeout de transporte, resposta vazia, JSON inválido). **Não cobre** as duas guardas que hoje lançam exceção por causa do *conteúdo* da resposta (a validação de evidência em `validate-response.ts:76` e a assertiva de segurança em `mariana-safety.ts:117`, a finding F-08): consertar isso significa "apagar só a frase ruim em vez de derrubar o turno", o que **muda comportamento de conversa** e é do Pacote C2. Aqui essas falhas passam a aparecer no log como `outcome: "guardrail_throw"`, que é tudo o que o Pacote A promete. Também não cobre os toques de botão sem resposta (Pacote B) nem o evento com lease expirado (Pacote E), e não adiciona prazo máximo para a chamada ao Gemini — hoje não existe timeout nenhum ali, e isso fica para o Pacote E.

### Lote E — proteção dos testes (passos 12 a 15, e o 16 opcional)

- **Passo 12 — tirar o `vitest`.** Ele está em `dependencies` (`package.json:33`), não tem arquivo de configuração, nenhum script usa e nenhum arquivo `.ts`/`.js`/`.json` do projeto o menciona. Sem configuração, o `vitest` pegaria todos os arquivos de teste **sem o preload, sem a guarda e com as credenciais reais do `.env`** — é a receita exata do vazamento de outubro. A prova de que a remoção é segura: o `grep` em todo o repositório (fora do `node_modules`) não acha nenhuma referência, o `node_modules/.bin/vitest` deixa de existir depois do `npm install`, e `npm run build`, `npx tsc --noEmit` e `npm run test:unit` continuam passando.
- **Passo 13 — o `setup-test-db.ts` nunca mais enxerga o Neon.** Hoje a linha 19 chama a guarda, pega o valor devolvido e **joga numa variável local**, sem nunca escrever em `process.env`. Como a linha 7 carrega o `dotenv`, o `DATABASE_URL` continua apontando para o Neon dentro de um processo cuja linha seguinte é `DROP SCHEMA public CASCADE`. Só não deu desastre por sorte: o `drizzle.test.config.ts` resolve a URL por conta própria. A correção é uma linha (`Object.assign(process.env, ...)` antes de abrir a conexão), e o teste de regressão é unitário, sobre uma função pura nova — ele falha hoje e não abre conexão nenhuma.
- **Passo 14 — a guarda vira lista de permissão.** Hoje ela só recusa um host que contenha `neon.tech` (`test-database-guard.ts:53`). Isso não pega um domínio próprio do Neon, um CNAME, um IP, nem um RDS ou um banco de homologação. Passa a exigir `localhost`, `127.0.0.1` ou `::1`, com uma saída de emergência explícita (`ALLOW_REMOTE_TEST_DB=1`) que avisa em voz alta qual host e qual banco — nunca a senha.
- **Passo 15 — o preload dos testes unitários passa a afirmar o que hoje só presume.** Ele funciona porque o `dotenv` não sobrescreve variáveis já definidas; se algum dia alguém usar `override: true`, os testes unitários apontariam para o Neon em silêncio. Passa a ter uma verificação explícita e um comentário dizendo de que ele depende. Admito que é a prova mais fraca do lote: um teste não consegue reexecutar um preload com facilidade.
- **Passo 16, opcional e recomendado:** fechar o buraco na **fonte**, dentro do `src/db/connections.ts`, recusando um banco não local quando o processo é um runner de teste (`--test` em `argv`/`execArgv`), com a mesma saída de emergência. É isso que protege `npx vitest`, `npx tsx --test arquivo.ts` e o runner do VS Code — os três que hoje escapam das guardas, porque elas vivem nos scripts do `npm`, não no código. Deixei opcional porque é o único passo do pacote que coloca uma verificação em módulo de produção; o desenho usa uma função pura e só dispara sob `--test`, mas a decisão é sua.

**Buraco que eu deixo de propósito para depois:** o `RELIABILITY_WORKERS_ENABLED` tem padrão `"true"` no `env.ts:43`, e a segurança depende do preload. Isso só é explorável através dos buracos 1 e 2, e mudar um padrão de produção pertence ao Pacote E.

## 3. O que eu NÃO vou mexer

- Nada de comportamento de conversa: não mexo em prompt, base de conhecimento, filtro de assunto sensível, corte de perguntas, filtro de cumprimento, ordem do agendamento, identidade Ademicon nem no "informar antes de oferecer". Tudo isso é B, C1 e C2.
- Não escolho o modelo. O padrão continua `gemini-3.5-flash-lite`, conforme a sua decisão D-02. A comparação lite contra flash é o Pacote A2, com a sua permissão para chamadas reais.
- Não chamo o Gemini, não rodo o `npm run sim:conversation`, não mando WhatsApp, não chamo o Google Calendar e não toco no Neon.
- Nenhuma migration. Nenhum passo precisa de mudança de schema, então nada aqui fica travado pelo congelamento — guardar o rastro numa tabela precisaria de migration e, por isso, ficou fora de escopo.
- Não mexo no seu `.env` (só no `.env.example`), não faço commit e não crio branch.

## 4. Riscos

1. **O limite de saída pode cortar o JSON.** A auditoria sugeriu 400 tokens; eu recomendo 1024, porque a resposta é um JSON (texto + `leadUpdate` + `evidenceUsed`) e os tokens de raciocínio são cobrados como saída. Se o limite cortar, o `JSON.parse` do `agent.ts:264` estoura. Como vamos perceber: o campo `finishReason` do rastro mostra `MAX_TOKENS`, e o lote D garante que o cliente receba o aviso em vez de silêncio.
2. **A validação do nome do modelo é parcial.** O formato recusa coisas como `gpt-4o`, mas `gemini-3.6-flash-lite` — o erro real do N6 — tem o formato certo e passaria. Conferir de verdade exige chamar a API; deixei isso como pergunta e fora de escopo. O que protege o cliente nesse caso é o lote D.
3. **Custo sobe.** `thinkingLevel = LOW` deve custar algo entre 1,5 e 3 vezes o atual por turno (estimativa da auditoria, §2.1.3). O rastro passa a mostrar os tokens por turno, então o custo deixa de ser estimativa.
4. **Volume de log.** Uma linha por turno, com hashes e números, é pequena; mas se o volume crescer muito, a retenção sugerida é de 7 a 14 dias.
5. **Mudar o `composeStageReply` é mexer no coração do texto.** O risco é alterar a string entregue sem perceber. Proteção: a função antiga continua existindo como casca de uma linha, e há um teste de regressão exigindo texto byte a byte idêntico em três casos.
6. **O lote D mexe no handler de mensagens recebidas**, que é onde vivem dois invariantes do `CLAUDE.md` (evento duplicado nunca processado duas vezes; mensagem que pode ter sido aceita pela Meta nunca volta para `pending`). Proteção: reuso da mesma `runKey` que já existe, nenhuma chave de idempotência nova, e um teste que executa a mesma task duas vezes e exige **uma** linha no outbox. Mais um teste garante que um erro que **não** é do modelo continua derrubando a task — para não engolir erro genérico.
7. **O passo 14 pode atrapalhar algum fluxo seu** se você usar um banco de teste que não seja local. A saída `ALLOW_REMOTE_TEST_DB=1` cobre, mas me diga se isso acontece.

## 5. O que muda no `.env` e os valores que você precisa definir

Nada deixa de funcionar se você não definir nada: as quatro variáveis têm padrão. Mas o ganho está em poder trocá-las sem deploy.

| Variável | Padrão proposto | Valores possíveis | Para que serve |
|---|---|---|---|
| `GEMINI_MODEL` | `gemini-3.5-flash-lite` | nome de modelo da família Gemini | Trocar de modelo (ou voltar atrás) por configuração, sem deploy. É o conserto do N6 |
| `GEMINI_TEMPERATURE` | `0.3` | 0 a 2 | Quanto menor, mais previsível. É o que faz a regra "não cumprimente de novo" ser obedecível |
| `GEMINI_THINKING_LEVEL` | `LOW` | `MINIMAL`, `LOW`, `MEDIUM`, `HIGH` | Profundidade do raciocínio |
| `GEMINI_MAX_OUTPUT_TOKENS` | `1024` | 128 a 8192 | Teto da resposta, incluindo os tokens de raciocínio |

**Sobre o nome da variável de raciocínio.** Você pediu `GEMINI_THINKING_BUDGET` "ou o equivalente no SDK". É o equivalente: eu li as definições de tipo instaladas em `node_modules/@google/genai/dist/genai.d.ts` e a `ThinkingConfig` (linha 15888) aceita `thinkingBudget` **e** `thinkingLevel`, mas a própria documentação do SDK, na linha 13753, diz que **a partir dos modelos Gemini 3.5 o `thinking_budget` deixa de ser suportado e resulta em erro do usuário se for definido; o parâmetro a usar é o `thinking_level`**. Como o nosso modelo é `gemini-3.5-flash-lite`, um orçamento em tokens quebraria a chamada. Por isso a variável é `GEMINI_THINKING_LEVEL`, com os quatro níveis do enum `ThinkingLevel` (linha 15902): `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`.

**Minha decisão e o porquê: `LOW`.** Um tier *flash-lite* sem configuração roda no raciocínio mínimo — é a resposta mais direta ao seu "ela não raciocina". `LOW` é o menor degrau explícito acima disso: custa, pela estimativa da auditoria, de 1,5 a 3 vezes o atual, com 0,5 a 2 segundos a mais por turno, e esses segundos são invisíveis diante dos ~20 segundos de ponta a ponta que o debounce de 15 segundos já impõe hoje. Começar em `MEDIUM` ou `HIGH` subiria custo e latência antes de termos **qualquer** medição — e a medição é justamente o que este pacote entrega. Com a variável no `.env`, você sobe para `MEDIUM` na hora da comparação do Pacote A2, sem deploy, e o rastro mostra em `usage.thoughtsTokens` se o nível realmente surtiu efeito.

## 6. Decisões que preciso de você

1. **A spec v1.1 perdida.** Você consegue colar ou restaurar o `docs/specs/MARIANA_BEHAVIOR_SPEC.md` v1.1 e commitar? Aviso de novo: a cópia que estava na raiz **não é recuperável pelo git**, porque nunca foi versionada. Enquanto isso, os critérios de `R-REL-07` e `S-17` ficam marcados como derivados da sua orientação.
2. **A mensagem de falha ao cliente.** Você aprova este texto exato? *"Desculpe, tive uma falha técnica aqui e não consegui processar sua mensagem agora. Pode me enviar de novo em alguns instantes?"* Recomendo aprovar como está; se quiser mudar, me diga a frase e eu fixo ela num teste.
3. **Nível de raciocínio.** `LOW` (minha recomendação) ou já `MEDIUM`?
4. **Limite de saída.** `1024` (minha recomendação, com margem contra JSON cortado) ou os `400` da auditoria?
5. **Passo 16.** Quer a guarda na fonte, dentro do `src/db/connections.ts`, que fecha de vez o `npx vitest` e o `npx tsx --test`? Recomendo **sim**, com a função pura; mas ela encosta em módulo de produção, então a decisão é sua. A alternativa é parar nos passos 12 a 15.
6. **Modo verboso do rastro.** A auditoria propôs um `TURN_TRACE_VERBOSE` que, ligado, grava o texto cru e o texto enviado em `debug`. Sua lista de quatro itens não pede isso e é a única parte que encostaria em texto de mensagem. Recomendo deixar para o Pacote A2, quando for útil para comparar modelos. Concorda?
7. **Banco de teste remoto.** O passo 14 restringe o `TEST_DATABASE_URL` a localhost, com a saída `ALLOW_REMOTE_TEST_DB=1`. Existe algum fluxo seu que usa um banco de teste não local?

## 7. Pedido de permissão

Resumo do que estou pedindo: 15 passos obrigatórios e 1 opcional, em 5 lotes, sem nenhuma mudança de comportamento de conversa, sem nenhuma migration, sem tocar no Neon, sem chamar o Gemini e sem enviar WhatsApp. O único texto novo que o cliente pode ver é a mensagem de falha técnica do item 6.2.

**Nada vai ser implementado e nada vai ser commitado até você responder.** O plano está em `docs/work/2026-10-22-pkg-A/plan.md` com a primeira linha `Status: DRAFT`, e o implementer se recusa a trabalhar num plano que não está aprovado.

Posso seguir com este plano? Responda: **aprovo** / **aprovo com mudanças** (diga quais) / **não aprovo**.
