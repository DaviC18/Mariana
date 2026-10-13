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
  <a href="https://github.com/DaviC18/Mariana">Repositório</a> ·
  <a href="https://github.com/DaviC18/Mariana/tree/develop">Branch develop</a> ·
  <a href="https://www.linkedin.com/in/david-curty-84b2a0285/">Davi Curty</a>
</p>

Mariana é um agente de atendimento comercial **backend-first**, desenvolvido para uma empresa de consórcio. O sistema recebe leads pelo WhatsApp, conduz uma qualificação comercial estruturada com apoio de IA, consulta a disponibilidade dos consultores no Google Calendar e permite que o interessado escolha e confirme um horário de atendimento.

O projeto também possui integrações para receber leads de campanhas de Google Ads e Meta Ads.

> **Estado deste documento:** 13/10/2026  
> **Branch de referência:** `develop`  
> **Repositório:** [DaviC18/Mariana](https://github.com/DaviC18/Mariana)

O foco atual é consolidar o backend, especialmente a confiabilidade do webhook, a idempotência, o processamento recuperável de mensagens e o envio confiável das respostas. Não há frontend como parte do escopo atual.

---

## Sumário

- [Visão geral](#visão-geral)
- [Funcionalidades implementadas](#funcionalidades-implementadas)
- [Arquitetura](#arquitetura)
- [Fluxo de atendimento](#fluxo-de-atendimento)
- [Fluxo de agendamento](#fluxo-de-agendamento)
- [Persistência e idempotência](#persistência-e-idempotência)
- [Tecnologias](#tecnologias)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Instalação e execução](#instalação-e-execução)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Banco de dados e migrations](#banco-de-dados-e-migrations)
- [Segurança e regras comerciais](#segurança-e-regras-comerciais)
- [Testes e validação](#testes-e-validação)
- [Estado atual e pendências](#estado-atual-e-pendências)
- [Roadmap](#roadmap)
- [Licença](#licença)

---

## Visão geral

O fluxo comercial de alto nível é:

```text
Google Ads / Meta Ads
          │
          ▼
     Entrada de leads
          │
          ▼
       WhatsApp
          │
          ▼
   Webhook Fastify
          │
          ├── Validação de assinatura
          ├── Identificação do evento
          └── Deduplicação por WAMID
          │
          ▼
    Lead / Conversation
          │
          ▼
  Persistência da mensagem
          │
          ▼
   Mariana / Gemini
          │
          ├── Conversação
          ├── Qualificação comercial
          └── Identificação de interesse
                     │
                     ▼
             Disponibilidade real
              Google Calendar
                     │
                     ▼
              Oferta de horários
                     │
                     ▼
            Botões interativos
                     │
                     ▼
             Seleção do horário
                     │
                     ▼
           Confirmação explícita
                     │
                     ▼
            AppointmentService
                 │        │
                 ▼        ▼
         Google Calendar PostgreSQL
```

A IA é responsável pela conversa e pela qualificação. A lógica de seleção, confirmação, validação de horários e criação de appointments pertence ao backend determinístico.

## Funcionalidades implementadas

### Atendimento e mensageria

- Recebimento de mensagens pelo webhook da WhatsApp Cloud API.
- Validação da assinatura do webhook usando HMAC SHA-256.
- Identificação e ingestão de leads pelo telefone.
- Criação ou reutilização de conversas ativas.
- Persistência de mensagens de usuário e do assistente.
- Recebimento de mensagens de texto e respostas interativas `button_reply`.
- Envio de mensagens de texto e botões interativos de resposta.
- Persistência de WAMIDs em mensagens outbound quando o envio retorna o identificador.
- Registro de eventos inbound de WhatsApp em `whatsapp_webhook_events`.
- Deduplicação de eventos por identificador externo, normalmente o WAMID.

**Limitação importante:** registrar um evento e impedir duplicatas não equivale, por si só, a garantir processamento recuperável. A recuperação automática de eventos interrompidos e o reenvio durável de respostas ainda precisam ser consolidados.

### Qualificação comercial

O fluxo comercial utiliza os estados:

```text
new → qualifying → qualified → scheduled
```

A qualificação considera informações como:

- Data de nascimento e maioridade.
- Objetivo do cliente.
- Tipo de consórcio.
- Situação atual.
- Dor ou motivação.
- Interesse explícito em conversar com um consultor.

A promoção do lead para `scheduled` depende do fluxo de agendamento confirmado.

### Inteligência artificial

O Gemini é utilizado para:

- Compreensão de texto livre.
- Condução do diálogo.
- Qualificação do lead.
- Definição da próxima ação conversacional.
- Geração de respostas contextuais.

A IA não deve escolher horários, inventar disponibilidade, decidir qual consultor atende, interpretar diretamente IDs de botões ou criar appointments sem passar pelas validações determinísticas do backend.

### Disponibilidade

O sistema consulta calendários dos consultores para verificar horários livres.

As regras do domínio implementadas/documentadas incluem:

- Horário comercial entre `08:00` e `18:00`.
- Dias úteis.
- Slots de 30 minutos.
- Verificação de sobreposição e conflitos.
- Oferta de no máximo três horários por vez.
- Formatação de horários para `America/Sao_Paulo`.

A disponibilidade final precisa ser verificada novamente durante a confirmação, pois pode mudar depois da oferta inicial.

---

## Arquitetura

O projeto utiliza TypeScript e Fastify, com separação entre rotas, integrações externas, serviços de domínio e persistência.

### Camadas principais

| Camada | Responsabilidade |
|---|---|
| Webhook WhatsApp | HTTP, assinatura, parsing, deduplicação e roteamento das mensagens |
| Integração WhatsApp | Envio de textos e botões pela Cloud API |
| Leads | Ingestão, persistência e atualização de dados comerciais |
| Conversas | Persistência de mensagens e coordenação do atendimento |
| Gemini | Conversação e qualificação assistida por IA |
| Disponibilidade | Consulta de horários e conflitos |
| Scheduling | Oferta, seleção, cancelamento e confirmação |
| Appointment | Validação final e criação do agendamento |
| PostgreSQL / Drizzle | Persistência, constraints, queries e migrations |
| Google Calendar | Consulta de disponibilidade e criação de eventos |

### Separação de responsabilidades

- O webhook não deve concentrar regras comerciais complexas.
- A integração do WhatsApp não decide se um horário é válido.
- O Gemini não deve ser a autoridade sobre IDs de slots ou estado de agendamento.
- O serviço de oferta persiste os horários que foram apresentados ao usuário.
- O serviço de escolha valida a seleção contra dados persistidos.
- O `AppointmentService` é a última barreira de validação antes da criação do agendamento.

---

## Fluxo de atendimento

### Mensagens de texto

```text
WhatsApp
   │
   ▼
webhook-whatsapp
   │
   ├── valida assinatura
   ├── identifica WAMID
   ├── tenta registrar/reivindicar evento
   └── identifica lead e conversa
           │
           ▼
receiveCustomerMessage
           │
           ├── persiste a mensagem
           ├── atualiza a conversa
           └── agenda processamento por debounce
                        │
                        ▼
             generateMarianaResponse
                        │
                        ▼
                      Gemini
                        │
                        ▼
                Resposta / ação
                        │
                        ▼
                 WhatsApp Cloud API
```

O processamento conversacional usa debounce para agrupar mensagens próximas antes de gerar uma resposta.

**Ponto de atenção:** o debounce atual é coordenado em memória. Para garantir recuperação após encerramento inesperado do processo, o ciclo de processamento precisa ser integrado a um mecanismo durável de tarefas e retomada.

### Respostas de botões

As respostas `interactive.button_reply` seguem um caminho determinístico separado do fluxo de texto. Elas não devem ser encaminhadas automaticamente ao Gemini nem depender do debounce para executar seleção, confirmação ou cancelamento.

Os identificadores técnicos usados atualmente incluem:

```text
<slotId>
confirm:<slotId>
cancel:<slotId>
```

- Um UUID de slot seleciona um horário persistido.
- `confirm:<slotId>` solicita a confirmação do horário selecionado.
- `cancel:<slotId>` representa a rejeição da confirmação.

A posição visual do botão não é usada como identidade do horário. O backend resolve os IDs contra o banco e valida o contexto da sessão.

---

## Fluxo de agendamento

### 1. Oferta

O serviço de disponibilidade consulta os calendários e fornece os slots elegíveis. O `SchedulingOfferService` persiste a sessão e os horários antes que eles sejam apresentados ao usuário.

Cada sessão contém os slots relacionados a uma oferta específica. O fluxo prevê até três opções.

### 2. Escolha de horário

Quando o usuário seleciona um botão, o `SchedulingChoiceService` verifica o slot e sua sessão. Entre as validações relevantes estão:

- Existência do slot.
- Vínculo com a sessão correspondente.
- Correspondência entre lead e conversa.
- Sessão ainda ativa.
- Sessão não expirada.
- Compatibilidade com o slot já selecionado.

A seleção é persistida em `scheduling_sessions.selectedSlotId`.

Se houver dois ou três horários, o usuário recebe a confirmação do horário escolhido. Se houver somente um, o sistema pode apresentar diretamente a pergunta de confirmação daquele horário.

### 3. Confirmação ou rejeição

O `SchedulingConfirmationService` interpreta os botões `Confirmar` e `Não`. O `SchedulingConfirmationOrchestrator` coordena a validação e encaminha a confirmação ao `AppointmentService`.

Em caso de confirmação, o `AppointmentService`:

1. Valida o intervalo de tempo.
2. Verifica a existência e o estado do consultor.
3. Valida o lead qualificado.
4. Valida o estado e a expiração da sessão quando fornecida.
5. Verifica conflitos de agendamento no PostgreSQL.
6. Reconsulta a disponibilidade no Google Calendar.
7. Cria o evento no Google Calendar.
8. Persiste o appointment e finaliza a sessão segundo as regras do serviço.
9. Utiliza compensação para excluir o evento criado quando a finalização no banco falha.

Esse processo não constitui uma transação distribuída: ainda existe uma janela de concorrência entre sistemas externos e banco de dados.

### 4. Rejeição

Quando o usuário rejeita a confirmação:

- Para uma oferta com dois ou três slots, o fluxo pode limpar a seleção e reapresentar os mesmos horários.
- Para uma oferta com um único slot, a sessão é encerrada de acordo com o serviço de cancelamento.

A rejeição da confirmação não deve provocar uma nova consulta de disponibilidade automaticamente, salvo se um fluxo separado solicitar novos horários.

### 5. Expiração

As sessões de agendamento possuem `expiresAt` e estados:

```text
active
closed
expired
```

A função `expireSchedulingSessionIfOverdue` altera condicionalmente uma sessão `active` para `expired` quando o prazo já passou. Os serviços de seleção e confirmação devem recusar sessões vencidas.

---

## Persistência e idempotência

### Mensagens

A tabela `messages` possui `externalId` para mapear IDs externos, especialmente WAMIDs do WhatsApp.

Há um índice único parcial sobre `externalId` quando ele não é nulo, para impedir que o mesmo identificador externo seja persistido em mais de uma mensagem.

### Eventos do webhook

A tabela `whatsapp_webhook_events` registra informações do processamento de eventos, incluindo:

- ID interno.
- `externalId`, com unicidade.
- Tipo de evento.
- Telefone de origem.
- Conversa associada, quando identificada.
- Payload persistido.
- Estado do processamento.
- Datas de criação e atualização.

Os estados modelados são:

```text
processing
processed
failed
```

A migration `20261013000000_whatsapp_webhook_idempotency.sql` cria a tabela e o índice único para o identificador externo, além do índice único parcial de mensagens.

**Estado atual:** a base de persistência de eventos existe, mas a implementação ainda precisa garantir recuperação efetiva após interrupções, controle robusto de posse durante processamento concorrente e tratamento confiável de falhas no envio de respostas. Um evento marcado como `failed` não é automaticamente recuperado só por existir no banco.

### Tarefas autônomas

O projeto também possui a tabela `autonomous_tasks` e o executor `autonomous-task-executor.ts`, com estados `pending`, `processing`, `completed` e `failed`, idempotency key, tentativas e backoff.

A existência desses componentes não significa que o webhook do WhatsApp já utiliza esse mecanismo para recuperar todos os eventos inbound. A integração e a estratégia de retomada precisam ser verificadas e concluídas antes de considerar o processamento durável.

---

## Tecnologias

| Tecnologia | Finalidade |
|---|---|
| Node.js 24 | Runtime |
| TypeScript | Linguagem principal |
| Fastify 5 | Servidor HTTP |
| Zod 4 | Validação e contratos |
| PostgreSQL | Banco de dados |
| Drizzle ORM | Schema, queries e migrations |
| `postgres` / `pg` | Conectividade com PostgreSQL |
| Google GenAI SDK | Integração com Gemini |
| Google Calendar API | Disponibilidade e criação de eventos |
| WhatsApp Cloud API | Mensagens inbound e outbound |
| `tsx` | Execução TypeScript e testes |
| `tsup` | Build |
| Ultracite / Biome | Verificação e padronização |
| Docker | Suporte ao ambiente de desenvolvimento |
| ngrok | Exposição local do webhook durante testes |

---

## Estrutura do projeto

Principais diretórios e arquivos da branch `develop`:

```text
src/
├── db/
│   ├── schema/
│   │   ├── appointments.ts
│   │   ├── autonomous-tasks.ts
│   │   ├── consultants.ts
│   │   ├── conversations.ts
│   │   ├── google-calendar-connections.ts
│   │   ├── leads.ts
│   │   ├── messages.ts
│   │   ├── relations.ts
│   │   ├── scheduling-sessions.ts
│   │   ├── scheduling-slots.ts
│   │   └── whatsapp-webhook-events.ts
│   └── ...
├── integrations/
│   └── whatsapp/
│       ├── whatsapp-client.ts
│       ├── whatsapp-service.ts
│       └── whatsapp-types.ts
├── routes/
│   ├── appointments/
│   ├── conversations/
│   ├── google-calendar/
│   ├── google-ads/
│   ├── leads/
│   ├── messages/
│   ├── meta-ads/
│   └── whatsapp/
│       └── webhook-whatsapp.ts
├── services/
│   ├── calendar/
│   │   ├── appointment-service.ts
│   │   ├── availability.ts
│   │   ├── consultant-availability.ts
│   │   ├── scheduling-availability.ts
│   │   ├── scheduling-cancellation-service.ts
│   │   ├── scheduling-choice-service.ts
│   │   ├── scheduling-confirmation-orchestrator.ts
│   │   ├── scheduling-confirmation-service.ts
│   │   ├── scheduling-offer-service.ts
│   │   └── scheduling-session-expiration.ts
│   ├── conversations/
│   │   ├── autonomous-task-executor.ts
│   │   ├── generateMarianaResponse.ts
│   │   ├── mariana-safety.ts
│   │   ├── message-debounce.ts
│   │   ├── receive-customer-message.ts
│   │   └── whatsapp-compliance.ts
│   ├── leads/
│   └── ...
├── tests/
│   ├── integrations/
│   ├── routes/
│   ├── services/
│   └── ...
├── utils/
└── server.ts

drizzle/
├── ... migrations anteriores ...
├── 20261012000000_persistent_selected_scheduling_slot/
│   └── migration.sql
└── 20261013000000_whatsapp_webhook_idempotency.sql
```

A árvore acima destaca arquivos relevantes para os fluxos principais, sem representar todos os arquivos do repositório.

---

## Instalação e execução

### Pré-requisitos

- Node.js 24.
- npm.
- PostgreSQL configurado.
- Credenciais do Google Gemini.
- Configuração OAuth do Google Calendar.
- Aplicativo e número configurados na WhatsApp Cloud API.
- Para testes locais com a Meta, uma URL pública de webhook, por exemplo via ngrok.

### Instalar dependências

```bash
npm install
```

### Configurar o ambiente

Crie e configure o arquivo de variáveis de ambiente conforme os nomes esperados pelo módulo `src/env.ts`.

Não coloque tokens ou credenciais reais no README, em commits ou em logs compartilhados.

### Aplicar migrations

```bash
npm run db:migrate
```

### Executar em desenvolvimento

```bash
npm run dev
```

### Executar testes

```bash
npm run test
```

### Verificar código e build

```bash
npm run check
npm run build
```

### Iniciar a build

```bash
npm run start
```

### Scripts disponíveis

| Script | Finalidade |
|---|---|
| `npm run dev` | Executa o servidor com watch via `tsx` |
| `npm run build` | Gera a build com `tsup` |
| `npm run start` | Executa `dist/server.js` |
| `npm run test` | Executa os testes com o runner de teste do Node via `tsx` |
| `npm run check` | Executa `ultracite check` |
| `npm run fix` | Executa `ultracite fix` |
| `npm run db:generate` | Gera migrations com Drizzle Kit |
| `npm run db:migrate` | Aplica migrations |
| `npm run db:seed` | Executa o seed do banco |

A disponibilidade real das integrações depende das credenciais e do ambiente configurados.

---

## Variáveis de ambiente

O projeto centraliza a leitura e validação das configurações no módulo `src/env.ts`.

Os nomes das variáveis devem ser conferidos diretamente nesse arquivo antes de preparar um `.env` novo. A configuração pode incluir, conforme a integração utilizada:

- Conexão PostgreSQL.
- Credenciais do Google Gemini.
- Credenciais OAuth do Google Calendar.
- Token de verificação e segredo da WhatsApp Cloud API.
- Token de acesso e identificadores da Meta.
- Porta do servidor e configurações de debounce.

Não inclua valores reais de credenciais, refresh tokens, API keys ou tokens de acesso no repositório.

---

## Banco de dados e migrations

O PostgreSQL é a persistência principal.

### Entidades principais

| Entidade | Responsabilidade |
|---|---|
| `leads` | Identidade e estado comercial do lead |
| `conversations` | Contexto de atendimento |
| `messages` | Histórico de mensagens |
| `consultants` | Cadastro e disponibilidade dos consultores |
| `appointments` | Agendamentos e estado dos eventos |
| `scheduling_sessions` | Estado e validade de uma oferta de horários |
| `scheduling_slots` | Horários apresentados na oferta |
| `whatsapp_webhook_events` | Idempotência e estado registrado de eventos inbound |
| `autonomous_tasks` | Persistência de tarefas de execução autônoma |

### Sessões e slots

A tabela `scheduling_sessions` mantém:

- `leadId`.
- `conversationId`.
- `selectedSlotId`.
- `status`.
- `createdAt`.
- `expiresAt`.
- `updatedAt`.

Há um índice único parcial que limita a uma sessão `active` por lead.

Cada slot persistido possui sua sessão, posição, consultor, calendário, início e fim. Há restrições de unicidade da posição dentro da sessão, posição positiva e intervalo temporal válido.

### Alterações recentes de schema

- `20261012000000_persistent_selected_scheduling_slot`: adiciona `selectedSlotId` à sessão de agendamento, com chave estrangeira e índice.
- `20261013000000_whatsapp_webhook_idempotency.sql`: adiciona a tabela de eventos do webhook, sua unicidade por `externalId` e o índice único parcial de mensagens.

Antes de implantar em outro ambiente, confirme que todas as migrations necessárias foram aplicadas no banco correspondente.

---

## Segurança e regras comerciais

### Regras de negócio

Mariana pode explicar conceitos gerais de consórcio, qualificar o lead, identificar interesse em falar com consultor, consultar horários reais e conduzir o processo de agendamento.

Mariana não deve:

- Recomendar grupo ou carta específica como orientação financeira personalizada.
- Prescrever estratégia personalizada de lance.
- Garantir contemplação ou prazo.
- Inventar horários, consultores, disponibilidade, IDs ou resultados.
- Confirmar agendamentos sem a confirmação explícita do cliente.

### Proteções implementadas no backend

- Validação HMAC da assinatura do webhook.
- Validação de entradas e contratos com Zod.
- Resolução de botões contra IDs persistidos.
- Validação de lead, conversa, sessão, slot e expiração nos serviços de agendamento.
- Revalidação do estado da sessão antes da criação do appointment.
- Verificação de conflitos no PostgreSQL e reconsulta ao Google Calendar.
- Uso de IDs externos/WAMIDs e estruturas únicas para deduplicação.

### Limitações de consistência e recuperação

Google Calendar e PostgreSQL não participam de uma única transação distribuída. O fluxo usa compensação quando a finalização no banco falha, mas ainda existe uma janela de concorrência entre consulta e criação do evento externo.

A idempotência do webhook também não deve ser confundida com entrega garantida. É necessário concluir a recuperação de eventos interrompidos e persistir/reprocessar respostas outbound pendentes sem repetir ações comerciais já realizadas.

A lógica de manutenção ou recuperação não deve executar efeitos colaterais no banco antes de a assinatura do webhook ser validada.

---

## Testes e validação

Execute:

```bash
npm run test
npm run check
npm run build
```

O repositório possui testes de serviços, integrações e rotas, incluindo:

- Webhook do WhatsApp.
- Serviço de integração WhatsApp.
- Geração de respostas da Mariana.
- Qualificação e persistência de leads.
- Disponibilidade e agendamento.
- Seleção, confirmação e cancelamento de horários.
- Expiração de sessões.
- Políticas e compliance das mensagens.

Um teste direcionado do webhook ter passado não é evidência suficiente, por si só, de que a suíte completa, o check e a build passaram na mesma revisão. Registre os resultados reais da última execução antes de marcar uma etapa como concluída.

### Cenários prioritários de teste

- Entrega duplicada do mesmo WAMID.
- Duas entregas concorrentes do mesmo evento.
- Assinatura inválida sem efeitos colaterais no banco.
- Interrupção durante o processamento e retomada posterior.
- Falha no envio de uma resposta outbound.
- Resposta pendente recuperada sem repetir o agendamento.
- Lease expirado com tentativa concorrente de retomada.
- Seleção ou confirmação de sessão expirada.
- Rejeição de slot pertencente a outro lead/conversa.
- Conflitos entre PostgreSQL e Google Calendar.
- Confirmação de um único horário sem pular a confirmação explícita.

---

## Estado atual e pendências

### Implementado na branch `develop`

- Backend Fastify em TypeScript.
- Integração com WhatsApp Cloud API.
- Validação da assinatura HMAC do webhook.
- Ingestão de leads e persistência de conversas/mensagens.
- Qualificação conversacional assistida por Gemini.
- Integração com Google Calendar e verificação de disponibilidade.
- Persistência das sessões de agendamento e dos slots ofertados.
- Seleção persistida do horário em `selectedSlotId`.
- Serviço de seleção e validação de slots.
- Serviços de confirmação e cancelamento/rejeição.
- Orquestrador de confirmação conectado ao `AppointmentService`.
- Envio de botões interativos para seleção e confirmação.
- Recebimento de `interactive.button_reply` no webhook.
- Expiração de sessões vencidas.
- Tabela `whatsapp_webhook_events` e migration para idempotência por WAMID.
- Tabela `autonomous_tasks` e executor de tarefas autônomas.

### Em andamento: confiabilidade do processamento

Esta é a prioridade antes de avançar para novas funcionalidades.

1. **Recuperação durável de eventos inbound:** eventos interrompidos precisam ser efetivamente reprocessados, em vez de apenas mudarem para `failed`.
2. **Controle de concorrência e posse:** um processador antigo que perde a posse de um evento não deve continuar provocando efeitos externos.
3. **Recuperação de mensagens já persistidas:** uma redelivery não pode ser descartada como duplicata se a persistência ocorreu antes de o processamento conversacional ser agendado.
4. **Entrega outbound recuperável:** falhas no envio de respostas não podem ser silenciosamente consideradas como entrega concluída.
5. **Separação entre ação de negócio e envio da resposta:** recuperar uma mensagem pendente não deve criar outro appointment, repetir uma seleção indevidamente ou duplicar efeitos.
6. **Validação de assinatura antes de qualquer recuperação ou alteração de dados:** requisições inválidas não devem disparar manutenção do estado dos eventos.
7. **Validação final da suíte:** executar testes direcionados, suíte completa, `check` e build após as alterações.

### Antes de produção

- Validar integrações no ambiente real autorizado pelo cliente.
- Substituir calendários e consultores fictícios pelos dados reais.
- Revisar credenciais, permissões e configuração OAuth.
- Configurar monitoramento, logs e tratamento operacional de falhas.
- Validar entregas inbound/outbound pelo número de WhatsApp autorizado.
- Documentar o procedimento de migrations, backup e recuperação.

---

## Roadmap

### Etapa atual — Confiabilidade do webhook

- Consolidar a idempotência por WAMID.
- Integrar o processamento inbound a um mecanismo durável.
- Definir política de retry e recuperação.
- Impedir efeitos colaterais após perda da posse do evento.
- Persistir e recuperar respostas outbound pendentes.
- Criar testes de falha, redelivery e concorrência.
- Rodar suíte completa, check e build.

### Etapa seguinte — Validação end-to-end

- Validar o fluxo real de qualificação.
- Testar ofertas com um, dois e três horários.
- Testar seleção, confirmação, cancelamento e expiração.
- Validar persistência de appointments e eventos no Google Calendar.
- Confirmar o comportamento no WhatsApp autorizado.
- Registrar os resultados de testes em ambiente integrado.

### Etapas futuras

- Reagendamento.
- Lembretes.
- Acompanhamento de status de entrega.
- Melhorias operacionais e de observabilidade.
- Suporte a áudio, imagens, PDFs e outros conteúdos multimodais, se aprovados no escopo.

---

## Licença

Este README não declara uma licença de distribuição. Consulte o campo de licença do `package.json` e os arquivos legais do repositório antes de reutilizar ou distribuir o projeto.

---

## Método de desenvolvimento

O projeto segue uma abordagem incremental:

```text
Análise do estado atual
        │
        ▼
Mudança pequena e isolada
        │
        ▼
Teste direcionado
        │
        ▼
Suíte completa + check + build
        │
        ▼
Revisão da alteração
        │
        ▼
Próxima etapa
```

A branch `develop` é a referência técnica usada neste documento. Atualize o README após mudanças de arquitetura, migrations, scripts ou estado funcional do sistema.
