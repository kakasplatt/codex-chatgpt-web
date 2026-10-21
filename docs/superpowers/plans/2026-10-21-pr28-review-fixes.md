# Correções do review do PR #28 — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir o item 1 do review do PR #28 e sua lacuna de teste (item 9). Estabilizar o teste de tempo (item 10). Registrar os demais achados numa issue de acompanhamento. O item 14 já foi corrigido em `aa16ae6`.

**Architecture:** A proteção contra roots amplos (`isBroadContextRoot`) só existe para impedir que um ambiente de pai em cache amplie o que subagentes herdam (`thread-environment.ts`, fallback do filho). No modo com vários Codex homes não há cache: `set()` retorna cedo e um filho sem prova nativa falha com `No current native Codex task proof`. A recusa passa então a valer só com um único Codex home, a mesma condição do cache. Assim a exceção `currentClaim === initialClaim`, que só acontece no modo com vários homes, deixa de ser necessária.

**Tech Stack:** TypeScript, Bun (`bun test`), `tsc --noEmit`.

**Spec:** review do PR #28 (itens 1, 9, 10 e 14) e a decisão D1 do plano `docs/superpowers/plans/2026-10-21-calendar-delta-final-minors.md`.

## Mudança na decisão D1 (requer aprovação do usuário)

- **Hoje:** "o início do turno continua como está; recuperação recusa só roots amplos novos em relação ao cache".
- **Proposta:** "com **um** Codex home, vale a regra acima. Com **vários** homes não há cache nem herança por cache, então nenhuma recusa se aplica e o root amplo enviado no início do turno sobrevive à meia-noite, ao steering e à compaction".
- **Por quê:** no modo com vários homes não há o risco que a proteção cobre. Além disso, a recusa atual derruba um turno legítimo (item 1, reproduzido no review).

## Evidência que define o escopo

Varredura de `~/.codex/sessions`, rodada em 2026-10-21:
- **Modo com vários homes:** não configurado nesta máquina. `CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES` não está definida e `config.json` não tem homes confiáveis. O item 1 é real no código, mas não é observado aqui.
- **Item 2** (delta de meia-noite sem `<workspace_roots>` num turno que começou com roots extras): 0 casos em 21 deltas reais. O comportamento é anterior a este PR.
- **Item 4** (diferença só de caixa, dentro de um turno, entre envelope inicial, `turn_context.cwd` e roots de delta): 0 casos.
- Os itens 2 e 4 e os demais achados (3, 5-8, 11-13) vão para a issue de acompanhamento (Task 3).

## Global Constraints

- Arquivos de código: `src/adapters/chatgpt-web/thread-environment.ts`, `tests/trusted-codex-homes.test.ts`, `tests/environment.test.ts`.
- Com um único Codex home, o comportamento não muda e todos os testes atuais de recusa continuam passando.
- Nenhum caminho pessoal (perfil do Windows, nome de usuário) em arquivos, commits, issue ou PR. Use `<user>` ou `~`.
- Bun local 1.4.3 ≠ pin 1.4.0: `check-version`, o bundle de runtime e o release smoke não são executados.

## Review Focus

1. Modo com vários homes, rollout DFA sem `workspace_roots`, envelope inicial com `[cwd, secondary]`: um delta de meia-noite repetindo `[cwd, secondary]` resolve `[cwd, secondary]`. Task 1.
2. Com um home, steering com Codex home como extra continua recusado. Coberto por `steering cannot widen omitted full-access roots with a trusted Codex home`.
3. Com um home, delta com Codex home, diretório da ponte ou home como extra continua recusado. Coberto pelos testes existentes.
4. O teste de tempo continua discriminando: o caso catastrófico mediu cerca de 1046 ms e o limite do JSC é cerca de 1,15 s. Task 2.
5. Remover a nova condição de um único home faz o teste da Task 1 falhar. Prova de mutação na Task 1.

---

### Task 1: Recusa de roots amplos só com um Codex home (itens 1 e 9)

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts`:
  - `refusesContext` e `isEstablished` (por volta das linhas 258-266);
  - condição de ampliação do ramo de claim (por volta das linhas 276-279);
  - comentário de `isBroadContextRoot`.
- Test: `tests/trusted-codex-homes.test.ts`, bloco `explicit trusted Codex homes (#851)`.

**Interfaces:**
- Consumes: os helpers do arquivo de teste `request(options)`, `rollout(home, options)` e `sharedStore(cache?)`, e as variáveis `cwd`, `primary`, `secondary`, `threadId`, `turnId`.

- [ ] **Step 1: Teste.** `a shared-home broad root from the turn start survives a midnight delta`:
  - `rollout(secondary, { mode: "danger-full-access" })`; o fixture já omite `workspace_roots`.
  - `parsed = request({ mode: "danger-full-access" })`; no envelope inicial (`input[0]`), acrescentar `<root>${secondary}</root>` depois do root de `cwd`.
  - Dar ids a `input[0]` e `input[1]` (`msg_start` e `msg_instruction`). O delta exige uma instrução ativa com `id` e `turn_id`.
  - Acrescentar ao `_rawBody.input`:
    - `{ type: "function_call", id: "fc_1", call_id: "call_1", name: "fixture", arguments: "{}" }`;
    - `{ type: "function_call_output", call_id: "call_1", output: "done" }`;
    - uma mensagem `user` com `id: "msg_calendar_delta"`, `internal_chat_message_metadata_passthrough: { turn_id: turnId, content_item_kinds: ["environments.environment_context"] }` e o texto:

      `<environment_context><current_date>2026-10-21</current_date><filesystem><workspace_roots><root>${cwd}</root><root>${secondary}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem></environment_context>`
  - `expect(sharedStore().resolve(parsed).roots).toEqual([cwd, secondary])`.
- [ ] **Step 2:** `bun test tests/trusted-codex-homes.test.ts -t "survives a midnight delta"`. Expected: FAIL com `Calendar environment delta conflicts with its current Codex rollout`.
  - Se falhar por outro motivo (formato do fixture), corrigir o fixture até a falha ser essa mensagem. Registrar como Ruling se o formato do delta precisar mudar.
- [ ] **Step 3: Implementação.**
  - `refusesContext` retorna `false` quando `this.codexHomes.length !== 1`.
  - `isEstablished` fica sem a checagem própria de um único home, que passa a ser redundante. Continua preguiçoso e chama `this.get` só quando houver root amplo.
  - Remover `currentClaim === initialClaim ||` do ramo de claim. Com vários homes a recusa já é `false`; com um home o `initialClaim` nunca é DFA nesse ramo.
  - No comentário de `isBroadContextRoot`, acrescentar: com vários homes não há cache nem herança por cache, então nenhuma recusa se aplica.
- [ ] **Step 4:** `bun test tests/trusted-codex-homes.test.ts tests/environment.test.ts tests/subagent-environment-history.test.ts` e `bun run typecheck`. Expected: PASS e sem erros. Em particular continuam passando:
  - `a shared-home turn start keeps a Codex-sent broad context root`;
  - `a corrupt single-home cache does not block a shared-home turn`;
  - `steering cannot widen omitted full-access roots with a trusted Codex home`.
- [ ] **Step 5: Mutação.** Remover temporariamente a condição `this.codexHomes.length !== 1` e rodar `-t "survives a midnight delta"`. Expected: FAIL. Restaurar com `git checkout -- src/` e rodar de novo. Expected: PASS.
- [ ] **Step 6: Commit:** `fix: apply the broad context root guard only where a thread cache exists`.

### Task 2: Teste de tempo menos frágil (item 10)

**Files:**
- Test: `tests/environment.test.ts`, teste `a rejected bullet worker inventory fails closed without exponential backtracking`.

- [ ] **Step 1:** Trocar `toBeLessThan(100)` por `toBeLessThan(500)` e acrescentar o comentário: o caso catastrófico mediu cerca de 1 s (limite de backtracking do JSC, cerca de 1,15 s), então 500 ms ainda distingue regressão de carga da máquina.
- [ ] **Step 2: Mutação.**
  - Trocar temporariamente, em `CALENDAR_SUBAGENT_INVENTORY_SOURCE`, o terminador `(?:\\r\\n|\\n)\\s*` por `\\s*`, que restaura a forma exponencial.
  - Rodar `-t "exponential backtracking"`. Expected: FAIL por tempo.
  - Restaurar com `git checkout -- src/` e rodar de novo. Expected: PASS.
- [ ] **Step 3: Commit:** `test: widen the backtracking timing bound to tolerate loaded machines`.

### Task 3: Issue de acompanhamento

- [ ] **Step 1:** Criar no fork (`kakasplatt/codex-chatgpt-web`) uma issue intitulada `Follow-up from PR #28 review: trusted environment context roots`. Um item por achado, com arquivo:linha e cenário, sem caminhos pessoais:
  - item 2 (delta sem roots descarta roots estabelecidos; anterior ao PR; 0 casos reais);
  - item 3 (envelope completo no meio do turno conta como `initialClaim`);
  - item 4 (grafia de caixa do delta e do cwd contra o broker; 0 casos reais);
  - item 5 (comparação léxica: junction, symlink, alias 8.3);
  - item 6 (`contains` trata `..notes` como fora; três cópias);
  - item 7 (`isEstablished` com efeitos colaterais);
  - item 8 (pastas sensíveis dentro do home);
  - item 11 (`CODEX_THREAD_ID_SOURCE` duplica `CODEX_ID_SOURCE`);
  - item 12 (três cópias de `pathIdentity`);
  - item 13 (bloco de adoção difícil de ler).
- [ ] **Step 2:** Registrar o número da issue no ledger.

### Task 4: Atualizar o PR #28

- [ ] **Step 1:** `git push` (sem force) do branch.
- [ ] **Step 2:** Editar a descrição do PR (`gh pr edit 28 --body-file`). Acrescentar uma seção `Review follow-up` com:
  - item 14 corrigido em `aa16ae6`, com a nota de que commits anteriores do branch ainda contêm os caminhos antigos no histórico;
  - item 1 corrigido (D1 ajustada para o modo com vários homes);
  - item 10 ajustado;
  - item 2 é anterior a este PR;
  - o link da issue de acompanhamento.

  Atualizar as contagens de verificação com a Task 5.

### Task 5: Verificação final

- [ ] `bun test ./tests`, `bun run typecheck`, `bun run launcher:typecheck`, `bun run launcher:test`. Reportar as contagens.
- [ ] Falhas ambientais esperadas (`AGENTS.md`): symlink `EPERM` e `windows-installer`.
- [ ] Não executados: `check-version`, o bundle de runtime, o release smoke, o teste darwin, o modo com vários homes ao vivo, e um turno ao vivo atravessando a meia-noite.

## Fora de escopo

- Reescrever o histórico do branch para remover os caminhos pessoais dos commits antigos. Exige force-push e só será feito com autorização explícita.
- Itens 2-8 e 11-13: issue de acompanhamento (Task 3).
