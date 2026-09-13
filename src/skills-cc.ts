// The CC shape for materialized skills — the adapter's ONLY contribution to the
// skills capability.
//
// "Adapters only adapt": au-mcp owns discovery, path derivation, the atomic write, the
// GC, and the lifecycle. The single harness-specific question is "what files does
// Claude Code want on disk", and that is this file: a PURE skills -> files mapping,
// with no filesystem, path, or GC code. au-mcp writes what this returns.
//
// A second harness later is a second function like this one plus a thin entrypoint —
// no new IO. See [[spec - mcp.skill - packages ship agent guidance as typed instances
// materialized at launch into each harness skill folder::au-harness]].

import type { Skill, SkillTree } from '@arsumbris/au-mcp'

import { GATE_PREFIX } from './surface.ts'

/**
 * CC namespaces a PLUGIN's skills by the plugin NAME: a plugin named `au-host` shipping
 * skill `orchestrate` is invoked `/au-host:orchestrate`. So one synthetic plugin per
 * OWNER repo gives us collision-free namespacing by construction — against the user's
 * own skills, against eidos, and against other plugins — with no owner-prefix on the
 * skill names themselves. The launcher passes one `--plugin-dir` per owner.
 */
export function ccTransform(skills: Skill[]): SkillTree {
  const byOwner = new Map<string, Skill[]>()
  for (const skill of skills) byOwner.set(skill.owner, [...(byOwner.get(skill.owner) ?? []), skill])

  const files: SkillTree['files'] = []
  const pluginRoots: string[] = []
  for (const [owner, owned] of [...byOwner].sort(([a], [b]) => a.localeCompare(b))) {
    pluginRoots.push(owner)
    files.push({ relPath: `${owner}/.claude-plugin/plugin.json`, content: pluginManifest(owner, owned) })
    for (const skill of owned) {
      files.push({ relPath: `${owner}/skills/${skill.name}/SKILL.md`, content: skillMarkdown(skill) })
    }
  }
  return { files, pluginRoots }
}

/** The synthetic plugin manifest. `name` IS the CC namespace, so it must be the owner repo. */
function pluginManifest(owner: string, owned: Skill[]): string {
  const description = `Agent guidance contributed by the ${owner} package (${owned.length} skill${
    owned.length === 1 ? '' : 's'
  }), generated from its mcp.skill instances.`
  return `${JSON.stringify({ name: owner, version: '0.0.0', description }, null, 2)}\n`
}

/**
 * One `SKILL.md`: the frontmatter CC reads, then the instance's markdown body verbatim.
 *
 * The field mapping (spec > Delivery):
 * - `name` -> `name`, the invocable slug.
 * - `description` -> `description`, what CC AUTO-INVOKES on by matching the model's intent.
 * - `allowed-tools` -> `allowed-tools`, pre-approved so the skill runs without a
 *   permission prompt mid-flow. Omitted entirely when empty — an empty key would read
 *   as "allow nothing", which is a different and wrong claim.
 * - `related-tools` is deliberately NOT materialized: it is the DISCOVERY axis, a
 *   graph-only edge for "which skill teaches tool X", with no permission meaning.
 */
function skillMarkdown(skill: Skill): string {
  const front = [`name: ${yamlScalar(skill.name)}`, `description: ${yamlScalar(skill.description)}`]
  const allowed = skill.allowedTools.map(ccToolName)
  if (allowed.length > 0) front.push(`allowed-tools: ${JSON.stringify(allowed.join(', '))}`)

  const body = skill.body.trim()
  return `---\n${front.join('\n')}\n---\n\n${body}${body ? '\n' : ''}`
}

/**
 * A `mcp.tool` DEF NAME to the name CC sees: `mcp.tool.shout` -> the gate's
 * `mcp__plugin_au-mcp-adapter-cc_au__shout`.
 *
 * This mapping is the adapter's to own — it is the same `GATE_PREFIX` the redirect
 * classifies against, derived from how CC namespaces our MCP server. au-mcp hands over
 * the def name and stays ignorant of CC naming, per "adapters only adapt".
 */
function ccToolName(defName: string): string {
  return `${GATE_PREFIX}${defName.replace(/^mcp\.tool\./, '')}`
}

/** Quote a scalar when YAML would otherwise mis-read it (`:` and `#` are the live risks in prose). */
function yamlScalar(value: string): string {
  return /[:#\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value
}
