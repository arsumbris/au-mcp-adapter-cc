import { describe, it, expect } from 'vitest'
import { pinnedFileTarget, commitReferent, commitOfPinnedTarget } from '@arsumbris/au-mcp-sdk'
import { extractTouch } from '../src/touched.ts'

// CC delivers a tool result to the hook as an MCP content array `[{type:'text', text}]`.
const mcpText = (text: string) => [{ type: 'text', text }]

describe('extractTouch', () => {
  it('lifts a mutation touch (path + commit) from the gate result', () => {
    const response = mcpText(JSON.stringify({ message: 'wrote /abs/note.md (hash h1)', touched: { path: 'note.md', commit: 'c0ffee' } }))
    const touch = extractTouch(response)
    expect(touch).toEqual({ path: 'note.md', commit: 'c0ffee' })
    expect(pinnedFileTarget(touch)).toBe('[[note.md::@c0ffee]]')
  })

  it('lifts an unpinned touch (no commit, non-git repo) but yields no target', () => {
    const response = mcpText(JSON.stringify({ message: 'wrote /abs/note.md', touched: { path: 'note.md' } }))
    const touch = extractTouch(response)
    expect(touch).toEqual({ path: 'note.md' })
    expect(pinnedFileTarget(touch)).toBeNull() // unpinned -> no value (would fail file*@)
  })

  it('returns null for a read result (numbered text, not JSON)', () => {
    expect(extractTouch(mcpText('     1\t# Title\n     2\tbody'))).toBeNull()
  })

  it('returns null for an error string and for empty/malformed shapes', () => {
    expect(extractTouch(mcpText('Error: old_string not found'))).toBeNull()
    expect(extractTouch(mcpText('{ not json'))).toBeNull()
    expect(extractTouch(mcpText(JSON.stringify({ message: 'no touch here' })))).toBeNull()
    expect(extractTouch(null)).toBeNull()
    expect(extractTouch([])).toBeNull()
  })

  it('accepts a bare JSON string response too (transport-tolerant)', () => {
    expect(extractTouch(JSON.stringify({ touched: { path: 'a/b.md', commit: 'abc' } }))).toEqual({ path: 'a/b.md', commit: 'abc' })
  })

  it('carries the direction + old path through: a rename touch keeps access + from', () => {
    const response = mcpText(
      JSON.stringify({ message: 'renamed /abs/new.md', touched: { path: 'new.md', commit: 'c1', access: 'rename', from: 'old.md' } }),
    )
    const touch = extractTouch(response)
    // The adapter reads `access`/`from` straight off the touch and forwards them, never
    // classifying the tool name (the whole point of stamping them at the gate).
    expect(touch).toEqual({ path: 'new.md', commit: 'c1', access: 'rename', from: 'old.md' })
    expect(pinnedFileTarget(touch)).toBe('[[new.md::@c1]]') // target = the NEW-name pin
  })

  it('carries a delete direction through (access: delete, no from)', () => {
    const response = mcpText(JSON.stringify({ message: 'deleted /abs/gone.md', touched: { path: 'gone.md', commit: 'c2', access: 'delete' } }))
    expect(extractTouch(response)).toEqual({ path: 'gone.md', commit: 'c2', access: 'delete' })
  })

  it('a delete touch pins the LAST-LIVE commit (priorCommit) as target, not the deletion commit', () => {
    // A delete carries BOTH: `commit` = the deletion commit (absent target), `priorCommit` =
    // the last-live commit (readable). The tombstone `target` must resolve, so it pins priorCommit.
    const response = mcpText(
      JSON.stringify({ message: 'deleted /abs/gone.md', touched: { path: 'gone.md', commit: 'de1e7e', priorCommit: 'l1ve', access: 'delete' } }),
    )
    const touch = extractTouch(response)
    expect(touch).toEqual({ path: 'gone.md', commit: 'de1e7e', priorCommit: 'l1ve', access: 'delete' })
    // pinnedFileTarget prefers priorCommit -> the tombstone resolves to the file's last content.
    expect(pinnedFileTarget(touch)).toBe('[[gone.md::@l1ve]]')
    // The deletion commit rides `committed` for attribution, as the referent the hook builds.
    expect(commitReferent(touch!.commit)).toBe('[[::@de1e7e]]')
  })
})

// The SDK helpers the delete-tombstone chain leans on. Owned by au-mcp-sdk, exercised here at the
// consumer that assembles the wire forms (the adapter), to lock the target/attribution split.
describe('pin helpers (delete tombstone split)', () => {
  it('pinnedFileTarget pins commit for a write/edit/rename touch', () => {
    expect(pinnedFileTarget({ path: 'a.md', commit: 'c1' })).toBe('[[a.md::@c1]]')
  })
  it('pinnedFileTarget prefers priorCommit (last-live) over commit for a delete touch', () => {
    expect(pinnedFileTarget({ path: 'a.md', commit: 'deletion', priorCommit: 'lastlive', access: 'delete' })).toBe('[[a.md::@lastlive]]')
  })
  it('pinnedFileTarget yields null when neither commit is present (off-git)', () => {
    expect(pinnedFileTarget({ path: 'a.md' })).toBeNull()
    expect(pinnedFileTarget({ path: 'a.md', priorCommit: '' })).toBeNull()
  })
  it('commitReferent builds a [[::@sha]] referent that commitOfPinnedTarget round-trips', () => {
    const ref = commitReferent('de1e7e')
    expect(ref).toBe('[[::@de1e7e]]')
    expect(commitOfPinnedTarget(ref)).toBe('de1e7e')
    expect(commitReferent(undefined)).toBeNull()
    expect(commitReferent('')).toBeNull()
  })
})
