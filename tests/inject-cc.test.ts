import { describe, it, expect } from 'vitest'
import type { InjectBlock } from '@arsumbris/au-mcp'

import { injectTransform, renderInjectTree } from '../src/inject-cc.ts'

// The adapter renders already-EXPANDED blocks (au-mcp does discovery + hops); a block is the
// per-node unit { key, stem, repo, body }.
const block = (over: Partial<InjectBlock> = {}): InjectBlock => ({
  key: 'au-mcp-workspace:knowledge-base-orientation',
  stem: 'orientation',
  repo: 'au-mcp-workspace',
  body: '# Orientation\n\nThis is the dev workspace.\n',
  ...over,
})

/** A block named `n`, addressed `[[n::au-mcp-workspace]]`, for the multi-block tests. */
const named = (n: string): InjectBlock => block({ key: `au-mcp-workspace:${n}`, stem: n })

/** The file map, so a test can assert one file's content by its relative path. */
const filesOf = (tree: { files: { relPath: string; content: string }[] }): Map<string, string> =>
  new Map(tree.files.map((f) => [f.relPath, f.content]))

describe('injectTransform / renderInjectTree', () => {
  it('empty in, empty out (no plugin, nothing dropped)', () => {
    expect(injectTransform([])).toEqual({ files: [], pluginRoots: [], dropped: [] })
  })

  it('wraps each block in the addressed envelope and emits one au-inject plugin', () => {
    const tree = injectTransform([block()])
    expect(tree.pluginRoots).toEqual(['au-inject'])
    expect(tree.dropped).toEqual([])
    const files = filesOf(tree)
    const slot = files.get('au-inject/content/slot-1.md') ?? ''
    expect(slot).toContain('<injected file [[orientation::au-mcp-workspace]]>')
    expect(slot).toContain('</injected file [[orientation::au-mcp-workspace]]>')
    expect(slot).toContain('# Orientation')
    expect(slot).not.toContain('type: mcp.inject') // body already frontmatter-stripped
  })

  it('the hook command runs the trusted emitter against a CLAUDE_PLUGIN_ROOT content file', () => {
    const hooks = JSON.parse(filesOf(injectTransform([block()])).get('au-inject/hooks/hooks.json') ?? '{}')
    const cmd: string = hooks.hooks.SessionStart[0].hooks[0].command
    expect(cmd).toContain('inject-emit.ts') // our entrypoint, not package code
    expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}/content/slot-1.md')
  })

  it('PACKS several small blocks into one slot / one hook (not one hook per inject)', () => {
    const blocks = [named('a'), named('b'), named('c')]
    const tree = renderInjectTree(blocks, { budget: 8500 })
    const files = filesOf(tree)
    const slotFiles = [...files.keys()].filter((k) => k.startsWith('au-inject/content/'))
    const hooks = JSON.parse(files.get('au-inject/hooks/hooks.json') ?? '{}')
    expect(slotFiles).toEqual(['au-inject/content/slot-1.md']) // all three fit one slot
    expect(hooks.hooks.SessionStart).toHaveLength(1)
    // all three blocks present in the single slot
    for (const a of ['[[a::au-mcp-workspace]]', '[[b::au-mcp-workspace]]', '[[c::au-mcp-workspace]]']) {
      expect(files.get('au-inject/content/slot-1.md')).toContain(a)
    }
  })

  it('opens more slots (more hooks) as the budget fills', () => {
    // A budget small enough that each block needs its own slot.
    const blocks = [named('a'), named('b')]
    const tree = renderInjectTree(blocks, { budget: 90 })
    const hooks = JSON.parse(filesOf(tree).get('au-inject/hooks/hooks.json') ?? '{}')
    expect(hooks.hooks.SessionStart.length).toBeGreaterThan(1)
    expect(tree.dropped).toEqual([])
  })

  it('under a maxSlots cap: injects what fits, names the rest IN-BAND, and reports dropped OUT', () => {
    const blocks = [named('a'), named('b'), named('c')]
    // budget 200 holds ONE ~120-char block but not two; cap at 1 content slot keeps a, drops b + c.
    const tree = renderInjectTree(blocks, { budget: 200, maxSlots: 1 })
    // OUT-OF-BAND: dropped carries the cut blocks by address, for the human/launcher.
    expect(tree.dropped.map((d) => d.key)).toEqual(['au-mcp-workspace:b', 'au-mcp-workspace:c'])
    // IN-BAND: a final overflow slot names them for the agent (rides OUTSIDE the cap).
    const files = filesOf(tree)
    const slotFiles = [...files.keys()].filter((k) => k.startsWith('au-inject/content/')).sort()
    expect(slotFiles).toEqual(['au-inject/content/slot-1.md', 'au-inject/content/slot-2.md'])
    const overflow = files.get('au-inject/content/slot-2.md') ?? ''
    expect(overflow).toContain('budget-overflow')
    expect(overflow).toContain('[[b::au-mcp-workspace]]')
    expect(overflow).toContain('[[c::au-mcp-workspace]]')
  })

  it('no overflow slot when nothing is dropped', () => {
    const files = filesOf(injectTransform([block()]))
    expect([...files.values()].some((c) => c.includes('budget-overflow'))).toBe(false)
  })
})
