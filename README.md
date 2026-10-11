# 🧠 Mariana

<p>
  <img src="https://img.shields.io/badge/Node.js-24-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js 24" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Fastify-5-000000?style=for-the-badge&logo=fastify&logoColor=white" alt="Fastify 5" />
  <img src="https://img.shields.io/badge/PostgreSQL-Drizzle-4169E1?style=for-the-badge&logo=postgresql&logoColor=white" alt="PostgreSQL + Drizzle" />
</p>

<p>
  <img src="https://img.shields.io/badge/Gemini-AI-8E75B2?style=for-the-badge&logo=google&logoColor=white" alt="Gemini AI" />
  <img src="https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="WhatsApp Cloud API" />
  <img src="https://img.shields.io/badge/Google%20Calendar-Integration-4285F4?style=for-the-badge&logo=googlecalendar&logoColor=white" alt="Google Calendar" />
</p>

<p>
  <a href="https://github.com/DaviC18/Mariana">Repository</a> ·
  <a href="https://github.com/DaviC18/Mariana/tree/develop">Develop</a> ·
  <a href="https://www.linkedin.com/in/david-curty-84b2a0285/">Davi Curty</a>
</p>

</div>

Mariana é um agente backend-first de atendimento comercial via WhatsApp
para uma empresa de consórcio. O sistema automatiza o pré-atendimento de
leads provenientes de campanhas de Google Ads e Meta Ads, conduz uma
qualificação estruturada, consulta a disponibilidade de consultores no
Google Calendar e conduz o agendamento de uma reunião humana quando há
interesse e confirmação explícita.

> **Estado documentado:** 24/09/2026\
> **Branch de referência:** `develop`\
> **Repositório:** `github.com/DaviC18/Mariana`

O projeto está sendo construído inicialmente **sem frontend**. O foco
atual é o backend responsável pelo fluxo de atendimento, qualificação,
disponibilidade e agendamento via WhatsApp.

------------------------------------------------------------------------

## Visão geral

O fluxo comercial de alto nível é:

``` text
Lead
  │
  │ Google Ads / Meta Ads
  ▼
WhatsApp
  │
  ▼
Webhook
  │
  ▼
Fastify
  │
  ▼
Mariana / Gemini
  │
  ├── Qualificação
  │
  └── Interesse em falar com consultor
             │
             ▼
     Google Calendar
             │
             ▼
      Oferta de horários
             │
             ▼
      Escolha estruturada
             │
             ▼
    Confirmação explícita
             │
             ▼
      AppointmentService
        │           │
        ▼           ▼
 Google Calendar  PostgreSQL
```

O objetivo é que somente leads qualificados e interessados em falar com
um consultor avancem para o agendamento.

### Regras comerciais

Mariana pode:

-   explicar consórcio de forma geral;
-   qualificar o lead;
-   identificar interesse em falar com um consultor;
-   consultar disponibilidade real;
-   conduzir o processo de agendamento.

Mariana não deve:

-   recomendar grupo ou carta específica;
-   informar porcentagem de lance como estratégia personalizada;
-   fornecer estratégia personalizada de consórcio;
-   garantir contemplação ou prazo;
-   inventar horários, consultores, disponibilidade, IDs ou resultados
    de agendamento.

A disponibilidade deve ser determinada pelo backend e pelo Google
Calendar. O agendamento só deve ser criado após a qualificação e a
confirmação explícita do usuário.

A conversa deve permanecer objetiva, com uma pergunta principal por
mensagem, sem pressionar o lead a marcar uma reunião prematuramente.

------------------------------------------------------------------------

## Principais funcionalidades

### Atendimento via WhatsApp

-   Recebimento de mensagens por webhook.
-   Validação de assinatura HMAC SHA-256.
-   Identificação do lead pelo telefone.
-   Criação ou reutilização de uma conversa ativa.
-   Persistência das mensagens inbound.
-   Deduplicação lógica por `externalId`, principalmente WAMID.
-   Envio de mensagens de texto.
-   Persistência do WAMID das mensagens outbound.

### Qualificação comercial

O lead passa pelos estados:

``` text
new → qualifying → qualified → scheduled
```

A qualificação considera:

-   data de nascimento válida para maioridade;
-   objetivo;
-   tipo de consórcio;
-   situação atual;
-   dor ou motivação;
-   interesse explícito em falar com consultor.

A promoção para `scheduled` depende da existência de um appointment
confirmado.

### Inteligência artificial

O Gemini é utilizado como camada conversacional para:

-   processamento de texto livre;
-   diálogo;
-   qualificação;
-   definição da próxima ação conversacional.

A IA não é responsável por:

-   escolher horários;
-   escolher consultores;
-   inventar disponibilidade;
-   resolver IDs de botões;
-   criar diretamente appointments.

Essas operações pertencem a serviços determinísticos do backend.

### Disponibilidade

O sistema consulta a disponibilidade dos consultores utilizando o Google
Calendar.

As regras atuais documentadas são:

-   horário comercial entre `08:00` e `18:00`;
-   dias úteis;
-   slots de 30 minutos;
-   verificação de sobreposição e conflitos;
-   no máximo três horários apresentados por oferta;
-   horários formatados em `America/Sao_Paulo`.

### Scheduling Session

A oferta de horários é persistida em uma sessão de agendamento.

Uma `scheduling_session` possui:

-   UUID;
-   `leadId`;
-   `conversationId`;
-   `status`;
-   `createdAt`;
-   `expiresAt`;
-   `updatedAt`.

Os estados documentados são:

``` text
active
closed
expired
```

Existe uma restrição para permitir apenas uma sessão `active` por lead.

### Scheduling Slots

Cada horário ofertado é persistido como um `scheduling_slot`.

Os dados documentados incluem:

-   UUID;
-   referência à sessão;
-   `position`;
-   `consultantId`;
-   `consultantName`;
-   `calendarId`;
-   `startAt`;
-   `endAt`;
-   `createdAt`.

Existem constraints para:

-   unicidade de `(schedulingSessionId, position)`;
-   `position > 0`;
-   `startAt < endAt`.

### Agendamento

O `AppointmentService` atua como última barreira de validação antes da
criação do evento.

O serviço:

1.  valida data/hora;
2.  valida consultor;
3.  valida o lead qualificado;
4.  verifica conflitos no PostgreSQL;
5.  reconsulta a disponibilidade no Google Calendar;
6.  cria o evento no Google Calendar;
7.  persiste o appointment;
8.  promove o lead para `scheduled`;
9.  fecha a sessão.

### Seleção de horários por botões

A evolução definida para a Etapa 10 substitui a seleção textual de
horários, como `1/2/3`, por botões interativos do WhatsApp.

Quando existem dois ou três horários:

``` text
Tenho estes horários disponíveis:

[25/09 às 10:00]
[25/09 às 14:00]
[26/09 às 09:30]
```

Após o clique:

``` text
Você escolheu 25/09 às 14:00.

Posso confirmar esse horário para você?

[Confirmar] [Não]
```

Quando existe apenas um horário, não há etapa de escolha:

``` text
Temos apenas um horário disponível:

25/09 às 10:00

Posso confirmar esse horário para você?

[Confirmar] [Não]
```

**Importante:** a implementação dos botões, da seleção, da confirmação e
do fluxo interativo completo ainda está planejada no estado documentado.

------------------------------------------------------------------------

## Arquitetura

A aplicação segue uma arquitetura modular em TypeScript.

### Camadas principais

  -----------------------------------------------------------------------
  Camada                              Responsabilidade
  ----------------------------------- -----------------------------------
  Webhook                             HTTP, assinatura, parsing do
                                      payload e roteamento por tipo de
                                      mensagem

  WhatsApp Integration                Conversão entre o modelo interno e
                                      os payloads da WhatsApp Cloud API

  Conversação                         Recepção, persistência e
                                      processamento das mensagens

  Gemini                              Texto livre, diálogo e qualificação

  SchedulingAvailabilityService       Consulta e validação da
                                      disponibilidade

  SchedulingOfferService              Persistência da sessão e dos
                                      horários ofertados

  SchedulingChoiceService             Resolução e validação da escolha
                                      estruturada

  AppointmentService                  Validação final e criação do
                                      appointment/evento

  PostgreSQL / Drizzle                Persistência relacional,
                                      constraints e transações

  Google Calendar                     FreeBusy, criação de eventos e
                                      exclusão compensatória
  -----------------------------------------------------------------------

### Separação de responsabilidades

O webhook não deve conter regras comerciais complexas.

A integração do WhatsApp não deve decidir qual horário é válido.

O Gemini não deve interpretar IDs de botões.

O `SchedulingOfferService` não deve criar eventos no Google Calendar.

O `SchedulingChoiceService` não deve chamar Gemini, recalcular
disponibilidade ou criar appointments.

O `AppointmentService` não deve interpretar diretamente o payload bruto
do WhatsApp.

------------------------------------------------------------------------

## Fluxo de mensagens atual

O fluxo atualmente documentado para mensagens de texto é:

``` text
WhatsApp
   │
   ▼
webhook-whatsapp
   │
   ├── valida HMAC
   ├── faz parsing
   └── aceita type=text no estado atual
   │
   ▼
find/create lead
   │
   ▼
find/create active conversation
   │
   ▼
receiveCustomerMessage
   │
   ├── grava messages(user)
   └── debounce para role=user
   │
   ▼
generateMarianaResponse
   │
   ▼
Gemini
   │
   ▼
próxima ação / resposta
   │
   ▼
sendTextMessage
   │
   ▼
salva WAMID outbound
```

Esse fluxo não deve ser reutilizado diretamente para
`interactive.button_reply`, porque uma resposta de botão representa uma
decisão estruturada e não precisa passar pelo debounce ou pelo Gemini.

------------------------------------------------------------------------

## Fluxo de agendamento

### 1. Oferta

``` text
Gemini / Mariana
       │
       ▼
  offer_meeting
       │
       ▼
SchedulingAvailabilityService
       │
       ▼
  até 3 slots
       │
       ▼
SchedulingOfferService
       │
       ├── scheduling_session
       ├── scheduling_slots
       └── assistant message
       │
       ▼
WhatsAppService / Client
       │
       ▼
interactive buttons
       │
       ▼
salvar WAMID outbound
```

### 2. Escolha

O fluxo planejado para a escolha estruturada é:

``` text
interactive.button_reply
       │
       ▼
webhook + HMAC
       │
       ▼
parser / normalizador
       │
       ▼
lead + conversation
       │
       ▼
idempotência WAMID
       │
       ▼
SchedulingChoiceService
       │
       ├── session
       ├── slot
       ├── lead
       ├── conversation
       ├── TTL
       └── estado
       │
       ▼
slot selecionado
       │
       ▼
"Posso confirmar?"
       │
       ├──────────────┐
       ▼              ▼
 [Confirmar]        [Não]
```

### 3. Confirmação

``` text
Confirmar
    │
    ▼
AppointmentService
    │
    ├── Google Calendar
    ├── PostgreSQL appointment
    ├── lead = scheduled
    └── session = closed
    │
    ▼
confirmação WhatsApp
```

Com dois ou três slots, `Não` limpa a seleção e reapresenta a mesma
oferta.

Com um único slot, `Não` fecha a sessão e informa que o horário não será
confirmado.

Não deve haver consulta automática a novos horários nessa resposta.

------------------------------------------------------------------------

## Modelo de estado do agendamento

A decisão de desenho documentada é manter os três estados atuais da
sessão:

``` text
active
closed
expired
```

A seleção do horário deve ser representada no próprio slot por um campo
planejado como `selectedAt`, em vez de adicionar um estado
`pending_confirmation` à sessão.

> `selectedAt` ainda não existe no schema atual documentado. A
> implementação da seleção permanece planejada.

### Transições

``` text
active + sem seleção
        │
        │ usuário escolhe
        ▼
active + slot selecionado
        │
        ├── Confirmar ──► AppointmentService
        │                    │
        │                    ▼
        │              appointment
        │                    │
        │                    ▼
        │                  closed
        │
        └── Não
             │
             ├── 2/3 slots → limpa seleção e reapresenta
             │
             └── 1 slot → fecha sessão

active
  │
  │ TTL vencido
  ▼
expired
```

------------------------------------------------------------------------

## Identidade dos botões

A posição visual do botão (`1`, `2` ou `3`) não deve ser utilizada como
identificador de negócio.

O identificador técnico deve apontar para o slot persistido.

Formato proposto:

``` text
schedule:slot:<slotId>
schedule:confirm:<sessionId>:<slotId>
schedule:reject:<sessionId>:<slotId>
```

O `reply.id` é a autoridade técnica. O `reply.title` serve apenas como
texto visual/auditoria.

### Validações obrigatórias

Ao receber um botão, o backend deve validar:

-   existência do slot;
-   pertencimento do slot à sessão;
-   pertencimento da sessão ao lead identificado;
-   pertencimento da sessão à conversation esperada;
-   sessão em estado `active`;
-   `expiresAt > now`;
-   possibilidade de seleção do slot;
-   ausência de consumo por replay/concorrência.

------------------------------------------------------------------------

## SchedulingChoiceService

O `SchedulingChoiceService` é um serviço planejado para interpretar uma
escolha persistida de oferta.

### Responsabilidades

Deve:

1.  receber `leadId`, `conversationId`, `buttonId`, `WAMID` e `now`;
2.  validar o formato do identificador;
3.  resolver slot e sessão;
4.  validar posse, conversation, estado e expiração;
5.  selecionar/deselecionar o slot de forma atômica;
6.  retornar um resultado tipado para a camada seguinte.

### Não deve

-   chamar Gemini;
-   interpretar texto livre;
-   recalcular disponibilidade;
-   escolher outro consultor;
-   criar appointment;
-   interpretar diretamente o payload HTTP bruto do WhatsApp.

O fluxo previsto é:

``` text
Webhook
  │
  ▼
Normalizador
  │
  ▼
SchedulingChoiceService
  │
  ▼
Orquestrador de confirmação
  │
  ▼
AppointmentService
```

------------------------------------------------------------------------

## Tecnologias utilizadas

  -----------------------------------------------------------------------
  Tecnologia                          Finalidade
  ----------------------------------- -----------------------------------
  Node.js 24.18                       Runtime do backend

  npm 11.16                           Gerenciamento de dependências e
                                      scripts

  TypeScript                          Linguagem principal e tipagem de
                                      domínio/integrações

  Fastify 5                           Servidor HTTP e rotas

  Zod 4                               Validação e contratos de
                                      entrada/estrutura

  Drizzle ORM 1 RC                    Schema relacional, queries,
                                      transações e migrations

  PostgreSQL                          Persistência principal

  postgres.js                         Driver/conexão com banco

  Google GenAI SDK                    Integração com Gemini

  Google Calendar API                 FreeBusy, criação e exclusão de
                                      eventos

  WhatsApp Cloud API                  Canal de entrada e saída

  Docker                              Ambiente de apoio e serviços locais

  tsx                                 Execução de TypeScript em
                                      desenvolvimento/testes

  tsup                                Build do servidor

  Ultracite / Biome                   Check e padronização de código

  ngrok                               Exposição local do webhook durante
                                      testes
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## Estrutura do projeto

A estrutura abaixo reúne os principais caminhos explicitamente
identificados no dossiê técnico:

``` text
src/
├── integrations/
│   └── whatsapp/
│       ├── whatsapp-types.ts
│       ├── whatsapp-client.ts
│       └── whatsapp-service.ts
│
├── routes/
│   └── whatsapp/
│       └── webhook-whatsapp.ts
│
├── services/
│   ├── conversations/
│   │   ├── receive-customer-message.ts
│   │   └── generateMarianaResponse.ts
│   │
│   └── calendar/
│       ├── scheduling-availability-service.ts
│       ├── scheduling-offer-service.ts
│       ├── appointment-service.ts
│       └── scheduling-choice-service.ts
│          # planejado no estado documentado
│
├── db/
│   └── schema/
│       ├── leads.ts
│       ├── conversations.ts
│       ├── messages.ts
│       ├── scheduling-sessions.ts
│       └── scheduling-slots.ts
│
└── tests/
    └── services/
        ├── generate-mariana-response.test.ts
        └── scheduling-session.test.ts
```

O dossiê não fornece uma árvore completa do repositório; portanto, esta
seção apresenta somente os caminhos explicitamente identificados.

------------------------------------------------------------------------

## Configuração e instalação

O dossiê fornece os scripts e requisitos técnicos abaixo, mas não
especifica neste documento um procedimento completo de instalação do
ambiente do zero.

### Pré-requisitos identificados

-   Node.js `24.18`
-   npm `11.16`
-   PostgreSQL
-   credenciais/configuração do Google GenAI/Gemini;
-   credenciais OAuth 2.0 do Google Calendar;
-   configuração da WhatsApp Cloud API;
-   para testes locais do webhook, um túnel como ngrok.

### Scripts disponíveis

``` bash
npm run dev
npm run build
npm run start
npm run test
npm run check
npm run fix

npm run db:generate
npm run db:migrate
npm run db:seed
```

Equivalência documentada:

``` text
build       = tsup src/server.ts --format cjs --clean
check       = ultracite check
db:generate = drizzle-kit generate
db:migrate  = drizzle-kit migrate
db:seed     = tsx src/db/seed.ts
dev         = tsx watch src/server.ts
fix         = ultracite fix
start       = node dist/server.js
test        = tsx --test
```

> O dossiê não especifica valores concretos para as variáveis de
> ambiente nem fornece um passo a passo adicional de provisionamento do
> PostgreSQL. Por isso, esses detalhes não são inventados aqui.

------------------------------------------------------------------------

## Variáveis de ambiente

O projeto utiliza variáveis de ambiente para credenciais do Gemini,
OAuth do Google e integrações externas.

O dossiê não fornece uma lista completa e validada dos nomes das
variáveis. Portanto, este README não inventa nomes de variáveis.

Nunca versionar:

-   tokens;
-   refresh tokens;
-   API keys;
-   senhas;
-   IDs secretos;
-   outros valores sensíveis.

Os valores secretos também não devem aparecer em prompts, logs ou
documentação compartilhada.

------------------------------------------------------------------------

## API

### WhatsApp Webhook

O projeto possui um webhook para integração com a WhatsApp Cloud API.

O fluxo atual documentado inclui:

-   validação da assinatura HMAC SHA-256;
-   parsing do payload;
-   recebimento de mensagens `text`;
-   identificação do lead;
-   identificação/criação de conversation;
-   persistência da mensagem;
-   geração de resposta;
-   envio da resposta;
-   persistência do WAMID outbound.

O dossiê não especifica o método e o path HTTP exatos do endpoint. Por
isso, eles não são documentados como se fossem conhecidos.

### `interactive.button_reply`

O suporte a `interactive.button_reply` está planejado para a evolução do
fluxo de horários.

Quando implementado, o webhook deverá distinguir mensagens de texto de
respostas estruturadas de botões.

Respostas de botão:

-   não devem passar pelo debounce;
-   não devem chamar Gemini;
-   devem ser resolvidas diretamente contra `scheduling_slot` e
    `scheduling_session`;
-   devem validar lead, conversation, estado e TTL;
-   devem ser tratadas de forma idempotente.

------------------------------------------------------------------------

## Banco de dados

O PostgreSQL é a persistência principal e o acesso é realizado com
Drizzle ORM.

### Lead

Concentra os dados de qualificação e o estado comercial.

Dados de qualificação documentados:

-   nome;
-   telefone;
-   data de nascimento;
-   objetivo;
-   tipo de consórcio;
-   situação atual;
-   dor/motivação;
-   urgência;
-   abordagem comercial;
-   `interestedInConsultant`.

Estados:

``` text
new
qualifying
qualified
scheduled
```

O telefone é indexado, mas não é único.

### Conversation

Uma conversation pertence a um lead.

Estados:

``` text
active
closed
```

As mensagens estão vinculadas à conversation e `updatedAt` é atualizado.

### Message

Mensagens possuem:

-   `role`: `user`, `assistant` ou `system`;
-   `content`;
-   `externalId`;
-   timestamps.

`externalId` é utilizado para deduplicação de mensagens externas,
principalmente WAMID.

> O dossiê registra que `externalId` está indexado, mas não possui
> constraint `UNIQUE`, deixando uma pequena janela para duplicação
> concorrente.

### Scheduling Session

Representa uma oferta de horários.

Campos documentados:

``` text
id
leadId
conversationId
status
createdAt
expiresAt
updatedAt
```

Estados:

``` text
active
closed
expired
```

Há um índice parcial para permitir somente uma sessão `active` por lead.

### Scheduling Slot

Representa cada horário persistido em uma sessão.

Campos documentados:

``` text
id
schedulingSessionId
position
consultantId
consultantName
calendarId
startAt
endAt
createdAt
```

Constraints documentadas:

``` text
UNIQUE (schedulingSessionId, position)
position > 0
startAt < endAt
```

A representação persistida da seleção por meio de `selectedAt` ainda é
planejada.

### Appointment

O appointment é persistido pelo fluxo final de agendamento.

O dossiê não fornece o schema completo dessa entidade, portanto este
README não inventa seus campos.

------------------------------------------------------------------------

## Autenticação e autorização

### WhatsApp

O webhook utiliza validação de assinatura:

``` text
HMAC SHA-256
```

### Google Calendar

A integração utiliza:

``` text
OAuth 2.0
```

O ambiente de desenvolvimento utiliza uma conta Google pessoal e o
escopo cobre operações de FreeBusy e eventos.

Os calendários atualmente conectados são de desenvolvimento/teste e não
representam os calendários reais do cliente em produção.

### Aplicação

O dossiê não especifica um sistema separado de autenticação de usuários
do backend. Não há informação suficiente para documentar mecanismos
adicionais de autenticação/autorização.

------------------------------------------------------------------------

## Integrações

### WhatsApp Cloud API

Responsável pelo canal de comunicação com os leads.

Uso documentado:

-   recebimento de mensagens;
-   webhook;
-   validação HMAC;
-   envio de mensagens;
-   WAMID;
-   futura utilização de mensagens interativas com botões.

### Google GenAI / Gemini

Responsável pelo processamento conversacional de texto livre e
qualificação.

O Gemini não deve ser utilizado para resolver decisões estruturadas de
agendamento.

### Google Calendar API

Responsável por:

-   consultar disponibilidade via FreeBusy;
-   criar eventos;
-   excluir eventos quando necessário para compensação.

### Google Ads e Meta Ads

São as origens comerciais dos leads previstas no fluxo do produto.

O dossiê descreve essas plataformas como fontes das campanhas que levam
os contatos ao WhatsApp, mas não documenta uma integração direta dessas
APIs dentro do backend atual.

------------------------------------------------------------------------

## IA e governança

A IA possui um papel deliberadamente limitado no domínio.

``` text
Texto livre
    │
    ▼
Gemini
    │
    ├── conversa
    ├── qualificação
    └── próxima ação
```

As decisões críticas de agendamento são determinísticas:

``` text
Disponibilidade
    │
    ▼
SchedulingAvailabilityService
    │
    ▼
SchedulingOfferService
    │
    ▼
slots persistidos
    │
    ▼
SchedulingChoiceService
    │
    ▼
AppointmentService
```

### Regra central

O Gemini nunca deve inventar:

-   horários;
-   consultores;
-   disponibilidade;
-   IDs;
-   resultados de agendamento.

### Retry

A integração utiliza retry para respostas HTTP transitórias e limites de
taxa:

``` text
408
429
500
502
503
504
```

O retry utiliza:

-   backoff exponencial;
-   jitter;
-   atraso máximo limitado.

------------------------------------------------------------------------

## Segurança

Mecanismos documentados:

-   HMAC SHA-256 no webhook;
-   validação de entrada com Zod;
-   OAuth 2.0 para Google Calendar;
-   persistência de TTL das sessões;
-   validação de lead/conversation/session/slot;
-   verificação de conflitos antes do agendamento;
-   reconsulta do Google Calendar antes da criação do evento;
-   exclusão compensatória de evento quando a transação do banco falha;
-   deduplicação lógica por `externalId`/WAMID;
-   uso de IDs persistidos para resolver botões, em vez de confiar na
    posição visual;
-   separação entre IA conversacional e decisões determinísticas de
    agendamento.

### Pontos de endurecimento identificados

O dossiê identifica algumas proteções como planejadas:

-   idempotência atômica e possível `UNIQUE` para `externalId`;
-   consumo atômico da seleção;
-   idempotência do appointment;
-   validação integral de `buttonId` contra o banco;
-   observabilidade e recuperação de compensações.

### Caveat de consistência

Google Calendar e PostgreSQL não participam de uma transação
distribuída.

O código utiliza exclusão compensatória do evento caso a transação do
banco falhe, mas permanece uma janela de corrida entre a verificação de
disponibilidade e a criação do evento.

------------------------------------------------------------------------

## Testes

O projeto utiliza o runner de testes do Node via `tsx`:

``` bash
npm run test
```

Testes explicitamente mencionados:

``` text
src/tests/services/generate-mariana-response.test.ts
src/tests/services/scheduling-session.test.ts
```

### Validações já registradas

No estado documentado em 24/09/2026:

-   `generate-mariana-response.test.ts`: 6 testes passaram;
-   `scheduling-session.test.ts`: 8 testes passaram;
-   `npm run check`: 103 arquivos verificados sem correções;
-   `npm run build`: concluído com sucesso.

O resultado capturado da execução completa de `npm test` não apresentou
o resumo final. Portanto, o dossiê não considera a suíte completa como
aprovada.

### Testes planejados para a finalização

#### WhatsApp

-   parsing e tipagem de `text` e `interactive.button_reply`;
-   payload outbound com 1, 2 e 3 botões;
-   títulos respeitando formato e limites;
-   persistência correta do WAMID outbound;
-   falha HTTP sem falso positivo de envio.

#### SchedulingChoiceService

-   slot válido;
-   slot inexistente;
-   slot de outra sessão;
-   sessão de outro lead/conversation;
-   sessão fechada;
-   sessão expirada;
-   troca de seleção;
-   duas escolhas concorrentes.

#### Confirmação

-   `Confirmar` chama `AppointmentService` uma única vez;
-   slot selecionado chega com dados persistidos;
-   appointment só é criado após validação;
-   conflito recente no Google Calendar impede a confirmação;
-   `Não` em oferta de 2/3 slots limpa a seleção e reapresenta a oferta;
-   `Não` em oferta de 1 slot fecha a sessão.

#### Gemini

Um evento `interactive.button_reply` não deve disparar Gemini nem o
debounce da conversa.

------------------------------------------------------------------------

## Deploy e ambiente

O dossiê não especifica uma plataforma de produção definitiva para o
backend.

### Desenvolvimento local

O webhook pode ser exposto durante testes por meio de um túnel como:

``` text
ngrok
```

### Google Calendar

Antes da produção:

-   substituir os calendários de desenvolvimento pelos calendários reais
    dos consultores;
-   substituir credenciais OAuth de desenvolvimento pelas credenciais
    apropriadas ao ambiente de produção.

Os consultores usados no ambiente de teste --- João, Maria e Carlos ---
são fictícios.

### WhatsApp / Meta

Para testes reais de entrega, é necessário um ambiente de negócio e
número autorizado.

O dossiê registra que um número de teste da Meta retornou o código
`130497`, associado a uma restrição da conta de negócio de teste para
mensagens ao país do destinatário. O incidente foi tratado como uma
limitação do ambiente Meta, e não como uma falha do backend Mariana.

------------------------------------------------------------------------

## Status do projeto

### Implementado

Segundo o estado consolidado no dossiê:

-   base de leads;
-   conversations;
-   messages;
-   qualificação com IA;
-   integração com Google Calendar;
-   consulta de disponibilidade;
-   `AppointmentService`;
-   `Scheduling Session`;
-   limite de até três horários por oferta;
-   persistência de `Scheduling Slots`;
-   webhook e recebimento de mensagens de texto;
-   validação HMAC;
-   persistência e deduplicação lógica de mensagens;
-   envio de texto e armazenamento do WAMID outbound.

### Implementado e validado na Etapa 10

A persistência original da Etapa 10 foi implementada.

O `SchedulingOfferService`:

1.  fecha a sessão ativa anterior;
2.  cria uma nova sessão;
3.  define expiração de 15 minutos;
4.  persiste os slots;
5.  atualiza a mensagem do assistant.

### Em desenvolvimento / planejado

-   suporte a `interactive.button_reply`;
-   envio de mensagens interativas;
-   seleção persistida de slot;
-   `SchedulingChoiceService`;
-   orquestrador de confirmação;
-   tratamento de `Confirmar` / `Não`;
-   integração do fluxo interativo com o `AppointmentService`;
-   testes de botões, seleção, confirmação, expiração e concorrência;
-   validação E2E do fluxo interativo;
-   validação no WhatsApp em ambiente autorizado.

### Limitações atuais

No estado documentado:

-   o webhook processa somente mensagens `text`;
-   o modelo de `interactive.button_reply` ainda não está implementado;
-   a seleção persistida via `selectedAt` ainda não existe no schema;
-   o `SchedulingChoiceService` ainda é planejado;
-   o orquestrador de confirmação ainda é planejado;
-   a suíte completa de testes ainda não possui resultado final
    registrado;
-   os calendários atuais são de desenvolvimento/teste;
-   o ambiente Meta utilizado anteriormente apresentou uma restrição de
    entrega.

------------------------------------------------------------------------

## Roadmap

### V1

A versão 1 contempla:

-   WhatsApp texto;
-   webhook;
-   idempotência básica;
-   leads;
-   conversations;
-   messages;
-   Gemini;
-   qualificação;
-   identificação de interesse em consultor;
-   disponibilidade;
-   oferta;
-   escolha;
-   confirmação;
-   appointment;
-   testes E2E.

### V1.5

Planejado:

-   status de entrega;
-   retries mais robustos;
-   idempotência reforçada;
-   tratamento de concorrência;
-   cancelamento;
-   reagendamento;
-   lembretes.

### V2

Planejado:

-   imagens;
-   PDFs;
-   documentos;
-   áudio;
-   visão;
-   transcrição;
-   extração multimodal.

------------------------------------------------------------------------

## Ordem de implementação da próxima etapa

A ordem acordada no dossiê é:

1.  fechar o contrato de estado e seleção;
2.  alterar o schema de slot, se aprovado, e gerar/aplicar migration;
3.  adicionar tipos do WhatsApp interativo;
4.  adicionar envio interativo no `WhatsAppClient`;
5.  expor envio interativo no `WhatsAppService`;
6.  ajustar `SchedulingOfferService` para o caso de 1 slot e dados
    outbound;
7.  ajustar `generateMarianaResponse` para expor a oferta estruturada ao
    chamador;
8.  criar `SchedulingChoiceService`;
9.  criar o orquestrador de confirmação e integrá-lo ao
    `AppointmentService`;
10. ajustar `receiveCustomerMessage` para não enviar mensagens
    interativas ao Gemini;
11. ajustar o webhook para inbound `text` + `interactive`;
12. adicionar e executar testes direcionados;
13. executar `check`;
14. executar `build`;
15. executar a suíte completa e registrar o resultado real;
16. validar no WhatsApp com ambiente autorizado.

### Método de trabalho

As alterações devem ser feitas em pequenos blocos, com teste e validação
local antes de avançar.

A preferência estabelecida para o projeto é revisar pessoalmente cada
mudança antes de continuar.

------------------------------------------------------------------------

## Critérios objetivos de conclusão da etapa atual

A finalização do fluxo de horários por botões deve atender aos seguintes
critérios:

  -----------------------------------------------------------------------
  Área                                Critério
  ----------------------------------- -----------------------------------
  Persistência                        Sessão e slots persistidos
                                      corretamente, com TTL e seleção

  Oferta                              1, 2 ou 3 horários apresentados
                                      pelo WhatsApp de forma estruturada

  Escolha                             `button_reply` resolve exatamente
                                      um slot persistido

  Confirmação                         `Confirmar` e `Não` possuem
                                      comportamento determinístico

  Segurança                           Lead, conversation, session, TTL e
                                      slot são validados

  Idempotência                        Replay não gera duas consequências

  Agendamento                         `AppointmentService` permanece como
                                      barreira final

  Qualidade                           Check, build e testes relevantes
                                      passam
  -----------------------------------------------------------------------

------------------------------------------------------------------------

## Alterações previstas

  ---------------------------------------------------------------------------------------------------------------
  Arquivo / área                                             Status                  Objetivo
  ---------------------------------------------------------- ----------------------- ----------------------------
  `src/integrations/whatsapp/whatsapp-types.ts`              Alterar                 Adicionar tipos de
                                                                                     `interactive/button_reply`

  `src/integrations/whatsapp/whatsapp-client.ts`             Alterar                 Enviar mensagens interativas
                                                                                     com até 3 botões

  `src/integrations/whatsapp/whatsapp-service.ts`            Alterar                 Expor operação de envio
                                                                                     interativo

  `src/routes/whatsapp/webhook-whatsapp.ts`                  Alterar                 Processar `text` e
                                                                                     `interactive.button_reply`

  `src/services/conversations/receive-customer-message.ts`   Alterar                 Persistir interativo sem
                                                                                     enviar automaticamente para
                                                                                     debounce/Gemini

  `src/services/conversations/generateMarianaResponse.ts`    Alterar                 Expor contexto estruturado
                                                                                     da oferta

  `src/services/calendar/scheduling-offer-service.ts`        Alterar                 Registrar seleção de 1 slot
                                                                                     e dados necessários à oferta

  `src/db/schema/scheduling-slots.ts`                        Alterar                 Adicionar representação
                                                                                     persistida da seleção, se
                                                                                     aprovada

  `src/services/calendar/scheduling-choice-service.ts`       Criar                   Resolver e validar
                                                                                     `buttonId` contra sessão +
                                                                                     slot

  Orquestrador de confirmação                                Criar                   Tratar `Confirmar`/`Não` e
                                                                                     chamar `AppointmentService`

  `src/services/calendar/appointment-service.ts`             Manter                  Continuar como validação
                                                                                     final e criação

  `src/db/schema/scheduling-sessions.ts`                     Manter inicialmente     Estados atuais são
                                                                                     suficientes

  `src/db/schema/messages.ts`                                Manter inicialmente     Modelo atual suporta
                                                                                     auditoria e WAMID

  Migration                                                  Criar quando necessária Aplicar somente alterações
                                                                                     de schema aprovadas

  Testes                                                     Expandir                Cobrir botões, seleção,
                                                                                     confirmação, expiração e
                                                                                     concorrência
  ---------------------------------------------------------------------------------------------------------------

------------------------------------------------------------------------

## Decisões técnicas importantes

### IA fora do caminho crítico de agendamento

A IA é utilizada para conversação e qualificação, enquanto decisões de
agendamento são feitas por serviços determinísticos.

Isso evita que uma resposta generativa altere diretamente:

-   horário;
-   consultor;
-   disponibilidade;
-   identificadores;
-   resultado de agendamento.

### Persistência da oferta

Os horários apresentados ao usuário são persistidos em
`scheduling_session` e `scheduling_slots`.

Isso permite que a escolha posterior seja resolvida contra dados
persistidos, em vez de depender novamente de texto livre.

### Identificador técnico independente da posição

O número visual do botão não representa a identidade do horário.

O backend utiliza IDs persistidos de slot/sessão, reduzindo ambiguidades
quando uma nova oferta substitui uma anterior.

### AppointmentService como última barreira

Mesmo após a seleção do usuário, o appointment só é criado depois de
novas validações de domínio, PostgreSQL e Google Calendar.

------------------------------------------------------------------------

## Limitações e observações

### Consistência entre PostgreSQL e Google Calendar

Não existe transação distribuída entre os dois sistemas.

O mecanismo atual utiliza exclusão compensatória do evento quando a
transação do banco falha. Ainda existe uma janela de corrida entre a
consulta de disponibilidade e a criação do evento.

### Idempotência

`externalId` está indexado, mas não é `UNIQUE` no estado documentado.

A idempotência mais forte e o tratamento de concorrência são pontos
planejados.

### Expiração

As sessões possuem `expiresAt` e devem ser recusadas após o vencimento.

O fluxo final deve garantir que uma escolha feita depois do TTL não seja
aceita.

### Ambiente de produção

Os calendários e consultores atualmente usados são de teste.

Antes da produção, devem ser substituídos pelos dados reais fornecidos
pelo cliente.

### Credenciais

Credenciais OAuth, tokens, API keys e outros segredos não devem ser
versionados ou incluídos no README.

------------------------------------------------------------------------

## Contribuição e método de desenvolvimento

O projeto segue um fluxo incremental:

``` text
Alteração pequena
      │
      ▼
Teste direcionado
      │
      ▼
Validação local
      │
      ▼
Revisão da mudança
      │
      ▼
Próxima etapa
```

Antes de implementar novas alterações, o contrato de seleção/confirmacão
deve ser revisado.

A branch `develop` é a referência de código atual descrita no dossiê.

------------------------------------------------------------------------

## Licença

O dossiê técnico não especifica uma licença para o projeto. Nenhuma
licença é declarada neste README.

------------------------------------------------------------------------

## Referência técnica

Este README foi estruturado a partir do **Dossiê Técnico de Continuidade
--- Projeto Mariana**, consolidado em 24/09/2026.

O dossiê registra tanto funcionalidades verificadas quanto decisões
arquiteturais ainda não implementadas. Portanto, este documento
diferencia explicitamente o estado implementado do planejamento,
especialmente no fluxo de seleção e confirmação de horários por botões
interativos do WhatsApp.
