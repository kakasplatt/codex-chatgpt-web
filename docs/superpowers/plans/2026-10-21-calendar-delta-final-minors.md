# Achados finais do delta de calendário e endurecimento dos roots de contexto — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolver quatro grupos de itens.
1. Os quatro achados menores da revisão de `b3855c3..daf08fc`:
   - teste de grafia com outra caixa;
   - separadores literais nos testes;
   - terceira cópia do dedupe;
   - comentário incompleto.
2. Uma regressão encontrada nos dados reais: a regra "root extra que contém um root nativo", de `daf08fc`, recusa o layout de tarefas sem projeto do Codex.
3. Os três itens que estavam fora de escopo:
   - proteção no ramo de claim;
   - roots extras amplos que não contêm o projeto;
   - caixa de caminho no macOS.

**Architecture:** Uma única função de módulo em `thread-environment.ts` decide se um root extra é "amplo". Ela é usada tanto na adoção de roots do delta de calendário quanto na adoção de roots de uma claim, e conta com três regras:
- grafia namespaced ou de device do Windows;
- raiz de filesystem;
- root igual a, ou que contém, um caminho protegido: Codex homes confiáveis, diretório de dados da ponte e home do usuário.

A regra "contém root nativo" sai. Um root amplo só é recusado quando é **novo** em relação aos roots já estabelecidos para o thread no cache (decisão D1). O início do turno não muda.

**Tech Stack:** TypeScript, Bun (`bun test`), `tsc --noEmit`.

**Spec:**
- relatório da revisão final de `b3855c3..daf08fc`;
- planos `docs/superpowers/plans/2026-10-21-calendar-delta-minor-findings.md` e `…-followups.md`;
- pedido do usuário para incluir os três itens fora de escopo.

## Decisões para revisão do usuário

- **D1 — onde aplicar a proteção (recomendado: b).**
  - **(a)** Aplicar também no início do turno (`thread-environment.ts:196`): um workspace com root amplo falha logo ao começar.
  - **(b)** Manter o início do turno como está. Nos ramos de recuperação (claim e delta de calendário), recusar um root amplo **só se ele não estiver** nos roots já estabelecidos para o thread no cache.
  - **Por que (b):** o início do turno é o envelope nativo do Codex e já é gravado no cache; recusá-lo quebraria configurações legítimas do usuário. Com (b), um root amplo que o próprio usuário configurou sobrevive a steering, compaction e meia-noite. O broker fixa o ambiente inicial durante todo o loop de ferramentas (`turn-broker.ts:437`), então mudar no meio do turno já falharia. Só um root amplo **introduzido** por uma claim de recuperação é recusado.
  - **Limite:** com mais de um Codex home não há cache (`set` retorna cedo), e (b) vira uma proteção estática.
- **D2 — macOS (recomendado: manter sensível a caixa).** Hoje uma divergência de caixa no macOS falha fechado, porque gera conflito.
  - Ignorar caixa misturaria caminhos distintos em volumes APFS sensíveis a caixa e tornaria a contenção mais permissiva.
  - Usar `realpath` mudaria a semântica de symlinks e acrescentaria I/O.
  - O plano documenta a decisão e fixa o comportamento com um teste só para darwin, que **não roda nesta máquina**.

## Evidência dos dados reais (varredura de `~/.codex/sessions`)

- Foram 787 listas de roots e 97 roots extras (diferentes do cwd).
- **Nenhum** extra é raiz de filesystem, usa `\\?\` ou `\\.\`, nem contém `~/.codex`, `~/.codex-chatgpt-web` ou o home.
- Seis tarefas sem projeto têm `cwd = C:\Users\<user>\Documents\Codex\<data>\<slug>` e o extra `C:\Users\<user>\Documents\Codex`, **ancestral do cwd**. Uma delas é `rollout-…-01a14bb5-…` (2026-10-17, `chatgpt-web/gpt-6-sol`, `danger-full-access`, rollout **sem** `workspace_roots`). Se ela atravessar a meia-noite, a regra atual de `daf08fc` recusa o delta e o turno falha. A regra precisa sair.
- O `os.homedir()` do Bun segue `USERPROFILE`/`HOME` em tempo de execução: com `USERPROFILE = C:/tmp-fake-home`, ele retorna esse valor. O diretório da ponte vem de `getConfigDir()` (`src/config.ts:157`), controlado por `CODEX_CHATGPT_WEB_HOME`. As duas regras podem ser testadas de forma isolada.

## Global Constraints

- Arquivos:
  - `src/adapters/chatgpt-web/thread-environment.ts`;
  - `src/adapters/chatgpt-web/environment.ts` (só exportar `dedupeResolvedPaths` e comentar `pathIdentity`);
  - `tests/environment.test.ts`.
- Um root extra é **amplo** quando, em comparação por `pathIdentity`, ele:
  - não é root nativo; **e**
  - tem prefixo `\\?\` ou `\\.\` no Windows; **ou** é raiz de filesystem; **ou** é igual a, ou contém, um caminho protegido: `this.codexHomes`, `getConfigDir()` ou `homedir()`, os dois últimos calculados no construtor.
- Com a decisão D1(b), um root amplo é aceito se já estiver nos roots do thread no cache (`this.get(threadId)?.roots`).
- Mensagens esperadas:
  - delta recusado: `Calendar environment delta conflicts with its current Codex rollout`;
  - claim de steering recusada: `Steering environment conflicts with its current Codex rollout (fields: workspace_roots)`. É a mensagem existente de `conflictingAuthorityFields`; quando a ampliação é recusada, o fluxo cai nela.
- Roots irmãos, a pasta de visualizações (dentro de um Codex home, sem contê-lo) e o pai de tarefas sem projeto (`Documents\Codex`) continuam aceitos.
- Testes que dependem do Windows usam `test.skipIf(process.platform !== "win32")`; o teste de macOS usa `test.skipIf(process.platform !== "darwin")`.
- Testes que alteram `USERPROFILE`, `HOME` ou `CODEX_CHATGPT_WEB_HOME` restauram os valores originais num `finally`.
- Bun local 1.4.3 ≠ pin 1.4.0: `check-version`, o bundle de runtime e o release smoke não são executados.

## Review Focus

1. O pai de uma tarefa sem projeto (`resolve(root, "..")`) junto com o cwd e a pasta de visualizações volta a ser adotado na ordem do delta. Task 3.
2. Um Codex home, o diretório de dados da ponte ou o home do usuário como extra é recusado tanto no delta quanto na claim de steering. Tasks 3 e 4.
3. Um root amplo já estabelecido no cache do thread sobrevive à meia-noite. Task 4.
4. A pasta de visualizações, que fica dentro de um Codex home, continua aceita. Teste existente `a midnight delta keeps its repeated workspace context…`.
5. Um cache persistido com o mesmo root em duas caixas carrega um root só. Task 2.

---

### Task 1: Testes de grafia e escapes explícitos (Minors 1 e 2)

**Files:**
- Test: `tests/environment.test.ts`:
  - perto de `a midnight delta keeps its repeated workspace context when a full-access rollout omits workspace_roots` (por volta da linha 1399);
  - casos com U+2028 (por volta da linha 1615) e U+2029 (por volta da linha 1619) no teste `a calendar worker inventory cannot conceal authority changes or extra markup`.

**Interfaces:**
- Consumes: `undeclaredRolloutMidnightFixture()`, que retorna `{ codexHome, request, delta, visualizationRoot, repeatRoots(delta, ...roots) }`.

- [ ] **Step 1:** Adicionar, com `test.skipIf(process.platform !== "win32")`:
  1. `a midnight delta that repeats the cwd in another case does not add it as an extra root`:
     - `repeatRoots(delta, root, root.toUpperCase())`;
     - `roots` é `toEqual([root])`.
  2. `adopted midnight roots keep the delta spelling while cwd keeps the rollout spelling`:
     - `repeatRoots(delta, root.toUpperCase(), visualizationRoot)`;
     - `toMatchObject({ cwd: root, roots: [root.toUpperCase(), visualizationRoot], writableRoots: [root.toUpperCase(), visualizationRoot] })`.
- [ ] **Step 2:** Trocar os dois separadores literais pelos escapes `\u2028` e `\u2029`. Conferir com `grep -nP "\x{2028}|\x{2029}" tests/environment.test.ts`. Expected: nenhuma saída.
- [ ] **Step 3:** `bun test tests/environment.test.ts -t "another case|delta spelling|cannot conceal"`. Expected: PASS. É comportamento já correto, portanto não há RED.
- [ ] **Step 4: Provar que os testes discriminam.**
  - Remover temporariamente `\\u2028\\u2029` da classe do nome em `CALENDAR_SUBAGENT_INVENTORY_SOURCE`. Expected: `cannot conceal` FALHA.
  - Trocar temporariamente o valor adotado `calendarDelta.workspaceRoots.at(-1)!` por `rolloutEnvironment.roots`. Expected: `delta spelling` FALHA.
  - Restaurar com `git checkout -- src/`. Expected: PASS.
- [ ] **Step 5: Commit:** `test: pin adopted root spelling and use explicit separator escapes`.

### Task 2: Dedupe compartilhado no cache persistido (Minor 3)

**Files:**
- Modify: `src/adapters/chatgpt-web/environment.ts:77`. `dedupeResolvedPaths` passa a ser `export`.
- Modify: `src/adapters/chatgpt-web/thread-environment.ts`: import de `./environment` e `absolutePaths` (linhas 63-72).
- Test: `tests/environment.test.ts`, perto dos testes de cache persistido que usam `thread-environments.json` (por volta das linhas 887-930).

**Interfaces:**
- Produces: `export function dedupeResolvedPaths(paths: string[]): string[]`, com o comportamento atual.

- [ ] **Step 1:** Adicionar, com `test.skipIf(process.platform !== "win32")`, `a persisted thread environment loads case-duplicated roots once`:
  - gravar um ambiente `dangerFullAccess` com `roots` e `writableRoots` iguais a `[root, root.toUpperCase()]`;
  - resolver um request sem envelope para esse thread;
  - `roots` é `toEqual([root])`.

  Seguir o formato dos testes de cache existentes.
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "case-duplicated"`. Expected: PASS. O teste fixa a refatoração.
- [ ] **Step 3:** Exportar `dedupeResolvedPaths` e fazer `absolutePaths` manter a validação e retornar `dedupeResolvedPaths(value as string[])`.
- [ ] **Step 4:** `bun test tests/environment.test.ts` e `bun run typecheck`. Expected: PASS e sem erros.
- [ ] **Step 5: Commit:** `refactor: reuse resolved path dedupe for persisted thread roots`.

### Task 3: Regra de root amplo baseada em caminhos protegidos (regressão de `daf08fc` + item "roots amplos fora do projeto")

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts`:
  - import de `node:os` (`homedir`) e de `../../config` (`getConfigDir`);
  - construtor: novo campo `private readonly protectedRoots: string[]`;
  - nova função de módulo `isBroadContextRoot`;
  - substituir o `broadRoot` local do bloco de calendário (por volta das linhas 264-273).
- Test: `tests/environment.test.ts`, bloco dos testes de `undeclaredRolloutMidnightFixture()`.

**Interfaces:**
- Produces: `function isBroadContextRoot(path: string, nativeRoots: Set<string>, protectedRoots: readonly string[]): boolean`. É de módulo e não exportada. `nativeRoots` contém identidades (`pathIdentity`). Retorna `false` para um root nativo.
- Produces: `this.protectedRoots = [...this.codexHomes, getConfigDir(), homedir()]`, calculado no construtor.

- [ ] **Step 1: Testes.**
  1. **Alterar** o caso `an ancestor of the rollout cwd` do laço `a midnight delta cannot add ${label} as workspace context`: ele sai do laço e vira `a midnight delta keeps a projectless task parent root as workspace context`.
     - `repeatRoots(delta, resolve(root, ".."), root, visualizationRoot)`;
     - `roots` é `toEqual([resolve(root, ".."), root, visualizationRoot])`.
  2. `a midnight delta cannot add a trusted Codex home as workspace context`:
     - `repeatRoots(delta, root, codexHome)`;
     - `toThrow("Calendar environment delta conflicts")`.
  3. `a midnight delta cannot add the bridge data directory as workspace context`:
     - com `CODEX_CHATGPT_WEB_HOME` apontando para um temp dir `bridgeHome` antes de criar o store;
     - `repeatRoots(delta, root, bridgeHome)`;
     - mesma asserção; restaurar a variável no `finally`.
  4. `a midnight delta cannot add the user home directory as workspace context`:
     - com `USERPROFILE` e `HOME` apontando para um temp dir `fakeHome` (fora de `root` e de `codexHome`) antes de criar o store;
     - `repeatRoots(delta, root, fakeHome)`;
     - mesma asserção; restaurar no `finally`.
  5. Os casos existentes de raiz de filesystem, outro drive, share e grafias namespaced continuam no laço, sem mudança.
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "midnight delta"`. Expected:
  - o teste 1 FALHA, porque hoje o ancestral é recusado;
  - os testes 2, 3 e 4 FALHAM, porque hoje esses roots são adotados;
  - os demais passam.
- [ ] **Step 3: Implementação.**
  - `isBroadContextRoot` implementa as três regras das Global Constraints. A regra "contém root nativo" é removida.
  - O bloco de calendário usa `isBroadContextRoot(path, nativeRoots, this.protectedRoots)`.
- [ ] **Step 4:** `bun test tests/environment.test.ts`. Expected: PASS em todos.
- [ ] **Step 5: Mutações** (cada uma deve derrubar pelo menos um teste; restaurar depois de cada):
  - sem a cláusula de raiz de filesystem;
  - sem a cláusula namespaced;
  - sem `getConfigDir()`;
  - sem `homedir()`;
  - sem `this.codexHomes`.
- [ ] **Step 6: Commit:** `fix: judge adopted calendar roots by protected paths instead of native ancestry`.

### Task 4: Proteção no ramo de claim e roots já estabelecidos (item "ramo de claim", decisão D1, Minor 4)

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts`:
  - bloco de claim (linhas 243-252);
  - bloco de calendário;
  - comentário do guard.
- Test: `tests/environment.test.ts`:
  - perto de `steering accepts native output grants with … rollout workspace roots` (por volta da linha 1688), usando `steeredRolloutFixture(false, [])`;
  - bloco de calendário.

**Interfaces:**
- Consumes: `isBroadContextRoot` e `this.protectedRoots` (Task 3); `steeredRolloutFixture(child, workspaceRoots)`, que retorna `{ codexHome, request, body, rolloutPath, environment, auxiliary }`, onde `environment.content[1].text` é o XML do envelope de steering.

- [ ] **Step 1: Testes.**
  1. `steering cannot widen omitted full-access roots with a trusted Codex home`:
     - reescrever o rollout sem `workspace_roots`;
     - em `environment.content[1].text`, trocar `auxiliary` por `codexHome`;
     - `toThrow("Steering environment conflicts with its current Codex rollout (fields: workspace_roots)")`.
  2. `steering still adopts a sibling auxiliary root when the rollout omits workspace_roots`: guarda positiva com o `auxiliary` original; `roots` é `toEqual([root, auxiliary])`.
  3. `a broad root already established for the thread survives a midnight delta` (D1 b):
     - pré-gravar, via `thread-environments.json` de um store com `path`, o ambiente do thread com `roots: [root, codexHome]`;
     - `repeatRoots(delta, root, codexHome)`;
     - `roots` é `toEqual([root, codexHome])`.
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "steering cannot widen|sibling auxiliary|already established"`. Expected: os testes 1 e 3 FALHAM; o teste 2 passa.
- [ ] **Step 3: Implementação.**
  - Calcular uma vez `established = new Set((this.get(rolloutIdentity.threadId)?.roots ?? []).map(pathIdentity))`.
  - Um root é recusado só quando `isBroadContextRoot(...) && !established.has(pathIdentity(root))`.
  - No ramo de claim, a ampliação (`roots`/`writableRoots` com `currentClaim.environment.roots`) só acontece se nenhum root da claim for recusado. Caso contrário, o fluxo segue para `conflictingAuthorityFields`, que lança a mensagem acima.
  - Aplicar a mesma exceção `established` no bloco de calendário.
- [ ] **Step 4: Comentário (Minor 4).** Num único comentário sobre `isBroadContextRoot`, explicar:
  - os roots adotados passam a ser o ambiente do pai, persistido no cache;
  - filhos sem envelope herdam `parent.roots` e são checados contra ele;
  - por isso uma claim de recuperação não pode introduzir raiz de filesystem, grafia namespaced ou um root que contenha Codex home, dados da ponte ou o home;
  - roots que o próprio início do turno estabeleceu são mantidos (D1).
- [ ] **Step 5:** `bun test tests/environment.test.ts tests/subagent-environment-history.test.ts tests/trusted-codex-homes.test.ts` e `bun run typecheck`. Expected: PASS e sem erros.
- [ ] **Step 6: Commit:** `fix: refuse broad roots introduced by recovery claims while keeping start-established roots`.

### Task 5: Caixa de caminho no macOS (item "pathIdentity no macOS", decisão D2)

**Files:**
- Modify: comentário de `pathIdentity` em `src/adapters/chatgpt-web/environment.ts:71` e `src/adapters/chatgpt-web/thread-environment.ts:53`.
- Test: `tests/environment.test.ts`, bloco de calendário.

- [ ] **Step 1:** Adicionar `test.skipIf(process.platform !== "darwin")`, `macOS keeps root identity case-sensitive and fails closed on a case mismatch`:
  - delta com `repeatRoots(delta, root.toUpperCase())`;
  - `toThrow("Calendar environment delta conflicts")`.
- [ ] **Step 2:** Comentar nas duas funções `pathIdentity`:
  - só o Windows ignora caixa;
  - no macOS a comparação continua sensível a caixa de propósito, porque ignorar misturaria caminhos distintos em volumes APFS sensíveis a caixa, e `realpath` mudaria a semântica de symlinks;
  - uma divergência falha fechado.
- [ ] **Step 3:** `bun test tests/environment.test.ts`. Expected: PASS, com o teste darwin pulado. Reportar o teste darwin como **não executado** nesta máquina.
- [ ] **Step 4: Commit:** `docs: record case-sensitive macOS path identity and pin it in a darwin test`.

### Task 6: Verificação final

- [ ] `bun test ./tests`, `bun run typecheck`, `bun run launcher:typecheck`, `bun run launcher:test`. Reportar as contagens.
- [ ] Repetir a varredura de `~/.codex/sessions` (script descartável fora do repo). Confirmar que nenhum dos 97 extras reais é classificado como amplo pela regra nova.
- [ ] Falhas ambientais esperadas (`AGENTS.md`): symlink `EPERM` e `windows-installer`.
- [ ] Não executados: `check-version`, o bundle de runtime, o release smoke, o teste darwin, e um turno ao vivo atravessando a meia-noite.

## Fora de escopo

- Guardas no início do turno (`thread-environment.ts:196`), caso D1 fique em (b).
- Unificar a `pathIdentity` namespaced de `codex-rollout-environment.ts` com as outras duas, porque isso mudaria a comparação de grafias `\\?\` dentro da proteção.
