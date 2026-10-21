# Achados menores finais do PR #28 — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolver os dois achados menores da revisão final de `aa16ae6..6000bdd`:
1. o teste de backtracking depende só de tempo, com cerca de 2x de folga;
2. o plano `2026-10-21-calendar-delta-final-minors.md` ainda descreve a D1 antiga.

**Architecture:** Nenhuma mudança de código de produção.
- O ramo de lista é linear porque **exige** uma quebra de linha depois de cada worker (`(?:\r\n|\n)`). Um teste determinístico passa a fixar essa propriedade: um worker sem quebra de linha antes de `</subagents>` é recusado. A forma exponencial antiga (`\s*`) aceitaria esse fragmento, então o teste falha se a regressão voltar, independentemente da velocidade da máquina. O teste de tempo continua como proteção secundária.
- O plano antigo ganha uma nota curta apontando para a emenda da D1.

**Tech Stack:** TypeScript, Bun (`bun test`).

**Spec:** revisão final de `aa16ae6..6000bdd` (Minors 1 e 2); emenda da D1 em `docs/superpowers/plans/2026-10-21-pr28-review-fixes.md`.

## Global Constraints

- Arquivos: `tests/environment.test.ts` e `docs/superpowers/plans/2026-10-21-calendar-delta-final-minors.md`.
- Nenhuma expectativa de teste existente muda.
- Nenhum caminho pessoal em arquivos, commits ou PR.
- Bun local 1.4.3 ≠ pin 1.4.0: `check-version`, o bundle de runtime e o release smoke não são executados.

---

### Task 1: Verificação estrutural da linearidade

**Files:**
- Test: `tests/environment.test.ts`, teste `a rejected bullet worker inventory fails closed without exponential backtracking` (por volta da linha 1633).

- [ ] **Step 1:** No mesmo teste, depois da asserção de tempo, acrescentar a verificação estrutural:
  - `delta.content[0]!.text = original.replace("</environment_context>", "<subagents>\n    - 01a15bde-6c1b-7211-a9a6-130ce8b5d6db: Worker</subagents>\n</environment_context>")`. Guardar o texto original do delta no começo do teste como `original`.
  - `expect(() => store.resolve(request)).toThrow("missing cwd")`.
  - Comentário: a linearidade vem da quebra de linha obrigatória depois de cada worker; a forma exponencial aceitaria este fragmento, e esta verificação não depende da velocidade da máquina.
- [ ] **Step 2:** `bun test tests/environment.test.ts -t "exponential backtracking"`. Expected: PASS.
- [ ] **Step 3: Mutação.**
  - Copiar `src/adapters/chatgpt-web/environment.ts` para um backup fora do repo.
  - Trocar o terminador `(?:\\r\\n|\\n)\\s*)+` por `\\s*)+`.
  - Rodar o teste. Expected: FAIL. A verificação estrutural falha mesmo que o tempo fique abaixo de 500 ms.
  - Restaurar **a partir do backup**, não com `git checkout`, e rodar de novo. Expected: PASS.
- [ ] **Step 4: Commit:** `test: pin the line-break terminator that keeps bullet inventories linear`.

### Task 2: Nota da emenda D1 no plano antigo

**Files:**
- Modify: `docs/superpowers/plans/2026-10-21-calendar-delta-final-minors.md`, logo abaixo do item **D1** (linha 33).

- [ ] **Step 1:** Acrescentar uma nota:

  > **Emenda (2026-10-21):** aprovada em `docs/superpowers/plans/2026-10-21-pr28-review-fixes.md`. Com vários Codex homes não há cache nem herança por cache, então nenhuma recusa de root amplo se aplica; a regra abaixo vale só com um único Codex home.

- [ ] **Step 2: Commit:** `docs: point the earlier plan's D1 at its approved amendment`.

### Task 3: Verificação e PR

- [ ] `bun test tests/environment.test.ts`. Expected: PASS. A suíte completa não é necessária: as mudanças se limitam a um teste e a um documento.
- [ ] `git push` (sem force). Na descrição do PR #28, ajustar o item 10 da seção `Review follow-up` para mencionar a verificação estrutural.
