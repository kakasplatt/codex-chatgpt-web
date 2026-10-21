# Achados menores do delta de calendário — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolver os quatro achados menores que a revisão final de `96f14f7..b3855c3` deixou para depois:
1. teste managed com asserção genérica;
2. roots ancestrais ou de filesystem adotados e gravados no cache;
3. falta de um teste isolado para `\u2029`;
4. dedupe de roots duplicando `uniqueAbsolutePaths`.

**Architecture:** As mudanças em produção são duas, ambas em código já existente. Uma função pura de dedupe passa a ser compartilhada em `environment.ts`. A regra de adoção de roots do delta de calendário (`thread-environment.ts:265-273`) passa a recusar roots extras que sejam raiz de filesystem ou ancestrais de um root nativo. Os outros dois achados são só de teste.

**Tech Stack:** TypeScript, Bun (`bun test`), `tsc --noEmit`.

**Spec:** relatório da revisão final das correções de 2026-10-21 (Minors 1-4) e o plano `docs/superpowers/plans/2026-10-21-calendar-delta-followups.md` (Task 3 e sua Ruling).

## Estado verificado

- **Minor 1:** o teste `a managed midnight delta still cannot add roots when the rollout omits workspace_roots` já lança `Calendar environment delta conflicts`. Trocar a asserção passa sem mudar o código.
- **Minor 2:** um delta `[root, "C:\\"]`, num rollout full-access sem `workspace_roots`, é adotado e gravado por `this.set(rolloutIdentity.threadId, …)` (`thread-environment.ts:285`). Depois, o fallback de filho pelo pai em cache (`thread-environment.ts:321-325`) aceita qualquer `lineage.workspaceRoots` contido em `C:\`. O ramo de claim (`:243-252`) tem a mesma propriedade, mas fica **fora** deste plano: o achado é sobre o delta.
- **Minor 3:** `\u2029` já é rejeitado. O teste novo só documenta e fixa esse comportamento.
- **Minor 4:** o parse do delta (`environment.ts:534-539`) reimplementa a parte de resolver e deduplicar de `uniqueAbsolutePaths` (`environment.ts:948-957`). Uma divergência futura de grafia quebraria a identidade de ambiente no broker (`turn-broker.ts:437`).

## Global Constraints

- Arquivos: `src/adapters/chatgpt-web/environment.ts`, `src/adapters/chatgpt-web/thread-environment.ts`, `tests/environment.test.ts`.
- Todos os testes atuais continuam passando sem alteração de expectativa, exceto a asserção que a Task 1 torna explícita.
- Um root extra adotado de um delta precisa:
  - ser diferente de todo root nativo (comparado por `pathIdentity`);
  - não ser raiz de filesystem (`parse(path).root` com `pathIdentity` igual ao do próprio path);
  - não conter nenhum root nativo (via `contains`).

  Se algum extra violar uma dessas regras, a adoção não acontece e vale a comparação estrita, que lança `Calendar environment delta conflicts with its current Codex rollout`.
- Roots irmãos ou externos que não contêm o projeto, como a pasta de visualizações, continuam aceitos.
- Bun local 1.4.3 ≠ pin 1.4.0: `check-version`, o bundle de runtime e o release smoke não são executados.

## Review Focus

1. Um root extra que é ancestral do cwd (`resolve(root, "..")`) junto com o próprio cwd deve ser recusado. Teste na Task 3.
2. Uma raiz de filesystem (`parse(root).root`) junto com o cwd deve ser recusada. Teste na Task 3.
3. Um root extra igual a um root nativo com outra grafia (maiúsculas no Windows) é o mesmo root, não um extra. Já é deduplicado; coberto pelo teste existente de adoção.
4. A pasta de visualizações continua sendo adotada. Coberto por `a midnight delta keeps its repeated workspace context…`.
5. A refatoração de dedupe não pode mudar a grafia nem a ordem dos roots no envelope inicial. Coberto pelos testes existentes que comparam `roots` com `toEqual`.

---

### Task 1: Testes explícitos (Minors 1 e 3)

**Files:**
- Test: `tests/environment.test.ts`:
  - teste `a managed midnight delta still cannot add roots when the rollout omits workspace_roots` (por volta da linha 1443);
  - teste `a calendar worker inventory cannot conceal authority changes or extra markup` (array de inventários rejeitados).

**Interfaces:** nenhuma.

- [ ] **Step 1:** No teste managed, trocar `.toThrow()` por `.toThrow("Calendar environment delta conflicts")`.
- [ ] **Step 2:** No array de inventários rejeitados, acrescentar `` `<subagents>\n - ${workerId}: A\u2029B\n</subagents>` ``.
- [ ] **Step 3:** `bun test tests/environment.test.ts -t "managed midnight delta still|cannot conceal"`. Expected: PASS. Os dois testes fixam comportamento já correto, portanto não há RED.
- [ ] **Step 4: Provar que o teste do Step 2 discrimina.**
  - Remover temporariamente `\\u2029` da classe do nome em `CALENDAR_SUBAGENT_INVENTORY_SOURCE`.
  - Rodar `-t "cannot conceal"`. Expected: FAIL com `Expected substring: "missing cwd"`, porque o `resolve` passa a aceitar o delta.
  - Restaurar com `git checkout -- src/adapters/chatgpt-web/environment.ts` e rodar de novo. Expected: PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add tests/environment.test.ts
  git commit -m "test: pin calendar conflict message and U+2029 worker-name rejection"
  ```

### Task 2: Dedupe compartilhado de caminhos (Minor 4)

**Files:**
- Modify: `src/adapters/chatgpt-web/environment.ts`:
  - nova função de módulo, perto de `pathIdentity` (linha 71);
  - `uniqueAbsolutePaths` (linha 948);
  - parse dos roots do delta (linhas 534-539).

**Interfaces:**
- Produces: `function dedupeResolvedPaths(paths: string[]): string[]`. Não exportada. Aplica `resolve()` a cada caminho, deduplica por `pathIdentity` e mantém a primeira grafia e a ordem de entrada.

- [ ] **Step 1:** Implementar `dedupeResolvedPaths`.
  - `uniqueAbsolutePaths` passa a decodificar, validar (lança como hoje) e retornar `dedupeResolvedPaths(decoded)`.
  - O parse do delta substitui o laço com `Map` por `workspaceRoots.push(dedupeResolvedPaths(roots))` e mantém o comentário sobre a grafia nativa.
  - Refatoração pura, sem teste novo: os existentes já fixam a grafia e a ordem.
- [ ] **Step 2:** `bun test tests/environment.test.ts tests/chatgpt-web-harness.test.ts tests/subagent-environment-history.test.ts` e `bun run typecheck`. Expected: PASS e sem erros.
- [ ] **Step 3: Commit**
  ```bash
  git add src/adapters/chatgpt-web/environment.ts
  git commit -m "refactor: share resolved path dedupe for envelope and calendar roots"
  ```

### Task 3: Recusar roots extras amplos na adoção do delta (Minor 2)

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts:265-273`, condição de `contextRoots`, e o import de `node:path`, que passa a incluir `parse`.
- Test: `tests/environment.test.ts`, junto aos testes de `undeclaredRolloutMidnightFixture()` (por volta das linhas 1380-1445).

**Interfaces:**
- Consumes: `undeclaredRolloutMidnightFixture()`, que já existe nos testes e retorna `{ codexHome, request, body, delta, rolloutPath, visualizationRoot, repeatRoots(delta, ...roots) }`.

- [ ] **Step 1: Testes que falham.**
  1. `a midnight delta cannot add an ancestor of the rollout cwd as workspace context`:
     - `repeatRoots(delta, root, resolve(root, ".."))`;
     - `expect(() => new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome).resolve(request)).toThrow("Calendar environment delta conflicts")`.
  2. `a midnight delta cannot add a filesystem root as workspace context`:
     - `repeatRoots(delta, root, parse(root).root)`;
     - mesma asserção;
     - importar `parse` de `node:path` no teste.
  3. Guarda positiva, `a midnight delta keeps a sibling output root as workspace context`:
     - `repeatRoots(delta, root, resolve(root, "..", "sibling-output"))`;
     - `expect(store.resolve(request).roots).toEqual([root, resolve(root, "..", "sibling-output")])`.
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "midnight delta"`. Expected: os testes 1 e 2 FALHAM (o `resolve` retorna em vez de lançar); o teste 3 passa.
- [ ] **Step 3: Implementação.** Na condição de `contextRoots`, depois da checagem de inclusão dos roots nativos, exigir que cada root de `calendarDelta.workspaceRoots.at(-1)!` que não seja nativo:
  - não seja raiz de filesystem;
  - não contenha nenhum root nativo (`contains(extra, native)`).

  Acrescentar uma linha ao comentário existente: um root de contexto não pode ampliar a checagem de sobreposição que filhos fazem contra o pai em cache.
- [ ] **Step 4:** `bun test tests/environment.test.ts`. Expected: PASS em todos.
- [ ] **Step 5: Commit**
  ```bash
  git add src/adapters/chatgpt-web/thread-environment.ts tests/environment.test.ts
  git commit -m "fix: refuse ancestor and filesystem roots as adopted calendar workspace context"
  ```

### Task 4: Verificação final

- [ ] `bun test ./tests`, `bun run typecheck`, `bun run launcher:typecheck`, `bun run launcher:test`. Reportar as contagens.
- [ ] Falhas ambientais esperadas (`AGENTS.md`): symlink `EPERM` e `windows-installer`.
- [ ] Não executados: `check-version`, o bundle de runtime, o release smoke, e um turno ao vivo atravessando a meia-noite.

## Fora de escopo

- O mesmo endurecimento no ramo de claim (`thread-environment.ts:243-252`), que hoje adota `currentClaim.roots` com a mesma amplitude. Mudar esse ramo afeta o início de turnos e a retomada após compaction. Se for desejado, merece plano próprio.
- NEL (`\u0085`) e controles bidi (`\u202e`) em nomes de subagente. O revisor não os julgou. São descartados e não concedem autoridade.
