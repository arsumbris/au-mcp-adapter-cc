// The hook -> daemon bridge.
//
// Each CC hook is a short-lived process: it resolves the session + workspace
// from the hook payload, connects to the daemon, forwards one request, and
// exits. The daemon must be reachable; when it is not, capture/mediation degrade
// quietly (a missing daemon must never break the user's CC session).
//
// Ported from old au-cc `hooks/lib/trace.mjs` (the root/session resolution),
// rewired from a direct disk write to a daemon round-trip.

import {
  connectSocket,
  createDaemonClient,
  LAUNCH_ENV,
  parseProfile,
  parseSessionHandle,
  socketPath,
  traceEvent,
  type DaemonClient,
  type Decision,
  type PendingAction,
  type ReplayEvent,
} from '@arsumbris/au-mcp-sdk'
import { ccAdapterInfo } from './surface.ts'

// The per-launch launch env is namespaced `AU_MCP_*`, defined ONCE in `@arsumbris/au-mcp-sdk`
// (`LAUNCH_ENV` + the pure value parsers) so the launcher that WRITES it and this adapter that
// READS it cannot drift. The names carry no unprefixed alias (an unprefixed `AU_TRACE` collided
// with au-engine's presence-only perfetto toggle). Tool restriction (native + typed) is no longer a
// launch env — it resolves daemon-side from the active profile the `AU_MCP_PROFILE` locator names.

/**
 * The per-launch session HANDLE for this launch (`AU_MCP_SESSION`), or undefined when the launcher
 * set none. A stable value the LAUNCHER mints once and every process of the session inherits: the
 * hooks declare it on session-open (bound to the CC session id daemon-side), and the long-lived
 * mcp-server shim carries it on invoke (CC exposes no session id to an MCP server). ENV-ONLY, like
 * the other launch knobs. The mcp-server FAILS CLOSED without it; the hooks stay lenient (they key
 * on the CC session id and simply declare no handle), so the loud failure is a single, clear one.
 */
export function resolveSessionHandle(): string | undefined {
  return parseSessionHandle(process.env[LAUNCH_ENV.SESSION])
}

/**
 * The ACTIVE agent-profile for this session (`AU_MCP_PROFILE`), or undefined for a bare launch.
 * ENV-ONLY, a trimmed-non-empty locator (sibling to `resolveSessionHandle`).
 *
 * A LOCATOR, not config: the adapter forwards it opaquely as `AdapterInfo.profile`, and the DAEMON
 * resolves the profile instance from the graph at session-open to read its typed `hooks` / `hookConfig`
 * (decision 2609020302, E2). Hooks run in the daemon, so the daemon (not the launcher) resolves their
 * config — this env var only carries WHICH profile. Absent -> no profile: only hard-defaults + always-on
 * floors, no typed hook config. Adapters only adapt: no profile shape knowledge lives here.
 */
export function resolveProfile(): string | undefined {
  return parseProfile(process.env[LAUNCH_ENV.PROFILE])
}

/**
 * Whether this open is a RESUME, from CC's SessionStart `source === 'resume'` (a `--resume`/`--continue`
 * launch). ONLY the SessionStart payload carries `source`; every other hook returns false here, which
 * is correct — session-open is idempotent, so the first open (SessionStart's, before any tool hook or
 * the handle-bound mcp-server invoke) is the one that fixes the run + continuity-lost verdict.
 *
 * The daemon otherwise INFERS a resume from its own dormant record; this assertion matters only for the
 * data-LOST case (record retired/wiped), where nothing else can tell a resume from a fresh id-reuse.
 */
export function resolveResume(payload: { source?: unknown } | null): boolean {
  return payload?.source === 'resume'
}

export interface HookContext {
  workspace: string
  session: string
}

/**
 * Resolve the workspace ENTRY + session id from a CC hook payload. Under the schema-16
 * folder-repo model the entry is a DIRECTORY and entry == root == home, so the SAME folder
 * is correct for BOTH the daemon socket (`socketPath(workspace)`) AND in-repo state
 * (`<workspace>/operations/`, `<workspace>/.arsumbris/au-mcp/`) — no entry-vs-root split
 * needed (the message-260715160914 conflation is dissolved). Prefer AU_MCP_WORKSPACE (au-host
 * passes the exact entry folder; parity with bin/mcp-server.ts); else CLAUDE_PROJECT_DIR
 * (CC's normalized project dir, which now IS the correct entry); else the payload cwd.
 */
export function resolveContext(payload: { cwd?: string; session_id?: string } | null): HookContext {
  const workspace = process.env[LAUNCH_ENV.WORKSPACE] ?? process.env.CLAUDE_PROJECT_DIR ?? payload?.cwd ?? process.cwd()
  const session = payload?.session_id ?? 'unknown-session'
  return { workspace, session }
}

/**
 * The per-call AGENT attribution off a tool hook payload — CC puts `agent_id` + `agent_type`
 * on a SUBAGENT's PreToolUse/PostToolUse payload (the main agent's calls carry neither). We
 * FORWARD them onto the observed tool event (`ToolStartData` / `ToolCallData`) so a consumer
 * partitions the one session ledger by agent (main-agent events carry none). Harness-specific
 * payload naming, hence the adapter's business — surfaced as generic event fields downstream.
 * Returns an empty object for a main-agent call, so it spreads cleanly onto the event data.
 */
export function agentFields(payload: { agent_id?: unknown; agent_type?: unknown } | null): {
  agent_id?: string
  agent_type?: string
} {
  return {
    ...(typeof payload?.agent_id === 'string' ? { agent_id: payload.agent_id } : {}),
    ...(typeof payload?.agent_type === 'string' ? { agent_type: payload.agent_type } : {}),
  }
}

/** Read all of stdin, parse JSON, never throw. */
export async function readPayload(stream: AsyncIterable<string | Buffer>): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of stream) raw += chunk
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { unparseable: raw }
  }
}

/**
 * Open a daemon connection for the payload's workspace, ensure the session
 * exists (idempotent session-open declaring CC's surface), run `fn`, then close.
 * Returns `fallback` if the daemon is unreachable or anything throws — capture
 * must never break the hook.
 */
async function withSession<T>(
  payload: Record<string, unknown> | null,
  fn: (client: DaemonClient, session: string) => Promise<T>,
  fallback: T,
): Promise<T> {
  const { workspace, session } = resolveContext(payload)
  const transport = await connectSocket(socketPath(workspace)).catch(() => null)
  if (!transport) return fallback
  const client = createDaemonClient(transport)
  try {
    await client.sessionOpen(
      ccAdapterInfo(
        session,
        workspace,
        resolveSessionHandle(),
        resolveResume(payload),
        resolveProfile(),
      ),
    )
    return await fn(client, session)
  } catch {
    return fallback
  } finally {
    client.dispose()
    transport.close()
  }
}

/**
 * Record one event for this session (best-effort). Resolves with any mediator `review` text —
 * the POST-tool announcement channel — for the caller to surface as PostToolUse
 * `additionalContext`. Undefined when no mediator reviewed, or the daemon is unreachable.
 */
export async function observeEvent(
  payload: Record<string, unknown> | null,
  kind: string,
  data: unknown,
): Promise<string | undefined> {
  return withSession(payload, (client, session) => client.observe(session, traceEvent(kind, session, data)), undefined)
}

/**
 * Record several events over one connection (best-effort). Used by the lifter.
 *
 * Returns whether the daemon was REACHED (the batch flushed). The lifter advances its read-cursor
 * only on `true`: a down daemon returns `false`, so the same transcript tail is re-read next hook and
 * re-emitted — the kernel dedupes any that did get through. Empty batch -> `true` (nothing to flush).
 */
export async function observeEvents(
  payload: Record<string, unknown> | null,
  events: Array<{ kind: string; data: unknown; at?: string; dedupeKey?: string }>,
): Promise<boolean> {
  if (events.length === 0) return true
  return withSession(
    payload,
    async (client, session) => {
      // e.at = the lifted event's real (transcript) time, so the writer doesn't stamp lift-time.
      // e.dedupeKey (uuid / tool_use_id) makes the observe idempotent kernel-side: the transcript
      // re-scan re-emits every candidate each turn, and the kernel records each key at most once.
      for (const e of events) await client.observe(session, traceEvent(e.kind, session, e.data, e.at, e.dedupeKey))
      return true
    },
    false,
  )
}

/**
 * Replay a resumed session's OBSERVABLE conversation to the daemon (best-effort). The events come
 * from the adapter's transcript (see `extractObservable`); the kernel injects them read-only for
 * `consultTrace` and refuses any governance kind. A no-op for an empty slice or an unreachable daemon.
 * Resolves with the daemon's `{injected, refused}` tally, or undefined when it did not run.
 */
export async function sendRehydrate(
  payload: Record<string, unknown> | null,
  events: ReplayEvent[],
): Promise<{ injected: number; refused: number } | undefined> {
  if (events.length === 0) return undefined
  return withSession(payload, (client, session) => client.sessionRehydrate(session, events), undefined)
}

/**
 * Report that CC's turn ended (its Stop hook fired).
 *
 * A pure translation of a harness lifecycle event: the adapter states WHAT HAPPENED in its
 * harness and knows nothing about what the daemon does with it. Best-effort like every other
 * hook call, so a daemon that is down costs at most a stale index.
 */
export async function reportTurnEnd(payload: Record<string, unknown> | null): Promise<void> {
  await withSession(payload, (client, session) => client.turnEnd(session), undefined)
}

/** Ask the daemon to decide a pending action. Allows by default if unreachable. */
export async function mediateAction(
  payload: Record<string, unknown> | null,
  action: PendingAction,
): Promise<Decision> {
  return withSession(payload, (client, session) => client.mediate(session, action), { kind: 'allow' })
}

/** The session's governance posture (native-tool allowlist present -> `denyNative`). Ungoverned if unreachable. */
export async function sessionGuards(
  payload: Record<string, unknown> | null,
): Promise<{ denyNative: boolean }> {
  return withSession(payload, (client, session) => client.sessionGuards(session), { denyNative: false })
}

/**
 * The COMPUTED session-start inject blocks the daemon's `session-start` hooks produced at open (a
 * live-broker graph query, e.g. "N instances of type T"). Empty when unreachable (fail-open: a down
 * daemon injects nothing, never wedges the SessionStart hook). The daemon fired + stashed these at
 * the idempotent session-open above; this just fetches the stash. Owned + typed entirely daemon-side
 * — the adapter forwards the blocks verbatim, holding no knowledge of what any hook computed.
 */
export async function sessionStartContext(
  payload: Record<string, unknown> | null,
): Promise<{ inject: string[] }> {
  return withSession(payload, (client, session) => client.sessionStartContext(session), { inject: [] })
}

/**
 * The context to INJECT when this session RESTRICTS native tools — the "use the gate" note, so the
 * agent knows up front instead of only meeting a hard block. Null when native tools are unrestricted.
 *
 * States the POSTURE only, and names no tool. Which tools a session has varies per launch
 * (the allowlist), so an inventory here would promise tools the session may not have — the
 * same failure the static preamble had. The gate's own instructions already carry the
 * generated catalogue of exactly this session's tools, so this does not repeat it.
 */
export function buildNativeRestrictionNote(guards: { denyNative: boolean }): string | null {
  if (!guards.denyNative) return null
  return 'You are operating under the au harness with a restricted native-tool set. Native file/shell tools are not available in this session. Route every state-touching action through the au gate instead: its tools are listed in the gate\'s own instructions, and they are the only ones available to you here. Prefer the gate\'s engine reads when you want typed or structured answers.'
}

/**
 * The context to inject when the launch handle is MISSING — the fail-legible session-start warning
 * (sibling to the mcp-server's per-call refusal + degraded instructions). SUPERSEDES the native-restriction note:
 * a "use the gate" instruction is nonsense when the gate is non-functional. Launcher-agnostic; a
 * proper launcher (au-host) sets the env. Null when the handle is present. See the mandatory-session-
 * handle decision.
 */
export function buildHandleMissingNote(): string {
  return (
    'HIGHEST PRIORITY: this session is missing the required AU_MCP_SESSION handle, so the au gate ' +
    'CANNOT FUNCTION — no state-touching action can be governed, traced, or provenance-stamped, and ' +
    'every au tool will refuse. This is otherwise SILENT and can fail badly. Surface this to the user ' +
    'as your FIRST action, before anything else: this session was launched without AU_MCP_SESSION set ' +
    'and must be relaunched with it present (a proper launcher sets it automatically).'
  )
}

/** Close this session in the daemon (best-effort). */
export async function closeSession(payload: Record<string, unknown> | null): Promise<void> {
  const { workspace, session } = resolveContext(payload)
  const transport = await connectSocket(socketPath(workspace)).catch(() => null)
  if (!transport) return
  const client = createDaemonClient(transport)
  try {
    await client.sessionClose(session)
  } catch {
    // best-effort
  } finally {
    client.dispose()
    transport.close()
  }
}
