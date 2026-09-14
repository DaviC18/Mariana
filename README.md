# Mariana Backend v1

## Visão geral

O backend da Mariana implementa o atendimento inicial de clientes interessados em consórcio, com agrupamento de mensagens por debounce de 15s, qualificação do lead, bloqueio contra garantias não respaldadas, e regra de encaminhamento para consultor.

A arquitetura atual preserva o fluxo de Fastify + Drizzle + PostgreSQL + Gemini, sem introduzir frontend ou integrações externas não configuradas.

## Regras de comunicação

- Saudação breve e direta.
- Uma resposta por bloco de mensagens.
- Escopo restrito a consórcio.
- Explicação geral antes de aprofundar.
- Uma pergunta principal por vez.
- Evita repetir dados já informados.
- Não garante contemplação, prazo, aprovação ou disponibilidade.
- Respeita o debounce de 15 segundos.

## Estados de agendamento

Para o fluxo de reunião, a versão 1 assume os seguintes estados:

- `pending_confirmation`: horário reservado e aguardando confirmação explícita do cliente.
- `confirmed`: agenda confirmada após resposta positiva do cliente.
- `expired`: reserva vencida sem confirmação.
- `cancelled`: cancelada.
- `completed`: reunião concluída.
- `scheduled`: compatibilidade legacy mantida no schema atual.

O tempo de confirmação permanece configurável entre 30 e 60 minutos pela variável `SCHEDULE_CONFIRMATION_MINUTES`.

## Regras de distribuição de consultores

A seleção prioriza consultores com menor carga atual baseada em reuniões em estados:

- `pending_confirmation`
- `confirmed`

Consultores inativos e indisponíveis são descartados antes da seleção. Em caso de empate, a escolha é aleatória entre os empatados, mantendo o fallback por ordem de chegada para a fila de espera.

## Tarefa passiva de disponibilidade

A versão 1 inclui a estrutura de fila de espera passiva para clientes sem horário disponível, com ordem de chegada como regra de fallback obrigatória.

O backend já prepare o ponto de extensão para:

- lead associado;
- período desejado;
- preferência de horário;
- consultor ou grupo de consultores;
- status;
- data de criação;
- controle para evitar envio duplicado.

Como o projeto ainda não possui fila ou Redis, a implementação atual se limita à lógica de seleção e à regra de fallback, sem garantir sincronização multi-instância em tempo real.

## Variáveis de ambiente

Use o arquivo [.env.example](.env.example) como base.

- `DATABASE_URL`: URL do PostgreSQL.
- `GEMINI_API_KEY`: chave da API do Gemini.
- `NODE_ENV`: `development`, `production` ou `test`.
- `PORT`: porta do Fastify (padrão 3252).
- `MESSAGE_DEBOUNCE_MS`: debounce de mensagens em milissegundos (padrão 15000).
- `SCHEDULE_CONFIRMATION_MINUTES`: tempo máximo de confirmação da reserva (30 a 60 minutos).

## Scripts

- `npm test`: executa os testes automatizados.
- `npx tsc --noEmit`: valida o TypeScript.
- `npm run check`: executa o Ultracite.
- `npm run build`: gera build de produção.
- `npm run db:migrate`: aplica migrações do Drizzle.
- `npm run db:generate`: gera migrations.

## Execução

```bash
npm install
cp .env.example .env
npm run db:migrate
npm run dev
```

## Limitações da versão 1

- sem fila distribuída/Redis para processamento multi-instância;
- sem integração real com WhatsApp, Google Calendar ou provedores externos;
- sem disponibilidade real de consultores e horários vindos de sistema externo;
- dependência de definição oficial da Ademicon para regras específicas de idade, horário e prioridade comercial;
- comportamento de alertas passivos ainda preparado para extensão e não integrado a canal externo.

## Dependências externas e pendências da Ademicon

Ainda dependem de definição oficial da Ademicon:

- faixa etária e regras de elegibilidade;
- compatibilidade por tipo de atendimento;
- prioridade de clientes aguardando disponibilidade;
- consultores, calendários e horários reais;
- regras comerciais específicas de grupo, lance e carta de crédito;
- integrações com WhatsApp e Google Calendar.

## Documentação técnica relevante

- [src/ai/prompt.ts](src/ai/prompt.ts): regras da Mariana.
- [src/services/conversations/message-debounce.ts](src/services/conversations/message-debounce.ts): agrupamento de mensagens por bloco.
- [src/services/agent/execute-next-action.ts](src/services/agent/execute-next-action.ts): ação executada após resposta da IA.
- [src/services/conversations/mariana-safety.ts](src/services/conversations/mariana-safety.ts): bloqueio de garantias.
- [src/services/consultants/consultant-load.ts](src/services/consultants/consultant-load.ts): carga de consultores.
- [src/services/availability/waitlist.ts](src/services/availability/waitlist.ts): fila passiva por ordem de chegada.

## Próximos passos para v2

- integrar fila distribuída com Redis ou broker;
- persistir a fila de disponibilidade real e avisos passivos;
- conectar consultores e agenda real;
- validar regras de idade e compatibilidade com a Ademicon;
- adicionar canais de WhatsApp e Google Calendar reais;
- ampliar testes de integração com o fluxo completo de lead para agendamento.
