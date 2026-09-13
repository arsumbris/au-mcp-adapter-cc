// Claude Code's native tool surface — the one thing only the adapter can declare.
//
// The generic redirect plugin denies/redirects against THIS; it hardcodes none
// of it. Each native tool names the gate tool the agent should use instead (the
// CC-visible MCP name). Tools with no gate equivalent have nothing to fall back to
// when the native-tool allowlist excludes them.

import type { AdapterInfo, NativeTool } from '@arsumbris/au-mcp-sdk'

// O4 (dogfood 2606201618): CC namespaces a PLUGIN's MCP-server tools as
// `mcp__plugin_<plugin-dir>_<server>__<tool>`, NOT `mcp__au__<tool>`. We ship the
// `au` server inside the au-mcp-adapter-cc plugin (loaded via --plugin-dir), so the
// gate tools appear as `mcp__plugin_au-mcp-adapter-cc_au__<tool>` (observed live).
// The old `mcp__au__` assumption made the redirect mis-classify the gate tools.
// Brittle in the plugin-dir name; revisit if the package is renamed or the load mode
// changes (a project-level .mcp.json would instead expose plain `mcp__au__`).
const PLUGIN_DIR = 'au-mcp-adapter-cc'
const SERVER = 'au'

/** The prefix CC gives this plugin's MCP-server tools. */
export const GATE_PREFIX = `mcp__plugin_${PLUGIN_DIR}_${SERVER}__`

/** CC's native tools and where the agent goes instead when one is denied. */
export const CC_NATIVE_TOOLS: NativeTool[] = [
  { name: 'Bash', gateEquivalent: `${GATE_PREFIX}bash` },
  { name: 'Read', gateEquivalent: `${GATE_PREFIX}read_file_pinned` },
  { name: 'Write', gateEquivalent: `${GATE_PREFIX}write_file` },
  { name: 'Edit', gateEquivalent: `${GATE_PREFIX}edit_file` },
  { name: 'Glob', gateEquivalent: `${GATE_PREFIX}glob` },
  { name: 'Grep', gateEquivalent: `${GATE_PREFIX}grep_files` },
  { name: 'NotebookEdit' }, // no gate equivalent: unavailable unless the allowlist lists it
  { name: 'Task' }, // subagents unavailable unless the allowlist lists them
  { name: 'Skill' }, // skills unavailable unless the allowlist lists them
]

/**
 * Which of CC's NATIVE tools touch a file, and in which direction.
 *
 * Harness-specific naming, which is exactly what an adapter is for: `Edit` is a Claude Code
 * name and means nothing anywhere else. Stating it here lets the daemon reason about file
 * access WITHOUT a table of tool names, which is the boundary "adapters only adapt" draws.
 *
 * The gate's own tools are absent on purpose. A gate call reports its access from the
 * mutation result (a `touched`), which is exact, rather than from its name.
 */
export const CC_FILE_ACCESS: Record<string, 'read' | 'write'> = {
  Read: 'read',
  Edit: 'write',
  Write: 'write',
  NotebookEdit: 'write',
}

/** The AdapterInfo a CC session declares at session-open. TOOL restriction — native AND typed — does
 *  NOT ride here: both axes resolve DAEMON-SIDE from the active agent-profile (`nativeToolAllowlist`
 *  and `tools`), reached via the `profile` locator below. The adapter forwards the locator opaquely
 *  and carries no allowlist.
 *  (Trace is retired: capture is always-on substrate; whether an observer persists is its own
 *  concern, not a launch flag — see the launch-surface + session-retention specs.) */
export function ccAdapterInfo(
  session: string,
  workspace: string,
  handle?: string,
  resume?: boolean,
  profile?: string,
): AdapterInfo {
  return {
    harness: 'mcp.adapter.cc',
    // Adapter-owned opaque relaunch recipe. CC resumes directly by its native session id.
    // The host forwards this through --resume without interpreting it.
    resumeRef: session,
    session,
    workspace,
    nativeTools: CC_NATIVE_TOOLS,
    gatePrefix: GATE_PREFIX,
    // The active agent-profile locator (`AU_MCP_PROFILE`): forwarded opaquely so the daemon resolves
    // the profile instance from the graph at session-open (its typed `hooks` / `hookConfig`). Absent
    // = a bare launch (no profile). The adapter knows no profile shape — it only carries the locator.
    ...(profile ? { profile } : {}),
    // The per-launch session handle (`AU_MCP_SESSION`): the daemon binds it to `session` so the
    // long-lived mcp-server shim (which carries only the handle on invoke) resolves to this session.
    ...(handle ? { handle } : {}),
    // The RESUME assertion (CC's SessionStart `source === 'resume'`). It rides the FIRST open of the
    // session (SessionStart's, which precedes every tool hook and the handle-bound mcp-server invoke),
    // so the daemon can detect a data-LOST resume — a resume whose durable record was retired/wiped,
    // which nothing but this assertion can distinguish from a brand-new session reusing the id. Absent
    // on non-SessionStart hooks (they carry no source); harmless, as their opens are idempotent no-ops.
    ...(resume ? { resume } : {}),
  }
}
