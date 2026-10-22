# Falhas de testes da raiz no CI do fork (#33, #34, #35) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir as três falhas preexistentes de `bun run test` que apareceram na primeira execução de CI do fork (run 39706958990, PR #32), num único PR com `Fixes #33`, `Fixes #34` e `Fixes #35`, e obter CI verde nos três sistemas.

**Architecture:** Três correções independentes, uma por task, cada uma com TDD e commit próprio, executadas em série:
- **#33:** o home do usuário passa a ser injetável em `ChatGptThreadEnvironmentStore`. O padrão de produção continua `homedir()`.
- **#34:** o planner do Full Context passa a contar os tokens de cada registro uma vez por chamada, com um cache local à chamada. A pesagem dos registros sai do laço de `stagingEffort`.
- **#35:** os fixtures de socket do broker passam a usar um diretório temporário curto, só no arquivo de teste.

**Tech Stack:** TypeScript, Bun 1.4.0 (`bun test`, `bun:test` `spyOn`), `tsc --noEmit`, GitHub Actions (`.github/workflows/ci.yml`).

**Spec:** issues #33, #34 e #35 do fork `kakasplatt/codex-chatgpt-web`, e as decisões do usuário registradas na sessão de planejamento de 2026-10-21. As investigações read-only foram feitas contra `c0e8085` e re-verificadas neste worktree.

## Evidência que define o escopo

- **Run 39706958990** (`pull_request`, PR #32, head `71490ec`): `verify` parou em `bun run test` nos três sistemas.
  - windows-latest: só `Full Context checkpoint overhead does not reduce the canonical 1,050,000-token ceiling`, a 36.441 ms contra um timeout de 30 s.
  - ubuntu-latest: só `a midnight delta cannot add the user home directory as workspace context`.
  - macos-15: esse mesmo teste e `broker shutdown succeeds immediately after a bounded rejected claim`.
- **Nunca rodaram no fork:** todos os passos do `verify` depois de `test` (`launcher:typecheck`, `launcher:test`, `launcher:build`, bundle de runtime, notices, `smoke-release`) e também `app:package`, o smoke de símbolos do AppImage e `app:smoke`.
- **`launcher:audit` falha na base `c0e8085`:** `electron@41.10.7`, moderate, GHSA-fw47-9c62-h3vw. Medido neste worktree em 2026-10-21. O PR #32 corrige isso e mexe só em `launcher/bun.lock`, `launcher/package.json` e `launcher/tests/packaging-contract.test.cjs`. **Este PR sozinho para em `launcher:audit`, antes de `test`, nos três sistemas**, e portanto não prova nada no CI. Ver a decisão D1.
- **Medições locais** (Windows, Bun 1.4.0, base `c0e8085`):
  - teste alvo do #34: 19,6 s;
  - vizinho Plus (`selects smallest safe count…`): 26,3 s;
  - arquivo `chatgpt-web-usage.test.ts` inteiro: 70,9 s, com 14 testes.
- **Protótipo fora do repo** (descartado), com o mesmo desenho das Tasks 1 e 2:
  - #33: o teste novo falha no Windows sem a correção (`Received function did not throw`). Com a correção, os 24 testes `midnight delta` passam.
  - #34: o teste de guarda falha sem a correção (`Expected length: 4`, `Received length: 24`) e passa com ela. O teste alvo cai para 8,7 s, o vizinho para 8,2 s e o arquivo inteiro para 32,0 s (15 testes). Os 245 testes dos 7 arquivos que compilam multipart passam e o `typecheck` fica limpo.

## Decisão D1 (requer escolha do usuário antes da Task 6)

Como `launcher:audit` falha em `main`, a evidência de CI dos três sistemas só existe numa árvore que contenha este PR **e** o #32. Opções:

- **(a) Recomendada.** PR rascunho descartável para `main`, a partir de um branch `kakasplatt/ci-evidence-32-plus-root-tests` = `main` + head do #32 + este branch.
  - Dá a evidência completa antes de qualquer merge.
  - Depois: merge deste PR, sabidamente vermelho só em `launcher:audit`; atualização do #32 (ver Task 7); fechamento do PR rascunho sem merge e remoção do branch.
- **(b)** Merge deste PR sabidamente vermelho em `launcher:audit`; depois o CI do #32 atualizado passa a ser a evidência combinada.
- **(c)** Merge do #32 primeiro, sabidamente vermelho só nos três testes; depois o CI deste PR roda completo.

Empilhar este PR sobre o branch do #32 não serve, porque `Fixes #N` só fecha issues num merge no branch padrão.

**Regras de `main`** (conferidas em 2026-10-22): não há branch protection clássica (404). Há o ruleset ativo `main-protection`, com estas regras:
- bloqueia deleção e non-fast-forward;
- exige PR com 1 aprovação e review de code owner;
- **não** exige status checks;
- dá bypass `always` ao papel admin.

Portanto um merge com CI vermelho não é bloqueado pelos checks. A aprovação exigida, porém, pede outro revisor ou o bypass de admin. Isso vale para qualquer opção.

## Global Constraints

- **Arquivos por task, disjuntos:**
  - Task 1: `src/adapters/chatgpt-web/thread-environment.ts` e `tests/environment.test.ts`.
  - Task 2: `src/adapters/chatgpt-web/prompt.ts`, `src/adapters/chatgpt-web/usage.ts` e `tests/chatgpt-web-usage.test.ts`.
  - Task 3: `tests/turn-broker-lifecycle.test.ts`.
- **Execução em série,** na ordem 1, 2, 3, no branch `kakasplatt/fix-ci-root-test-failures`, a partir de `c0e8085`.
- **Arquivo local:** `docs/superpowers/model-selection.md` tem uma edição local intencional. Não incluir em nenhum commit; usar `git add` com caminhos explícitos.
- **Bun pinado em cada shell PowerShell:**
  `$MainRoot = (git worktree list --porcelain | Select-Object -First 1) -replace '^worktree ', '' -replace '/', '\'; $env:PATH = "$MainRoot\.tools\bun-1.4.0;$env:PATH"`.
  Dependências: `bun install --frozen-lockfile` na raiz e em `launcher/`.
- **Commits:** mensagens em inglês, terminando com a linha de atribuição do harness de quem comita.
- **Sem dados pessoais:** nenhum caminho pessoal ou absoluto de usuário em arquivos, commits, PR ou issues.
- **Mudanças fora de escopo:**
  - comportamento de produção do #33 e do #35;
  - resultados do planner do #34: mesma contagem de partes, mesma busca do menor número seguro (2..12 em ordem, com `fits()` inalterado);
  - corpo e timeout `30_000` do teste alvo do #34;
  - cache em nível de módulo. A regra de `token-estimate.ts:29-30` ("never retain prompt text between requests") vale.
- **Push, PR e comentários** só depois da confirmação do usuário (Task 6).

## Roteamento de modelos (`docs/superpowers/model-selection.md`, versão local)

Teto do Claude: `Opus 5.5` / `high`. Nada de Fable e nada de Opus acima de `high`. `Sonnet 5.5` e `Haiku 5.5` podem usar `xhigh` e `max`.

| Fase | Codex | Claude Code | Antigravity |
| --- | --- | --- | --- |
| Planejamento (este documento) | `gpt-6.1-sol` / `xhigh` | `Opus 5.5` / `high` | `Claude Opus 4.6 (Thinking)` |
| Coordenação (`subagent-driven-development`) | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` |
| Task 1, injeção do home (TDD) | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` |
| Task 2, cache do planner (TDD, mais delicada) | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` (`xhigh` se a mutação ou a equivalência de resultados surpreender) | `Gemini 3.8 Flash High` |
| Task 3, fixtures de socket (mecânica) | `gpt-6-luna` / `high` | `Haiku 5.5` / `high` | `Gemini 3.6 Flash Medium` |
| Review por task e review final | `gpt-6-astra` / `high` | `Opus 5.5` / `high` | `Claude Opus 4.6 (Thinking)` |
| Avaliação do feedback do review | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` |
| Verificação e finalização do branch | `gpt-6-luna` / `medium` | `Haiku 5.5` / `medium` | `Gemini 3.6 Flash Medium` |
| Depuração se o CI trouxer falha nova | `gpt-6.1-sol` / `xhigh` | `Opus 5.5` / `high` | `Claude Opus 4.6 (Thinking)` |

Nos reviews, preferir uma família ou modelo diferente do implementador.

## Review Focus

1. **Home injetado com `HOME`/`USERPROFILE` intactos.** O teste do #33 tem de recusar o home falso em qualquer sistema e falhar sem a regra do home. O RED no Windows e a mutação ficam na Task 1. Não usar o `homedir()` real como candidato: no Windows `tmpdir()` fica dentro do home, e as regras do Codex home e da ponte também recusariam.
2. **Mesmo resultado do planner com o cache.** O cache usa como chave o texto exato do registro, e o peso só depende do texto (`estimateTokens` ignora `modelId`, `token-estimate.ts:24`). As contagens 11/11, 2/3, `>6 e ≤12` e os erros de teto continuam fixados pelos testes atuais do arquivo. Task 2, Step 6.
3. **Isolamento do spy.** O spy de módulo em `estimateTokens` tem de ser restaurado em `finally`, porque `bun test ./tests` roda os arquivos no mesmo processo. Ele também tem de importar o módulo com o mesmo especificador relativo dos fontes. No protótipo, um import absoluto com barras normais criou outra instância do módulo e contou 0 chamadas. Task 2, Step 1.
4. **Nenhum fixture de socket POSIX sob `tmpdir()` neste arquivo.** No macOS, `tmpdir()` tem 48 bytes. Hoje o pior caso dá 106 bytes, acima do limite de 103. Com `/tmp` fica em 62. Task 3, Step 3.
5. **Passos do CI que nunca rodaram no fork.** `launcher:test`, `app:package`, o AppImage e `app:smoke` podem revelar falhas novas quando `test` passar. Elas viram issues de acompanhamento e não entram neste PR. Task 7.

---

### Task 1: Home do usuário injetável em `ChatGptThreadEnvironmentStore` (#33)

**Causa:** `thread-environment.ts:196` monta `protectedRoots` com `homedir()`. O teste (`tests/environment.test.ts:1519-1530`) troca `HOME`/`USERPROFILE` em tempo de execução.
- **POSIX:** segundo o código-fonte da tag `bun-v1.4.0`, o Bun lê `HOME` do ambiente nativo do processo e o guarda em cache. A troca não chega à guarda, `refusesContext` (`:265`) não recusa e o `throw` de `:304` nunca acontece.
- **Windows:** `USERPROFILE` é relido, por isso o teste passa hoje.

**Files:**
- Modify: `src/adapters/chatgpt-web/thread-environment.ts:188-197` (construtor).
- Test: `tests/environment.test.ts:1519-1530`.

**Interfaces:**
- Produces: `constructor(path?: string, now: () => number = Date.now, codexHome: string = getCodexHome(), sqliteHome?: string, additionalCodexHomes?: readonly string[], userHome: string = homedir())`.
- Os chamadores atuais não mudam: `src/adapters/chatgpt-web/index.ts:411` (1 argumento), `scripts/smoke-codex-environment.ts:53` (4 argumentos) e os demais testes.

- [ ] **Step 1: Teste.** Em `a midnight delta cannot add the user home directory as workspace context`:
  - Trocar o `withEnvironment` por `withEnvironment({ CODEX_CHATGPT_WEB_HOME: bridgeHome }, …)`, sem `USERPROFILE` nem `HOME`.
  - Construir `new ChatGptThreadEnvironmentStore(undefined, Date.now, codexHome, undefined, undefined, fakeHome)`.
  - Manter `.toThrow("Calendar environment delta conflicts")` e o comentário sobre manter a ponte fora do home falso.
  - Acrescentar um comentário dizendo que o home é injetado porque o Bun em POSIX guarda em cache o `HOME` de inicialização.
- [ ] **Step 2: RED.** `bun test ./tests/environment.test.ts -t "user home directory"`. Expected: FAIL com `Received function did not throw`, também no Windows. Não rodar `typecheck` aqui: o sexto argumento ainda não existe.
- [ ] **Step 3: Implementação.** Acrescentar o sexto parâmetro `userHome: string = homedir()` e usar `userHome` no lugar de `homedir()` em `this.protectedRoots`. Documentar o parâmetro numa linha: guarda contra roots amplos; injetável para testes.
- [ ] **Step 4: GREEN.** Rodar `bun test ./tests/environment.test.ts ./tests/trusted-codex-homes.test.ts ./tests/subagent-environment-history.test.ts` e `bun run typecheck`. Expected: 0 fail e `typecheck` sem erros.
  - O teste `a midnight delta keeps a projectless task parent root…` depende de `process.cwd()`: o checkout não pode estar sob `%TEMP%` ou `%LOCALAPPDATA%`.
- [ ] **Step 5: Mutação.** Manter o parâmetro, mas usar `homedir()` em `protectedRoots`, e rodar `-t "user home directory"`. Expected: FAIL. Restaurar com `git checkout -- src/adapters/chatgpt-web/thread-environment.ts`, reaplicar o Step 3 e rodar de novo. Expected: PASS.
- [ ] **Step 6: Commit:** `git add src/adapters/chatgpt-web/thread-environment.ts tests/environment.test.ts`, com a mensagem `fix(environment): inject the user home into the thread environment guard (#33)`.

### Task 2: Pesar cada registro uma vez por chamada do planner do Full Context (#34)

**Causa:** `resolveFullContextMultipartPlan` (`usage.ts:258-269`) recompila o prompt para cada contagem de 2 a 12. Cada compilação pesa todos os registros de novo (`prompt.ts:419` → `multipartRecordWeight`, `:358-360`), embora o peso não dependa da contagem. No Plus, o laço de `stagingEffort` (`prompt.ts:737-769`, que tenta `low` e depois `medium`) dobra essa pesagem.
- O teste alvo usa `proAvailable: true`, ou seja, um único esforço `max`. Quem o corrige é o **cache por chamada**.
- A **remoção da pesagem do laço** só ajuda o Plus. Ela não é observável pelo teste de guarda e fica coberta pelos testes atuais que fixam os resultados.

**Files:**
- Modify: `src/adapters/chatgpt-web/prompt.ts`: `CompileChatGptWebPromptOptions` (`:46-60`), `multipartRecordWeight` (`:358-361`), `partitionMultipartContext` (`:413-435`) e o ramo multipart de `build` (`:736-761`).
- Modify: `src/adapters/chatgpt-web/usage.ts:170-181` (closure `compile`).
- Test: `tests/chatgpt-web-usage.test.ts`.

**Interfaces:**
- Produces, todas internas, sem novo export de função:
  - `CompileChatGptWebPromptOptions.multipartRecordTokenCache?: Map<string, number>`. JSDoc: uso interno do planner; guarda as contagens de tokens por texto exato do registro, válida por uma única chamada de planejamento.
  - `multipartRecordWeight(record: MultipartContextRecord, tokenCache?: Map<string, number>): MultipartRecordWeight`. A chave é o `text` já calculado (`withoutRetiredTurnHandles(JSON.stringify(record))`); o valor é `estimateTokens(text)`. Os `+ 1` de `tokens` e `chars` ficam fora do cache.
  - `partitionMultipartContext(records, weights: readonly MultipartRecordWeight[], totalParts, budgets)`. Deixa de pesar.
  - No ramo multipart, antes de `for (const stagingEffort …)`: `const weights = records.map(record => multipartRecordWeight(record, options?.multipartRecordTokenCache));`.
  - Em `resolveFullContextMultipartPlan`: `const multipartRecordTokenCache = new Map<string, number>();` antes de `compile`, passado nas opções de `compile`.

- [ ] **Step 1: Teste de guarda.**
  - Imports: acrescentar `spyOn` ao import de `bun:test` e `import * as tokenEstimate from "../src/lib/token-estimate";`. Usar exatamente esse especificador relativo, igual ao import existente na linha 12. Não usar caminho absoluto.
  - Novo teste `Full Context planner tokenizes each context record once per planning call`.
  - Fixture: `plus = { ...capabilities, extraHighAvailable: false, proAvailable: false }` e 4 mensagens `user`, cada uma com `` `chunk ${index}: ${"word ".repeat(60_000)}` ``.
  - Criar `const estimate = spyOn(tokenEstimate, "estimateTokens")`, que repassa a chamada para a implementação real. Dentro de `try`:
    - `expect(resolveFullContextMultipartPlan(parsed, plus)).toBe(4)`;
    - `recordTexts` = textos de `estimate.mock.calls` que começam com `'{"kind":'`;
    - `expect(new Set(recordTexts).size).toBe(4)`;
    - `expect(recordTexts).toHaveLength(4)`.
  - Em `finally`: `estimate.mockRestore()`.
- [ ] **Step 2: RED.** `bun test ./tests/chatgpt-web-usage.test.ts -t "once per planning call"`. Expected: FAIL com `Expected length: 4` e `Received length: 24` (contagens 2, 3 e 4 × `low`/`medium`).
- [ ] **Step 3: Tempos de base.** Antes de implementar, rodar e anotar:
  - `bun test ./tests/chatgpt-web-usage.test.ts -t "does not reduce the canonical"` (referência: cerca de 19,6 s);
  - `-t "selects smallest safe count"` (cerca de 26,3 s);
  - o arquivo inteiro (cerca de 70,9 s).
- [ ] **Step 4: Implementação** conforme o bloco Interfaces. Não mexer no laço `for (let count = 2; …)`, em `fits()`, em `checkAtomicString` nem em `canonicalInline`.
- [ ] **Step 5: GREEN.** `bun test ./tests/chatgpt-web-usage.test.ts`. Expected: 15 pass, 0 fail.
- [ ] **Step 6: Equivalência.**
  - Rodar `bun test ./tests/browser-worker-contract.test.ts ./tests/luna-bigger-context.test.ts ./tests/prompt-contract.test.ts ./tests/prompt-history-metadata.test.ts ./tests/responses-agent-message.test.ts ./tests/skill-attachments.test.ts ./tests/zero-risk-prompt-contract.test.ts` e `bun run typecheck`. Expected: 0 fail (o protótipo deu 245 pass) e `typecheck` limpo.
  - Os resultados `11`/`11`, `2`/`3` e os erros de teto do arquivo de uso continuam iguais.
- [ ] **Step 7: Tempos depois.** Repetir os três comandos do Step 3. Referência do protótipo: cerca de 8,7 s, 8,2 s e 32,0 s. Anotar os seis números para o corpo do PR. No CI Windows, o fator de cerca de 1,75× é uma estimativa e não foi verificado.
- [ ] **Step 8: Mutação.** Remover só a passagem de `multipartRecordTokenCache` em `usage.ts` e rodar `-t "once per planning call"`. Expected: FAIL com `Received length: 12`. Restaurar com `git checkout -- src/adapters/chatgpt-web/usage.ts`, reaplicar e rodar de novo. Expected: PASS.
- [ ] **Step 9: Commit:** `git add src/adapters/chatgpt-web/prompt.ts src/adapters/chatgpt-web/usage.ts tests/chatgpt-web-usage.test.ts`, com a mensagem `perf(chatgpt-web): weigh each Full Context record once per planning call (#34)`.

### Task 3: Fixtures de socket do broker num diretório temporário curto (#35)

**Causa:** o socket fica em `join(home, "runtime", "turn-broker.sock")` (`src/config.ts:171`). A guarda `MAX_UNIX_SOCKET_PATH_BYTES = 103` (`turn-broker.ts:305`, verificação em `:838-845`) recusa o caminho, como esperado. Com o `tmpdir()` de 48 bytes do macOS, `cgw-broker-rejected-close-` (`:393`) dá 106 bytes. No Windows o endpoint é um pipe com hash, então o teste não exercita o problema.

**Files:**
- Test: `tests/turn-broker-lifecycle.test.ts`. São nove fixtures de socket POSIX: linhas 11, 36, 248, 284, 305, 330 (`unansweredBrokerEndpoint`), 393, 478 e 530.

**Interfaces:**
- Produces: `function shortSocketTempRoot(): string`, local ao arquivo e idêntica a `tests/retained-compaction.test.ts:65-67` (`process.platform === "win32" ? tmpdir() : "/tmp"`). Levar junto o comentário sobre o limite de `sun_path`. O link `/tmp` → `/private/tmp` do macOS já é usado pelos fixtures de `9b95ef3`.

- [ ] **Step 1: RED (evidência existente).**
  - Registrar a falha de macos-15 do run 39706958990.
  - Rodar `bun -e 'import { defaultBrokerEndpoint } from "./src/config"; for (const root of ["/tmp", "/var/folders/nj/" + "x".repeat(30) + "/T"]) console.log(root.length, Buffer.byteLength(defaultBrokerEndpoint(root + "/cgw-broker-rejected-close-XXXXXX", "darwin")));'`. Expected: `4 62` e `48 106`.
- [ ] **Step 2: Implementação.** Acrescentar o helper depois dos imports. Trocar `mkdtempSync(join(tmpdir(), …))` por `mkdtempSync(join(shortSocketTempRoot(), …))` nas nove linhas. `tmpdir` continua importado porque o helper o usa.
- [ ] **Step 3: Checagem determinística.** `git grep -n "join(tmpdir()" -- tests/turn-broker-lifecycle.test.ts`. Expected: nenhuma saída (o helper usa `tmpdir()` sem `join`). O maior prefixo é `cgw-broker-rejected-close-` (26 bytes): o pior caso sob `/tmp` é 62 ≤ 103 (Step 1).
- [ ] **Step 4:** `bun test ./tests/turn-broker-lifecycle.test.ts`. Expected: 0 fail. No Windows os testes `skipIf(win32)` são pulados. A prova definitiva é o job macos-15 (Task 7).
- [ ] **Step 5: Commit:** `git add tests/turn-broker-lifecycle.test.ts`, com a mensagem `test(turn-broker): root broker socket fixtures under a short temp dir (#35)`.

### Task 4: Verificação local completa

- [ ] **Step 1: Diff.**
  - `git diff --stat c0e8085..HEAD`. Expected: só os 6 arquivos das Tasks 1-3.
  - `git status --short`. Expected: só ` M docs/superpowers/model-selection.md` e o plano.
- [ ] **Step 2a: `bun run verify` neste branch,** com o Bun pinado. Expected: `check-version` e `audit` passam, e o comando para em `launcher:audit` (`electron@41.10.7`, GHSA-fw47-9c62-h3vw). Registrar isso como evidência da falha preexistente, fora de escopo e corrigida pelo #32.
- [ ] **Step 2b: Passos seguintes do `verify`, um a um.** Rodar, nesta ordem e com o Bun pinado:
  - `check-version`, `audit`, `typecheck`, `test`;
  - `launcher:typecheck`, `launcher:test`, `launcher:build`;
  - `bun run scripts/build-runtime-bundle.ts <scratch>\runtime`;
  - `bun run scripts/generate-third-party-notices.ts <scratch>\THIRD_PARTY_NOTICES.txt --include-launcher`;
  - `bun run scripts/smoke-release.ts <scratch>\runtime`.

  Expected: tudo verde, exceto as falhas ambientais conhecidas: `EPERM` de symlink em `tests/codex-integration.test.ts` e `launcher/tests/runtime-host.test.cjs`, e `launcher/tests/windows-installer.test.cjs` quando a execution policy bloqueia scripts.
- [ ] **Step 3: Comparação com a base.** Criar `git worktree add --detach <pasta irmã do checkout principal>\codex-chatgpt-web-base-c0e8085 c0e8085`. Não pode ficar sob `%TEMP%` nem `%LOCALAPPDATA%`: o runtime recusa caminhos efêmeros e o teste projectless depende do caminho.
  - Instalar as dependências (`--frozen-lockfile`) na raiz e em `launcher/`.
  - Rodar `bun test ./tests/codex-integration.test.ts` e `bun run launcher:test`.
  - Expected: as mesmas falhas ambientais do Step 2. Toda falha que só aparece no branch é regressão.
  - Remover o worktree com `git worktree remove`.
- [ ] **Step 4 (obrigatório, espelha D1-a): `bun run verify` completo na árvore combinada.** Num worktree separado (mesma regra de caminho), fazer `git merge` do head do #32 (`71490ec`) e deste branch sobre `main`. Instalar as dependências e rodar `bun run verify`. Esta é a única execução local que cumpre o gate completo.
  - Expected: só as falhas ambientais do Step 2b.
  - Se não puder rodar (por exemplo, o download do binário do Electron 43 falhar), dizer isso explicitamente no relatório e no PR, sem considerar o gate cumprido.
  - Remover o worktree no fim.

### Task 5: Review independente

- [ ] **Step 1:** Rodar `superpowers:requesting-code-review` sobre `c0e8085..HEAD`, com o revisor da tabela (`Opus 5.5` / `high`, `gpt-6-astra` / `high` ou `Claude Opus 4.6 (Thinking)`). Pontos de foco: Review Focus 1-4 e a afirmação de "mesmos resultados" do #34.
- [ ] **Step 2:** Tratar os achados com `superpowers:receiving-code-review`. Correções entram como commits novos na task dona do arquivo, com a verificação focada repetida.

### Task 6: Portão do usuário, push e PR

- [ ] **Step 1:** Apresentar ao usuário o resumo, as evidências das Tasks 1-5 e a decisão D1. **Esperar a confirmação** para push, PR e a opção de D1.
- [ ] **Step 2:** `git push -u origin kakasplatt/fix-ci-root-test-failures`, sem force.
- [ ] **Step 3:** `gh pr create -R kakasplatt/codex-chatgpt-web --base main`, com título `fix(ci): repair the three root test failures from the fork's first CI run`. Corpo:
  - `Fixes #33`, `Fixes #34`, `Fixes #35`, uma seção por issue (causa, correção e evidência RED/GREEN);
  - a tabela de tempos antes e depois da Task 2;
  - as verificações que rodaram e as que não rodaram, com as falhas ambientais e `launcher:audit` preexistente;
  - os acompanhamentos;
  - a linha de atribuição de PR do harness.
- [ ] **Step 4:** Se o usuário escolheu D1-a, criar o branch combinado `kakasplatt/ci-evidence-32-plus-root-tests` (= `main` + `71490ec` + este branch, via merge e sem rebase de branches publicados). Abrir um PR **rascunho** para `main` com o título `DO NOT MERGE: CI evidence for #32 + root test fixes`.

### Task 7: CI e atualização do #32

**Como o CI de `pull_request` faz o checkout** (documentação do GitHub, conferida em 2026-10-21):
- `GITHUB_REF` é `refs/pull/<N>/merge` e `GITHUB_SHA` é o último merge commit do head do PR na base, calculado quando o evento dispara. É esse commit que `actions/checkout@v6` baixa.
- Um **re-run reutiliza o mesmo `GITHUB_SHA` e o mesmo `GITHUB_REF` do evento original**. Re-rodar o run 39706958990 testaria de novo o merge antigo, sem estas correções.
- O workflow só roda em `opened`, `synchronize` e `reopened`. Não roda se houver conflito de merge.

- [ ] **Step 1:** Acompanhar o CI do PR que carrega a evidência: o PR rascunho em D1-a, o #32 atualizado em D1-b ou este PR em D1-c. Expected: `verify`, `app:package`, o AppImage e `app:smoke` verdes nos três sistemas e `actionlint` verde. Os três testes passam; no Windows o teste alvo deve ficar bem abaixo de 30 s.
- [ ] **Step 2:** Se um passo que nunca rodou no fork falhar (`launcher:test`, `app:package`, AppImage, `app:smoke`), diagnosticar com `superpowers:systematic-debugging`. Registrar como issue de acompanhamento e não corrigir neste PR, salvo decisão do usuário.
- [ ] **Step 3:** Depois do merge deste PR em `main`, **o #32 precisa de um evento novo**: um re-run não basta.
  - Rodar `gh pr update-branch 32 -R kakasplatt/codex-chatgpt-web`. Isso faz merge de `main` no branch do #32 e gera um `synchronize`. Alternativas: merge local de `main` e push, ou fechar e reabrir o PR.
  - Os arquivos são disjuntos (o #32 só mexe em `launcher/`), então não se espera conflito.
- [ ] **Step 4:** No novo run do #32, confirmar que o commit baixado contém este PR: o log do checkout mostra o merge SHA, e `gh api repos/kakasplatt/codex-chatgpt-web/commits/<sha>` mostra os pais. Expected: CI verde nos três sistemas.
- [ ] **Step 5:** Em D1-a, fechar o PR rascunho sem merge e apagar o branch combinado, com confirmação do usuário.

## Acompanhamentos (fora de escopo; propor como issues, sem implementar)

- **#33:** `a midnight delta keeps a projectless task parent root as workspace context` falha quando `resolve(process.cwd(), "..")` contém `tmpdir()`, o home real ou `~/.codex-chatgpt-web`, por exemplo num checkout sob `%LOCALAPPDATA%` ou `%TEMP%`. A recusa está correta. O fixture deveria usar um `cwd` isolado criado com `mkdtemp` (`resumedRootFixture`, `childTurnContext`, `environmentlessChild`). O CI não é afetado.
- **#35:** `tests/dev-chat.test.ts:346` e `:418` ficam com 102 bytes no macOS, 1 byte abaixo do limite.
- **#34:** o custo de `fits()` (cerca de 19% do tempo) e uma busca com limite inferior ficam para depois. Mudar a busca altera a semântica do menor número seguro de partes.
