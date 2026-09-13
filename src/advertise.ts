// Tool advertisement for the MCP-server shim.
//
// The shim advertises the daemon's callables to CC. Each MCP tool needs a name, a
// description, and an `inputSchema` (JSON Schema). "Adapters only adapt": BOTH the
// description AND the input schema are owned at the tool's def (the `tool-presentation-meta`
// meta / the subtype fields) and ride the manifest from au-mcp — the adapter forwards
// `manifest.description` + `manifest.inputSchema`, holding no table of its own.
//
// The daemon GENERATES each schema at discovery (via au-type-codegen over the def fields)
// and sets it on the manifest, so LOADABLE tools advertise their real inputs too — not an
// empty schema. This retired the au-mcp-only static artifact + gen-tool-schemas build-step
// (decision 2606251602 / plan 2606102230 action 5).

import type { PluginManifest, ToolManifest } from '@arsumbris/au-mcp-sdk'

export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Permissive fallback for a callable whose manifest carries no schema (open object). */
const EMPTY_SCHEMA: Record<string, unknown> = { type: 'object', properties: {}, additionalProperties: false }

/** The agent-facing tool name for a plugin id (`mcp.read_file_pinned` -> `read_file_pinned`). */
export const toolName = (id: string): string => id.replace(/^mcp\./, '')

/**
 * A line for the session instructions telling the agent which tools are CORE (engine-bundled)
 * vs CONTRIBUTED by a mounted capability package. GENERATED from the manifests' `provenance`
 * (the daemon sets it: 'core' vs the owner repo), so it stays correct as packages mount — NOT a
 * hand-maintained list. Empty-of-contributed → says everything is core.
 */
export function provenanceNote(callables: PluginManifest[]): string {
  const contributed = new Map<string, string[]>() // repo -> agent-facing tool names
  for (const m of callables) {
    if (!m.provenance || m.provenance === 'core') continue
    contributed.set(m.provenance, [...(contributed.get(m.provenance) ?? []), toolName(m.id)])
  }
  if (contributed.size === 0) {
    return '\nTool provenance: every tool here is CORE, built into the gate by the arsumbris engine. No capability packages contribute tools in this workspace.'
  }
  const groups = [...contributed].map(([repo, names]) => `${names.sort().join(', ')} (from ${repo})`).join('; ')
  return `\nTool provenance: tools not named here are CORE, built into the gate by the arsumbris engine. CONTRIBUTED by mounted capability packages: ${groups}. A contributed tool comes from an installed package (not the engine itself) and is advertised because that package is mounted in this workspace.`
}

/**
 * The per-tool catalogue for the session instructions, GENERATED from what this session
 * actually advertises. Each line is `name: description`, and the description is the one
 * owned by the tool's def and carried on the manifest — never restated here.
 *
 * A session's tool set varies per launch (the allowlist), so a hand-written catalogue would
 * name tools the session does not have. That would break the tool-visibility spec's claim
 * that a tool outside the allowlist is one the agent never learns the name of.
 */
export function toolCatalogue(tools: McpToolDescriptor[]): string {
  if (tools.length === 0) {
    return '\nNo tools are available in this session. If you expected some, the au-mcp daemon may not be running for this workspace.'
  }
  const lines = tools.map((t) => `- ${t.name}: ${t.description}`).join('\n')
  return `\nThe ${tools.length} tools available to you in this session:\n${lines}`
}

/**
 * The proactive triggers for this session's tools: WHEN to reach for each, unprompted.
 * GENERATED from each manifest's `guidance`, which is owned by the tool's own def
 * (`tool-presentation-meta`). Sparse — most tools have no trigger.
 *
 * Nothing here is keyed by tool name. A note travels with its tool, so a scoped session
 * carries exactly the triggers for the tools it has, and this stays correct as tools change.
 */
export function guidanceNotes(callables: PluginManifest[]): string {
  // A callable is a TOOL (kind: 'tool'); guidance / description / inputSchema live on ToolManifest,
  // not HookManifest. Narrow to tools (the callable list is tools) before reading them.
  const notes = callables
    .filter((m): m is ToolManifest => m.kind === 'tool')
    .filter((m) => m.guidance)
    .map((m) => `- ${toolName(m.id)}: ${m.guidance}`)
  return notes.length === 0 ? '' : `\nWhen to reach for these, unprompted:\n${notes.join('\n')}`
}

/** Build MCP tool descriptors from the daemon's advertised callables. */
export function buildTools(callables: PluginManifest[]): McpToolDescriptor[] {
  return callables
    .filter((m): m is ToolManifest => m.kind === 'tool')
    .map((manifest) => ({
      // description + inputSchema owned by the tool def, surfaced on the manifest.
      name: toolName(manifest.id),
      description: manifest.description ?? manifest.name,
      inputSchema: manifest.inputSchema ?? EMPTY_SCHEMA,
    }))
}
