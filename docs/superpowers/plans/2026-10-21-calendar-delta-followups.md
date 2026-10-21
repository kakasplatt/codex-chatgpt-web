# Achados restantes do delta de calendário — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os três achados restantes da correção da issue #27:
1. separadores incomuns aceitos no nome de subagente;
2. asserções genéricas nos testes negativos;
3. a falha `Calendar environment delta conflicts with its current Codex rollout` quando o delta de meia-noite repete roots extras e o rollout nativo não declara `workspace_roots`.

**Architecture:** As tasks 1 e 2 apertam o ramo de lista da regex em `environment.ts` e tornam os testes negativos explícitos. A task 3 estende ao delta de calendário a regra que o store já aplica a claims com cwd (`thread-environment.ts:243-252`, `codex-rollout-environment.ts:668`): num rollout `dangerFullAccess` sem `workspace_roots` declarados, `[cwd]` não é uma restrição nativa, então os roots repetidos pelo delta atual servem de contexto de workspace. Permissões e identidade continuam vindo do rollout.

**Tech Stack:** TypeScript, Bun (`bun test`), `tsc --noEmit`.

**Spec:** plano anterior `docs/superpowers/plans/2026-10-21-calendar-delta-bullet-subagent-inventory.md` (seção "Fora de escopo") e o relatório da revisão final da issue #27 (minors 1 e 2).

## Evidência do achado 3

O rollout é `~/.codex/sessions/2026/10/19/rollout-2026-10-19T23-50-41-01a15737-dc1e-7a02-8903-779b0cad3868.jsonl`, turno `01a15739-…`.
- Às 03:00:39Z, o delta de meia-noite repete `<workspace_roots>` com dois roots: `C:\Work\game` e `C:\Users\kakas\.codex\visualizations\2026\10\20\01a15737-…`. O perfil é `disabled/unrestricted`.
- `resolveCurrentCodexRolloutEnvironment` sobre o rollout real retorna `roots = [C:\Work\game]` e `workspaceRootsDeclared = false`. O `turn_context` não tem `workspace_roots`.
- `thread-environment.ts:253-259` compara os roots do delta com `[cwd]` e lança o conflito. A substituição das linhas 243-252 só ocorre com `currentClaim`, e o delta de calendário não produz claim, porque não tem `<cwd>`.

## Global Constraints

- Arquivos: `src/adapters/chatgpt-web/environment.ts`, `src/adapters/chatgpt-web/thread-environment.ts`, `tests/environment.test.ts`.
- O ramo XML `<agent name="…" />` e todos os testes atuais continuam válidos.
- A widening de roots vale **somente** quando as quatro condições abaixo valem juntas. Em qualquer outro caso, a comparação estrita atual é mantida:
  - `!rollout.workspaceRootsDeclared`;
  - a política do rollout é `dangerFullAccess`;
  - todos os perfis do delta são idênticos a `rollout.filesystemProfileXml`;
  - todas as listas de roots repetidas pelo delta, comparadas como conjuntos via `pathIdentity`, são iguais entre si e contêm **exatamente** cada root do rollout (aqui `[cwd]`). Nenhum root nativo pode sumir; um root ancestral não substitui o cwd.
- Por que adotar os roots do delta em vez de manter `[cwd]`:
  - O turno registrou no broker o ambiente do envelope inicial, com os mesmos roots que o delta repete.
  - `turn-broker.ts:437` rejeita qualquer mudança de ambiente durante o loop de ferramentas.
  - Sob `dangerFullAccess`, nenhum consumidor da ponte usa roots como limite. O MCP server lê apenas `environment.tools`, e o sandbox das ferramentas é aplicado pelo Codex.
- Os roots adotados preservam a grafia original do delta: `resolve(path)`, não `pathIdentity`, que deixa tudo em minúsculas no Windows.
- O cwd, a política e a identidade vêm sempre do rollout.
- Bun local 1.4.3 ≠ pin 1.4.0: `check-version`, o bundle de runtime e o release smoke não são executados.

## Review Focus

1. Num rollout `managed` (workspace-write/read-only) sem roots declarados, um delta com root extra deve continuar sendo rejeitado. Teste na Task 3.
2. Dois deltas no mesmo request com conjuntos de roots diferentes devem ser rejeitados. Teste na Task 3.
3. Um delta cujos roots não contêm o cwd do rollout deve ser rejeitado. Teste na Task 3.
4. Com rollout de roots declarados, um root extra continua sendo rejeitado. Já coberto por `calendar updates cannot introduce roots or malformed permission fields`.
5. A grafia dos roots adotados deve ser preservada no Windows (não ficar em minúsculas). Teste na Task 3 compara com o `root` original.

---

### Task 1: Apertar o nome de subagente no inventário em lista

**Files:**
- Modify: `src/adapters/chatgpt-web/environment.ts` (constante `CALENDAR_SUBAGENT_INVENTORY_SOURCE`)
- Test: `tests/environment.test.ts`, teste `a calendar worker inventory cannot conceal authority changes or extra markup`

**Interfaces:** nenhuma mudança de assinatura.

- [ ] **Step 1: Testes que falham.** No teste acima, acrescentar ao array de inventários rejeitados, usando o `workerId` existente:
  - `` `<subagents>\n - ${workerId}: A\u2028cwd /outside\n</subagents>` ``
  - `` `<subagents>\r - ${workerId}: A\r</subagents>` ``
  - `` `<subagents>\n - ${workerId}: A\vB\n</subagents>` ``
  - `` `<subagents>\n - ${workerId}: A\fB\n</subagents>` ``
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "cannot conceal"`. Expected: FAIL. Hoje esses quatro são aceitos e `resolve` não lança.
- [ ] **Step 3: Implementação.**
  - Nome: trocar `[^<>\s][^<>\r\n]*` por `[^<>\s][^<>\r\n\u2028\u2029\v\f]*`.
  - Terminador: trocar `(?:\r\n|\r|\n)` por `(?:\r\n|\n)`.
- [ ] **Step 4:** `bun test tests/environment.test.ts`. Expected: PASS, incluindo os testes de CRLF e de backtracking.

### Task 2: Asserções explícitas nos testes negativos

**Files:**
- Test: `tests/environment.test.ts`, mesmo teste `cannot conceal`.

- [ ] **Step 1:** No laço do teste, trocar `expect(() => store.resolve(request)).toThrow()` por `toThrow("missing cwd")`.
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "cannot conceal"`. Expected: PASS.
  - Se algum caso **XML pré-existente** lançar outra mensagem, separar os casos em dois laços: os de lista e os novos com `"missing cwd"`, e os demais com `toThrow()`. Registrar como Ruling.
  - Não é RED→GREEN: a mudança só torna explícito um comportamento já correto. Para provar que a asserção nova discrimina, remover temporariamente a alternativa de lista da regex e confirmar que o teste de inventário em lista (#27) falha com `missing cwd`; depois restaurar.
- [ ] **Step 3: Commit** (Tasks 1 e 2 juntas):
  ```bash
  git add src/adapters/chatgpt-web/environment.ts tests/environment.test.ts
  git commit -m "fix: reject unusual separators in bullet worker inventories"
  ```

### Task 3: Roots repetidos pelo delta em rollout full-access sem roots declarados

**Files:**
- Modify: `src/adapters/chatgpt-web/environment.ts`, `extractChatGptCalendarEnvironmentDelta`: `workspaceRoots` passa a conter `resolve(root)` em vez de `pathIdentity(root)`. A deduplicação continua por `pathIdentity`, preservando a primeira grafia.
- Modify: `src/adapters/chatgpt-web/thread-environment.ts:253-260`, bloco `if (calendarDelta)`.
- Test: `tests/environment.test.ts`, próximo a `a same-turn midnight delta accepts rollout-authenticated roots for a projectless task`.

**Interfaces:**
- `extractChatGptCalendarEnvironmentDelta(parsed): { workspaceRoots: string[][]; filesystemProfiles: string[] } | undefined`. Mesma assinatura. Os roots agora são caminhos absolutos resolvidos com a grafia original. O único consumidor (`thread-environment.ts`) passa a comparar por `pathIdentity`.

- [ ] **Step 1: Testes que falham.** Criar um helper local `undeclaredRolloutMidnightFixture()`:
  - usa `midnightRolloutFixture()`;
  - reescreve `rolloutPath` com `session_meta` e `childTurnContext(rolloutTurnId, { workspace_roots: undefined })`;
  - define `visualizationRoot = join(codexHome, "visualizations", "2026", "10", "20", rolloutThreadId)`.

  Testes:
  1. `a midnight delta keeps its repeated workspace context when a full-access rollout omits workspace_roots`.
     - Delta: `<filesystem><workspace_roots><root>${root}</root><root>${visualizationRoot}</root></workspace_roots>…`.
     - Expected: `toEqual({ cwd: root, roots: [root, visualizationRoot], writableRoots: [root, visualizationRoot], sandboxPolicy: { type: "dangerFullAccess" }, tools: [] })`.
  2. `a midnight delta without the rollout cwd cannot replace omitted full-access roots`.
     - Delta com apenas `<root>${visualizationRoot}</root>`.
     - Expected: `toThrow("Calendar environment delta conflicts")`.
  3. `competing midnight deltas cannot replace omitted full-access roots`.
     - Dois deltas de calendário no mesmo request, ambos com `turn_id` atual e ids distintos.
     - Um com `[root]`, outro com `[root, visualizationRoot]`.
     - Expected: `toThrow("Calendar environment delta conflicts")`.
  4. `a midnight delta cannot replace the rollout cwd with an ancestor root`.
     - Delta com apenas `<root>${resolve(root, "..")}</root>`.
     - Expected: `toThrow("Calendar environment delta conflicts")`.
  5. `a managed midnight delta still cannot add roots when the rollout omits workspace_roots`.
     - Usa `managedMidnightFixture("workspace-write", false)`, reescrevendo o rollout sem `workspace_roots`.
     - Delta com `[root, visualizationRoot]`.
     - Expected: `toThrow()`.
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "midnight delta"`. Expected: o teste 1 FALHA com `Calendar environment delta conflicts with its current Codex rollout`. Os testes 2-5 já passam: são guardas.
- [ ] **Step 3: Implementação em `thread-environment.ts`.**
  - Manter a checagem de perfil.
  - Quando as quatro condições das Global Constraints valerem, substituir `rolloutEnvironment` por `{ ...rolloutEnvironment, roots: deltaRoots, writableRoots: deltaRoots }`, onde `deltaRoots` é a lista do último delta.
  - Caso contrário, manter a comparação estrita atual, agora por `pathIdentity`.
  - Comentar a regra citando a mesma justificativa das linhas 239-242.
- [ ] **Step 4:** `bun test tests/environment.test.ts`. Expected: PASS em todos.
- [ ] **Step 5:** Validar contra o rollout real de 2026-10-20 com um script descartável fora do repo, simulando o request com o delta real. Expected: `resolve` retorna os dois roots com a grafia original.
- [ ] **Step 6: Commit**
  ```bash
  git add src/adapters/chatgpt-web/environment.ts src/adapters/chatgpt-web/thread-environment.ts tests/environment.test.ts
  git commit -m "fix: keep repeated workspace context in midnight deltas for full-access rollouts without declared roots"
  ```

### Task 4: Verificação final

- [ ] `bun test ./tests`, `bun run typecheck`, `bun run launcher:typecheck`, `bun run launcher:test`. Reportar as contagens.
- [ ] Falhas ambientais esperadas (`AGENTS.md`):
  - symlink `EPERM` em `codex-integration` e no launcher;
  - `windows-installer`.
- [ ] Não executados: `check-version`, o bundle de runtime, o release smoke, e um turno ao vivo atravessando a meia-noite.
