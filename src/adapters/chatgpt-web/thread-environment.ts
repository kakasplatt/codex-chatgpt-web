import { existsSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";
import { atomicWriteFile, getConfigDir } from "../../config";
import { getCodexHome, getTrustedCodexHomes } from "../../codex-integration-shared";
import type { CodexParsedRequest } from "../../types";
import {
  dedupeResolvedPaths,
  extractChatGptTurnEnvironmentClaim,
  extractChatGptCompactionSourceRevision,
  extractChatGptContinuationEnvironmentClaim,
  extractChatGptSteeringEnvironmentClaim,
  extractChatGptTurnIdentity,
  extractChatGptThreadSpawnLineage,
  extractChatGptRootThreadMetadata,
  hasCurrentChatGptEnvironmentContext,
  extractChatGptCalendarEnvironmentDelta,
  extractChatGptNativeCompactionEnvironment,
  hasRawChatGptEnvironmentContext,
  unattributedChatGptEnvironmentMessages,
  isChatGptCompactionContinuation,
  MissingTrustedCodexEnvironmentError,
  type ChatGptCalendarEnvironmentDelta,
  type ChatGptEnvironmentClaim,
  type ChatGptSandboxPolicy,
  type ChatGptTurnEnvironment,
} from "./environment";
import { resolveCurrentCodexRolloutEnvironment, type CodexRolloutEnvironment } from "./codex-rollout-environment";
import { ChatGptWebAdapterError } from "./adapter-error";

interface StoredThreadEnvironment {
  cwd: string;
  roots: string[];
  writableRoots: string[];
  sandboxPolicy: ChatGptSandboxPolicy;
  updatedAt: number;
}

interface StoredThreadEnvironmentFile {
  version: 1;
  threads: Record<string, StoredThreadEnvironment>;
}

const MAX_THREAD_ENVIRONMENTS = 256;
const THREAD_ENVIRONMENT_TTL_MS = 30 * 24 * 60 * 60_000;
// Repeating an unchanged environment only renews updatedAt, which is measured in days. Skip the
// durable write for it so every request does not pay an fsync.
const THREAD_ENVIRONMENT_REFRESH_MS = 60_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

// Only Windows folds case. macOS stays case-sensitive on purpose: folding would merge distinct
// paths on case-sensitive APFS volumes, and realpath would change symlink semantics. A case
// mismatch therefore fails closed.
function pathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function contains(root: string, path: string): boolean {
  const rel = relative(pathIdentity(root), pathIdentity(path));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Replace each path with the first cached spelling of the same identity, keeping the order of paths. */
function preferSpelling(paths: string[], cached: readonly string[]): string[] {
  return paths.map(path => cached.find(spelling => pathIdentity(spelling) === pathIdentity(path)) ?? path);
}

/**
 * An extra workspace context root that a recovery claim (steering, compaction or a midnight delta)
 * may not introduce. Adopted roots become the thread's own environment, persisted in the cache;
 * children without an envelope inherit parent.roots and are checked against them. So a recovery
 * claim may not add a filesystem root, a Windows namespaced or device spelling, or a root that
 * equals or contains a trusted Codex home, the bridge data directory or the user home. Roots the
 * turn start already established from Codex's own envelope are kept by the caller. Shared homes
 * keep no cache and no cached parent, so the caller applies no refusal there.
 */
function isBroadContextRoot(path: string, nativeRoots: Set<string>, protectedRoots: readonly string[]): boolean {
  if (nativeRoots.has(pathIdentity(path))) return false;
  return (process.platform === "win32" && /^[\\/]{2}[?.][\\/]/.test(path))
    || pathIdentity(parse(path).root) === pathIdentity(path)
    || protectedRoots.some(protectedRoot => contains(path, protectedRoot));
}

function absolutePaths(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(path => typeof path !== "string" || !isAbsolute(path))) {
    throw new Error(`Invalid persisted ChatGPT thread ${field}`);
  }
  return dedupeResolvedPaths(value as string[]);
}

function sandboxPolicy(value: unknown, roots: string[], writableRoots: string[]): ChatGptSandboxPolicy {
  const parsed = record(value);
  if (parsed?.type === "dangerFullAccess") {
    const rootIdentities = new Set(roots.map(pathIdentity));
    if (writableRoots.length !== roots.length || writableRoots.some(path => !rootIdentities.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT danger-full-access roots");
    }
    return { type: "dangerFullAccess" };
  }
  if (parsed?.type === "workspaceWrite") {
    const policyRoots = absolutePaths(parsed.writableRoots, "workspace-write policy writable roots");
    const declared = new Set(policyRoots.map(pathIdentity));
    // Project membership is not the grant boundary: native Codex also authorizes
    // external output directories. Both persisted grant sets must agree exactly.
    if (typeof parsed.networkAccess !== "boolean" || policyRoots.length !== writableRoots.length
      || writableRoots.some(path => !declared.has(pathIdentity(path)))) {
      throw new Error("Invalid persisted ChatGPT workspace-write policy");
    }
    return { type: "workspaceWrite", writableRoots, networkAccess: parsed.networkAccess };
  }
  if (parsed?.type === "readOnly") {
    if (typeof parsed.networkAccess !== "boolean" || writableRoots.length !== 0) {
      throw new Error("Invalid persisted ChatGPT read-only policy");
    }
    return { type: "readOnly", networkAccess: parsed.networkAccess };
  }
  throw new Error("Invalid persisted ChatGPT sandbox policy");
}

function validateStoredEnvironment(value: unknown): StoredThreadEnvironment {
  const parsed = record(value);
  if (!parsed || typeof parsed.cwd !== "string" || !isAbsolute(parsed.cwd) || typeof parsed.updatedAt !== "number") {
    throw new Error("Invalid persisted ChatGPT thread environment");
  }
  const cwd = resolve(parsed.cwd);
  const roots = absolutePaths(parsed.roots, "roots");
  const writableRoots = Array.isArray(parsed.writableRoots) && parsed.writableRoots.length === 0
    ? []
    : absolutePaths(parsed.writableRoots, "writable roots");
  if (!roots.some(root => contains(root, cwd))) throw new Error("Persisted ChatGPT cwd is outside its roots");
  return {
    cwd,
    roots,
    writableRoots,
    sandboxPolicy: sandboxPolicy(parsed.sandboxPolicy, roots, writableRoots),
    updatedAt: parsed.updatedAt,
  };
}

function authority(environment: ChatGptTurnEnvironment, updatedAt: number): StoredThreadEnvironment {
  return {
    cwd: environment.cwd,
    roots: environment.roots,
    writableRoots: environment.writableRoots,
    sandboxPolicy: environment.sandboxPolicy,
    updatedAt,
  };
}

function conflictingAuthorityFields(claim: ChatGptEnvironmentClaim, right: ChatGptTurnEnvironment): string[] {
  const left = claim.environment;
  const claimedRoots = new Set(left.roots.map(pathIdentity));
  const nativeRoots = new Set(right.roots.map(pathIdentity));
  const nativeGrants = new Set([...right.roots, ...right.writableRoots].map(pathIdentity));
  const fields: string[] = [];
  if (pathIdentity(left.cwd) !== pathIdentity(right.cwd)) fields.push("cwd");
  // Codex 0.163 omits workspace_roots in some rollouts while its envelope still
  // lists output directories. Every extra claimed root must be an exact native
  // grant, and no native workspace may disappear. Return only native authority.
  if ([...nativeRoots].some(root => !claimedRoots.has(root))
    || [...claimedRoots].some(root => !nativeGrants.has(root))) fields.push("workspace_roots");
  // Filesystem envelopes omit Codex's extra output directories, including after
  // compaction. Only the current native rollout supplies the returned grants.
  if (!left.writableRoots.every(path => right.writableRoots.some(root => pathIdentity(root) === pathIdentity(path)))) {
    fields.push("writable_roots");
  }
  if (left.sandboxPolicy.type !== right.sandboxPolicy.type) fields.push("sandbox_policy");
  // An envelope that does not state its network policy cannot contradict the rollout on it.
  if (left.sandboxPolicy.type !== "dangerFullAccess" && right.sandboxPolicy.type !== "dangerFullAccess"
    && claim.statesNetworkAccess && left.sandboxPolicy.networkAccess !== right.sandboxPolicy.networkAccess) {
    fields.push("network_access");
  }
  return fields;
}

/**
 * Codex emits its trusted environment envelope when a task starts or its environment changes,
 * not on every follow-up. This store carries only that trusted authority across turns. Tool
 * declarations are always taken from the current request and are never persisted.
 */
export class ChatGptThreadEnvironmentStore {
  private loaded = false;
  private readonly threads = new Map<string, StoredThreadEnvironment>();
  private lastPersistedAt = Number.NEGATIVE_INFINITY;
  private readonly codexHomes: readonly string[];
  private readonly protectedRoots: readonly string[];

  constructor(
    private readonly path?: string,
    private readonly now: () => number = Date.now,
    codexHome: string = getCodexHome(),
    private readonly sqliteHome?: string,
    additionalCodexHomes?: readonly string[],
    // Guarded against becoming a broad context root; injectable for tests.
    userHome: string = homedir(),
  ) {
    this.codexHomes = getTrustedCodexHomes(codexHome, additionalCodexHomes);
    this.protectedRoots = [...this.codexHomes, getConfigDir(), userHome];
  }

  resolve(parsed: CodexParsedRequest): ChatGptTurnEnvironment {
    const identity = extractChatGptTurnIdentity(parsed);
    let initialClaim: ChatGptEnvironmentClaim | undefined;
    try {
      const claim = extractChatGptTurnEnvironmentClaim(parsed);
      const environment = claim.environment;
      if (this.codexHomes.length > 1
        || (environment.sandboxPolicy.type !== "dangerFullAccess" && !claim.statesNetworkAccess)) {
        // A shared bridge must prove the current native owner even for complete envelopes.
        // Modern envelopes state filesystem access only. Resolve the current native policy on
        // the first round too: absence of a network statement is not a disabled-network grant.
        initialClaim = claim;
        throw new MissingTrustedCodexEnvironmentError(
          this.codexHomes.length > 1 ? "current native task ownership" : "network access",
        );
      }
      if (identity.threadId) this.set(identity.threadId, environment);
      return environment;
    } catch (error) {
      if (!(error instanceof MissingTrustedCodexEnvironmentError) || !identity.threadId) throw error;
      const hasCurrentContext = hasCurrentChatGptEnvironmentContext(parsed);
      const lineage = extractChatGptThreadSpawnLineage(parsed);
      const currentCompaction = hasCurrentContext && isChatGptCompactionContinuation(parsed);
      // Root tasks also retain unattributed environment fragments after compaction.
      // They are historical only when the exact native record predates this task;
      // neither the fragment nor the cache supplies the current authority.
      const historicalMessages = hasCurrentContext && !currentCompaction
        ? unattributedChatGptEnvironmentMessages(parsed) : undefined;
      const steeringClaim = hasCurrentContext && !currentCompaction
        ? extractChatGptSteeringEnvironmentClaim(parsed) : undefined;
      const calendarDelta = hasCurrentContext && !currentCompaction
        ? extractChatGptCalendarEnvironmentDelta(parsed) : undefined;
      const nativeCompaction = hasCurrentContext && !currentCompaction && !initialClaim && !steeringClaim && !calendarDelta
        ? extractChatGptNativeCompactionEnvironment(parsed) : undefined;
      if (hasCurrentContext && !currentCompaction && !initialClaim && !historicalMessages && !steeringClaim && !calendarDelta && !nativeCompaction) {
        console.warn("[chatgpt-web] trusted_environment_recovery rejected=unrecognized_current_context");
        throw error;
      }
      const currentClaim = initialClaim ?? (currentCompaction
        ? extractChatGptContinuationEnvironmentClaim(parsed) : steeringClaim ?? nativeCompaction?.claim);
      const resolvedCalendarDelta = calendarDelta ?? currentClaim?.calendarDelta;
      const rolloutIdentity = lineage ?? extractChatGptRootThreadMetadata(parsed);
      // Automatic compaction has a current turn_context; standalone compaction has only its
      // source turn_context. Either must be the latest native record, never an arbitrary ancestor.
      const compactionSourceTurnId = parsed._compactionRequest
        ? extractChatGptCompactionSourceRevision(parsed).turnId : undefined;
      if (rolloutIdentity && identity.turnId) {
        const rollout = resolveCurrentCodexRolloutEnvironment({
          codexHome: this.codexHomes[0]!,
          additionalCodexHomes: this.codexHomes.slice(1),
          ...(this.sqliteHome ? { sqliteHome: this.sqliteHome } : {}),
          lineage: rolloutIdentity,
          turnId: identity.turnId,
          ...(compactionSourceTurnId ? { compactionSourceTurnId } : {}),
          ...(historicalMessages ? { historicalEnvironmentMessages: historicalMessages } : {}),
          ...(nativeCompaction ? { compactedEnvironmentItems: nativeCompaction.items } : {}),
          tools: parsed.context.tools,
        });
        if (rollout) {
          let rolloutEnvironment = rollout.environment;
          // Roots this thread already established at turn start stay valid context (D1). Read the
          // cache only when a broad root needs it, so an ordinary turn can still repair a corrupt
          // cache file through set(). Shared homes keep no cache, so nothing is refused there.
          let established: Set<string> | undefined;
          const isEstablished = (path: string) => (
            established ??= new Set((this.get(rolloutIdentity.threadId)?.roots ?? []).map(pathIdentity))
          ).has(pathIdentity(path));
          const refusesContext = (roots: string[], nativeRoots: Set<string>) => this.codexHomes.length === 1
            && roots.some(path => isBroadContextRoot(path, nativeRoots, this.protectedRoots) && !isEstablished(path));
          // After a restart Codex can omit workspace_roots while still explicitly
          // granting unrestricted access. In that case [cwd] is not a native
          // restriction. Keep the current envelope's workspace context; permissions
          // and task identity still come from the exact current native record.
          if (!rollout.workspaceRootsDeclared
            && rolloutEnvironment.sandboxPolicy.type === "dangerFullAccess"
            && currentClaim?.environment.sandboxPolicy.type === "dangerFullAccess"
            && pathIdentity(currentClaim.environment.cwd) === pathIdentity(rolloutEnvironment.cwd)
            && !refusesContext(currentClaim.environment.roots, new Set(rolloutEnvironment.roots.map(pathIdentity)))) {
            rolloutEnvironment = {
              ...rolloutEnvironment,
              roots: [...currentClaim.environment.roots],
              writableRoots: [...currentClaim.environment.roots],
            };
          }
          if (resolvedCalendarDelta) {
            const contextRoots = this.calendarContextRoots(
              resolvedCalendarDelta,
              { ...rollout, environment: rolloutEnvironment },
              rolloutIdentity.threadId,
              refusesContext,
            );
            if (contextRoots) {
              rolloutEnvironment = { ...rolloutEnvironment, roots: [...contextRoots], writableRoots: [...contextRoots] };
            }
            // The broker compares the pinned turn-start environment exactly. Keep the spelling the
            // turn start cached for every path whose identity is unchanged.
            const established = this.peek(rolloutIdentity.threadId);
            if (established) {
              const spellings = [established.cwd, ...established.roots, ...established.writableRoots];
              rolloutEnvironment = {
                ...rolloutEnvironment,
                cwd: preferSpelling([rolloutEnvironment.cwd], spellings)[0]!,
                roots: preferSpelling(rolloutEnvironment.roots, spellings),
                writableRoots: preferSpelling(rolloutEnvironment.writableRoots, spellings),
              };
            }
          }
          const conflicts = currentClaim ? conflictingAuthorityFields(currentClaim, rolloutEnvironment) : [];
          if (conflicts.length > 0) {
            const source = currentCompaction || nativeCompaction ? "Compaction continuation" : initialClaim ? "Current" : "Steering";
            // Field names are safe to export; paths, request text and permission
            // contents are deliberately excluded from both the log and UI error.
            console.warn(`[chatgpt-web] trusted environment conflict (source=${source}, fields=${conflicts.join(",")})`);
            throw new Error(`${source} environment conflicts with its current Codex rollout (fields: ${conflicts.join(", ")})`);
          }
          this.set(rolloutIdentity.threadId, rolloutEnvironment);
          return rolloutEnvironment;
        }
      }
      console.warn(`[chatgpt-web] trusted_environment_recovery ${JSON.stringify({
        currentContext: hasCurrentContext,
        compactionContinuation: currentCompaction,
        nativeMetadata: rolloutIdentity !== undefined,
        nativeTurnId: identity.turnId !== undefined,
        registeredHomes: this.codexHomes.length,
        nativeRolloutFound: false,
      })}`);
      if (this.codexHomes.length > 1) {
        throw new Error("No current native Codex task proof in the trusted homes", { cause: error });
      }
      // Only a current native rollout can supersede an unrecognized historical envelope. Without
      // that proof, do not turn arbitrary history or an invalid update into cached authority.
      if (hasRawChatGptEnvironmentContext(parsed)) throw error;
      const sameThread = this.get(identity.threadId);
      if (sameThread) return {
        cwd: sameThread.cwd,
        roots: sameThread.roots,
        writableRoots: sameThread.writableRoots,
        sandboxPolicy: sameThread.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };

      if (!lineage) throw error;
      const parent = this.get(lineage.parentThreadId);
      if (!parent) throw error;
      if (lineage.sandboxType !== parent.sandboxPolicy.type) {
        throw new Error("ChatGPT Web subagent sandbox metadata conflicts with its trusted parent thread");
      }
      if (lineage.workspaceRoots.length > 0 && !lineage.workspaceRoots.some(root => contains(root, parent.cwd))) {
        throw new Error("ChatGPT Web subagent workspace metadata does not contain its trusted parent cwd");
      }
      if (lineage.workspaceRoots.some(root => !parent.roots.some(parentRoot => (
        contains(parentRoot, root) || contains(root, parentRoot)
      )))) {
        throw new Error("ChatGPT Web subagent workspace metadata conflicts with its trusted parent roots");
      }
      const inherited: ChatGptTurnEnvironment = {
        cwd: parent.cwd,
        roots: parent.roots,
        writableRoots: parent.writableRoots,
        sandboxPolicy: parent.sandboxPolicy,
        tools: parsed.context.tools ?? [],
      };
      this.set(lineage.threadId, inherited);
      return inherited;
    }
  }

  /**
   * The workspace context a midnight delta leaves in place, or undefined to keep the rollout's own
   * roots. Throws when the delta contradicts its current native rollout.
   */
  private calendarContextRoots(
    delta: ChatGptCalendarEnvironmentDelta,
    rollout: CodexRolloutEnvironment,
    threadId: string,
    refusesContext: (roots: string[], nativeRoots: Set<string>) => boolean,
  ): string[] | undefined {
    const environment = rollout.environment;
    const nativeRoots = new Set(environment.roots.map(pathIdentity));
    const deltaRoots = delta.workspaceRoots.map(roots => new Set(roots.map(pathIdentity)));
    const sameRoots = (left: Set<string>, right: Set<string>) => left.size === right.size
      && [...left].every(root => right.has(root));
    if (delta.filesystemProfiles.some(profile => profile !== rollout.filesystemProfileXml)) {
      throw new Error("Calendar environment delta conflicts with its current Codex rollout");
    }
    // As in resolve(), an omitted unrestricted rollout root list is not a native restriction.
    // Permissions and cwd still come from the native record.
    const unrestricted = !rollout.workspaceRootsDeclared && environment.sandboxPolicy.type === "dangerFullAccess";
    if (unrestricted && deltaRoots.length === 0) {
      // The delta repeats no roots, so the roots this thread established at turn start stay its
      // context (the broker pins the start envelope for the whole tool loop), provided they keep
      // the native cwd and every native root.
      const established = this.peek(threadId);
      if (established?.sandboxPolicy.type === "dangerFullAccess"
        && pathIdentity(established.cwd) === pathIdentity(environment.cwd)
        && [...nativeRoots].every(root => established.roots.some(path => pathIdentity(path) === root))) {
        return established.roots;
      }
      return undefined;
    }
    // The current turn's repeated roots stay its workspace context only when they agree with each
    // other and keep every native root exactly.
    const latest = delta.workspaceRoots.at(-1);
    if (unrestricted && latest
      && deltaRoots.every(roots => sameRoots(roots, deltaRoots[0]!))
      && [...nativeRoots].every(root => deltaRoots[0]!.has(root))
      && !refusesContext(latest, nativeRoots)) {
      return latest;
    }
    if (deltaRoots.some(roots => !sameRoots(roots, nativeRoots))) {
      throw new Error("Calendar environment delta conflicts with its current Codex rollout");
    }
    return undefined;
  }

  /**
   * Read a cached entry without evicting or persisting. Call only after current native proof:
   * like set(), it rebuilds a damaged-JSON cache file instead of failing.
   */
  private peek(threadId: string): StoredThreadEnvironment | undefined {
    if (this.codexHomes.length > 1) return undefined;
    this.load(true);
    const stored = this.threads.get(threadId);
    return stored && this.now() - stored.updatedAt <= THREAD_ENVIRONMENT_TTL_MS ? stored : undefined;
  }

  private get(threadId: string): StoredThreadEnvironment | undefined {
    this.load();
    const stored = this.threads.get(threadId);
    if (!stored) return undefined;
    if (this.now() - stored.updatedAt > THREAD_ENVIRONMENT_TTL_MS) {
      this.threads.delete(threadId);
      this.persist();
      return undefined;
    }
    return stored;
  }

  private set(threadId: string, environment: ChatGptTurnEnvironment): void {
    // Shared-home recovery uses current native proof, never the single-home cache.
    if (this.codexHomes.length > 1) return;
    // Only this path has already verified authority from the current request, native
    // rollout, or a successfully loaded parent. A cache read alone may never recover it.
    this.load(true);
    const now = this.now();
    const previous = this.threads.get(threadId);
    const next = authority(environment, now);
    const unchanged = previous !== undefined
      && JSON.stringify({ ...previous, updatedAt: 0 }) === JSON.stringify({ ...next, updatedAt: 0 });
    this.threads.delete(threadId);
    this.threads.set(threadId, next);
    let evicted = false;
    while (this.threads.size > MAX_THREAD_ENVIRONMENTS) {
      const oldest = this.threads.keys().next().value as string | undefined;
      if (!oldest) break;
      this.threads.delete(oldest);
      evicted = true;
    }
    if (unchanged && !evicted && now - this.lastPersistedAt < THREAD_ENVIRONMENT_REFRESH_MS) return;
    this.persist(now);
  }

  private load(verifiedEnvironment = false): void {
    if (this.loaded) return;
    if (!this.path || !existsSync(this.path)) {
      this.loaded = true;
      return;
    }
    // Only a damaged-JSON file is rebuilt from a fresh task's verified environment. An unfamiliar
    // format or invalid records are never discarded, so a fresh task fails the same way.
    const invalidState = (reason: string, freshTaskRepairs = false) => new ChatGptWebAdapterError(
      `The saved Codex task environment file (thread-environments.json) ${reason}. `
      + "Its contents have not been overwritten. "
      + (freshTaskRepairs
        ? "Start a fresh Codex task to supply its current workspace and permissions. "
          + "If that also fails, export Activity > Export safe log; do not delete your launcher settings."
        : "A fresh Codex task will not repair it. Move thread-environments.json aside so it can be rebuilt "
          + "(tasks started before then must be restarted), or export Activity > Export safe log and ask for help. "
          + "Do not delete your launcher settings."),
      { status: 409, errorType: "invalid_request_error", code: "thread_environment_state_invalid", retryable: false },
    );
    const source = readFileSync(this.path, "utf8");
    let decoded: unknown;
    try {
      decoded = JSON.parse(source);
    } catch {
      if (!verifiedEnvironment) throw invalidState("contains invalid JSON", true);
      // Preserve the original for diagnosis. Never infer permissions from a damaged cache,
      // discard an unfamiliar schema, or turn a read/rename permission error into recovery.
      if (readFileSync(this.path, "utf8") !== source) throw invalidState("changed during recovery", true);
      const backup = `${this.path}.corrupt-${crypto.randomUUID()}`;
      renameSync(this.path, backup);
      console.warn("[chatgpt-web] preserved corrupt thread-environments.json beside the original; rebuilding from a verified current Codex environment");
      this.loaded = true;
      return;
    }
    const parsed = record(decoded);
    const rawThreads = record(parsed?.threads);
    if (parsed?.version !== 1 || !rawThreads) throw invalidState("has an unsupported or invalid format");
    let entries: Array<readonly [string, StoredThreadEnvironment]>;
    try {
      const cutoff = this.now() - THREAD_ENVIRONMENT_TTL_MS;
      entries = Object.entries(rawThreads)
        .map(([threadId, value]) => [threadId, validateStoredEnvironment(value)] as const)
        .filter(([, environment]) => environment.updatedAt >= cutoff)
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt)
        .slice(-MAX_THREAD_ENVIRONMENTS);
    } catch {
      throw invalidState("contains invalid workspace or permission records");
    }
    for (const [threadId, environment] of entries) this.threads.set(threadId, environment);
    this.loaded = true;
  }

  private persist(now: number = this.now()): void {
    if (!this.path) return;
    const payload: StoredThreadEnvironmentFile = {
      version: 1,
      threads: Object.fromEntries(this.threads),
    };
    atomicWriteFile(this.path, `${JSON.stringify(payload, null, 2)}\n`, { durable: true });
    this.lastPersistedAt = now;
  }
}
