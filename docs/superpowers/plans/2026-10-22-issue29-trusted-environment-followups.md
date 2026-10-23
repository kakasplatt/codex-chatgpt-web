# Issue #29: follow-ups do ambiente confiável — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir os pontos comportamentais pertinentes da issue #29 com diffs mínimos. Registrar a decisão sobre os demais pontos.

**Architecture:** O código afetado fica em `ChatGptThreadEnvironmentStore.resolve` (`src/adapters/chatgpt-web/thread-environment.ts`) e em três helpers de contenção léxica. O bloco de adoção do delta de calendário vira um método privado testado. Esse método também cobre o delta sem `<workspace_roots>` e a grafia de caixa. O broker (`turn-broker.ts`) não muda.

**Tech Stack:** TypeScript, Bun (`bun test ./tests`).

**Spec:** issue https://github.com/kakasplatt/codex-chatgpt-web/issues/29 (corpo e comentário). Origem: `docs/superpowers/plans/2026-10-21-pr28-review-fixes.md` Task 3, que usa a numeração 2–13 citada na issue.

## Triagem dos pontos da issue

Verificado contra o código em `ad0a0c0`.

| # (pr28-review-fixes) | Ponto | Pertinente? | Destino |
| --- | --- | --- | --- |
| 2 | Delta sem `<workspace_roots>` descarta roots estabelecidos | **Sim.** `extractChatGptCalendarEnvironmentDelta` (`environment.ts:569`) não empurra nada quando o delta omite roots. Então `deltaRoots` fica vazio, `contextRoots` fica `undefined` e não há throw. `set()` grava o `[cwd]` do rollout, e o broker (`turn-broker.ts:437`) aborta o loop de ferramentas. Houve 0 casos reais. | Task 1 |
| 3 | Envelope completo no meio do turno conta como `initialClaim` | Real, mas não é regressão: esses envelopes já eram confiáveis antes do #28. | Só registrar (fora de escopo) |
| 4 | Grafia de caixa do delta e do cwd contra o broker | **Sim, no Windows.** `environmentIdentity` compara as strings exatas, e o teste `environment.test.ts:1434` fixa a grafia do delta. Houve 0 casos reais. | Task 2 |
| 5 | `isBroadContextRoot` é léxico (junction, symlink, 8.3) | Real. Mas `realpath` traria I/O e corrida sem ganho de segurança: sob acesso total, o sandbox nativo já não restringe nada. | Só registrar |
| 6 | `contains` trata `..notes` como fora do root | **Sim.** Há três cópias: `thread-environment.ts:63`, `codex-rollout-environment.ts:56` e `environment.ts:987` (`matchesPath`). O erro rejeita um cwd persistido válido. | Task 3 |
| 7 | `isEstablished` tem efeitos colaterais | Real e de baixo valor. A leitura preguiçosa é intencional: o comentário em `thread-environment.ts:261-263` explica que ela preserva o reparo de cache corrompido. | Só registrar. A Task 1 introduz `peek()`, que pode ser reaproveitado depois |
| 8 | Pastas sensíveis dentro do home (`~/.ssh`, `~/.aws`) adotáveis | É uma decisão de design. | **Decisão aberta**, veja abaixo |
| 11 | `CODEX_THREAD_ID_SOURCE` duplica `CODEX_ID_SOURCE` | Sim, como manutenção. O código é do upstream. | Proposta upstream (#50) |
| 12 | Três cópias de `pathIdentity`, uma com `toNamespacedPath` | Sim, como manutenção. Cada módulo compara só identidades próprias, então a divergência é cosmética hoje. Unificar mudaria o comportamento de dois módulos. O código é do upstream (vechen). | Proposta upstream (#50) |
| 13 | Bloco de adoção do calendário difícil de ler | Sim. | Task 1 (mesmo bloco) |
| — | Nomes de worker aceitam NEL (U+0085) e controles bidi | Sim, risco baixo. Endurecer converte uma entrada hoje benigna em falha do turno, porque o delta passa a não ser reconhecido. | Task 4 |
| comentário | Cópias da leitura de `turn_id` | Sim, como manutenção. **Não é um refactor puro.** `itemTurnId` (`environment.ts:109`, `private-checkpoint.ts:47`) aceita qualquer string. `readNativeThreadDelegation` e `isNativeAgentsMdContext` (`native-context.ts`) exigem valor não vazio após `trim`. Também há `compaction-continuation.ts:102`, o que dá cinco sites ao todo. | Proposta upstream (#50) |

### Decisão aberta (não implementar sem resposta do usuário)

- **Ponto 8.** Hoje `~/.ssh` e `~/.aws` não contam como root amplo. Uma claim de recuperação pode adotá-los como root de contexto.
- Recomendação: manter assim. Sob acesso total, o sandbox nativo já lê esses diretórios, e a lista de bloqueio seria incompleta por natureza.
- Se o usuário decidir bloquear, crie uma Task 5:
  - adicionar `join(userHome, ".ssh")` e `join(userHome, ".aws")` a `protectedRoots` (`thread-environment.ts:198`);
  - usar o mesmo padrão de teste de `a midnight delta cannot add the user home directory as workspace context`.

### Dedupes: proposta upstream, não neste fork

Os itens 11, 12 e `turn_id` mexem em código do upstream. Fazê-los aqui gera conflito na próxima sincronização, como aconteceu no #46. Acrescente-os ao rascunho da issue #50 e confirme com o usuário antes de publicar qualquer coisa upstream. O texto deve dizer que:

- `turn_id` tem duas semânticas, a permissiva e a com `trim`;
- unificar `pathIdentity` exige escolher entre a forma namespaced e a simples.

## Global Constraints

- Diffs mínimos em arquivos do upstream. Nada de renomear nem mover helpers fora do que cada task pede.
- Não alterar `environmentIdentity` em `turn-broker.ts`.
- `pathIdentity` dobra caixa só no Windows. O macOS continua sensível a caixa (decisão D2, teste `environment.test.ts:1445`).
- Mensagens de erro e logs não incluem caminhos (regra de `thread-environment.ts:313-314`).
- Verificação: `bun test ./tests/environment.test.ts` em cada task. No fim, rode `bun run verify`, ou os passos individuais, se a versão do Bun diferir do `packageManager`. Reporte como ambientais as falhas de symlink `EPERM` e de execution policy (ver `AGENTS.md`).

## Review Focus

1. Cache expirado (TTL) ou ausente com delta sem roots: o resultado volta a ser o `[cwd]` do rollout, como hoje, sem throw. Teste na Task 1.
2. Cache com `cwd` de outra identidade que o rollout: não adota os roots do cache. Teste na Task 1.
3. Rollout que declara `workspace_roots`, ou política `managed`: o comportamento atual não muda. Os testes existentes `a managed midnight delta still cannot add roots…` e `managed midnight updates…` continuam passando.
4. Cache com JSON corrompido e delta sem roots: não pode passar a lançar onde hoje `set()` repararia o arquivo. Teste na Task 1.
5. Inventário de workers realista emitido pelo Codex continua aceito depois do endurecimento. O teste existente `compaction plus midnight accepts a native bullet worker inventory (#27)` continua passando, e a Task 4 adiciona um teste novo.

---

### Task 1: Delta sem `<workspace_roots>` preserva os roots estabelecidos (itens 2 e 13)

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts:259-309` (bloco de adoção), mais um método privado novo
- Test: `tests/environment.test.ts`, perto da linha 1487, reaproveitando `undeclaredRolloutMidnightFixture`

**Interfaces:**
- Produces: `private peek(threadId: string): StoredThreadEnvironment | undefined`. Chama `this.load(true)`, aplica o TTL **sem** apagar nem persistir, e não lança por JSON corrompido. Pode chamar `load(true)` porque só roda depois da prova do rollout nativo, e o `set()` seguinte faria o mesmo.
- Produces: `private calendarContextRoots(delta: ChatGptCalendarEnvironmentDelta, rollout: { environment: ChatGptTurnEnvironment; workspaceRootsDeclared: boolean; filesystemProfileXml: string }, threadId: string, refusesContext: (roots: string[], nativeRoots: Set<string>) => boolean): string[] | undefined`. Lança `"Calendar environment delta conflicts with its current Codex rollout"` nos mesmos casos de hoje. Retorna os roots de contexto a adotar, ou `undefined` para manter os do rollout. A Task 2 estende este método.

- [ ] **Step 1: Escrever os testes que falham** em `tests/environment.test.ts`. Use o padrão de `a broad root already established for the thread survives a midnight delta`: cache em arquivo temporário e `rolloutThreadId`. **Não** chame `repeatRoots`, para que o delta não tenha `<workspace_roots>`.
  - `a midnight delta without workspace_roots keeps the roots established at turn start`: cache `{ cwd: root, roots: [root, visualizationRoot], writableRoots: [root, visualizationRoot], sandboxPolicy: dangerFullAccess }`. Espere `resolve(request).roots` e `writableRoots` iguais a `[root, visualizationRoot]`. Espere também que o arquivo de cache continue com esses roots.
  - `a midnight delta without workspace_roots falls back to the rollout cwd without a cache`: store sem path; espere `roots` igual a `[root]` (fixa o comportamento atual).
  - `a midnight delta without workspace_roots ignores an expired cache entry`: `updatedAt: 0`; espere `[root]`.
  - `a midnight delta without workspace_roots ignores a cache for another cwd`: cache com `cwd: visualizationRoot`; espere `[root]`.
  - `a midnight delta without workspace_roots repairs a corrupt cache`: o arquivo contém `"{"`. Espere `[root]`, sem throw, e um arquivo `thread-environments.json.corrupt-*` preservado ao lado.
- [ ] **Step 2: Rodar** `bun test ./tests/environment.test.ts -t "without workspace_roots"`. Esperado: o primeiro teste FALHA (recebe `[root]`) e os demais PASSAM.
- [ ] **Step 3: Implementar.** Mova as linhas 285-309 para `calendarContextRoots`, sem mudar a semântica atual. Troque `at(-1)!` por uma variável local, porque a guarda `deltaRoots.length > 0` já a garante. Depois acrescente o ramo novo, que só vale quando todas estas condições valem:
  - `delta.workspaceRoots.length === 0`, `!rollout.workspaceRootsDeclared` e o rollout é `dangerFullAccess`;
  - `peek(threadId)` retorna uma entrada `dangerFullAccess` com `pathIdentity(cached.cwd) === pathIdentity(rollout.environment.cwd)`;
  - essa entrada contém todos os roots nativos.

  Nesse caso, retorne `cached.roots`. Não aplique `refusesContext`: são roots já estabelecidos, que é a regra D1.
- [ ] **Step 4: Rodar** `bun test ./tests/environment.test.ts`. Esperado: PASS, incluindo todos os testes `midnight` e `compaction plus midnight` existentes.
- [ ] **Step 5: Commit:** `fix(environment): keep established roots across a midnight delta without workspace_roots (#29)`.

### Task 2: Preferir a grafia do cache quando a identidade coincide (item 4)

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts`, em `calendarContextRoots` (Task 1) e no ponto onde o resultado é montado, antes de `this.set(...)`
- Test: `tests/environment.test.ts`, ao lado do teste da linha 1434

**Interfaces:**
- Consumes: `peek(threadId)` da Task 1.
- Produces: `function preferSpelling(paths: string[], cached: readonly string[]): string[]`, uma função de módulo. Troca cada path cuja `pathIdentity` coincide com um path de `cached` pela grafia de `cached`. A ordem fica a de `paths`.

- [ ] **Step 1: Escrever os testes que falham.** Use `test.skipIf(process.platform !== "win32")`.
  - `a midnight delta that differs from the established roots only in case keeps the cached spelling`: cache com `roots: [root, visualizationRoot]` e `repeatRoots(delta, root.toUpperCase(), visualizationRoot)`. Espere `roots` e `writableRoots` iguais a `[root, visualizationRoot]`.
  - `the rollout cwd keeps the cached spelling when only its case differs`: cache com `cwd: root.toUpperCase()` e roots em maiúsculas. Espere `cwd` igual a `root.toUpperCase()`.
  - O teste existente na linha 1434, que não tem cache, continua passando sem alteração.
- [ ] **Step 2: Rodar** `bun test ./tests/environment.test.ts -t "spelling"`. Esperado: os dois testes novos FALHAM.
- [ ] **Step 3: Implementar** `preferSpelling` e aplicá-la a `roots`, `writableRoots` e `cwd` do ambiente retornado no ramo do delta de calendário, quando `peek` retornar uma entrada. Fora do ramo de calendário, nada muda.
- [ ] **Step 4: Rodar** `bun test ./tests/environment.test.ts`. Esperado: PASS.
- [ ] **Step 5: Commit:** `fix(environment): reuse the established path spelling so the broker keeps the tool loop (#29)`.

### Task 3: `contains` aceita um filho chamado `..notes` (item 6)

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts:63-66`, `src/adapters/chatgpt-web/codex-rollout-environment.ts:56-59` e `src/adapters/chatgpt-web/environment.ts:987-990`
- Test: `tests/environment.test.ts`

**Interfaces:** nenhuma nova. As assinaturas continuam iguais.

- [ ] **Step 1: Escrever os testes que falham:**
  - `a persisted cwd inside a child named ..notes stays inside its root`: o cache tem `cwd: join(root, "..notes")` e `roots: [root]`, e a continuação usa o cache (padrão de `environment.test.ts:890-911`). Espere `cwd` igual a `join(root, "..notes")`, sem `Persisted ChatGPT cwd is outside its roots`.
  - `a sibling reached through .. is still outside its root`: cache com `cwd: resolve(root, "..", "other")`. Espere throw `Invalid persisted` ou `outside its roots`. Esse teste fixa a direção restritiva.
- [ ] **Step 2: Rodar.** Esperado: o primeiro teste FALHA e o segundo PASSA.
- [ ] **Step 3: Implementar** nas três cópias. A regra passa a ser `rel === "" || (rel !== ".." && !rel.startsWith(\`..${sep}\`) && !isAbsolute(rel))`, com `sep` importado de `node:path`.
- [ ] **Step 4: Rodar** `bun test ./tests`. Esperado: PASS, exceto as falhas ambientais conhecidas (ver Global Constraints).
- [ ] **Step 5: Commit:** `fix(environment): treat a child named ..notes as inside its root (#29)`.

### Task 4: Nomes de worker sem NEL nem controles bidi

**Files:**
- Modify: `src/adapters/chatgpt-web/environment.ts:505-510` (`CALENDAR_SUBAGENT_INVENTORY_SOURCE`)
- Test: `tests/environment.test.ts`, perto da linha 1693

- [ ] **Step 1: Escrever os testes:**
  - `a bullet worker name with NEL or a bidi control is not a calendar delta`: para cada um de `\u0085`, `‮`, `⁦` e `‏`, insira o caractere no nickname do fixture de inventário em bullet. Espere a mesma falha fechada do teste `a rejected bullet worker inventory…`.
  - `a realistic Codex bullet worker inventory still matches`: nicknames `Pauli`, `Ada Lovelace` e `Ünal-2`. Espere aceitação.
- [ ] **Step 2: Rodar.** Esperado: o primeiro teste FALHA e o segundo PASSA.
- [ ] **Step 3: Implementar.** Acrescente `\u0085`, `؜`, `‎‏`, `‪-‮` e `⁦-⁩` à classe negada do nome e ao primeiro caractere `[^<>\s]`. O `\s` do JS não inclui U+0085. A classe continua linear: nada de alternância nova.
- [ ] **Step 4: Rodar** `bun test ./tests/environment.test.ts`. Esperado: PASS, incluindo o teste de backtracking (linha 1693).
- [ ] **Step 5: Commit:** `fix(environment): reject NEL and bidi controls in calendar worker names (#29)`.

### Task 5: Fechamento

- [ ] **Step 1:** Rodar `bun run verify`. Se a versão do Bun diferir do `packageManager`, rode os passos individualmente e reporte como não executados os passos que dependem da versão.
- [ ] **Step 2:** Revisão final da branch com `superpowers:requesting-code-review`.
- [ ] **Step 3:** Mostrar ao usuário o rascunho do texto para a issue #50, com os dedupes 11, 12 e `turn_id`. **Não publicar sem confirmação.**
- [ ] **Step 4:** Mostrar ao usuário o rascunho do comentário de fechamento da #29. Ele lista o que foi corrigido, o que foi só registrado (3, 5 e 7), o que foi para o upstream e a decisão do item 8. Publique só depois da confirmação.

## Fora de escopo

- Item 3 (envelope no meio do turno), item 5 (`realpath`) e item 7 (tornar `isEstablished` puro). Os motivos estão na tabela de triagem.
- Qualquer mudança em `turn-broker.ts`.
- Validação com sessão ChatGPT autenticada. Ela não roda neste plano: os testes usam rollouts sintéticos.
