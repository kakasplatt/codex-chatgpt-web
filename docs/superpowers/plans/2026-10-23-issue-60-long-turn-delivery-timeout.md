# Issue #60: orçamento de retry em turnos longos (Message delivery timed out) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fazer o orçamento de retries automáticos (`MAX_CHATGPT_WEB_TURN_RETRIES = 3`) valer também para turnos ChatGPT Web que duram mais que `RETRY_BUDGET_TTL_MS` (30 min).

**Architecture:** hoje `ChatGptWebTurnRetryPolicy.prune()` descarta a entrada pelo tempo desde a última falha. Como cada tentativa longa dura de 26 a 40 min, a entrada expira antes da próxima falha e o contador volta a 1 a cada vez. A correção marca a entrada como "tentativa ativa" quando um request do mesmo turno entra. O `prune()` não descarta entradas ativas, até um teto de segurança de 6 h. A entrada volta a ficar ociosa quando uma falha é registrada.

**Tech Stack:** TypeScript, Bun (`bun test`, `tsc --noEmit`).

**Spec:** issue https://github.com/kakasplatt/codex-chatgpt-web/issues/60, mais a análise de pertinência no fim deste arquivo.

## Global Constraints

- O valor de `MAX_CHATGPT_WEB_TURN_RETRIES` não muda (3).
- `RETRY_BUDGET_TTL_MS` continua 30 min para entradas ociosas.
- Teto da tentativa ativa: `MAX_ACTIVE_ATTEMPT_MS = 6 * 60 * 60_000`.
- A classificação do alerta (`upstream_server_error`, `retryable: true`) não muda.
- Sem dependências novas.

## Review Focus

1. Tentativa ativa por mais de 30 min seguida de falha → contador = 2, não 1 (Task 1, `long attempt keeps the retry count`).
2. Request que nunca termina (abort sem `record`/`clear`) → a entrada não pode ficar presa para sempre; ela expira depois de `MAX_ACTIVE_ATTEMPT_MS` (Task 1, `stale active attempt is pruned after the ceiling`).
3. `markAttempt` sem entrada prévia (primeira tentativa) → não cria entrada nem consome orçamento (Task 1, `markAttempt without a failure is a no-op`).
4. Sucesso depois de retries → `clear` remove a entrada (coberto pelo comportamento atual, verificado pelo teste do harness existente).
5. Entrada ociosa por mais de 30 min (o usuário retoma o mesmo turno muito depois) → continua expirando como hoje (Task 1, `idle entry still expires after the TTL`).

---

### Task 1: manter o orçamento de retry durante tentativas longas

**Files:**
- Modify: `src/adapters/chatgpt-web/retry-policy.ts` (interface `RetryBudgetEntry`, `recordRetryableFailure`, `prune`, novo `markAttempt`)
- Modify: `src/adapters/chatgpt-web/index.ts:981-993` (chamar `markAttempt` logo após a checagem de `exhaustedError`)
- Create: `tests/chatgpt-web-retry-policy.test.ts`

**Interfaces:**
- Produces: `ChatGptWebTurnRetryPolicy.markAttempt(key: string, now?: number): void`. Marca `activeSince = now` se a entrada já existe e não faz nada se não existe.
- Produces: `export const MAX_ACTIVE_ATTEMPT_MS = 6 * 60 * 60_000` em `retry-policy.ts`.
- `RetryBudgetEntry` ganha `activeSince?: number`. `recordRetryableFailure` grava `activeSince: undefined`.
- A regra do `prune(now)` passa a ser: remove se `activeSince !== undefined ? now - activeSince >= MAX_ACTIVE_ATTEMPT_MS : now - updatedAt >= ttlMs`.

- [ ] **Step 1: escrever os testes que falham**

Em `tests/chatgpt-web-retry-policy.test.ts`, use `new ChatGptWebTurnRetryPolicy(30 * 60_000)` com `now` explícito e um `ChatGptWebAdapterError` retryable (`status: 502, errorType: "server_error", code: "upstream_server_error"`).

```ts
test("long attempt keeps the retry count", () => {
  const p = new ChatGptWebTurnRetryPolicy(30 * MIN);
  p.recordRetryableFailure("k", err, 0);          // falha 1 (tentativa inicial)
  p.markAttempt("k", 2_000);                       // retry começa em seguida
  p.recordRetryableFailure("k", err, 34 * MIN);    // falha 2 após 34 min
  p.markAttempt("k", 34 * MIN + 2_000);
  p.recordRetryableFailure("k", err, 70 * MIN);    // falha 3
  p.markAttempt("k", 70 * MIN + 2_000);
  const fourth = p.recordRetryableFailure("k", err, 110 * MIN); // falha 4 > MAX(3)
  expect(fourth.retryable).toBe(false);
  expect(p.exhaustedError("k", 110 * MIN + 1)).toBeDefined();
});

test("idle entry still expires after the TTL", () => {
  const p = new ChatGptWebTurnRetryPolicy(30 * MIN);
  p.recordRetryableFailure("k", err, 0);
  expect(p.recordRetryableFailure("k", err, 31 * MIN).retryable).toBe(true); // reiniciou em 1
});

test("markAttempt without a failure is a no-op", () => {
  const p = new ChatGptWebTurnRetryPolicy(30 * MIN);
  p.markAttempt("k", 0);
  expect(p.exhaustedError("k", 1)).toBeUndefined();
  // a primeira falha real continua contando como 1
  for (let i = 1; i <= MAX_CHATGPT_WEB_TURN_RETRIES; i++) {
    expect(p.recordRetryableFailure("k", err, i).retryable).toBe(true);
  }
});

test("stale active attempt is pruned after the ceiling", () => {
  const p = new ChatGptWebTurnRetryPolicy(30 * MIN);
  for (let i = 0; i <= MAX_CHATGPT_WEB_TURN_RETRIES; i++) p.recordRetryableFailure("k", err, i);
  p.markAttempt("k", 10);
  expect(p.exhaustedError("k", MAX_ACTIVE_ATTEMPT_MS - 1)).toBeDefined();
  expect(p.exhaustedError("k", 10 + MAX_ACTIVE_ATTEMPT_MS)).toBeUndefined();
});
```

- [ ] **Step 2: rodar e confirmar que falham**

Run: `bun test tests/chatgpt-web-retry-policy.test.ts`
Expected: FAIL (`markAttempt` / `MAX_ACTIVE_ATTEMPT_MS` não existem). Depois de criar só os stubs, `long attempt keeps the retry count` ainda falha porque `fourth.retryable` é `true`. Essa é a reprodução do bug.

- [ ] **Step 3: implementar `markAttempt`, o campo `activeSince` e a nova regra do `prune` em `retry-policy.ts`**

Atualize o comentário da classe para explicar por que a entrada ativa não expira pelo TTL: uma tentativa ChatGPT pode durar mais de 30 min, e o `turnTimeoutMs` vem indefinido por padrão.

- [ ] **Step 4: chamar `chatGptWebTurnRetryPolicy.markAttempt(retryKey)` em `index.ts`**

A chamada vai logo após o bloco `if (exhaustedRetry) { ... return; }` (~linha 993). Ela roda em todo request do turno, inclusive nas rodadas de tool. Isso é intencional e idempotente.

- [ ] **Step 5: rodar os testes novos e a regressão do harness**

Run: `bun test tests/chatgpt-web-retry-policy.test.ts tests/chatgpt-web-harness.test.ts`
Expected: PASS. O teste existente do harness (`browserStarts === MAX_CHATGPT_WEB_TURN_RETRIES + 1`, ~linha 1459) continua passando.

- [ ] **Step 6: typecheck e suíte completa**

Run: `bun run typecheck` e `bun test ./tests`
Expected: sem erros novos. Falhas `EPERM` de symlink e de execution policy são ambientais (ver `AGENTS.md`); se aparecerem, rode de novo na base antes de tratá-las como regressão.

- [ ] **Step 7: commit**

```bash
git add src/adapters/chatgpt-web/retry-policy.ts src/adapters/chatgpt-web/index.ts tests/chatgpt-web-retry-policy.test.ts
git commit -m "fix(retry): keep the browser-turn retry budget across attempts longer than its TTL (#60)"
```

---

## Itens da issue fora deste plano (decisão e motivo)

| Item da issue | Decisão | Motivo (evidência) |
|---|---|---|
| Esperado 3: reconhecer o alerta independentemente do idioma | **Já atendido** | A detecção é estrutural: qualquer `[role="alert"]` novo depois do turno, após 3 s de graça (`chatGptThreadAlertTexts` / `ChatGptThreadAlertTracker`, `browser-worker.ts:1943-2022`). O texto só entra na mensagem de erro. `tests/chatgpt-thread-alert.test.ts` já cobre o alerta em pt-BR. |
| "2º timeout consecutivo → não-retryable" | **Rejeitado** | `7fa76eb3676e` falhou duas vezes e **completou na 3ª tentativa** (18,8 min). Já `9e26442d2754` completou no 1º retry. A regra teria matado turnos recuperáveis. O teto correto é o orçamento existente, que a Task 1 faz funcionar. |
| "Retomar do último tool result" | **Já ocorre em grande parte** | O input do retry cresce (14k → 114k → 139k; 239k → 276k), porque o histórico do Codex carrega as chamadas e os resultados de tool já concluídos. O que se perde é a resposta do lado ChatGPT, mais o custo de restaging. As imagens são cortadas pelo limite de compactação (`src/responses/compaction.ts:190`, `maxImages = 10`; os logs mostram `images=9`). |
| Encerrar turnos longos de forma proativa (wrap-up depois de N tools ou M min) | **Adiado: precisa de dados** | Não há limiar nítido. As falhas aconteceram com 26–40 min, mas há sucessos com até 34,8 min (`5b49c7cc13fe`, 55 tools) e 29,9 min (`814e37cdae75`, 28 tools de imagem). Um limiar fixo cortaria turnos que funcionam. Vale reavaliar com mais ocorrências, e o log seguro já permite calcular duração e contagem de tools. |
| Classificar "delivery timeout" separado de outros alertas | **Adiado** | Hoje nenhuma política consumiria essa distinção. Ela só vale a pena se o wrap-up proativo for adotado. |
| Retry de `22be5d98adc6` | **Abrir issue separada** | O retry não refez o turno: falhou em 18 s com `connector_not_found` ("Codex Native2" ausente no menu, não-retryable), e um claim antigo do broker foi rejeitado no meio. É uma falha distinta do timeout. |
