import { describe, it, expect } from 'vitest'
import type { PluginManifest } from '@arsumbris/au-mcp-sdk'
import { buildTools, toolName, provenanceNote } from '../src/advertise.ts'

const manifest = (
  id: string,
  extra: { description?: string; inputSchema?: Record<string, unknown>; provenance?: string } = {},
): PluginManifest => ({
  id,
  name: id,
  ...(extra.description ? { description: extra.description } : {}),
  ...(extra.inputSchema ? { inputSchema: extra.inputSchema } : {}),
  ...(extra.provenance ? { provenance: extra.provenance } : {}),
  contractVersion: 0,
  kind: 'tool',
})

const readFileSchema = {
  type: 'object',
  properties: { file_path: { type: 'string' } },
  required: ['file_path'],
  additionalProperties: false,
}

describe('MCP tool advertisement', () => {
  it('maps a plugin id to the agent-facing tool name', () => {
    expect(toolName('mcp.read_file_pinned')).toBe('read_file_pinned')
    expect(toolName('mcp.au_types')).toBe('au_types')
  })

  it('FORWARDS both the description AND the inputSchema off the manifest (owned by the tool def, not the adapter)', () => {
    // decision 2606251602 / plan action 5: BOTH the description (from the tool-presentation-meta)
    // and the inputSchema (generated at discovery from the def fields) ride the manifest; the
    // adapter holds no table, it forwards. This is what makes LOADABLE tools carry a real schema.
    const tools = buildTools([
      manifest('mcp.read_file_pinned', { description: 'Read a file from disk.', inputSchema: readFileSchema }),
      manifest('mcp.au_guide', { inputSchema: { type: 'object', properties: { scenario: { type: 'string' } }, additionalProperties: false } }),
    ])
    const read = tools.find((t) => t.name === 'read_file_pinned')!
    expect(read.description).toBe('Read a file from disk.')
    expect(read.inputSchema).toMatchObject(readFileSchema)
    // a loadable tool's schema forwards the same way (empty via the static file before this step)
    expect(tools.find((t) => t.name === 'au_guide')!.inputSchema).toMatchObject({ properties: { scenario: { type: 'string' } } })
  })

  it('falls back to the name when the manifest has no description', () => {
    const [tool] = buildTools([manifest('mcp.read_file_pinned')])
    expect(tool.description).toBe('mcp.read_file_pinned') // manifest.name fallback
  })

  it('falls back to a permissive open schema when the manifest carries no inputSchema', () => {
    const [tool] = buildTools([manifest('mcp.mystery')])
    expect(tool.name).toBe('mystery')
    expect(tool.inputSchema).toMatchObject({ type: 'object', properties: {}, additionalProperties: false })
  })
})

describe('tool provenance note (core vs contributed)', () => {
  it('groups contributed tools by their package repo, generated from manifest provenance', () => {
    const note = provenanceNote([
      manifest('mcp.au_types', { provenance: 'core' }),
      manifest('mcp.read_file_pinned', { provenance: 'core' }),
      manifest('mcp.au_guide', { provenance: 'au-mcp-type-knowledge' }),
      manifest('mcp.dry_run_type', { provenance: 'au-mcp-type-knowledge' }),
    ])
    expect(note).toContain('CONTRIBUTED by mounted capability packages:')
    expect(note).toContain('au_guide, dry_run_type (from au-mcp-type-knowledge)') // sorted, grouped by repo
    expect(note).not.toContain('au_types') // core tools are not listed as contributed
  })

  it('says everything is core when no package contributes a tool', () => {
    const note = provenanceNote([manifest('mcp.au_types', { provenance: 'core' }), manifest('mcp.read_file_pinned')])
    expect(note).toContain('every tool here is CORE')
    expect(note).not.toContain('CONTRIBUTED')
  })
})
