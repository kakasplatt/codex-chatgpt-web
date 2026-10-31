import { expect, test } from "bun:test";
import {
  assertChatGptModelFamily, chatGptModelFamilyMatches, chatGptModelFamilyMismatch, selectChatGptModelFamily,
} from "../src/adapters/chatgpt-web/model-selection";
import { chatGptUsageModelFromAnnouncements } from "../src/adapters/chatgpt-web/limits";

test("model selection recognizes Latest in the launcher languages without accepting other model names", async () => {
  for (const [label, accepted] of [
    ["Latest", true], ["最新", true], ["최신", true], ["GPT-6 Pro", true], ["6", true], ["GPT-6 Sol", true],
    ["GPT-5.6 Sol", false], ["GPT-6.1 Sol", false], ["GPT-7 Pro", false], ["Latest preview", false],
  ] as const) {
    const menu = { menu: {
      getByRole: (_role: string, options: { name: RegExp }) => ({
        count: async () => options.name.test(label) ? 1 : 0,
        getAttribute: async () => "true",
        waitFor: async () => { throw new Error("Requested family is absent"); },
      }),
      locator: () => ({ count: async () => 1, getAttribute: async () => "true" }),
    } } as unknown as Parameters<typeof selectChatGptModelFamily>[0];
    const selection = selectChatGptModelFamily(menu, "6", async () => menu);
    if (accepted) expect(await selection).toBe(menu);
    else await expect(selection).rejects.toThrow("could not be selected and verified");
  }
});

test("family confirmation verifies the exact Sol or Pro version, including the old Latest picker", () => {
  expect(chatGptModelFamilyMatches(["5.6 High, 3 of 5."], "5.6", "high")).toBe(true);
  expect(chatGptModelFamilyMatches(["5.6 Extra High, 4 of 5."], "6", "xhigh")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Medium, 2 of 3.", "Medium"], "6", "medium")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Sol Extra High, 4 of 5."], "6", "xhigh")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-6 Astra High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6.1 High, 3 of 5."], "6", "high")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "max")).toBe(true);
  expect(chatGptModelFamilyMatches(["GPT-5.6 Sol Pro, 5 of 5."], "5.6", "max")).toBe(true);
  for (const descriptions of [[], ["Try Pro for more reasoning"], ["5.6 High, 3 of 5."], ["5.6 Pro, 5 of 5."],
    ["7 Pro, 5 of 5."], ["6 Sol Pro, 5 of 5."], ["6 Pro, 5 of 5.", "5.6 Pro, 5 of 5."], ["6 Pro for better answers"]]) {
    expect(chatGptModelFamilyMatches(descriptions, "6", "max")).toBe(false);
  }
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "5.6", "max")).toBe(false);
  expect(chatGptModelFamilyMatches(["6 Pro, 5 of 5."], "6", "xhigh")).toBe(false);
});

test("explicit Astra Max verifies the requested Pro route without accepting Ultra or another model", () => {
  expect(chatGptModelFamilyMatches(["6 Astra Max"], "6", "max")).toBeTrue();
  expect(chatGptUsageModelFromAnnouncements(["6 Astra Max"])).toBe("gpt-6-pro");
  for (const description of ["6 Astra Ultra", "6 Astra High", "6 Sol Max", "6.1 Astra Max", "6 Max"]) {
    expect(chatGptModelFamilyMatches([description], "6", "max")).toBeFalse();
    expect(chatGptUsageModelFromAnnouncements([description])).toBe("pro-unknown");
  }
});

test("Simplified Chinese effort announcements preserve exact model and effort verification (#911)", () => {
  for (const [label, effort] of [["即时", "low"], ["中", "medium"], ["高", "high"]] as const) {
    expect(chatGptModelFamilyMatches([`GPT-6 Sol ${label}，第 3 项，共 3 项`, `6 ${label}`], "6", effort)).toBeTrue();
    expect(chatGptModelFamilyMatches([`5.6 ${label}`], "6", effort)).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Astra ${label}`], "6", effort)).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 ${label}`, "6 Pro"], "6", effort)).toBeFalse();
  }
  for (const effort of ["low", "medium", "xhigh", "max"] as const) {
    expect(chatGptModelFamilyMatches(["6 高"], "6", effort)).toBeFalse();
  }
  for (const label of ["超高", "高级", "高 reasoning", "高 6.1"]) {
    expect(chatGptModelFamilyMatches([`6 ${label}`], "6", "high")).toBeFalse();
  }
});


test("model verification accepts Unicode announcement punctuation without weakening identity", () => {
  for (const separator of ["、", "，", "،", "؛", "：", "—", "。", ",", ";"]) {
    expect(chatGptModelFamilyMatches([`6 Pro${separator}5 件中 5 番目。`], "6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`GPT-5.6 Sol Pro${separator}translated position`], "5.6", "max")).toBeTrue();
    expect(chatGptModelFamilyMatches([`6.1 Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Sol Pro${separator}position`], "6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([`6 Pro${separator}position`, "5.6 Pro"], "6", "max")).toBeFalse();
  }
  expect(chatGptModelFamilyMatches(["\u2068６ Pro\u2069、position"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Pro for better answers"], "6", "max")).toBeFalse();
});

test("repeated picker version verifies GPT-5.6 Pro without accepting conflicting evidence (#875)", () => {
  for (const header of ["5.6 Sol 5.6 Pro", "GPT-5.6 Sol GPT-5.6 Pro"]) {
    const evidence = ["5.6 Pro, 5 of 5.", header];
    expect(chatGptModelFamilyMatches(evidence, "5.6", "max")).toBeTrue();
    expect(chatGptUsageModelFromAnnouncements(evidence)).toBe("gpt-5.6-pro");
    expect(chatGptModelFamilyMatches(evidence, "5.6", "high")).toBeFalse();
    expect(chatGptModelFamilyMatches(evidence, "6", "max")).toBeFalse();
  }
  for (const header of ["5.6 Sol 6 Pro", "5.6 Sol 5.7 Pro", "5.6 Sol 5.6.1 Pro"]) {
    expect(chatGptModelFamilyMatches(["5.6 Pro, 5 of 5.", header], "5.6", "max")).toBeFalse();
    expect(chatGptModelFamilyMatches([header], "5.6", "high")).toBeFalse();
    expect(chatGptUsageModelFromAnnouncements([header])).toBe("pro-unknown");
  }
  expect(chatGptModelFamilyMatches(["6 Astra 6 Pro"], "6", "max")).toBeTrue();
  expect(chatGptModelFamilyMatches(["6 Astra 6 Pro"], "6", "high")).toBeFalse();
});

// #110: a rejected family names the condition that failed, not only the language hint.
test("family mismatch names the failing picker condition and its observed evidence (#110)", () => {
  const verified = { rows: 1, checked: true, slider: { min: 0, max: 2, value: 2 }, descriptions: ["High, 3 of 3.", "6 High"] };
  expect(chatGptModelFamilyMismatch(verified, "6", "high", 2)).toBeUndefined();
  expect(chatGptModelFamilyMismatch({ ...verified, rows: 0 }, "6", "high", 2))
    .toEqual({ reason: "the picker shows 0 GPT-6 model rows instead of 1" });
  expect(chatGptModelFamilyMismatch({ ...verified, rows: 2 }, "6", "high", 2))
    .toEqual({ reason: "the picker shows 2 GPT-6 model rows instead of 1" });
  expect(chatGptModelFamilyMismatch({ ...verified, checked: false }, "6", "high", 2))
    .toEqual({ reason: "the GPT-6 model row is not checked" });
  expect(chatGptModelFamilyMismatch({ ...verified, slider: { min: 0, max: 2, value: 1 } }, "6", "high", 2))
    .toEqual({ reason: "the effort slider is at position 1 instead of 2" });
  expect(chatGptModelFamilyMismatch({ ...verified, slider: { min: 1, max: 3, value: 3 } }, "6", "high", 2)).toBeUndefined();
  expect(chatGptModelFamilyMismatch({ ...verified, slider: undefined }, "6", "high", 2))
    .toEqual({ reason: "the effort slider has no valid position" });
  expect(chatGptModelFamilyMismatch({ ...verified, descriptions: ["High, 3 of 3.", "6.1 High"] }, "6", "high", 2))
    .toEqual({ reason: 'the picker announces "High, 3 of 3." | "6.1 High"' });
});

test("family mismatch keeps the language hint only for unreadable model evidence (#110)", () => {
  const evidence = { rows: 1, checked: true, slider: { min: 0, max: 2, value: 2 } };
  for (const descriptions of [[], ["High, 3 of 3."], ["Alto, 3 de 3."]]) {
    expect(chatGptModelFamilyMismatch({ ...evidence, descriptions }, "6", "high", 2)).toEqual({
      reason: "the picker shows no recognizable model label"
        + (descriptions.length ? " (" + descriptions.map(text => JSON.stringify(text)).join(" | ") + ")" : ""),
      unreadable: true,
    });
  }
  const long = chatGptModelFamilyMismatch({ ...evidence, descriptions: ["6.1 " + "x".repeat(500), "a", "b", "c", "d"] }, "6", "high", 2);
  expect(long?.reason.length).toBeLessThan(300);
});

/** A picker whose model row reports `checked()` on each read; the slider and header stay GPT-6 High. */
function fakePicker(checked: (read: number) => boolean) {
  let reads = 0;
  const menu = {
    menu: { getByRole: () => ({ count: async () => 1, getAttribute: async () => String(checked(++reads)) }) },
    slider: {
      getAttribute: async (name: string) => ({ "aria-valuemin": "0", "aria-valuemax": "2", "aria-valuenow": "2" })[name] ?? null,
      evaluate: async () => ["High, 3 of 3.", "6 High"],
    },
  } as unknown as Parameters<typeof assertChatGptModelFamily>[0];
  return { menu, reads: () => reads };
}

test("family assertion names the unchecked row and keeps the language hint out of it (#110)", async () => {
  const picker = fakePicker(() => false);
  const failure = await assertChatGptModelFamily(picker.menu, "6", "high", 2).then(() => undefined, error => error);
  expect(failure).toMatchObject({ code: "model_version_unavailable", retryable: false });
  expect((failure as Error).message).toBe("ChatGPT model 6 could not be selected and verified: the GPT-6 model row is not checked. "
    + "The pending message was not sent. Check the model in the browser.");
  expect(picker.reads()).toBe(1);
});

test("family assertion waits within its settle window for the picker to commit the row (#110)", async () => {
  const picker = fakePicker(read => read >= 3);
  await assertChatGptModelFamily(picker.menu, "6", "high", 2, 1_000);
  expect(picker.reads()).toBe(3);
});

test("unreadable model evidence keeps the language hint in the full message (#110)", async () => {
  const picker = fakePicker(() => true);
  (picker.menu.slider as unknown as { evaluate: () => Promise<string[]> }).evaluate = async () => ["Alto, 3 de 3."];
  const failure = await assertChatGptModelFamily(picker.menu, "6", "high", 2).then(() => undefined, error => error);
  expect((failure as Error).message).toBe("ChatGPT model 6 could not be selected and verified: the picker shows no recognizable "
    + 'model label ("Alto, 3 de 3."). The pending message was not sent. Check the model in the browser; if ChatGPT uses an '
    + "unsupported language, select English in Settings → General → Language and reload it.");
});
