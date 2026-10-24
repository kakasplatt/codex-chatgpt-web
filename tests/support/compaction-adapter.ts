import type { ProviderAdapter } from "../../src/adapters/base";
import type { CodexMessage, CodexProviderConfig } from "../../src/types";

export const compactionSummary = "The repository was inspected. Continue by implementing the bounded Web context contract.";

export interface CompactionAdapterObservation {
  compactionRequest: boolean | undefined;
  messages: CodexMessage[];
}

/**
 * A Web adapter that answers every turn with `compactionSummary`. It only records what it saw:
 * an `expect` inside `runTurn` would surface as a non-200 response, hiding the failing assertion,
 * so tests assert on `observations` and `factoryCalls` instead.
 */
export function compactionAdapterFactory(
  recorded: { factoryCalls?: CodexProviderConfig[]; observations?: CompactionAdapterObservation[] } = {},
) {
  return (provider: CodexProviderConfig): ProviderAdapter => {
    recorded.factoryCalls?.push(provider);
    return {
      name: "test-web-compactor",
      async runTurn(parsed, _incoming, emit) {
        recorded.observations?.push({ compactionRequest: parsed._compactionRequest, messages: parsed.context.messages });
        emit({ type: "text_delta", text: compactionSummary, phase: "final_answer" });
        emit({
          type: "done",
          stopReason: "stop",
          endTurn: true,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, estimated: true },
        });
      },
    };
  };
}
