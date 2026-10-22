# Issue #30: Electron 41.10.7 → 43.8.3 — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer `bun run launcher:audit` e, com ele, o gate completo `bun run verify` voltarem a passar com o Bun pinado (1.4.0), subindo o Electron do launcher de `41.10.7` para `43.8.3` sem mudar o comportamento do launcher.

**Architecture:** É uma troca de dependência de desenvolvimento (`launcher/package.json` + `launcher/bun.lock`). O código do launcher (`launcher/electron/*.cjs`, `preload.cjs`, renderer em `launcher/src`) não muda: nenhuma API removida ou alterada nas majors 42 e 43 é usada por ele. A única mudança do Electron 42+ com efeito no repositório é que o pacote npm `electron` não baixa mais o binário no `postinstall`; o `index.js` baixa sob demanda no primeiro `require("electron")`. Como quatro arquivos de teste do launcher carregam `browser-host.cjs` (que faz `require("electron")` ao carregar) em processos paralelos do `node --test`, a Task 2 garante que o binário seja instalado uma única vez antes dos testes (`pretest`), protegido por um teste de contrato.

**Tech Stack:** Electron 43.8.3 (Chromium 150.0.7871.250, Node 24.22.0), electron-builder 26.15.3, Bun 1.4.0 (`packageManager`), `node --test` (testes do launcher), `bun test` (testes da raiz), playwright-core 1.62.0.

**Spec:** issue `kakasplatt/codex-chatgpt-web#30`; decisão final do usuário: alvo exato `electron@43.8.3`; seções "Breaking API Changes (42.0)" e "(43.0)" de `docs/breaking-changes.md` do repositório `electron/electron`; `CONTRIBUTING.md`; `.github/pull_request_template.md`; `docs/release-validation.md`; `AGENTS.md` (seção "Verification").

## Global Constraints

- Arquivos que podem mudar: `launcher/package.json` (linha do `electron` na Task 1; script `pretest` na Task 2), `launcher/bun.lock` (Task 1) e `launcher/tests/packaging-contract.test.cjs` (teste de contrato da Task 2). Qualquer outro arquivo exige uma falha observada e um teste que a reproduza.
- Versão exata, sem range: `"electron": "43.8.3"`. O electron-builder exige versão fixa (`app-builder-lib/out/electron/electronVersion.js`), e o launcher já pina exata.
- O lockfile é regenerado **somente** com Bun 1.4.0. O Bun global pode ser outro (1.4.3 na máquina de referência); a CI usa `bun install --frozen-lockfile` com 1.4.0 e `scripts/check-version.ts` rejeita qualquer outra versão.
- O Bun pinado fica em `.tools\bun-1.4.0\bun.exe` na raiz do checkout principal (pasta git-ignored, criada por `build-windows.cmd`/`build-windows.ps1`). Os scripts do `package.json` chamam `bun` aninhado pelo PATH, então o diretório pinado precisa estar **na frente do PATH** da sessão; invocar só o executável pinado não basta. Em toda sessão de execução, antes de qualquer passo:

  ```powershell
  $MainRoot = (git worktree list --porcelain | Select-Object -First 1) -replace '^worktree ', '' -replace '/', '\'
  $env:PATH = "$MainRoot\.tools\bun-1.4.0;$env:PATH"
  bun --version   # Expected: 1.4.0
  ```

  Se `.tools\bun-1.4.0\bun.exe` não existir, rode `build-windows.cmd` uma vez no checkout principal (ele baixa o Bun pinado) ou baixe `bun-windows-x64-baseline.zip` de `bun-v1.4.0` como faz `build-windows.ps1`.
- Não adicionar ignore/allowlist de advisory no `bun audit`.
- Nenhum caminho pessoal ou absoluto em arquivos, commits, logs colados ou PR. Diretórios temporários via `$env:TEMP`.
- Mensagens de commit e corpo do PR em inglês, seguindo a convenção do repositório e o template.
- O PR só é aberto depois de confirmação explícita do usuário, com `Fixes #30`. macOS e Linux são validados somente pela CI. Tudo que depende de sessão autenticada do ChatGPT é marcado "not run" quando não executado.
- O grafo do Graphify não é reconstruído nem atualizado por este trabalho.

## Roteamento de modelos por fase

Conforme `docs/superpowers/model-selection.md`. A mudança é pequena e mecânica, com oráculos claros (`bun audit`, diff do lockfile, testes), então as fases usam o nível rápido/workhorse; escala-se só se aparecer falha não explicada por uma causa óbvia.

| Fase | Codex | Claude Code | Antigravity | Observação |
| --- | --- | --- | --- | --- |
| Coordenação (`subagent-driven-development`) | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Mantém o estado do plano e serializa as tasks (todas tocam `launcher/package.json`; nada em paralelo). |
| Task 1 (bump + lockfile; mecânica, padrão local, oráculo claro) | `gpt-6-luna` / `high` | `Haiku 5.5` / `high` | `Gemini 3.6 Flash Medium` (Fast) | Se o diff do lockfile sair diferente do esperado, escalar para o workhorse. |
| Task 2 (`pretest` + teste de contrato; TDD) | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Implementação atômica com teste; envolve runtime (Node/Bun) e rede. |
| Task 3 e Task 4, passos determinísticos (comandos e checagem de saída) | `gpt-6-luna` / `medium` | `Haiku 5.5` / `medium` | `Gemini 3.6 Flash Medium` (Fast) | Verificação é coleta de evidência fresca. |
| Task 3 e Task 4, interpretação (classificar falha como ambiental vs. regressão; checks manuais e visuais) | `gpt-6.1-sol` / `medium` ou `high` | `Sonnet 5.5` / `medium` ou `high` | `Gemini 3.8 Flash High` (Fast) | Escalar quando a saída conflitar com a base ou exigir leitura de comportamento em runtime. |
| Debugging, se o Electron 43 quebrar algo | `gpt-6.1-sol` / `xhigh` | `Opus 5.5` / `xhigh` | `Claude Opus 4.6 (Thinking)` | Evidência primeiro; voltar ao plano se exigir decisão de design. |
| Review independente (Task 5; uma revisão basta para mudança pequena) | `gpt-6-astra` / `high` | `Opus 5.5` / `high` | `Claude Opus 4.6 (Thinking)` | Contexto separado; preferir família diferente da que implementou. |
| Avaliação do feedback do review | `gpt-6.1-sol` / `high` | `Sonnet 5.5` / `high` | `Gemini 3.8 Flash High` (Fast) | Verificar cada apontamento no código e nos testes antes de aplicar. |

Fallbacks: seguir as escadas da seção 11 do guia (ex.: `Opus 5.5` indisponível → `Sonnet 5.5` no mesmo esforço ou um acima; nunca reduzir review a `low`).

## Evidência coletada no planejamento

Tudo abaixo foi verificado em 2026-10-21 contra o commit base `c0e8085`, o registro npm, o GitHub Advisory Database e os tarballs `electron@41.10.7` e `electron@43.8.3` baixados em diretório temporário.

- Advisory GHSA-fw47-9c62-h3vw (medium): afetados `< 42.11.3` → corrigido em `42.11.3`; `43.0.0-alpha.1 ≤ v < 43.7.0` → `43.7.0`; `44.0.0-alpha.1 ≤ v < 44.3.0` → `44.3.0`; alphas de 45 → `45.0.0-alpha.5`. `43.8.3 ≥ 43.7.0`.
- Dist-tags npm: `latest` 45.0.0, `44-x-y` 44.9.3, `43-x-y` 43.8.3, `42-x-y` 42.11.18, `41-x-y` 41.10.7. O Electron dá suporte às três últimas majors estáveis (`docs/tutorial/electron-timelines.md`); com 45.0.0 publicado em 2026-10-21, a 42 está em EOL. A 43 "is supported until January 2027" (texto do `@electron/get@5.1.0`, `dist/index.js`).
- Por que não 44: a 44.0 rearquitetou o módulo `clipboard` (`writeText` passa a devolver `Promise<void>`). `BrowserHost.writeManualPrompt` (`launcher/electron/browser-host.cjs:2256-2261`) é síncrono e é chamado em `:2347`, `:2370` (dentro de `try/catch` que depende de throw síncrono) e `:2454`; o mock de teste em `launcher/tests/browser-host.test.cjs:3734` é síncrono. Na 43 o `clipboard` continua síncrono.
- `electron@43.8.3`: `engines.node >= 22.12.0`; **sem** `scripts` (o `41.10.7` tinha `"postinstall": "node install.js"`); `bin` ganha `install-electron` → `install.js`; dependências idênticas às do 41.10.7 (`@electron-internal/extract-zip ^1.0.1`, `@electron/get ^5.0.0`, `@types/node ^24.9.0`). O `index.js` do 43 chama `spawnSync(process.execPath, ["install.js"])` quando `path.txt` ou o binário faltam; o do 41 apenas lançava erro.
- RED já reproduzido com o Bun pinado: `bun run launcher:audit` imprime `electron@41.10.7 … moderate: Electron: HID and USB permission checks can be attributed to the wrong origin (<42.11.3)` e sai com código 1; `bun run audit` na raiz passa (`No vulnerabilities found (checked 108 packages)`).
- Dry run do lockfile em diretório temporário com Bun 1.4.0 (`bun install --lockfile-only` sobre cópias de `launcher/package.json` e `launcher/bun.lock`): mudam exatamente 2 linhas, 377 pacotes, nenhuma dependência transitiva alterada (ver diff esperado na Task 1).
- `launcher/tsconfig.json` inclui só `src`, e nada em `launcher/src` importa `electron`: `launcher:typecheck` **não** valida a API do Electron. A compatibilidade vem da revisão estática abaixo, dos testes e do smoke empacotado.
- electron-builder 26.15.3 lê a versão em `node_modules/electron/package.json` e baixa o próprio zip (`electron-v43.8.3-<platform>-<arch>.zip`) via `@electron/get@3.1.0`; não usa `node_modules/electron/dist`. Os únicos gates de versão em `app-builder-lib` são de Snap (alvo não usado).
- Quem exige o binário em `launcher/node_modules/electron/dist`: `launcher/scripts/dev.cjs:7` (`require("electron")` sob Bun, usado por `bun run launcher:dev` / `bun run app`), `electron .` (`launcher` `start`), e os testes do launcher que carregam `browser-host.cjs` ao importar: `browser-announcements`, `browser-host`, `control-server`, `turn-suspension` (mais `runtime-supervisor.test.cjs:2060`, sob demanda). `node --test` roda arquivos em processos paralelos (`os.availableParallelism() - 1`).
- Os fixtures `launcher/tests/fixtures/*.cjs` **são** usados: pelos testes da raiz `tests/browser-generation.test.ts`, `tests/chatgpt-markdown-parser.test.ts`, `tests/context-markdown-regexp.test.ts`, `tests/launcher-navigation-viewport.test.ts`, `tests/launcher-viewport-browser.test.ts` e `tests/attachment-upload-electron.test.ts`, todos `test.skipIf(!process.env.LAUNCHER_TEST_ELECTRON)`. A CI não define a variável.
- Versões embutidas: 41.10.7 = Chromium 146.0.7680.216 / Node 24.18.0; 43.8.3 = Chromium 150.0.7871.250 / Node 24.22.0 (arquivo `DEPS` das tags). `playwright-core@1.62.0` espera Chromium 151. O launcher expõe `remote-debugging-port` (`launcher/electron/main.cjs:1154-1155`) e o helper o controla por CDP.
- `41.10.7` só aparece em `launcher/package.json:34` e `launcher/bun.lock` (linhas 17 e 370). `scripts/generate-third-party-notices.ts` percorre só `dependencies` do launcher (não `devDependencies`) e `LICENSES/` não tem arquivo do Electron.
- Bun 1.4.0 executa hooks `pre<script>` em `bun run` (verificado em diretório temporário).

## Mudanças de quebra (41 → 43) e exposição do launcher

| Mudança | Onde o launcher fica exposto | Ação |
| --- | --- | --- |
| 42: `electron` não baixa o binário no `postinstall`; download no primeiro `require`/CLI ou via `install-electron` | `dev.cjs:7`, `electron .`, e 4 arquivos de teste que carregam `browser-host.cjs:4` em paralelo | Task 2 |
| 42: notificações macOS via `UNNotification` (exige code-sign) | Nenhum `new Notification` em `launcher/electron` | Nenhuma |
| 42: offscreen rendering com `deviceScaleFactor` 1.0 por padrão | Sem `webPreferences.offscreen`; o `deviceScaleFactor: 0` em `browser-host.cjs:1776` é de `enableDeviceEmulation`, não OSR | Nenhuma |
| 42: removida `options.quotas` de `Session.clearStorageData()` | `browser-host.cjs:2871` e `:2958` chamam `clearStorageData()` sem opções | Nenhuma |
| 42: `hslShift` só-array em `createFromNamedImage` depreciado | Sem uso | Nenhuma |
| 43: janelas frameless com cantos arredondados no Linux (`roundedCorners` default `true`) | `main.cjs:408-420` usa `titleBarStyle: "hidden"` + `titleBarOverlay` fora do macOS, inclusive Linux | Checagem visual (Task 4) ou "not run" |
| 43: WCO segue o layout nativo da barra de título no Linux (controles podem ficar à esquerda; GNOME mostra só fechar) | Renderer não usa `env(titlebar-area-*)`; `.titlebar-left` fica em `left: 8px` fora do macOS (`launcher/src/styles.css:179-181`) | Checagem visual (Task 4); correção com `env(titlebar-area-x)` só se a CI/visual mostrar sobreposição (fora do escopo deste PR) |
| 43: `NativeImage.toBitmap()` normaliza para sRGB | Sem uso | Nenhuma |
| 43: `chrome.scripting` injeta CSS em frames de fallback | Sem extensões | Nenhuma |
| 43: `dialog.show*Dialog` usam Downloads como `defaultPath` padrão | Único diálogo de arquivo é `showSaveDialog` em `main.cjs:1057-1061`, com `defaultPath` explícito em Documentos; `showMessageBox` (`:775`, `:1554`) não tem caminho | Nenhuma |
| 43: `showHiddenFiles` removido em diálogos no Linux | Sem uso | Nenhuma |
| Sem handlers de HID/USB/permissão de dispositivo (`select-hid-device`, `select-usb-device`, `setDevicePermissionHandler`) | O advisory não muda comportamento do launcher; a correção importa por compliance do audit e pela superfície do Chromium embutido | Nenhuma |

## Review Focus

1. **Instalação nova + `node --test`:** quatro arquivos de teste carregam `browser-host.cjs` em processos paralelos; sem `pretest`, cada um tenta baixar e extrair o Electron ao mesmo tempo (o cache do `@electron/get` tem retry e comparação de hash, mas a extração em `node_modules/electron/dist` e o `rename` de `electron.d.ts` não são coordenados). Esperado: um único download antes dos testes, e nenhum durante. Pinado na Task 2 (passos 2, 7 e 8 e o teste de contrato).
2. **`bun run launcher:dev` em checkout novo:** o download sob demanda roda `spawnSync(process.execPath, install.js)`, e sob `bun run scripts/dev.cjs` o `execPath` é o Bun; `@electron-internal/extract-zip` tem binding N-API nativo. Esperado: o Bun consegue baixar e extrair, ou o `predev` entra com o mesmo contrato. Pinado na Task 2, passo 9.
3. **Barra de título no Linux (CI não cobre):** controles do WCO podem mudar de lado e cobrir o botão da sidebar em `left: 8px`; a janela ganha cantos arredondados. Esperado: controles e header não se sobrepõem. Pinado na Task 4, passo 5 (visual) — "not run" sem desktop Linux.
4. **Turno manual (clipboard síncrono):** `writeManualPrompt` deve continuar lançando síncrono quando o clipboard não existe e gravando o prompt quando existe. Pinado na Task 3, passo 4 (`launcher/tests/browser-host.test.cjs`, `manualTurnFixture`) e na Task 4, passo 3 (prompt copiado no app empacotado).
5. **Playwright 1.62 (Chromium 151) controlando o Chromium 150 do Electron 43 por CDP:** `_electron.launch` e `connectOverCDP` devem abrir janela, navegar e avaliar scripts. Pinado na Task 4, passo 4 (testes opt-in com `LAUNCHER_TEST_ELECTRON`). Os dois testes que afirmam que a regex do ChatGPT **trava** no Chromium (`chatgpt-markdown-parser`, `context-markdown-regexp`) podem divergir se o V8 do Chromium 150 mudou; divergência confirmada na base com Electron 41 é registrada, não bloqueia.

---

### Task 1: Subir o Electron para 43.8.3 e regenerar o lockfile

**Files:**
- Modify: `launcher/package.json:34`
- Modify: `launcher/bun.lock:17,370`

**Interfaces:**
- Consumes: nada.
- Produces: `launcher/bun.lock` com `electron@43.8.3` e `launcher/node_modules` instalado com Bun 1.4.0 (sem o binário do Electron: o 43 não tem `postinstall`).

- [ ] **Step 1: Preparar o PATH com o Bun pinado** (snippet das Global Constraints). Run: `bun --version`. Expected: `1.4.0`.
- [ ] **Step 2: RED (audit).** Run: `bun run launcher:audit`. Expected: saída contendo `electron@41.10.7`, `(direct dependency)`, `moderate: Electron: HID and USB permission checks can be attributed to the wrong origin (<42.11.3)`, `1 vulnerability (1 moderate)` e `error: script "audit" exited with code 1`.
- [ ] **Step 3: Trocar a versão.** Em `launcher/package.json`, trocar `"electron": "41.10.7",` por `"electron": "43.8.3",`. Nenhuma outra linha muda.
- [ ] **Step 4: Regenerar o lockfile.** Run (em `launcher/`): `bun install`. Expected: `bun install v1.4.0 (...)`, `Saved lockfile`, sem erro. Observação: o Bun não roda nenhum lifecycle script do `electron` (o 43 não tem); `launcher\node_modules\electron\path.txt` **não** existe ainda.
- [ ] **Step 5: Conferir o diff.** Run: `git status --short; git diff --stat; git diff launcher/bun.lock`. Expected: só `launcher/package.json` e `launcher/bun.lock` modificados (mais o plano, untracked); o diff do lockfile tem exatamente estes dois hunks e nada mais:

  ```diff
  -        "electron": "41.10.7",
  +        "electron": "43.8.3",
  ```

  ```diff
  -    "electron": ["electron@41.10.7", "", { "dependencies": { "@electron-internal/extract-zip": "^1.0.1", "@electron/get": "^5.0.0", "@types/node": "^24.9.0" }, "bin": { "electron": "cli.js" } }, "sha512-AqIiefddlf5i+HYCGatr8VlBuEbWJpad4/yloBFYcMB2r57j7xhW1ogiJ+BfA5kxQyfmSs5yjwy54Me+wJn1jw=="],
  +    "electron": ["electron@43.8.3", "", { "dependencies": { "@electron-internal/extract-zip": "^1.0.1", "@electron/get": "^5.0.0", "@types/node": "^24.9.0" }, "bin": { "electron": "cli.js", "install-electron": "install.js" } }, "sha512-KgvSm3bHXz96hSXzqxyRjLeli80rIdszbDQFKlRSfckmGazTPCH/CxUN31Dp9c5rFKTQSNf9gPJRWl1yWNB3pA=="],
  ```

  Qualquer outra linha alterada indica Bun errado ou lockfile desatualizado: descartar com `git checkout -- launcher/bun.lock`, conferir `bun --version` e repetir o passo 4.
- [ ] **Step 6: GREEN (audit).** Run: `bun run launcher:audit; bun run audit`. Expected: ambos imprimem `No vulnerabilities found (checked N packages)` e saem com 0.
- [ ] **Step 7: Lockfile reprodutível.** Run (em `launcher/`): `Remove-Item -Recurse -Force node_modules; bun install --frozen-lockfile`. Expected: instala sem erro; `git diff --stat launcher/bun.lock` continua mostrando só a mudança do passo 5 (o frozen install não reescreve o lockfile).
- [ ] **Step 8: Commit.**

  ```powershell
  git add launcher/package.json launcher/bun.lock
  git commit -m "fix(launcher): upgrade Electron to 43.8.3 for GHSA-fw47-9c62-h3vw (#30)"
  ```

  Acrescentar a linha de atribuição exigida pelo harness que executar o commit.

### Task 2: Instalar o binário do Electron uma única vez antes do `node --test`

**Files:**
- Modify: `launcher/package.json:21` (bloco `scripts`)
- Test: `launcher/tests/packaging-contract.test.cjs:21-26` (novo `test` logo após "the full verification gate audits launcher dependencies")

**Interfaces:**
- Consumes: `launcher/node_modules` com `electron@43.8.3` (Task 1, passo 7).
- Produces: script `pretest` em `launcher/package.json` com o valor exato `node node_modules/electron/install.js`; o binário em `launcher/node_modules/electron/dist/electron.exe` e `launcher/node_modules/electron/path.txt`, usados pela Task 3 e pela Task 4.

- [ ] **Step 1: Confirmar que a instalação está "nova" (sem binário).** Run: `Test-Path launcher\node_modules\electron\path.txt; Test-Path launcher\node_modules\electron\dist`. Expected: `False` e `False`. Se for `True`, repetir o passo 7 da Task 1.
- [ ] **Step 2: RED (comportamento).** Run: `bun run launcher:test 2>&1 | Tee-Object -FilePath "$env:TEMP\launcher-test-fresh.log" | Out-Null; (Select-String -Path "$env:TEMP\launcher-test-fresh.log" -Pattern 'Downloading Electron binary').Count`. Expected: contagem ≥ 2 (um por processo de teste que carregou `browser-host.cjs` antes de o primeiro download terminar), possivelmente com falhas `Electron failed to install correctly` ou de extração. A contagem depende de `os.availableParallelism()` da máquina; mesmo que saia 1, o problema continua existindo em máquinas e runners com outra paralelização: registrar a contagem e seguir para o passo 3.
- [ ] **Step 3: Escrever o teste de contrato (falhando).** Em `launcher/tests/packaging-contract.test.cjs`, após o teste "the full verification gate audits launcher dependencies":

  ```js
  test("launcher tests install the Electron binary once before node --test runs", () => {
    // Electron 42+ no longer downloads its binary in postinstall; several test files load
    // browser-host.cjs (require("electron")) in parallel processes, so install it up front.
    assert.equal(manifest.scripts.pretest, "node node_modules/electron/install.js");
    assert.equal(manifest.scripts.test, "node --test tests/*.test.cjs");
  });
  ```

- [ ] **Step 4: Rodar o teste de contrato e ver falhar.** Run (em `launcher/`): `node --test tests/packaging-contract.test.cjs`. Expected: o novo teste falha com `AssertionError` (`undefined !== 'node node_modules/electron/install.js'`); os demais testes do arquivo mantêm o resultado anterior.
- [ ] **Step 5: Implementar o `pretest`.** Em `launcher/package.json`, dentro de `scripts`, inserir imediatamente antes de `"test"`: `"pretest": "node node_modules/electron/install.js",`. `install.js` é o mesmo código do antigo `postinstall`; ele sai com 0 sem baixar nada quando `dist/version` e `path.txt` já batem com a versão. O `node` já é exigido por `test` e por `launcher/scripts/package.cjs`.
- [ ] **Step 6: Rodar o teste de contrato e ver passar.** Run (em `launcher/`): `node --test tests/packaging-contract.test.cjs`. Expected: PASS.
- [ ] **Step 7: GREEN (comportamento) em instalação nova.** Run (em `launcher/`): `Remove-Item -Recurse -Force node_modules; bun install --frozen-lockfile`. Depois, na raiz: `bun run launcher:test 2>&1 | Tee-Object -FilePath "$env:TEMP\launcher-test-pretest.log" | Out-Null; (Select-String -Path "$env:TEMP\launcher-test-pretest.log" -Pattern 'Downloading Electron binary').Count; Get-Content launcher\node_modules\electron\path.txt; Get-Content launcher\node_modules\electron\dist\version`. Expected: o log contém as linhas `$ node node_modules/electron/install.js` e `$ node --test tests/*.test.cjs` (o Bun ecoa cada script executado); contagem `0`; `path.txt` contém `electron.exe`; `dist\version` contém `43.8.3` (com ou sem `v`); os testes passam, salvo as falhas ambientais conhecidas (Task 3, passo 4).
- [ ] **Step 8: Idempotência.** Run: `bun run launcher:test 2>&1 | Select-String -Pattern 'install.js|Downloading'`. Expected: só a linha `$ node node_modules/electron/install.js` (retorno imediato), nenhum download.
- [ ] **Step 9: Download sob demanda executado pelo Bun (`launcher:dev`).** Run (em `launcher/`): `Remove-Item -Recurse -Force node_modules\electron\dist, node_modules\electron\path.txt; bun -e "console.log(require('electron'))"`. Expected: `Downloading Electron binary...` seguido de um caminho que termina em `launcher\node_modules\electron\dist\electron.exe`. Depois: `& node_modules\electron\dist\electron.exe --version`. Expected: `v43.8.3`. Se o Bun falhar (por exemplo no binding nativo de `@electron-internal/extract-zip`): registrar a saída, restaurar com `node node_modules/electron/install.js`, e acrescentar `"predev": "node node_modules/electron/install.js"` com uma asserção equivalente no mesmo teste de contrato (`assert.equal(manifest.scripts.predev, ...)`), repetindo os passos 4 e 6.
- [ ] **Step 10: Commit.**

  ```powershell
  git add launcher/package.json launcher/tests/packaging-contract.test.cjs
  git commit -m "fix(launcher): install the Electron binary once before node --test runs"
  ```

**Emenda (revisão final):** o script `pretest` desta Task foi trocado por `"postinstall": "node node_modules/electron/install.js"` em `launcher/package.json` (e o teste de contrato passou a exigir `postinstall` e `pretest === undefined`). Motivo: `scripts/verify.ts` roda os testes da raiz antes de `launcher:test`, e `tests/compaction-browser-recovery.test.ts` e `tests/zero-risk-adapter.test.ts` também carregam `launcher/electron/browser-host.cjs` (`require("electron")`); em runner novo, o `pretest` ainda não teria rodado e o Electron 43 tentaria baixar ~100 MB de forma síncrona dentro de um teste com timeout de 5 s. Com `postinstall`, o binário é instalado por `bun install` em `launcher/` (semântica anterior à versão 42). Portanto, "Quem exige o binário" (Evidência coletada) e o Review Focus 1 também incluem esses dois testes da raiz. Além disso, o `install.js` do Electron 43 não respeita mais `ELECTRON_SKIP_BINARY_DOWNLOAD`.

### Task 3: Compatibilidade estática, testes e gate completo

**Files:** nenhum, se tudo passar. Uma falha de teste ou de build causada pelo Electron 43 entra como task nova, com teste que a reproduza e arquivo justificado no relatório.

**Interfaces:**
- Consumes: `launcher/node_modules` com `electron@43.8.3` e binário instalado (Task 2).
- Produces: evidência de `bun run verify` verde para o PR (Task 5).

- [ ] **Step 1: Re-checar a exposição estática.** Run: `Select-String -Path launcher\electron\*.cjs -Pattern 'new Notification|toBitmap|createFromNamedImage|hslShift|select-hid-device|select-usb-device|setDevicePermissionHandler|quotas|showHiddenFiles|offscreen:'`. Expected: nenhuma linha. Run: `Select-String -Path launcher\electron\browser-host.cjs -Pattern 'clearStorageData\('`. Expected: duas linhas (`:2871`, `:2958`), ambas `clearStorageData()` sem argumentos. Run: `Select-String -Path launcher\electron\main.cjs -Pattern 'defaultPath'`. Expected: uma linha (`:1059`), explícita.
- [ ] **Step 2: Dependências da raiz com o Bun pinado.** Run (na raiz): `bun install --frozen-lockfile`. Expected: sem erro, lockfile da raiz inalterado (`git status --short` não lista `bun.lock`).
- [ ] **Step 3: Typecheck do launcher.** Run: `bun run launcher:typecheck`. Expected: PASS. Registrar no relatório que ele cobre só `launcher/src` e não exercita `electron.d.ts`.
- [ ] **Step 4: Testes do launcher.** Run: `bun run launcher:test`. Expected: PASS, incluindo o bloco `manualTurnFixture` de `browser-host.test.cjs` (Review Focus 4). Falhas aceitas só se forem ambientais e reproduzidas no commit base: `EPERM` de symlink em `runtime-host.test.cjs` (Developer Mode desligado) e política de execução em `windows-installer.test.cjs`. Para comparar: `git worktree add "$env:TEMP\codex-base-c0e8085" c0e8085`, dentro dele `bun install --frozen-lockfile` na raiz e em `launcher/`, `bun run launcher:test`, anotar as mesmas falhas, e depois `git worktree remove "$env:TEMP\codex-base-c0e8085"`. Não usar `git stash`.
- [ ] **Step 5: Build do launcher.** Run: `bun run launcher:build`. Expected: PASS (`tsc --noEmit` + `vite build` gerando `launcher/dist`).
- [ ] **Step 6: Gate completo.** Run (na raiz): `bun run verify`. Expected: todos os passos de `scripts/verify.ts` passam na ordem: `check-version` imprime `VERSION_SYNC_OK 6.1.13 bun@1.4.0`; `audit` e `launcher:audit` sem vulnerabilidades; `typecheck`; `test`; `launcher:typecheck`; `launcher:test` (com `$ node node_modules/electron/install.js` antes); `launcher:build`; bundle do runtime; third-party notices; `smoke-release` com código 0. Se algum passo falhar, registrar a saída e comparar com o commit base antes de tratar como regressão.

### Task 4: Validação do app empacotado (Windows local; macOS e Linux pela CI)

**Files:** nenhum.

**Interfaces:**
- Consumes: Task 3 verde; binário em `launcher/node_modules/electron/dist` (Task 2) para os testes opt-in.
- Produces: artefato `launcher/artifacts/codex-web-gpt-6.1.13-win-x64.exe`, saída do smoke e lista de checks manuais para o PR (Task 5).

- [ ] **Step 1: Empacotar no Windows.** Run: `bun run app:package 2>&1 | Tee-Object -FilePath "$env:TEMP\app-package.log" | Out-Null; Select-String -Path "$env:TEMP\app-package.log" -Pattern 'electron=|electron-v43'`. Expected: linha do electron-builder com `electron=43.8.3` (e, na primeira vez, o download de `electron-v43.8.3-win32-x64.zip`); `launcher\artifacts\codex-web-gpt-6.1.13-win-x64.exe` existe.
- [ ] **Step 2: Smoke do pacote.** Run: `bun run app:smoke`. Expected: `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`. Observação: o smoke instala o NSIS silenciosamente para o usuário atual (`/S /currentuser`) e valida o runtime durável; isso altera a máquina.
- [ ] **Step 3: Checks manuais no app instalado (Windows).** Abrir o launcher instalado e conferir: (a) janela principal com `titleBarOverlay` e botão da sidebar visíveis; (b) painel do navegador abre `chatgpt.com`; (c) menu e tray; (d) "Export safe log" abre o diálogo em Documentos com nome `codex-web-gpt-diagnostics-<data>.jsonl`; (e) em modo Zero Risk, iniciar um turno manual e confirmar que o prompt foi para a área de transferência (Review Focus 4). O item (e) exige sessão autenticada: se não houver conta, marcar "not run".
- [ ] **Step 4: Testes opt-in com o Electron real (Review Focus 5).** Run (na raiz):

  ```powershell
  $env:LAUNCHER_TEST_ELECTRON = (Resolve-Path launcher\node_modules\electron\dist\electron.exe).Path
  bun test tests/launcher-viewport-browser.test.ts tests/launcher-navigation-viewport.test.ts tests/browser-generation.test.ts tests/attachment-upload-electron.test.ts tests/chatgpt-markdown-parser.test.ts tests/context-markdown-regexp.test.ts
  Remove-Item Env:LAUNCHER_TEST_ELECTRON
  ```

  Expected: todos passam. Se `chatgpt-markdown-parser` ou `context-markdown-regexp` falharem na asserção de `timeout`, repetir no worktree do commit base (Task 3, passo 4) apontando `LAUNCHER_TEST_ELECTRON` para o `electron.exe` 41.10.7 daquele worktree: passar na base e falhar na 43 indica mudança do V8 no Chromium 150, registrada no PR como divergência fora do escopo; qualquer outro padrão é regressão e volta para debugging.
- [ ] **Step 5: Linux visual (Review Focus 3).** Se houver desktop Linux: abrir o AppImage gerado pela CI (ou `bun run app:package` em Linux) e conferir que os controles do WCO não cobrem o botão da sidebar e que os cantos arredondados não cortam o header. Sem desktop Linux: "not run" no PR.
- [ ] **Step 6: Sessão autenticada.** Os itens de `docs/release-validation.md` (Browser-only, Full/MCP, compaction, cancelamento, updater) não têm prova automatizada. Executar os que a conta disponível permitir e listar cada um como executado ou "not run".

### Task 5: Review independente e PR

**Files:** nenhum.

**Interfaces:**
- Consumes: commits das Tasks 1 e 2; evidência das Tasks 3 e 4.
- Produces: PR contra `main` com `Fixes #30`.

- [ ] **Step 1: Diff final.** Run: `git diff c0e8085..HEAD --stat`. Expected: exatamente `launcher/package.json`, `launcher/bun.lock`, `launcher/tests/packaging-contract.test.cjs` (o plano em `docs/superpowers/plans/` só se o usuário quiser versioná-lo).
- [ ] **Step 2: Review independente** (`requesting-code-review`, modelo da tabela de roteamento), com contexto separado, focado em: diff do lockfile limitado a 2 linhas; `pretest` idempotente e sem efeito em `app:package`/`app:smoke`; tabela de mudanças de quebra cruzada com o código; evidência de verificação real (não resumo).
- [ ] **Step 3: Confirmar com o usuário** antes de `git push` e de abrir o PR.
- [ ] **Step 4: Abrir o PR** com o template `.github/pull_request_template.md`, em inglês:
  - "What this changes": bump 41.10.7 → 43.8.3 e por quê 43 (42 em EOL desde 45.0.0; 44 muda `clipboard` para Promise, exigindo migrar `writeManualPrompt` — fora do escopo); `pretest` para o download sob demanda do Electron 42+; `Fixes #30`.
  - "Evidence": saída RED/GREEN do `launcher:audit`, os dois hunks do lockfile, `VERSION_SYNC_OK 6.1.13 bun@1.4.0`, `PACKAGED_LAUNCHER_SMOKE_OK win32/x64`, contagem de downloads antes/depois do `pretest`.
  - "Verification": marcar os itens realmente feitos; "I did not include an unrelated dependency update" vale porque o Electron **é** a mudança.
  - "Platform or account validation": Windows 11 x64 (pacote NSIS construído, smoke e checks manuais); macOS e Linux "via CI only" (preencher após o passo 5); checks com sessão autenticada executados ou "not run".
- [ ] **Step 5: Acompanhar a CI.** Run: `gh pr checks --watch`. Expected: job `verify` verde nas três entradas da matriz (`macos-15`, `ubuntu-latest`, `windows-latest`): `bun run verify`, `app:package`, smoke de símbolos do AppImage no Arch e `app:smoke`. Atualizar a seção "Platform or account validation" com o resultado por plataforma. Falha em macOS/Linux volta para debugging com o roteamento da tabela; não há validação local dessas plataformas.

## Auto-revisão do plano

- **Cobertura da spec:** upgrade (Task 1); revisão das mudanças de quebra para main/preload/browser-host (tabela + Task 3, passo 1); `launcher:audit`/`typecheck`/`test`/`build` com Bun pinado (Tasks 1 e 3); `bun run verify` completo (Task 3, passo 6); pacote validado no Windows e, via CI, em macOS/Linux (Tasks 4 e 5); CONTRIBUTING e template do PR (Task 5); alvo exato 43.8.3 (Global Constraints).
- **Passos:** cada passo tem um comando e a saída que significa sucesso; os únicos trechos de código são o teste de contrato e a linha do `pretest`.
- **Consistência de nomes:** `pretest` = `node node_modules/electron/install.js` em Task 2 (passos 3, 5, 7, 8) e Task 5; `LAUNCHER_TEST_ELECTRON` em Task 4; worktree base `c0e8085` em Tasks 3 e 4.
- **Review Focus:** os cinco itens estão pinados a passos concretos (Task 2: 1 e 2; Task 3/4: 4; Task 4: 3 e 5).
- **Proporção:** o plano é maior que o diff (3 linhas úteis) porque a maior parte é verificação multiplataforma exigida pela issue e pelo repositório, não transcrição de código.
