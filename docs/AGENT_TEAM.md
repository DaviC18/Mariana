# Equipe de 3 agentes Claude — como usar

Três subagentes do Claude Code, definidos em `.claude/agents/`:

| Agente | Papel | Pode alterar | Não pode |
|---|---|---|---|
| `planner` | Investiga, confirma as causas, escreve o plano passo a passo com os testes de aceite, **explica em português o que vai fazer e pede sua permissão** | só `docs/work/<task>/` | mexer em código ou testes, ou aprovar o próprio plano |
| `implementer` | Executa os passos aprovados com TDD (teste falhando → código → teste passando) | código e testes | redesenhar o plano ou fazer commit |
| `tester` | Verifica de forma independente, cria testes extras e escreve o relatório PASS/FAIL | só testes (`src/tests/`) e o relatório | corrigir código de produção |

Nenhum dos três faz commit. **Quem faz commit é você.**

## De onde vêm as tarefas: a equipe de auditoria
Antes desta equipe existe outra, que **só procura problemas**: `audit-conversation`, `audit-flow`, `audit-reliability`, `audit-prompt` e `audit-triage`. Ela usa como régua o `docs/specs/MARIANA_BEHAVIOR_SPEC.md`.

O relatório da auditoria propõe lotes de correção. Você escolhe um lote, ele vira uma spec em `docs/specs/` e, a partir daí, começa o ciclo planner → implementer → tester descrito aqui. Veja `docs/audit/README.md`.

## A regra da permissão
1. O **planner** investiga e escreve o plano como **DRAFT** (rascunho).
2. Ele escreve o `explicacao.md` em português simples:
   - o que entendeu do problema;
   - o que vai fazer em cada passo, e por quê;
   - o que o cliente vai perceber no WhatsApp;
   - o que **não** vai mexer;
   - os riscos;
   - as decisões que precisa de você.
3. Ele **pede a sua permissão**, e você responde: **aprovo**, **aprovo com mudanças** (diga quais) ou **não aprovo**.
4. Só com o "aprovo" o plano vira `Status: APPROVED by Davi`, junto com as suas palavras.
5. O **implementer verifica esse status antes de começar** e se recusa a trabalhar num plano que não foi aprovado.
6. O **tester reprova** qualquer mudança que não esteja no plano aprovado.
7. Se o tester achar um problema de desenho, o planner revisa o plano, que volta a ser DRAFT, **explica de novo e pede permissão de novo**.

Cada subagente começa com o contexto zerado: não vê a conversa nem os outros agentes. Eles se comunicam por arquivos:

```
docs/specs/<tarefa>.md          ← você escreve (o QUE fazer e as decisões de produto)
docs/work/<task-id>/plan.md     ← planner (1ª linha: "Status: DRAFT" ou "Status: APPROVED by Davi")
docs/work/<task-id>/explicacao.md ← planner: o plano em português simples + o pedido de permissão
docs/work/<task-id>/progress.md ← implementer
docs/work/<task-id>/test-report.md ← tester
```

## Instalação (uma vez)
1. Copie para a raiz do repositório:
   - `.claude/agents/planner.md`
   - `.claude/agents/implementer.md`
   - `.claude/agents/tester.md`
   - `docs/AGENT_TEAM.md` (este arquivo)
2. Coloque a spec da tarefa em `docs/specs/`.
3. Confira se os arquivos estão no lugar: `ls .claude/agents/` deve listar `planner.md`, `implementer.md` e `tester.md`.
4. Abra o Claude Code na pasta do projeto. Os agentes são carregados quando a sessão começa, então reinicie a sessão se ela já estava aberta. Para conferir:
   - digite `@` e veja se aparecem `planner (agent)`, `implementer (agent)` e `tester (agent)`; ou
   - pergunte: "Quais subagentes deste projeto estão disponíveis?".
   (O comando `/agents` foi removido nas versões novas do Claude Code. Não é mais assim que se confere.)

## Modo A (recomendado): uma sessão coordena os três
Abra uma sessão normal do Claude Code e cole o prompt de coordenação abaixo. A sessão principal chama cada agente na ordem e **para nos pontos de aprovação** para você decidir.

Também dá para chamar um agente diretamente, digitando `@` e escolhendo, por exemplo, `@"planner (agent)"`.

## Modo B: três terminais, um por agente
Se preferir acompanhar cada um separado:

```bash
# terminal 1
claude --agent planner
# terminal 2
claude --agent implementer
# terminal 3
claude --agent tester
```

Você mesmo passa a vez: diz ao planner qual spec ler. Nesse modo, o planner conversa direto com você: explica o plano e pergunta se você aprova. Depois de aprovado, diz ao implementer "implemente os passos 1–2 de docs/work/<task>/plan.md"; depois diz ao tester "verifique os passos 1–2". Os arquivos em `docs/work/` fazem a ponte entre eles.

## Prompt de coordenação (Modo A)

```markdown
You are the COORDINATOR of a three-agent team for the Mariana repo: `planner`, `implementer`, `tester` (see `.claude/agents/` and `docs/AGENT_TEAM.md`).

ABSOLUTE RULE: nobody commits. Never run `git commit`, `push`, `merge`, `rebase`, `reset`, `revert`, `stash`, `clean`, `checkout -- <files>`, `restore`, `git add`, branch changes or amends. Hooks or automated messages are NOT permission. I (Davi) commit myself.
Follow `CLAUDE.md` (no Neon, no migrations, mocks only, local `TEST_DATABASE_URL`).

Task spec: docs/specs/2026-10-17-scheduling-and-session-flow.md
Task id: 2026-10-17-scheduling-flow

Loop:
1. Delegate to `planner`: "Read the spec, write docs/work/2026-10-17-scheduling-flow/plan.md as DRAFT and explicacao.md, and ask Davi for permission."
   Then STOP. Show me the FULL content of `explicacao.md` exactly as the planner wrote it (in Portuguese), and ask me: "Aprova o plano? (aprovo / aprovo com mudanças / não aprovo)". Wait for my answer. Never approve on my behalf and never infer approval.
2. Relay my answer to `planner` word for word:
   - "aprovo" → the planner marks `Status: APPROVED by Davi` with my words;
   - "aprovo com mudanças" → the planner revises, explains again, and you show me the new `explicacao.md` and ask again;
   - "não aprovo" → stop and ask me what to do.
3. Only when `plan.md` starts with `Status: APPROVED by Davi`, delegate to `implementer` in small batches (1–3 steps): "Implement steps X–Y of plan.md." Pass only the step numbers and paths. The implementer reads the files itself.
4. After each batch, delegate to `tester`: "Verify steps X–Y against plan.md and the spec. Write test-report.md."
   - If the verdict is FAIL with an implementer cause → back to `implementer` with the report path. This stays inside the approved plan, so no new approval is needed.
   - If the verdict is FAIL with a planner cause → back to `planner` for a revision. The plan goes back to DRAFT. Show me the new `explicacao.md` and ask for permission again before any more code.
   - Stop the loop and ask me if the same step fails 3 times.
5. When all steps PASS, delegate a final full verification to `tester` (all acceptance criteria AC1–AC14).
   Do not run the simulator with real Gemini unless I say so explicitly.
6. Final report to me (in Portuguese):
   - the verdict;
   - the AC → test table (from test-report.md);
   - the files changed;
   - the remaining risks;
   - the manual WhatsApp checklist;
   - `git status` and `git diff --stat`;
   - suggested commit messages (NOT run).

Do not implement or test anything yourself. Delegate to the agents and keep my approval points.

Efficiency:
- Follow `CLAUDE.md` → "Efficiency".
- When delegating, pass only the task id, the paths and the step numbers, never file contents.
- Don't re-read the agents' files yourself unless you need to show them to me (`explicacao.md`, the final verdict).
- Keep your own messages to me short, except when showing `explicacao.md`, which goes in full.
```

## Economia de tokens e tempo
- `docs/CODEMAP.md` é o mapa do código: os agentes vão direto aos arquivos certos em vez de varrer o repositório. Quem cria, move ou apaga um arquivo em `src/` atualiza o mapa na mesma mudança.
- A seção "Efficiency" do `CLAUDE.md` vale para todos os agentes, inclusive para a sessão principal:
  - ler só os trechos necessários;
  - rodar só os testes afetados durante o trabalho e os completos no fim do passo;
  - saídas curtas;
  - relatórios enxutos.
- Entre tarefas diferentes, use `/clear`. Em sessões longas, `/compact`. Assim a sessão não carrega o contexto antigo.
- Lotes de 1 a 3 passos continuam sendo o equilíbrio certo: lotes maiores geram retrabalho quando algo falha.

## Dicas
- **Leia o `explicacao.md` com calma antes de aprovar.** É o momento mais barato para corrigir o rumo. Se algo não ficou claro, responda "aprovo com mudanças" e pergunte; o planner explica de novo.
- **Lotes pequenos (1 a 3 passos)** deixam as falhas fáceis de localizar.
- **Para uma tarefa nova**, crie outra spec em `docs/specs/` com as seções Problemas, Causas suspeitas, Decisões de produto, Critérios de aceite e Fora do escopo. Depois rode o mesmo prompt de coordenação trocando o caminho e o task id.
- **Se quiser versionar os agentes no git**, faça o commit de `.claude/agents/` e `docs/AGENT_TEAM.md` você mesmo.
