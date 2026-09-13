// The MCP-server shim — CC's callable surface.
//
// A stdio MCP server CC connects to. On startup it asks the daemon which
// callables are active (workspace-scoped list-capabilities) and advertises each
// as an MCP tool (name = id minus `mcp.`, description + JSON Schema inputSchema
// from the advertisement table). A tool call just forwards `invoke` to the daemon
// and returns its result — the daemon validates the input against mcp.tool.<tool>
// at the gate (daemon-side, in `invoke`), so the shim holds no validation logic.
//
// Uses the SDK's LOW-LEVEL Server (not McpServer) so we advertise JSON Schema
// directly — no zod (the engine is the validator; codegen gives the shape).

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connectSocket, createDaemonClient, DaemonConnectionError, socketPath, type DaemonClient } from '@arsumbris/au-mcp-sdk'
import { buildTools, guidanceNotes, provenanceNote, toolCatalogue } from './advertise.ts'
import { resolveProfile, resolveSessionHandle } from './bridge.ts'

const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })
const ok = (result: unknown, isError?: boolean) => ({
  content: [{ type: 'text' as const, text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
  isError,
})

// Re-dial backoff after the daemon drops (a restart). The daemon + bridge respawn fresh,
// so a short staggered retry usually catches the new one; if not, we surface a clear error
// rather than hang (au-engine message 2607051600). A WEDGED daemon (alive but silent) is
// NOT retried — re-dialing reaches the same stuck process — it fails fast on the timeout.
const RECONNECT_BACKOFF_MS = [100, 300, 900]
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// Plugin-level overview. MCP `instructions` load at session START even under CC's
// tool-search deferral (the per-tool schemas are otherwise hidden until ToolSearch).
// So this is where the agent first learns what the gate IS + when to reach for it
// (dogfood findings P5e-O5 first-contact-is-name-only + O6 no-overview). The `au`
// server is also `alwaysLoad: true` in .mcp.json, so the tools themselves load upfront.
//
// This is the STANDING framing only: what the gate is and how to approach it. It names
// no tool, because a session's tool set varies per launch (the allowlist). The per-tool
// catalogue is GENERATED from what this session actually advertises, so the instructions
// and the tool list can never disagree. See the tool-visibility spec.
const FRAMING = `The "au" gate mediates this workspace's typed knowledge base (the arsumbris engine).
State-touching actions (writes, edits, deletes) route through the gate, so every one is governed and traced.
For plain file CONTENT, use your native read/search tools — that is the default. Reach for the gate's reads when you want TYPED or STRUCTURED answers about the knowledge base (types, instances, provenance, diagnostics), not to read a file's text. Paths are absolute.
Your tools in this session are exactly the ones listed below. The set is scoped per launch, so a tool you have used in another session may simply not be here.`

/** Open a fresh daemon client, or null if the socket is unreachable right now. */
async function dialDaemon(workspace: string): Promise<DaemonClient | null> {
  const transport = await connectSocket(socketPath(workspace)).catch(() => null)
  return transport ? createDaemonClient(transport) : null
}

/** Re-dial with staggered backoff; null if every attempt fails (the daemon is still down). */
async function reconnectDaemon(workspace: string): Promise<DaemonClient | null> {
  for (const delay of RECONNECT_BACKOFF_MS) {
    await sleep(delay)
    const client = await dialDaemon(workspace)
    if (client) return client
  }
  return null
}

/** An empty capabilities set — the DEGRADED result (no tools advertised, calls self-heal on reconnect). */
const NO_CAPS = { callables: [], redirects: [] } as Awaited<ReturnType<DaemonClient['listCapabilities']>>

/**
 * Fetch the daemon's capabilities at STARTUP, GUARDED so it can NEVER crash the shim.
 *
 * The failure this fixes: a daemon SOCKET can exist before the daemon is READY (mid-discovery /
 * dialing the engine) or drop mid-request, so `listCapabilities` can THROW even though `dialDaemon`
 * already succeeded. That throw would propagate out of the top-level `await runMcpServer(...)` and
 * EXIT the process — which Claude Code reports as `CONNECTION_CLOSED` (the "failed server" the human
 * sees via `/mcp`), the exact fail mode this shim is built to avoid.
 *
 * So: try once; on ANY error re-dial with backoff and try ONCE more (catches the common "daemon still
 * starting" race → a full tool list); if it still fails, DEGRADE — return no client + empty caps. The
 * server then STILL starts (empty tool list) and self-heals on the next tool call (the CallTool handler
 * re-dials when `client` is null). Never throws. `reconnect` is injectable for tests.
 */
export async function resolveStartupCapabilities(
  client: DaemonClient | null,
  workspace: string,
  profile: string | undefined,
  reconnect: (ws: string) => Promise<DaemonClient | null> = reconnectDaemon,
): Promise<{ client: DaemonClient | null; caps: Awaited<ReturnType<DaemonClient['listCapabilities']>> }> {
  if (!client) return { client: null, caps: NO_CAPS } // never connected -> degraded (CallTool re-dials)
  try {
    return { client, caps: await client.listCapabilities(undefined, profile) }
  } catch (e) {
    process.stderr.write(`au-mcp shim: listCapabilities failed at startup (${msg(e)}); retrying once\n`)
    client.dispose()
    const retry = await reconnect(workspace)
    if (!retry) return { client: null, caps: NO_CAPS }
    try {
      return { client: retry, caps: await retry.listCapabilities(undefined, profile) }
    } catch (e2) {
      process.stderr.write(`au-mcp shim: listCapabilities still failing (${msg(e2)}); starting DEGRADED\n`)
      retry.dispose()
      return { client: null, caps: NO_CAPS }
    }
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

// The fail-LEGIBLE message when the launch handle is missing (see the mandatory-session-handle
// decision). A missing `AU_MCP_SESSION` means the invoke path carries no session, so nothing can be
// governed / traced / provenance-stamped. Rather than exit (which CC buries as a "failed" server the
// human only sees via `/mcp`), the gate STAYS UP but every tool call REFUSES with this — an agent
// that reaches for the gate is forced to surface the problem at the point of use. Launcher-agnostic:
// a proper launcher (au-host) sets the env; we do not prescribe a wrapper here.
const HANDLE_MISSING_TOOL_ERROR =
  'This session is missing the required AU_MCP_SESSION handle, so the au gate is NON-FUNCTIONAL: ' +
  'no state-touching action can be governed, traced, or provenance-stamped, and this tool will not run. ' +
  'This CANNOT be fixed from inside the session. As your FIRST action, tell the user: this session was ' +
  'launched without AU_MCP_SESSION set and must be relaunched with it present (a proper launcher sets it ' +
  'automatically). Do not retry the gate tools.'

// Prepended to the plugin instructions when degraded, so the warning also loads as standing context
// at session start (belt to the per-call refusal, and to the SessionStart hook note).
const HANDLE_MISSING_FRAMING =
  'HIGHEST PRIORITY — the au gate is installed but this session is missing the required AU_MCP_SESSION ' +
  'handle, so it CANNOT FUNCTION: every au tool below will refuse. Surface this to the user immediately, ' +
  'before anything else — the session must be relaunched with AU_MCP_SESSION set (a proper launcher does ' +
  'this automatically). This is otherwise silent and easy to miss.\n\n'

/** Run the MCP server for `workspace`, advertising the daemon's callables over stdio. */
export async function runMcpServer(workspace: string): Promise<void> {
  // The launch handle, or undefined -> DEGRADED: the gate stays up (tools still listed, so an agent
  // sees the real gate) but every call refuses legibly. Missing it is a launcher misconfiguration.
  const handle = resolveSessionHandle()
  const degraded = handle === undefined
  // `client` is mutable: a daemon restart drops the socket, and we re-dial a fresh one on the
  // next tool call so the session self-heals instead of hanging on the dead connection.
  // Tool visibility is PROFILE-derived (plan 2609072337): the advertise runs at startup, BEFORE
  // session-open, so it cannot gate from session state. The shim forwards the opaque `AU_MCP_PROFILE`
  // locator and the daemon resolves the allowlist from the profile graph. Adapters only adapt: no
  // tool names, no profile shape here. (Invoke gates from the daemon session, open by call time.)
  const profile = resolveProfile()
  // GUARDED: a daemon that is up-but-not-ready can make this throw; degrading (not crashing) here is
  // what keeps CC from reporting the shim as CONNECTION_CLOSED. `client` may come back null (degraded).
  let { client, caps } = await resolveStartupCapabilities(await dialDaemon(workspace), workspace, profile)
  const tools = buildTools(caps.callables)
  const advertised = new Set(tools.map((t) => t.name))

  const server = new Server(
    { name: 'au', version: '0.0.0' },
    {
      capabilities: { tools: {} },
      instructions:
        (degraded ? HANDLE_MISSING_FRAMING : '') +
        FRAMING +
        toolCatalogue(tools) +
        guidanceNotes(caps.callables) +
        provenanceNote(caps.callables),
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const args = (request.params.arguments ?? {}) as Record<string, unknown>

    // DEGRADED (no launch handle): the gate is up + tools are listed, but nothing runs — refuse
    // every call legibly, so an agent reaching for the gate surfaces the misconfiguration at the
    // point of use (the strongest signal in the medium; the passive instructions + hook note back it).
    if (degraded) return fail(HANDLE_MISSING_TOOL_ERROR)

    // Never forward a name this server did not advertise, so hiding a tool also makes it
    // uncallable. The daemon refuses independently; this keeps the shim consistent with
    // its own advertisement rather than relying on that.
    if (!advertised.has(name)) return fail(`tool not available in this session: ${name}`)

    // The daemon was down at launch — try once to bring the connection up now.
    if (!client) {
      client = await reconnectDaemon(workspace)
      if (!client) return fail('au-mcp daemon not reachable for this workspace — is it running?')
    }

    try {
      const { result, isError } = await client.invoke(handle, `mcp.${name}`, args)
      return ok(result, isError)
    } catch (e) {
      // A tool/engine error rides back as a normal response (isError), not a throw. A THROW
      // here is a transport failure — the three states au-engine asked us to distinguish
      // (message 2607051600), never a silent forever-hang.
      if (!(e instanceof DaemonConnectionError)) throw e
      // WEDGED: the connection is open but the daemon never replied. Re-dialing reaches the
      // same stuck process, so fail fast rather than retry.
      if (e.code === 'timeout') return fail('au-mcp daemon is not responding (wedged) — restart the daemon')
      // DROPPED (daemon restarted): the old socket is dead. Re-dial with backoff and retry ONCE
      // against the fresh daemon; the original never ran (its daemon died), so the retry is safe.
      client.dispose()
      client = await reconnectDaemon(workspace)
      if (!client) return fail('au-mcp daemon connection dropped and could not reconnect — restart the daemon')
      try {
        const { result, isError } = await client.invoke(handle, `mcp.${name}`, args)
        return ok(result, isError)
      } catch {
        return fail('au-mcp daemon still unreachable after reconnect — restart the daemon or this session')
      }
    }
  })

  await server.connect(new StdioServerTransport())
}
