import { describe, it, expect } from 'vitest'
import type { Skill } from '@arsumbris/au-mcp'

import { ccTransform } from '../src/skills-cc.ts'
import { GATE_PREFIX } from '../src/surface.ts'

const skill = (over: Partial<Skill> = {}): Skill => ({
  path: '/ws/pkg/shout-skill.md',
  owner: 'tool-fixture',
  name: 'shout-helper',
  description: 'When the user wants text SHOUTED.',
  relatedTools: [],
  allowedTools: [],
  body: '# When to use\n\nThe user asks to shout.\n',
  ...over,
})

/** The file map, so a test can assert one file's content by its relative path. */
const filesOf = (skills: Skill[]): Map<string, string> =>
  new Map(ccTransform(skills).files.map((f) => [f.relPath, f.content]))

describe('ccTransform', () => {
  it('emits one synthetic plugin per owner, named for the owner repo', () => {
    // The plugin NAME is the CC namespace: `/tool-fixture:shout-helper`. Getting this
    // wrong collapses the collision-freedom the whole per-owner design buys.
    const tree = ccTransform([skill()])
    expect(tree.pluginRoots).toEqual(['tool-fixture'])
    const manifest = JSON.parse(filesOf([skill()]).get('tool-fixture/.claude-plugin/plugin.json')!)
    expect(manifest.name).toBe('tool-fixture')
    expect(manifest.description).toContain('tool-fixture')
  })

  it('writes each skill to skills/<name>/SKILL.md under its owner', () => {
    const files = filesOf([skill()])
    expect([...files.keys()]).toEqual([
      'tool-fixture/.claude-plugin/plugin.json',
      'tool-fixture/skills/shout-helper/SKILL.md',
    ])
  })

  it('maps name + description into the frontmatter and keeps the body verbatim', () => {
    const md = filesOf([skill()]).get('tool-fixture/skills/shout-helper/SKILL.md')!
    expect(md).toBe(
      '---\nname: shout-helper\ndescription: When the user wants text SHOUTED.\n---\n\n' +
        '# When to use\n\nThe user asks to shout.\n',
    )
  })

  it('maps allowed-tools def-refs to their CC-facing gate names', () => {
    const md = filesOf([skill({ allowedTools: ['mcp.tool.shout', 'mcp.tool.read_file_pinned'] })]).get(
      'tool-fixture/skills/shout-helper/SKILL.md',
    )!
    expect(md).toContain(`allowed-tools: "${GATE_PREFIX}shout, ${GATE_PREFIX}read_file_pinned"`)
  })

  it('OMITS allowed-tools entirely when the skill declares none', () => {
    // An empty key would read as "allow nothing", a different and wrong claim than
    // "this skill places no restriction".
    const md = filesOf([skill({ allowedTools: [] })]).get('tool-fixture/skills/shout-helper/SKILL.md')!
    expect(md).not.toContain('allowed-tools')
  })

  it('does NOT materialize related-tools — it is the discovery axis, graph-only', () => {
    // A skill that DOCUMENTS a tool without pre-approving it must not gain permission
    // to it: related-tools carries no permission meaning. Asserted against the
    // gate-prefixed name, since the bare word "shout" occurs legitimately in the
    // skill's own name and body.
    const md = filesOf([skill({ relatedTools: ['mcp.tool.shout'], allowedTools: [] })]).get(
      'tool-fixture/skills/shout-helper/SKILL.md',
    )!
    expect(md).not.toContain('related-tools')
    expect(md).not.toContain('allowed-tools')
    expect(md).not.toContain(GATE_PREFIX)
  })

  it('groups two owners into two plugin roots, each with its own manifest', () => {
    const tree = ccTransform([
      skill({ owner: 'au-host', name: 'orchestrate' }),
      skill({ owner: 'tool-fixture', name: 'shout-helper' }),
      skill({ owner: 'au-host', name: 'inspect' }),
    ])
    expect(tree.pluginRoots).toEqual(['au-host', 'tool-fixture'])
    const paths = tree.files.map((f) => f.relPath)
    expect(paths).toContain('au-host/.claude-plugin/plugin.json')
    expect(paths).toContain('au-host/skills/orchestrate/SKILL.md')
    expect(paths).toContain('au-host/skills/inspect/SKILL.md')
    expect(paths).toContain('tool-fixture/.claude-plugin/plugin.json')
    expect(paths.filter((p) => p.endsWith('plugin.json'))).toHaveLength(2)
  })

  it('quotes a description that would otherwise break the YAML frontmatter', () => {
    // Descriptions are prose written by package authors; a colon is entirely likely.
    const md = filesOf([skill({ description: 'Use this: when the user asks for X' })]).get(
      'tool-fixture/skills/shout-helper/SKILL.md',
    )!
    expect(md).toContain('description: "Use this: when the user asks for X"')
    const frontmatter = md.split('---')[1]
    expect(frontmatter.split('\n').filter((l) => l.trim()).length).toBe(2) // name + description, still 2 keys
  })

  it('an empty skill set yields no files and no plugin roots', () => {
    expect(ccTransform([])).toEqual({ files: [], pluginRoots: [] })
  })

  it('is PURE — same input, same output, and no ambient state', () => {
    const input = [skill()]
    expect(ccTransform(input)).toEqual(ccTransform(input))
  })
})
