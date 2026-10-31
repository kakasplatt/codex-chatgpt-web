import {
  type ChatGptEffortActivation,
  type ChatGptEffortSliderState,
  chatGptModelOption,
  openChatGptModelRows,
  parseChatGptEffortSliderState,
  parseChatGptModelAnnouncement,
  readChatGptModelAnnouncements,
} from "../../chatgpt-ui/model-picker";
import type { ChatGptWebAdapterEffort, ChatGptWebModelFamily } from "../../chatgpt-web-models";
import { ChatGptWebAdapterError } from "./adapter-error";

type EffortMenu = ChatGptEffortActivation;

const LANGUAGE_HINT = "if ChatGPT uses an unsupported language, select English in Settings → General → Language and reload it.";

function familyError(family: ChatGptWebModelFamily, cause?: unknown, mismatch?: ChatGptModelFamilyMismatch): ChatGptWebAdapterError {
  const detail = mismatch ? `: ${mismatch.reason}` : "";
  const advice = !mismatch || mismatch.unreadable ? `; ${LANGUAGE_HINT}` : ".";
  return new ChatGptWebAdapterError(
    `ChatGPT model ${family} could not be selected and verified${detail}. The pending message was not sent. Check the model in the browser${advice}`,
    { status: 400, errorType: "invalid_request_error", code: "model_version_unavailable", retryable: false, cause },
  );
}

function familyOption(menu: EffortMenu, family: ChatGptWebModelFamily, effort?: ChatGptWebAdapterEffort) {
  return chatGptModelOption(menu.menu, {
    version: family, name: family === "6" && effort === "max" ? "astra" : "sol",
  });
}

/** Model and effort are separate browser controls; a generic Pro label proves neither family. */
export async function selectChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  activate: () => Promise<EffortMenu>,
  effort?: ChatGptWebAdapterEffort,
): Promise<EffortMenu> {
  try {
    const option = await familyOption(menu, family, effort);
    if (await option.count() > 1) throw familyError(family);
    if (await option.count() === 1 && await option.getAttribute("aria-checked") === "true") return menu;
    await openChatGptModelRows(menu.menu);
    await option.waitFor({ state: "visible", timeout: 5_000 });
    await option.click({ timeout: 5_000 });
    // Choosing a family returns the open picker to its slider. Keep that surface:
    // Escape followed by an immediate reopen races the outgoing menu's cleanup.
    // Activation reuses the open menu and verifies its owner before returning it.
    const selected = await activate();
    const deadline = Date.now() + 1_000;
    do {
      const current = await familyOption(selected, family, effort);
      if (await current.count() > 1) throw familyError(family);
      if (await current.count() === 1 && await current.getAttribute("aria-checked") === "true") return selected;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw familyError(family);
  } catch (cause) {
    if (cause instanceof ChatGptWebAdapterError) throw cause;
    throw familyError(family, cause);
  }
}

export function chatGptModelFamilyMatches(
  descriptions: readonly string[],
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
): boolean {
  // GPT-6 uses Sol below Pro and Astra at Pro. An old Latest picker can still use
  // 5.6 at lower efforts; that is not proof of an explicitly requested GPT-6 turn.
  const expectedName = family === "6" && effort === "max" ? "astra" : "sol";
  const expectedMode = { low: "instant", medium: "medium", high: "high", xhigh: "extra high", max: "pro" }[effort];
  const states = descriptions.flatMap(text => {
    const state = parseChatGptModelAnnouncement(text);
    return state ? [state] : [];
  });
  return states.length > 0 && states.every(state => state.version === family
    && (!state.name || state.name === expectedName)
    && (state.mode.toLowerCase() === expectedMode
      || family === "6" && effort === "max" && state.name === "astra" && /^max$/i.test(state.mode)));
}

export interface ChatGptModelFamilyEvidence {
  /** Model rows matching the requested family; exactly one is expected. */
  rows: number;
  checked: boolean;
  slider: ChatGptEffortSliderState | undefined;
  descriptions: readonly string[];
}

export interface ChatGptModelFamilyMismatch {
  reason: string;
  /** No announcement could be parsed, which is how an unsupported UI language shows up. */
  unreadable?: true;
}

function quotedEvidence(descriptions: readonly string[]): string {
  return descriptions.slice(0, 4).map(text => JSON.stringify(text.replace(/\s+/g, " ").trim().slice(0, 60))).join(" | ");
}

/** Name the first picker condition that rejects the requested family, or undefined when all hold. */
export function chatGptModelFamilyMismatch(
  evidence: ChatGptModelFamilyEvidence,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
  effortIndex: number,
): ChatGptModelFamilyMismatch | undefined {
  const { rows, checked, slider, descriptions } = evidence;
  if (rows !== 1) return { reason: `the picker shows ${rows} GPT-${family} model rows instead of 1` };
  if (!checked) return { reason: `the GPT-${family} model row is not checked` };
  if (!slider) return { reason: "the effort slider has no valid position" };
  const position = slider.value - slider.min;
  if (position !== effortIndex) return { reason: `the effort slider is at position ${position} instead of ${effortIndex}` };
  if (chatGptModelFamilyMatches(descriptions, family, effort)) return undefined;
  if (!descriptions.some(text => parseChatGptModelAnnouncement(text))) {
    const shown = descriptions.length ? ` (${quotedEvidence(descriptions)})` : "";
    return { reason: `the picker shows no recognizable model label${shown}`, unreadable: true };
  }
  return { reason: `the picker announces ${quotedEvidence(descriptions)}` };
}

async function readChatGptModelFamilyEvidence(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
): Promise<ChatGptModelFamilyEvidence> {
  const option = await familyOption(menu, family, effort);
  const rows = await option.count();
  return {
    rows,
    checked: rows === 1 && await option.getAttribute("aria-checked") === "true",
    slider: parseChatGptEffortSliderState(
      await menu.slider.getAttribute("aria-valuemin"), await menu.slider.getAttribute("aria-valuemax"),
      await menu.slider.getAttribute("aria-valuenow"),
    ),
    descriptions: await readChatGptModelAnnouncements(menu.slider),
  };
}

export async function assertChatGptModelFamily(
  menu: EffortMenu,
  family: ChatGptWebModelFamily,
  effort: ChatGptWebAdapterEffort,
  effortIndex: number,
  settleMs = 0,
): Promise<void> {
  const deadline = Date.now() + settleMs;
  do {
    const evidence = await readChatGptModelFamilyEvidence(menu, family, effort);
    const mismatch = chatGptModelFamilyMismatch(evidence, family, effort, effortIndex);
    if (!mismatch) return;
    if (Date.now() >= deadline) throw familyError(family, undefined, mismatch);
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (true);
}
