import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { namespacedToolName, type CodexTool } from "../../types";
import { VERSION } from "../../version";
import type { ChatGptTurnEnvironment } from "./environment";
import { CODEX_COMPACTION_CONTROL_WIRE_NAME } from "./native-compaction-control";
import { callTurnBroker, TurnBrokerTimeoutError, type BrokerToolResult } from "./turn-broker";
import { observeMcpToolCalls } from "./mcp-observation";

interface ClaimedTurn {
  bindingId: string;
  activityId: string;
  environment: ChatGptTurnEnvironment & { expiresAt?: number };
}

export type ChatGptMcpContract = "native" | "safe";

const BRIDGE_TOOL_NAMES = new Set([
  "codex_turn_start",
  "codex_exec",
  "codex_write_stdin",
  "codex_apply_patch",
  "codex_view_image",
  "codex_tool_inventory",
  "codex_tool_call",
  "codex_turn_complete",
]);

const GATEWAY_AGENT_WAIT_TOOL_NAMES = new Set([
  "multi_agent_v1__wait_agent",
  "multi_agent_v2__wait_agent",
  "collaboration__wait_agent",
]);

const GATEWAY_AGENT_CLOSE_TOOL_NAMES = new Set([
  "multi_agent_v1__close_agent",
  "multi_agent_v2__close_agent",
  "collaboration__close_agent",
]);

const GATEWAY_AGENT_REACTIVATION_TOOL_NAMES = new Set([
  "multi_agent_v1__send_input",
  "multi_agent_v1__resume_agent",
  "multi_agent_v2__followup_task",
  "collaboration__followup_task",
]);

const turnTokenSchema = z.string().min(20).max(256);
const jsonArgumentsSchema = z.record(z.string(), z.unknown()).default({});
// Match Codex's default wait interval while returning before the MCP invocation deadline.
export const CHATGPT_WEB_AGENT_WAIT_POLL_MS = 30_000;
const AGENT_WAIT_TRANSPORT_RULE = `ChatGPT Web transport rule: wait for exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS / 1_000} seconds per call, matching the Codex default, then release the MCP channel so spawned Web agents can use their own tools. A wait timeout is not task completion; check agent progress and wait again if needed. Keep the native tool's declared arguments.`;
const AGENT_CLOSE_ORCHESTRATION_RULE = "ChatGPT Web orchestration rule: do not call close_agent for a worker whose latest observed status is still running. A wait timeout is not evidence that the worker is stalled. If a running worker appears stuck, first request a checkpoint with the available non-interrupting message or follow-up tool (send_input in Compatibility V1), then wait again. The current native close schema exposes no verifiable stall-evidence field, so this bridge forwards structured close_agent only after a structured wait_agent result has returned that target in a terminal-status map. Any structured resume/follow-up attempt starts a new causal generation and requires wait_agent to report the target terminal again. Overlapping lifecycle mutations cannot certify terminal state. Raw exec close_agent is blocked, and raw exec invalidates binding-wide terminal observations because nested lifecycle mutations cannot update the structured ledger.";
const MAX_AGENT_TERMINAL_STATE_BINDINGS = 64;
// Native command calls share a transport with the two-minute MCP tunnel. Keep each command/session
// poll bounded so a long-running process yields a session_id instead of occupying the invocation
// until the 90-second local deadline retires the whole turn binding.
const CHATGPT_WEB_NATIVE_COMMAND_POLL_MS = 30_000;
// The OpenAI tunnel currently owns a two-minute command-response deadline. The local MCP server
// must settle first so an abandoned native tool call is returned as an MCP error instead of
// letting the tunnel tear down and poison its long-lived stdio transport.
export const CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS = 90_000;

const ZERO_RISK_MCP_INSTRUCTIONS = [
  "For each pasted Codex Web GPT request, begin with codex_turn_start using the request_id in its request block.",
  "Use that request_id with the Codex tools needed for the task.",
  "When the task is finished, send the complete answer with codex_turn_complete.",
  "If a tool returns an error, report that error instead of changing the request_id.",
].join(" ");

function turnReferenceInput(contract: ChatGptMcpContract): Record<string, z.ZodString> {
  return contract === "safe"
    ? { request_id: turnTokenSchema }
    : { turn_token: turnTokenSchema };
}

function turnReference(contract: ChatGptMcpContract, input: object): string {
  const key = contract === "safe" ? "request_id" : "turn_token";
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} is required`);
  return value;
}

interface McpRequestExtra {
  sessionId?: string;
  requestId: string | number;
  _meta?: unknown;
  requestInfo?: unknown;
  signal?: AbortSignal;
}

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function requestScopeSummary(extra: McpRequestExtra): string {
  const meta = extra._meta && typeof extra._meta === "object" && !Array.isArray(extra._meta)
    ? Object.entries(extra._meta as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => ({
        key,
        type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
        ...(typeof value === "string" ? { chars: value.length, hash: scopeHash(value) } : {}),
      }))
    : [];
  const requestInfoKeys = extra.requestInfo && typeof extra.requestInfo === "object"
    ? Object.keys(extra.requestInfo as Record<string, unknown>).sort()
    : [];
  return JSON.stringify({
    requestId: String(extra.requestId),
    session: extra.sessionId ? { chars: extra.sessionId.length, hash: scopeHash(extra.sessionId) } : null,
    meta,
    requestInfoKeys,
  });
}

function result(value: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function afterSafeStart(contract: ChatGptMcpContract, description: string): string {
  return contract === "safe"
    ? `For a Zero Risk request connected by codex_turn_start. ${description}`
    : description;
}

function wireName(tool: CodexTool): string {
  return namespacedToolName(tool.namespace, tool.name);
}

function exactTool(environment: ChatGptTurnEnvironment, name: string): CodexTool | undefined {
  return environment.tools.find(tool => !tool.namespace && tool.name === name);
}

function toolAcceptsArgument(tool: CodexTool, name: string): boolean {
  const properties = tool.parameters.properties;
  return (properties !== undefined
      && properties !== null
      && typeof properties === "object"
      && !Array.isArray(properties)
      && Object.hasOwn(properties, name))
    || tool.parameters.additionalProperties !== false;
}

function assertToolSupportsBoundedCommandPolling(tool: CodexTool, argumentName: string): void {
  if (!toolAcceptsArgument(tool, argumentName)) {
    throw new Error(`The current native ${tool.name} tool does not support ${argumentName} required for bounded command polling`);
  }
}

function gatewayToolNameIsValid(name: string): boolean {
  return /^[A-Za-z0-9_$]+$/.test(name);
}

function safeVisibleTools(environment: ChatGptTurnEnvironment, contract: ChatGptMcpContract): CodexTool[] {
  if (contract === "native") return environment.tools;
  const bridgeNamespaces = new Set(environment.tools
    .filter(tool => tool.namespace && BRIDGE_TOOL_NAMES.has(tool.name))
    .map(tool => tool.namespace!));
  return environment.tools.filter(tool => (
    wireName(tool) !== CODEX_COMPACTION_CONTROL_WIRE_NAME
    && !BRIDGE_TOOL_NAMES.has(tool.name)
    // Zero Risk does not expose model-authored JavaScript. Automatic Full mode keeps the native
    // Codex exec surface and applies its transport guard at invocation time below.
    && (tool.namespace !== undefined || tool.name !== "exec")
    && (!tool.namespace || !bridgeNamespaces.has(tool.namespace))
  ));
}

function isAgentWaitTool(tool: CodexTool): boolean {
  return isGatewayAgentWaitTool(wireName(tool));
}

function isGatewayAgentWaitTool(name: string): boolean {
  return GATEWAY_AGENT_WAIT_TOOL_NAMES.has(name);
}

function isAgentCloseTool(tool: CodexTool): boolean {
  return isGatewayAgentCloseTool(wireName(tool));
}

function isGatewayAgentCloseTool(name: string): boolean {
  return GATEWAY_AGENT_CLOSE_TOOL_NAMES.has(name);
}

function isGatewayAgentReactivationTool(name: string): boolean {
  return GATEWAY_AGENT_REACTIVATION_TOOL_NAMES.has(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function terminalAgentIdsFromResult(value: unknown): string[] {
  const ids = new Set<string>();
  const inspect = (candidate: unknown, depth: number): void => {
    if (depth > 6 || candidate === null || candidate === undefined) return;
    if (typeof candidate === "string") {
      const trimmed = candidate.trim();
      if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return;
      try {
        inspect(JSON.parse(trimmed), depth + 1);
      } catch {
        // Ordinary tool text is not structured status evidence.
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) inspect(item, depth + 1);
      return;
    }
    if (!isRecord(candidate)) return;

    for (const key of ["status", "statuses"] as const) {
      const statuses = candidate[key];
      if (!isRecord(statuses)) continue;
      for (const agentId of Object.keys(statuses)) {
        if (agentId.length > 0) ids.add(agentId);
      }
    }
    if ("structuredContent" in candidate) inspect(candidate.structuredContent, depth + 1);
    if ("content" in candidate) inspect(candidate.content, depth + 1);
    if (candidate.type === "text" && typeof candidate.text === "string") {
      inspect(candidate.text, depth + 1);
    }
  };
  inspect(value, 0);
  return [...ids];
}

function closeAgentTarget(argumentsValue: Record<string, unknown>): string | undefined {
  const target = argumentsValue.target;
  return typeof target === "string" && target.length > 0 ? target : undefined;
}

function reactivatedAgentTarget(toolName: string, argumentsValue: Record<string, unknown>): string | undefined {
  if (!isGatewayAgentReactivationTool(toolName)) return undefined;
  const candidate = toolName === "multi_agent_v1__resume_agent" ? argumentsValue.id : argumentsValue.target;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function browserToolDescription(tool: CodexTool): string {
  if (isAgentWaitTool(tool)) return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}\n\n${AGENT_CLOSE_ORCHESTRATION_RULE}`;
  if (isAgentCloseTool(tool)) return `${tool.description}\n\n${AGENT_CLOSE_ORCHESTRATION_RULE}`;
  if (isGatewayAgentReactivationTool(wireName(tool))) return `${tool.description}\n\n${AGENT_CLOSE_ORCHESTRATION_RULE}`;
  if (!tool.namespace && tool.name === "exec") {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE} This rule is enforced for wait_agent calls made inside exec; recursive raw exec is unavailable.\n\n${AGENT_CLOSE_ORCHESTRATION_RULE}`;
  }
  return tool.description;
}

function browserToolParameters(tool: CodexTool): Record<string, unknown> {
  if (!isAgentWaitTool(tool)) return tool.parameters;
  const parameters = structuredClone(tool.parameters);
  const properties = parameters.properties && typeof parameters.properties === "object" && !Array.isArray(parameters.properties)
    ? parameters.properties as Record<string, unknown>
    : {};
  const timeout = properties.timeout_ms && typeof properties.timeout_ms === "object" && !Array.isArray(properties.timeout_ms)
    ? properties.timeout_ms as Record<string, unknown>
    : {};
  // The cloned native schema must not advertise a default that contradicts our required interval.
  delete timeout.default;
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...parameters,
    properties: {
      ...properties,
      timeout_ms: {
        ...timeout,
        type: "number",
        const: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        minimum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        maximum: CHATGPT_WEB_AGENT_WAIT_POLL_MS,
        description: `Required transport-safe polling interval. Use exactly ${CHATGPT_WEB_AGENT_WAIT_POLL_MS}; a timed-out wait does not mean the agents have finished.`,
      },
    },
    required: [...new Set([...required, "timeout_ms"])],
  };
}

function assertBrowserToolArguments(tool: CodexTool, args: Record<string, unknown>): void {
  if (!isAgentWaitTool(tool)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

function assertGatewayToolArguments(name: string, args: Record<string, unknown>): void {
  if (!isGatewayAgentWaitTool(name)) return;
  if (args.timeout_ms !== CHATGPT_WEB_AGENT_WAIT_POLL_MS) {
    throw new Error(
      `ChatGPT Web wait_agent requires timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`
      + " so the shared MCP channel remains available to spawned Web agents",
    );
  }
}

export function chatGptMcpInvocationTimeout(
  environment: ChatGptTurnEnvironment & { expiresAt?: number },
  now = Date.now(),
): number {
  const remaining = environment.expiresAt === undefined
    ? CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS
    : Math.max(1, environment.expiresAt - now);
  return Math.min(CHATGPT_WEB_MCP_INVOCATION_TIMEOUT_MS, remaining);
}

function asMcpResult(value: BrokerToolResult) {
  return {
    content: value.content as never,
    ...(value.structuredContent !== undefined && value.structuredContent !== null && typeof value.structuredContent === "object"
      ? { structuredContent: value.structuredContent as Record<string, unknown> }
      : {}),
    ...(value.isError ? { isError: true } : {}),
    ...(value._meta !== undefined && value._meta !== null && typeof value._meta === "object"
      ? { _meta: value._meta as Record<string, unknown> }
      : {}),
  };
}

function execGateway(environment: ChatGptTurnEnvironment): CodexTool | undefined {
  const tool = exactTool(environment, "exec");
  return tool?.freeform ? tool : undefined;
}

function gatewayNestedToolName(toolName: string): string {
  return toolName.replace(/[^A-Za-z0-9_$]/g, "_");
}

interface GatewayToolDescriptor {
  name: string;
  description: string;
}

interface GatewayToolCatalogPage {
  tools: GatewayToolDescriptor[];
  total: number;
}

function gatewayToolDescription(tool: GatewayToolDescriptor): string {
  if (isGatewayAgentWaitTool(tool.name)) {
    return `${tool.description}\n\n${AGENT_WAIT_TRANSPORT_RULE}\n\n${AGENT_CLOSE_ORCHESTRATION_RULE}`;
  }
  if (isGatewayAgentCloseTool(tool.name)) return `${tool.description}\n\n${AGENT_CLOSE_ORCHESTRATION_RULE}`;
  if (isGatewayAgentReactivationTool(tool.name)) return `${tool.description}\n\n${AGENT_CLOSE_ORCHESTRATION_RULE}`;
  return tool.description;
}

function gatewayToolCatalogProgram(options: {
  query?: string;
  offset: number;
  limit: number;
  excludedNames: string[];
}): string {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return [
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const excludedNames = new Set(${JSON.stringify(options.excludedNames)});`,
    `const needle = ${JSON.stringify(needle)};`,
    "const visibleName = name => {",
    "  return typeof name === \"string\" && /^[A-Za-z0-9_$]+$/.test(name) && !excludedNames.has(name);",
    "};",
    "const matches = ALL_TOOLS",
    "  .filter(tool => visibleName(tool?.name))",
    "  .map(tool => ({ name: tool.name, description: typeof tool.description === \"string\" ? tool.description : \"\" }))",
    "  .filter(tool => !needle || (tool.name + \"\\n\" + tool.description).toLowerCase().includes(needle));",
    `const page = matches.slice(${options.offset}, ${options.offset + options.limit});`,
    "text(JSON.stringify({ tools: page, total: matches.length }));",
  ].join("\n");
}

function gatewayToolCatalogPage(response: {
  content: unknown[];
  isError?: boolean;
}, excludedNames: ReadonlySet<string>): GatewayToolCatalogPage {
  const textBlocks = response.content
    .map(item => item && typeof item === "object" && !Array.isArray(item)
      ? item as Record<string, unknown>
      : undefined)
    .filter((item): item is Record<string, unknown> => item?.type === "text" && typeof item.text === "string")
    .map(item => item.text as string);
  if (response.isError) {
    throw new Error(`Native nested tool inventory failed: ${textBlocks.join("\n") || "unknown error"}`);
  }
  if (textBlocks.length !== 1) {
    throw new Error("Native nested tool inventory returned an invalid text response");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(textBlocks[0]!);
  } catch {
    throw new Error("Native nested tool inventory returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Native nested tool inventory returned an invalid catalog");
  }
  const catalog = parsed as Record<string, unknown>;
  if (!Number.isSafeInteger(catalog.total) || (catalog.total as number) < 0 || !Array.isArray(catalog.tools)) {
    throw new Error("Native nested tool inventory returned invalid pagination");
  }
  const tools = catalog.tools.map((value): GatewayToolDescriptor => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native nested tool inventory returned an invalid tool entry");
    }
    const tool = value as Record<string, unknown>;
    if (typeof tool.name !== "string"
      || typeof tool.description !== "string"
      || !gatewayToolNameIsValid(tool.name)
      || excludedNames.has(tool.name)) {
      throw new Error("Native nested tool inventory returned an invalid tool descriptor");
    }
    return { name: tool.name, description: tool.description };
  });
  return { tools, total: catalog.total as number };
}

function execGatewayResultProgram(invocation: string[]): string {
  return [
    ...invocation,
    "const emit = value => {",
    "  if (Array.isArray(value)) { for (const item of value) emit(item); return; }",
    "  if (value && typeof value === \"object\") {",
    "    if (value.type === \"image\") { image(value); return; }",
    "    if (value.type === \"audio\") { audio(value); return; }",
    "    if (value.type === \"text\" && typeof value.text === \"string\") { text(value.text); return; }",
    "    if (typeof value.image_url === \"string\" && typeof value.output_hint === \"string\") { generatedImage(value); return; }",
    "    if (typeof value.image_url === \"string\") { image(value.image_url, value.detail ?? \"auto\"); return; }",
    "    if (typeof value.audio_url === \"string\") { audio(value.audio_url); return; }",
    "    if (Array.isArray(value.content)) { for (const item of value.content) emit(item); return; }",
    "  }",
    "  text(value);",
    "};",
    "emit(result);",
  ].join("\n");
}

function execGatewayProgram(
  nestedToolName: string,
  freeform: boolean,
  payload: { arguments?: Record<string, unknown>; input?: string },
  excludedNames: string[],
): string {
  if (!gatewayToolNameIsValid(nestedToolName) || excludedNames.includes(nestedToolName)) {
    throw new Error(`Codex nested tool is not available in this turn: ${nestedToolName}`);
  }
  const gatewayName = gatewayNestedToolName(nestedToolName);
  if (gatewayName !== nestedToolName) {
    throw new Error(`Codex nested tool name is invalid: ${nestedToolName}`);
  }
  const nestedInput = freeform ? payload.input ?? "" : payload.arguments ?? {};
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native nested tool registry is unavailable\");",
    `const nestedToolName = ${JSON.stringify(gatewayName)};`,
    `const excludedNames = new Set(${JSON.stringify(excludedNames)});`,
    "if (excludedNames.has(nestedToolName)) throw new Error(\"Native nested tool is not callable through the structured gateway\");",
    "if (!ALL_TOOLS.some(tool => tool?.name === nestedToolName)) throw new Error(\"Native nested tool is not listed in this turn\");",
    "const nestedTool = tools[nestedToolName];",
    "if (typeof nestedTool !== \"function\") throw new Error(\"Native nested tool is listed but unavailable\");",
    `const result = await nestedTool(${JSON.stringify(nestedInput)});`,
  ]);
}

/**
 * Preserve the native freeform exec surface while applying the same wait_agent deadline contract
 * as direct calls. Raw exec cannot persist verified terminal-agent state across MCP calls, so it
 * also blocks close_agent rather than providing an escape hatch around the structured close guard.
 */
function transportBoundRawExecProgram(input: string, blockedExecName: string): string {
  return [
    "await (async (tools) => {",
    input,
    "})((() => {",
    "  const source = tools;",
    `  const waitNames = new Set(${JSON.stringify([...GATEWAY_AGENT_WAIT_TOOL_NAMES])});`,
    `  const closeNames = new Set(${JSON.stringify([...GATEWAY_AGENT_CLOSE_TOOL_NAMES])});`,
    `  const blockedExecName = ${JSON.stringify(blockedExecName)};`,
    `  const pollMs = ${CHATGPT_WEB_AGENT_WAIT_POLL_MS};`,
    "  const registryNames = new Set(Reflect.ownKeys(source));",
    "  if (typeof ALL_TOOLS !== \"undefined\" && Array.isArray(ALL_TOOLS)) {",
    "    for (const tool of ALL_TOOLS) if (typeof tool?.name === \"string\") registryNames.add(tool.name);",
    "  }",
    "  const wrappers = new Map();",
    "  const expose = name => {",
    "    if (wrappers.has(name)) return wrappers.get(name);",
    "    const value = Reflect.get(source, name, source);",
    "    let exposed = value;",
    "    if (typeof value === \"function\" && name === blockedExecName) {",
    "      exposed = () => { throw new Error(\"Nested raw exec is unavailable inside ChatGPT Web exec\"); };",
    "    } else if (typeof value === \"function\" && typeof name === \"string\" && closeNames.has(name)) {",
    "      exposed = () => { throw new Error(\"ChatGPT Web close_agent requires structured terminal-state verification and is unavailable inside raw exec\"); };",
    "    } else if (typeof value === \"function\" && typeof name === \"string\" && waitNames.has(name)) {",
    "      exposed = args => {",
    "        if (!args || typeof args !== \"object\" || Array.isArray(args) || args.timeout_ms !== pollMs) {",
    "          throw new Error(\"ChatGPT Web wait_agent requires timeout_ms=\" + pollMs + \" so the shared MCP channel remains available to spawned Web agents\");",
    "        }",
    "        return Reflect.apply(value, source, [args]);",
    "      };",
    "    } else if (typeof value === \"function\") {",
    "      exposed = (...args) => Reflect.apply(value, source, args);",
    "    }",
    "    wrappers.set(name, exposed);",
    "    return exposed;",
    "  };",
    "  return new Proxy(Object.create(null), {",
    "    get: (_target, name) => expose(name),",
    "    has: (_target, name) => registryNames.has(name) || Reflect.has(source, name),",
    "    ownKeys: () => [...registryNames],",
    "    getOwnPropertyDescriptor: (_target, name) =>",
    "      registryNames.has(name) || Reflect.has(source, name)",
    "        ? { configurable: true, enumerable: true, writable: false, value: expose(name) }",
    "        : undefined,",
    "    set: () => false,",
    "    defineProperty: () => false,",
    "    deleteProperty: () => false,",
    "    setPrototypeOf: () => false,",
    "    getPrototypeOf: () => null,",
    "    preventExtensions: () => false,",
    "  });",
    "})());",
  ].join("\n");
}

function execCommandGatewayProgram(
  execCommandArguments: Record<string, unknown>,
  shellCommandArguments: Record<string, unknown>,
): string {
  const execCommandName = gatewayNestedToolName("exec_command");
  const shellCommandName = gatewayNestedToolName("shell_command");
  return execGatewayResultProgram([
    "if (typeof ALL_TOOLS === \"undefined\" || !Array.isArray(ALL_TOOLS)) throw new Error(\"Native command tool registry is unavailable\");",
    `const nativeCommandCandidates = ALL_TOOLS.filter(tool => ${JSON.stringify([execCommandName, shellCommandName])}.includes(tool?.name));`,
    "if (nativeCommandCandidates.length !== 1) throw new Error(\"Expected exactly one native command tool; found \" + (nativeCommandCandidates.join(\", \") || \"none\"));",
    "const nativeCommandTool = nativeCommandCandidates[0];",
    "const nativeCommandName = nativeCommandTool.name;",
    `const boundedPollingArgument = nativeCommandName === ${JSON.stringify(execCommandName)} ? "yield_time_ms" : "timeout_ms";`,
    "const nativeCommandParameters = nativeCommandTool?.parameters;",
    "const nativeCommandProperties = nativeCommandParameters?.properties;",
    "if (nativeCommandParameters && typeof nativeCommandParameters === \"object\" && !Array.isArray(nativeCommandParameters) && nativeCommandParameters.additionalProperties === false && (!nativeCommandProperties || typeof nativeCommandProperties !== \"object\" || Array.isArray(nativeCommandProperties) || !Object.prototype.hasOwnProperty.call(nativeCommandProperties, boundedPollingArgument))) {",
    "  throw new Error(\"Native command tool \" + nativeCommandName + \" does not support \" + boundedPollingArgument + \" required for bounded command polling\");",
    "}",
    "const nativeCommand = tools[nativeCommandName];",
    "if (typeof nativeCommand !== \"function\") throw new Error(\"Native command tool \" + nativeCommandName + \" is listed but unavailable\");",
    `const nativeCommandInput = nativeCommandName === ${JSON.stringify(execCommandName)} ? ${JSON.stringify(execCommandArguments)} : ${JSON.stringify(shellCommandArguments)};`,
    "const result = await nativeCommand(nativeCommandInput);",
  ]);
}

export async function runChatGptMcpServer(options: {
  brokerSocketPath: string;
  contract?: ChatGptMcpContract;
}): Promise<void> {
  const contract = options.contract ?? "native";
  const server = new McpServer(
    { name: contract === "safe" ? "codex-safe" : "codex-native", version: VERSION },
    contract === "safe" ? { instructions: ZERO_RISK_MCP_INSTRUCTIONS } : undefined,
  );
  interface AgentLifecycleState {
    generation: number;
    terminalGeneration?: number;
    closeInFlight: boolean;
    reactivationInFlight: number;
  }

  interface BindingLifecycleState {
    epoch: number;
    rawExecInFlight: number;
    agents: Map<string, AgentLifecycleState>;
  }

  interface AgentWaitObservation {
    epoch: number;
    startedDuringRawExec: boolean;
    generations: Map<string, number>;
    mutationInFlight: Set<string>;
  }

  const agentLifecycleByBinding = new Map<string, BindingLifecycleState>();

  const lifecycleForBinding = (bindingId: string): BindingLifecycleState => {
    const existing = agentLifecycleByBinding.get(bindingId);
    if (existing) return existing;
    if (agentLifecycleByBinding.size >= MAX_AGENT_TERMINAL_STATE_BINDINGS) {
      const oldestBinding = agentLifecycleByBinding.keys().next().value;
      if (typeof oldestBinding === "string") agentLifecycleByBinding.delete(oldestBinding);
    }
    const created: BindingLifecycleState = { epoch: 0, rawExecInFlight: 0, agents: new Map() };
    agentLifecycleByBinding.set(bindingId, created);
    return created;
  };

  const lifecycleForAgent = (bindingId: string, agentId: string): AgentLifecycleState => {
    const binding = lifecycleForBinding(bindingId);
    const existing = binding.agents.get(agentId);
    if (existing) return existing;
    const created: AgentLifecycleState = { generation: 0, closeInFlight: false, reactivationInFlight: 0 };
    binding.agents.set(agentId, created);
    return created;
  };

  const captureAgentWaitObservation = (bindingId: string, toolName: string): AgentWaitObservation | undefined => {
    if (!isGatewayAgentWaitTool(toolName)) return undefined;
    const binding = lifecycleForBinding(bindingId);
    return {
      epoch: binding.epoch,
      startedDuringRawExec: binding.rawExecInFlight > 0,
      generations: new Map([...binding.agents].map(([agentId, state]) => [agentId, state.generation])),
      mutationInFlight: new Set(
        [...binding.agents]
          .filter(([, state]) => state.closeInFlight || state.reactivationInFlight > 0)
          .map(([agentId]) => agentId),
      ),
    };
  };

  const rememberTerminalAgents = (
    bindingId: string,
    toolResult: unknown,
    observation: AgentWaitObservation | undefined,
  ): void => {
    if (!observation) return;
    const terminalAgentIds = terminalAgentIdsFromResult(toolResult);
    if (terminalAgentIds.length === 0) return;
    const binding = agentLifecycleByBinding.get(bindingId);
    if (!binding
      || observation.startedDuringRawExec
      || binding.rawExecInFlight > 0
      || binding.epoch !== observation.epoch) return;
    for (const agentId of terminalAgentIds) {
      const agent = lifecycleForAgent(bindingId, agentId);
      const observedGeneration = observation.generations.get(agentId) ?? 0;
      if (agent.generation === observedGeneration
        && !observation.mutationInFlight.has(agentId)
        && !agent.closeInFlight
        && agent.reactivationInFlight === 0) {
        agent.terminalGeneration = agent.generation;
      }
    }
  };

  const consumeAgentCloseAuthorization = (
    bindingId: string,
    toolName: string,
    invocationArguments: Record<string, unknown>,
  ): string | undefined => {
    if (!isGatewayAgentCloseTool(toolName)) return undefined;
    const target = closeAgentTarget(invocationArguments);
    if (!target) {
      throw new Error("ChatGPT Web close_agent requires a non-empty target for terminal-state verification");
    }
    const agent = lifecycleForAgent(bindingId, target);
    if (agent.closeInFlight) {
      throw new Error("ChatGPT Web close_agent already has an in-flight close for this target");
    }
    if (agent.reactivationInFlight > 0) {
      throw new Error("ChatGPT Web close_agent cannot run while an agent reactivation is in flight for this target");
    }
    if (agent.terminalGeneration !== agent.generation) {
      throw new Error(
        "ChatGPT Web close_agent requires an observed terminal status for the target in this turn. "
        + "A wait timeout or empty status is not stall evidence; request a checkpoint if useful and wait again.",
      );
    }
    // Reserve the target before dispatch. Advancing its generation invalidates any concurrent wait
    // that began against the terminal generation and blocks reactivation until this close settles.
    agent.closeInFlight = true;
    agent.generation += 1;
    agent.terminalGeneration = undefined;
    return target;
  };

  const finishAgentClose = (bindingId: string, target: string | undefined): void => {
    if (!target) return;
    const agent = agentLifecycleByBinding.get(bindingId)?.agents.get(target);
    if (agent) agent.closeInFlight = false;
  };

  const invalidateTerminalObservationForReactivation = (
    bindingId: string,
    toolName: string,
    invocationArguments: Record<string, unknown>,
  ): string | undefined => {
    const target = reactivatedAgentTarget(toolName, invocationArguments);
    if (!target) return undefined;
    const agent = lifecycleForAgent(bindingId, target);
    if (agent.closeInFlight) {
      throw new Error("ChatGPT Web cannot reactivate an agent while close_agent is in flight for that target");
    }
    // Every attempted reactivation starts a new causal generation. Even an explicit tool error is
    // not strong enough to prove that the remote mutation could not have crossed its activation boundary.
    agent.generation += 1;
    agent.terminalGeneration = undefined;
    agent.reactivationInFlight += 1;
    return target;
  };

  const finishAgentReactivation = (bindingId: string, target: string | undefined): void => {
    if (!target) return;
    const agent = agentLifecycleByBinding.get(bindingId)?.agents.get(target);
    if (agent) agent.reactivationInFlight = Math.max(0, agent.reactivationInFlight - 1);
  };

  const beginRawExec = (bindingId: string): void => {
    const binding = lifecycleForBinding(bindingId);
    if ([...binding.agents.values()].some(agent => agent.closeInFlight)) {
      throw new Error("ChatGPT Web raw exec cannot start while close_agent is in flight; retry after that structured close settles");
    }
    binding.epoch += 1;
    binding.rawExecInFlight += 1;
    for (const agent of binding.agents.values()) agent.terminalGeneration = undefined;
  };

  const finishRawExec = (bindingId: string): void => {
    const binding = lifecycleForBinding(bindingId);
    binding.epoch += 1;
    binding.rawExecInFlight = Math.max(0, binding.rawExecInFlight - 1);
    for (const agent of binding.agents.values()) agent.terminalGeneration = undefined;
  };

  const recordAgentLifecycleResult = (
    bindingId: string,
    toolName: string,
    toolResult: { structuredContent?: unknown; content?: unknown[]; isError?: boolean },
    waitObservation?: AgentWaitObservation,
  ): void => {
    if (toolResult.isError) return;
    if (isGatewayAgentWaitTool(toolName)) {
      rememberTerminalAgents(bindingId, toolResult, waitObservation);
    }
  };

  const claimTurn = async (
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
  ): Promise<ClaimedTurn> => {
    console.error(`[chatgpt-web-mcp] ${toolName} scope=${requestScopeSummary(extra)}`);
    const activityId = `activity_${randomBytes(18).toString("base64url")}`;
    try {
      const claimed = await callTurnBroker<Omit<ClaimedTurn, "activityId">>(
        options.brokerSocketPath,
        { method: "claim", token: turnToken, activityId, contract },
        contract === "safe" ? null : 5_000,
        extra.signal,
      );
      return { ...claimed, activityId };
    } catch (error) {
      try {
        await settleTurnActivity(turnToken, activityId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Codex Native claim failed: ${error instanceof Error ? error.message : String(error)}. Its broker activity could not be retired.`,
          { cause: error },
        );
      }
      throw error;
    }
  };

  const settleTurnActivity = async (turnToken: string, activityId: string): Promise<void> => {
    let firstError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await callTurnBroker(options.brokerSocketPath, {
          method: "activity_complete",
          token: turnToken,
          activityId,
        }, 5_000);
        return;
      } catch (error) {
        firstError ??= error;
      }
    }
    throw new AggregateError(
      [firstError],
      "Codex Native broker activity cleanup failed after an idempotent retry",
    );
  };

  const withClaimedTurn = async <T>(
    toolName: string,
    turnToken: string,
    extra: McpRequestExtra,
    action: (claimed: ClaimedTurn) => Promise<T> | T,
  ): Promise<T> => {
    const claimed = await claimTurn(toolName, turnToken, extra);
    try {
      return await action(claimed);
    } finally {
      // The broker's terminal fence treats even a fully local inventory lookup as live MCP work.
      // Settle the lease without the request AbortSignal: cancellation must not strand activity
      // and silently prevent every later completion candidate from committing.
      await settleTurnActivity(turnToken, claimed.activityId);
    }
  };

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_start",
      {
        title: "Connect a Codex Zero Risk request",
        description: "Connect the request_id included in the pasted Codex Web GPT request so its Codex tools can be used.",
        inputSchema: {
          request_id: turnTokenSchema,
        },
        outputSchema: {
          started: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_start scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ started: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_start",
          token: request_id,
        }, 5_000, extra.signal);
        return result(response);
      },
    );
  }

  const invoke = async (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    tool: CodexTool,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
  ) => {
    const timeoutMs = chatGptMcpInvocationTimeout(bound);
    try {
      const response = await callTurnBroker<BrokerToolResult>(options.brokerSocketPath, {
        method: "invoke",
        bindingId,
        wireName: wireName(tool),
        freeform: tool.freeform === true,
        ...(tool.freeform ? { input: payload.input ?? "" } : { arguments: payload.arguments ?? {} }),
      }, timeoutMs, signal);
      return asMcpResult(response);
    } catch (error) {
      // A cancelled/timed-out MCP request no longer has a consumer for the native result. Revoke
      // the whole turn capability so the broker drops the pending invocation and every later call
      // from that abandoned ChatGPT response fails explicitly against its retired binding.
      try {
        await callTurnBroker(options.brokerSocketPath, {
          method: "release",
          bindingId,
          ...(error instanceof TurnBrokerTimeoutError ? {
            failure: { code: "codex_tool_timeout" as const, tool: wireName(tool), timeoutMs },
          } : {}),
        });
      } catch (releaseError) {
        throw new AggregateError(
          [error, releaseError],
          "Codex Native invocation failed and its abandoned broker binding could not be retired",
        );
      }
      if (error instanceof TurnBrokerTimeoutError) {
        const toolName = wireName(tool);
        console.error(
          `[chatgpt-web-mcp] ${toolName} did not complete within ${timeoutMs}ms; retired its turn binding`,
        );
        return result({
          code: "codex_tool_timeout",
          tool: toolName,
          timeout_ms: timeoutMs,
          retryable: false,
          message: `Codex tool ${toolName} did not complete before the MCP transport deadline. The current turn binding was retired; do not retry it in this ChatGPT response.`,
        }, true);
      }
      throw error;
    }
  };

  const invokeNestedNative = (
    bindingId: string,
    bound: ChatGptTurnEnvironment & { expiresAt?: number },
    nestedToolName: string,
    freeform: boolean,
    payload: { arguments?: Record<string, unknown>; input?: string },
    signal?: AbortSignal,
  ) => {
    const gateway = execGateway(bound);
    if (!gateway) {
      throw new Error(`This Codex turn did not advertise ${nestedToolName} or the native exec gateway`);
    }
    return invoke(bindingId, bound, gateway, {
      input: execGatewayProgram(nestedToolName, freeform, payload, bound.tools.map(wireName)),
    }, signal);
  };

  server.registerTool(
    "codex_exec",
    {
      title: "Run a native Codex command",
      description: afterSafeStart(contract, "Invoke the command tool advertised by the current outer Codex harness. A long-running command returns its native session_id."),
      inputSchema: {
        ...turnReferenceInput(contract),
        cmd: z.string().min(1).max(100_000),
        workdir: z.string().max(16_384).optional(),
        yield_time_ms: z.number().int().min(250).max(30_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
        tty: z.boolean().optional(),
        sandbox_permissions: z.enum(["use_default", "require_escalated"]).optional()
          .describe("Native Codex sandbox request, only when the current command tool supports it. Codex decides whether to approve."),
        justification: z.string().optional()
          .describe("Approval question for a native require_escalated request; omit otherwise."),
        prefix_rule: z.array(z.string()).optional()
          .describe("Optional native approval prefix for require_escalated; Codex owns its approval and persistence."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_exec",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { cmd, workdir, yield_time_ms, max_output_tokens, tty, sandbox_permissions, justification, prefix_rule } = input;
        const bound = claimed.environment;
        const commandYieldMs = Math.min(yield_time_ms ?? CHATGPT_WEB_NATIVE_COMMAND_POLL_MS, CHATGPT_WEB_NATIVE_COMMAND_POLL_MS);
        const tool = exactTool(bound, "exec_command") ?? exactTool(bound, "shell_command");
        const permissions = {
          ...(sandbox_permissions !== undefined ? { sandbox_permissions } : {}),
          ...(justification !== undefined ? { justification } : {}),
          ...(prefix_rule !== undefined ? { prefix_rule } : {}),
        };
        const execCommandArguments = {
          cmd,
          ...(workdir ? { workdir } : {}),
          yield_time_ms: commandYieldMs,
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
          ...(tty !== undefined ? { tty } : {}),
          ...permissions,
        };
        const shellCommandArguments = {
          command: cmd,
          ...(workdir ? { workdir } : {}),
          timeout_ms: commandYieldMs,
          ...permissions,
        };
        if (tool) {
          // Never silently discard an approval request on a native registry that cannot express it.
          const properties = tool.parameters.properties;
          for (const key of Object.keys(permissions)) {
            if (!properties || typeof properties !== "object" || !Object.hasOwn(properties, key)) {
              throw new Error(`The current native ${tool.name} tool does not support ${key}`);
            }
          }
          assertToolSupportsBoundedCommandPolling(
            tool,
            tool.name === "exec_command" ? "yield_time_ms" : "timeout_ms",
          );
          const args = tool.name === "exec_command" ? execCommandArguments : shellCommandArguments;
          return invoke(claimed.bindingId, bound, tool, { arguments: args }, extra.signal);
        }
        const gateway = execGateway(bound);
        if (!gateway) {
          throw new Error("This Codex turn did not advertise a native command tool or the native exec gateway");
        }
        return invoke(claimed.bindingId, bound, gateway, {
          input: execCommandGatewayProgram(execCommandArguments, shellCommandArguments),
        }, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_write_stdin",
    {
      title: "Continue a native Codex command session",
      description: afterSafeStart(contract, "Write characters to, or poll, a session_id returned by codex_exec."),
      inputSchema: {
        ...turnReferenceInput(contract),
        session_id: z.number().int().nonnegative(),
        chars: z.string().max(1_000_000).optional(),
        yield_time_ms: z.number().int().min(250).max(300_000).optional(),
        max_output_tokens: z.number().int().min(1).max(1_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (input, extra) => withClaimedTurn(
      "codex_write_stdin",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { session_id, chars, yield_time_ms, max_output_tokens } = input;
        const bound = claimed.environment;
        const commandYieldMs = Math.min(yield_time_ms ?? CHATGPT_WEB_NATIVE_COMMAND_POLL_MS, CHATGPT_WEB_NATIVE_COMMAND_POLL_MS);
        const tool = exactTool(bound, "write_stdin");
        if (tool) assertToolSupportsBoundedCommandPolling(tool, "yield_time_ms");
        const payload = { arguments: {
          session_id,
          ...(chars !== undefined ? { chars } : {}),
          yield_time_ms: commandYieldMs,
          ...(max_output_tokens !== undefined ? { max_output_tokens } : {}),
        } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, "write_stdin", false, payload, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_apply_patch",
    {
      title: "Apply a native Codex patch",
      description: afterSafeStart(contract, "Invoke the outer Codex apply_patch tool, producing a native file-change item in the Codex task."),
      inputSchema: { ...turnReferenceInput(contract), patch: z.string().min(1).max(5_000_000) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_apply_patch",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { patch } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "apply_patch");
        if (!tool) return invokeNestedNative(claimed.bindingId, bound, "apply_patch", true, { input: patch }, extra.signal);
        return tool.freeform
          ? invoke(claimed.bindingId, bound, tool, { input: patch }, extra.signal)
          : invoke(claimed.bindingId, bound, tool, { arguments: { input: patch } }, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_view_image",
    {
      title: "View an image through native Codex",
      description: afterSafeStart(contract, "Invoke the outer Codex view_image tool and return its multimodal result to this same ChatGPT response."),
      inputSchema: {
        ...turnReferenceInput(contract),
        path: z.string().min(1).max(16_384),
        detail: z.enum(["high", "original"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_view_image",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { path, detail } = input;
        const bound = claimed.environment;
        const tool = exactTool(bound, "view_image");
        const payload = { arguments: { path, ...(detail ? { detail } : {}) } };
        return tool
          ? invoke(claimed.bindingId, bound, tool, payload, extra.signal)
          : invokeNestedNative(claimed.bindingId, bound, "view_image", false, payload, extra.signal);
      },
    ),
  );

  server.registerTool(
    "codex_tool_inventory",
    {
      title: "Discover tools from the current Codex harness",
      description: contract === "safe"
        ? "List tools available to the connected Zero Risk request, including configured MCP and app tools."
        : "Search the exact tool registry supplied to the current outer Codex turn, including configured MCP/app tools.",
      inputSchema: {
        ...turnReferenceInput(contract),
        query: z.string().max(500).optional(),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(50).default(20),
        include_schema: z.boolean().default(true),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input, extra) => withClaimedTurn(
      "codex_tool_inventory",
      turnReference(contract, input),
      extra,
      async claimed => {
        const { query, offset, limit, include_schema } = input;
        const bound = claimed.environment;
        const needle = query?.trim().toLowerCase();
        const visibleTools = safeVisibleTools(bound, contract);
        const directMatches = visibleTools.filter(tool => !needle || [
          wireName(tool),
          tool.name,
          tool.namespace ?? "",
          tool.description,
        ].join("\n").toLowerCase().includes(needle));
        const directPage = directMatches.slice(offset, offset + limit).map(tool => ({
          wire_name: wireName(tool),
          name: tool.name,
          namespace: tool.namespace ?? null,
          description: browserToolDescription(tool),
          kind: tool.freeform ? "freeform" : tool.toolSearch ? "tool_search" : "function",
          ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
        }));
        let nestedTotal = 0;
        let nestedPage: Array<Record<string, unknown>> = [];
        const gateway = execGateway(bound);
        if (gateway) {
          const excludedGatewayNames = bound.tools.map(wireName);
          const nestedOffset = Math.max(0, offset - directMatches.length);
          const nestedLimit = Math.max(0, limit - directPage.length);
          const response = await invoke(claimed.bindingId, bound, gateway, {
            input: gatewayToolCatalogProgram({
              query,
              offset: nestedOffset,
              limit: nestedLimit,
              // A gateway-discovered entry may supplement the outer registry, but it must never
              // duplicate or reopen an outer tool that this contract deliberately hid (including
              // our own MCP namespace in Zero Risk).
              excludedNames: excludedGatewayNames,
            }),
          }, extra.signal);
          const catalog = gatewayToolCatalogPage(response, new Set(excludedGatewayNames));
          nestedTotal = catalog.total;
          nestedPage = catalog.tools.map(tool => ({
            wire_name: tool.name,
            name: tool.name,
            namespace: null,
            description: gatewayToolDescription(tool),
            kind: "gateway",
            ...(include_schema ? {
              parameters: {
                type: "object",
                additionalProperties: true,
                description: "Pass the exact structured arguments declared in this tool's description. For a declared freeform tool, use codex_tool_call.input instead.",
              },
            } : {}),
          }));
        }
        const page = [...directPage, ...nestedPage];
        const total = directMatches.length + nestedTotal;
        // A filtered registry miss does not mean deferred tools are unavailable. Expose the
        // actual native discovery entry separately; it is not a query match or an automatic call.
        const discoveryTools = needle && total === 0
          ? visibleTools.filter(tool => tool.toolSearch).map(tool => ({
            wire_name: wireName(tool),
            name: tool.name,
            namespace: tool.namespace ?? null,
            description: browserToolDescription(tool),
            kind: "tool_search",
            ...(include_schema ? { parameters: browserToolParameters(tool) } : {}),
          }))
          : [];
        return result({
          tools: page,
          total,
          next_offset: offset + page.length < total ? offset + page.length : null,
          ...(discoveryTools.length > 0 ? { discovery_tools: discoveryTools } : {}),
        });
      },
    ),
  );

  server.registerTool(
    "codex_tool_call",
    {
      title: "Call any tool from the current Codex harness",
      description: afterSafeStart(contract, [
        "Invoke an exact wire_name returned by codex_tool_inventory. The outer Codex runtime performs the call, approvals, and UI lifecycle.",
        ...(contract === "native" ? [
          `A pending context-compaction request can also provide the reserved ${CODEX_COMPACTION_CONTROL_WIRE_NAME} operation, which is not listed by inventory.`,
          "Use only that request's issued control token and arguments {handoff_id, summary}. This operation submits the conversation summary to the pending Codex task; it does not execute commands, access files, or invoke other tools.",
        ] : []),
      ].join(" ")),
      inputSchema: {
        ...turnReferenceInput(contract),
        wire_name: z.string().min(1).max(1_000),
        arguments: jsonArgumentsSchema.optional(),
        input: z.string().max(5_000_000).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (toolInput, extra) => {
      const { wire_name, arguments: args, input } = toolInput;
      const requestId = turnReference(contract, toolInput);
      if (contract === "native" && wire_name === CODEX_COMPACTION_CONTROL_WIRE_NAME) {
        if (input !== undefined) {
          throw new Error("Compaction control handoff does not accept freeform input");
        }
        const handoffId = args?.handoff_id;
        const summary = args?.summary;
        if (typeof handoffId !== "string" || handoffId.length === 0) {
          throw new Error("Compaction control handoff requires handoff_id");
        }
        if (typeof summary !== "string") {
          throw new Error("Compaction control handoff requires summary");
        }
        await callTurnBroker(options.brokerSocketPath, {
          method: "submit_compaction_handoff",
          token: requestId,
          handoffId,
          summary,
        }, 5_000, extra.signal);
        return result({ submitted: true });
      }
      return withClaimedTurn("codex_tool_call", requestId, extra, async claimed => {
        const bound = claimed.environment;
        const tool = safeVisibleTools(bound, contract)
          .find(candidate => wireName(candidate) === wire_name);
        if (!tool) {
          const gateway = execGateway(bound);
          const hiddenOuterTool = bound.tools.some(candidate => wireName(candidate) === wire_name);
          if (!gateway || hiddenOuterTool || !gatewayToolNameIsValid(wire_name)) {
            throw new Error(`Codex tool is not available in this turn: ${wire_name}`);
          }
          if (input !== undefined && args && Object.keys(args).length > 0) {
            throw new Error(`Codex nested tool ${wire_name} accepts either arguments or freeform input, not both`);
          }
          if (isGatewayAgentWaitTool(wire_name) && input !== undefined) {
            throw new Error(`ChatGPT Web wait_agent requires structured arguments and timeout_ms=${CHATGPT_WEB_AGENT_WAIT_POLL_MS}`);
          }
          if (isGatewayAgentReactivationTool(wire_name) && input !== undefined) {
            throw new Error("ChatGPT Web agent lifecycle mutations require structured arguments for terminal-state tracking");
          }
          const invocationArguments = args ?? {};
          assertGatewayToolArguments(wire_name, invocationArguments);
          const waitObservation = captureAgentWaitObservation(claimed.bindingId, wire_name);
          const reactivatedTarget = invalidateTerminalObservationForReactivation(
            claimed.bindingId,
            wire_name,
            invocationArguments,
          );
          const closeTarget = consumeAgentCloseAuthorization(claimed.bindingId, wire_name, invocationArguments);
          let response;
          try {
            response = await invoke(claimed.bindingId, bound, gateway, {
              input: execGatewayProgram(wire_name, input !== undefined, {
                ...(input !== undefined ? { input } : { arguments: invocationArguments }),
              }, bound.tools.map(wireName)),
            }, extra.signal);
          } finally {
            finishAgentReactivation(claimed.bindingId, reactivatedTarget);
            finishAgentClose(claimed.bindingId, closeTarget);
          }
          recordAgentLifecycleResult(claimed.bindingId, wire_name, response, waitObservation);
          return response;
        }
        if (tool.freeform) {
          if (input === undefined) throw new Error(`Freeform Codex tool ${wire_name} requires input`);
          if (args && Object.keys(args).length > 0) throw new Error(`Freeform Codex tool ${wire_name} does not accept arguments`);
          const isRawExec = tool === execGateway(bound);
          if (isRawExec) beginRawExec(claimed.bindingId);
          try {
            return await invoke(claimed.bindingId, bound, tool, {
              input: isRawExec ? transportBoundRawExecProgram(input, wireName(tool)) : input,
            }, extra.signal);
          } finally {
            if (isRawExec) finishRawExec(claimed.bindingId);
          }
        }
        if (input !== undefined) throw new Error(`Function Codex tool ${wire_name} does not accept freeform input`);
        const invocationArguments = args ?? {};
        assertBrowserToolArguments(tool, invocationArguments);
        const waitObservation = captureAgentWaitObservation(claimed.bindingId, wire_name);
        const reactivatedTarget = invalidateTerminalObservationForReactivation(
          claimed.bindingId,
          wire_name,
          invocationArguments,
        );
        const closeTarget = consumeAgentCloseAuthorization(claimed.bindingId, wire_name, invocationArguments);
        let response;
        try {
          response = await invoke(claimed.bindingId, bound, tool, { arguments: invocationArguments }, extra.signal);
        } finally {
          finishAgentReactivation(claimed.bindingId, reactivatedTarget);
          finishAgentClose(claimed.bindingId, closeTarget);
        }
        recordAgentLifecycleResult(claimed.bindingId, wire_name, response, waitObservation);
        return response;
      });
    },
  );

  if (contract === "safe") {
    server.registerTool(
      "codex_turn_complete",
      {
        title: "Return the result to Codex",
        description: "Send the complete answer back to the connected Codex request after its work is finished. For compaction, send the requested compacted summary.",
        inputSchema: {
          request_id: turnTokenSchema,
          final_answer: z.string().min(1).max(5_000_000),
        },
        outputSchema: {
          completed: z.literal(true),
          duplicate: z.boolean(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ request_id, final_answer }, extra) => {
        console.error(`[chatgpt-web-mcp] codex_turn_complete scope=${requestScopeSummary(extra)}`);
        const response = await callTurnBroker<{ completed: true; duplicate: boolean }>(options.brokerSocketPath, {
          method: "safe_complete",
          token: request_id,
          finalAnswer: final_answer,
        }, null, extra.signal);
        return result(response);
      },
    );
  }

  await server.connect(observeMcpToolCalls(new StdioServerTransport(), BRIDGE_TOOL_NAMES));
}
