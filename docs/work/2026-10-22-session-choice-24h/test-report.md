# Test report — 2026-10-22-session-choice-24h

**Verdict: PASS** (Step 1 — política de tempo, textos e IDs)

Este relatório cobre **somente o lote Step 1**. Os lotes seguintes (Steps 2–13) acrescentam seções a este mesmo arquivo. Base: `develop` @ `595db13`. `plan.md:1` = `Status: APPROVED by Davi on 2026-10-22 — "aprovo"`.

## 1. Escopo verificado

Diff/untracked no momento da verificação:

| Arquivo | Estado | Previsto no Step 1 |
|---|---|---|
| `src/services/conversations/session-choice-policy.ts` | novo | sim |
| `src/tests/session-choice-policy.test.ts` | novo | sim |
| `package.json` (`test:unit` lista o novo teste) | M | sim |
| `docs/CODEMAP.md` (linha 45) | M | sim |
| `docs/work/2026-10-22-session-choice-24h/progress.md` | novo | sim (registro) |
| `docs/work/2026-10-22-session-choice-24h/explicacao.md` | novo | **não listado** |
| `docs/work/2026-10-22-session-choice-24h/plan.md` | novo | sim |
| `docs/work/2026-10-22-session-choice-24h/test-report.md` | novo | sim (este arquivo) |

`explicacao.md` é documento do planner na pasta da tarefa (não é código de produto, não altera comportamento). **Não é mudança não aprovada de produto**; fica registrado como arquivo extra em relação à lista de `Files` do Step 1 (`plan.md:163`). Nenhum arquivo de `src/` fora de `src/tests/` foi criado/alterado além do módulo do plano. Nenhum arquivo de `drizzle/`, `.env`, seed ou migration foi tocado.

## 2. Critérios do Step 1 → teste → resultado

| Critério (plan.md:161-170) | Teste | Resultado |
|---|---|---|
| `SESSION_INACTIVITY_MS = 24 * 60 * 60 * 1000` exportado | `a janela de sessão não reutiliza a janela do WhatsApp` | PASS |
| Exatamente 24h ⇒ `true` | `24h exatas contam como inatividade, 24h menos 1 ms não` | PASS |
| 24h − 1 ms ⇒ `false` | idem (segunda asserção) | PASS |
| `null` ⇒ `false`, sem throw | `timestamp nulo ou inválido não prova inatividade` | PASS |
| `Invalid Date` ⇒ `false`, sem throw | idem | PASS |
| 5 textos pinados exatos | `textos e IDs da escolha são estáveis e curtos` | PASS |
| IDs `sessao:continuar` / `sessao:nova` | idem | PASS |
| Títulos `Continuar` / `Nova conversa` e ≤ 20 chars | idem | PASS |
| Janela de sessão **não** importada de `whatsapp-compliance.ts` | `a janela de sessão não reutiliza a janela do WhatsApp` (lê o fonte e rejeita `from "...whatsapp-compliance"`) | PASS |
| `hasPreviousCustomerMessage` puro (contagem/lista) | *sem teste no lote entregue* → coberto por teste que adicionei (§4) | PASS (coberto) |
| Sem comportamento/DB/WhatsApp/Calendar | módulo não importa nada; só o teste o importa (`grep`/`rg`) | PASS |

### Meaningfulness (mutação, em cópia descartável em `/tmp/opencode/scp-mut`)

Cada teste foi rodado contra uma cópia mutada do módulo. Nenhum arquivo do repo foi alterado para isso.

| Mutação | Teste que falha |
|---|---|
| `>=` → `>` em `current - last` | `24h exatas...` (`✖`) |
| remoção do guard `instanceof Date` / `Number.isFinite` | `timestamp nulo ou inválido...` (`TypeError: Cannot read properties of null (reading 'getTime')`) |
| `import { WHATSAPP_CUSTOMER_WINDOW_MS } from "./whatsapp-compliance"` (com stub) | `a janela de sessão não reutiliza...` (`actual: true, expected: false`) |
| título `"Nova conversa agora!"` (21 chars) | `textos e IDs...` (`actual: 'Nova conversa agora!'`) |
| módulo removido | arquivo de teste inteiro falha (`Cannot find module` / `'test failed'`) |

## 3. Comandos e resultados

```
npx tsx --import ./src/tests/support/unit-test-preload.ts --test --test-reporter=dot src/tests/session-choice-policy.test.ts
  → ......  (6/6 pass, após os testes que adicionei)

npm run test:unit | tail -n 30
  → tests 253 / pass 253 / fail 0 / cancelled 0 / skipped 0

npx tsc --noEmit
  → sem saída (clean, exit 0)

npm run build            # script real: tsup src/server.ts --format cjs --clean
  → CJS dist/server.js 1.41 MB / Build success in 187ms

npx biome check src/services/conversations/session-choice-policy.ts src/tests/session-choice-policy.test.ts package.json
  → Checked 3 files. No fixes applied.

git diff --check
  → sem saída (clean)
```

`git status`: `M docs/CODEMAP.md`, `M package.json`, untracked `src/services/conversations/session-choice-policy.ts`, `src/tests/session-choice-policy.test.ts`, `docs/work/2026-10-22-session-choice-24h/`. Nada commitado.

## 4. Testes que adicionei

Somente em `src/tests/session-choice-policy.test.ts` (nenhum código de produto alterado):

1. `timestamp futuro, relógio inválido ou valor não-Date não provam inatividade` — `lastCustomerMessageAt` no futuro (clock skew do provedor), `now` inválido, `undefined` e string ISO (contrato de tipo, sem coerção) ⇒ `false`. Falha sob mutação `Math.abs(current - last)` (provado).
2. `a pergunta de 24h só aparece quando o cliente já escreveu antes` — `hasPreviousCustomerMessage` com `1`/`40` ⇒ `true`; `0`, `null`, `undefined`, `NaN` ⇒ `false`. Falha sob mutação `> 0` → `>= 0` (provado). Fecha a lacuna do helper entregue no Step 1 sem teste.

Não adicionei testes de colisão de prefixo: os IDs já são pinados por igualdade exata, e uma colisão só poderia vir de mudança nas famílias existentes (fora deste módulo).

## 5. Não executado (com motivo)

| Item | Motivo |
|---|---|
| `npm run test:db` | **not run — no authorized TEST_DATABASE_URL** |
| `npm test` | idem (exige `TEST_DATABASE_URL` preparada) |
| `setup-test-db.ts`, migrations, seeds, `db:push` | proibidos nesta sessão; Step 1 não toca DB |
| `DATABASE_URL` / Neon | nunca acessado; nenhuma consulta ou escrita |
| WhatsApp/Gemini/Calendar reais | não usados; Step 1 é puro |
| `npm run sim:conversation` | sem permissão do dono e sem comportamento a simular |

## 6. Riscos remanescentes (para os próximos lotes)

- **Detecção de import por regex**: o teste "não reutiliza" cobre `from "...whatsapp-compliance"` (estilo do repo, sem extensão). Não cobre `require(...)`, `import(...)` dinâmico nem extensão `.js`. Risco baixo; se o Step 4 importar o módulo por barrel, o teste não detecta.
- **Valores iguais hoje**: `SESSION_INACTIVITY_MS` e `WHATSAPP_CUSTOMER_WINDOW_MS` valem ambos 24h. O teste garante independência de *import*, não de valor; as regras podem divergir sem que o teste quebre (é o desejado).
- **Regra de 24h ainda inativa**: nada usa `isSessionInactivityGap` em produção. Até o Step 4, o bug RC-1 continua em produção.
- **Um relógio por mensagem**: o plano exige `receivedAt = new Date()` calculado uma vez no webhook (`plan.md:49`). Não é verificável neste lote; precisa de teste no Step 4.
- **`hasPreviousCustomerMessage` sem chamador**: a regra "não perguntar em conversa vazia/seed" só é provada de verdade no Step 4 (webhook).
- **Steps 2 e 9 continuam BLOCKED** por Q1/Q2 (`plan.md:352`); nenhum teste deste lote reduz esse risco.
- **Checklist manual de WhatsApp**: não se aplica ao Step 1 (nenhum comportamento novo). Fica para o lote que ativar o fluxo.
