import { describe, it, expect } from 'vitest'
import { CC_NATIVE_TOOLS, GATE_PREFIX, ccAdapterInfo } from '../src/surface.ts'

describe('CC native surface', () => {
  it('maps the state-touching native tools to gate equivalents', () => {
    const byName = Object.fromEntries(CC_NATIVE_TOOLS.map((t) => [t.name, t.gateEquivalent]))
    expect(byName.Read).toBe(`${GATE_PREFIX}read_file_pinned`)
    expect(byName.Bash).toBe(`${GATE_PREFIX}bash`)
    expect(byName.Edit).toBe(`${GATE_PREFIX}edit_file`)
    expect(byName.Grep).toBe(`${GATE_PREFIX}grep_files`)
  })

  it('declares tools with no gate equivalent (nothing to fall back to when restricted)', () => {
    const task = CC_NATIVE_TOOLS.find((t) => t.name === 'Task')
    expect(task).toBeDefined()
    expect(task?.gateEquivalent).toBeUndefined()
  })

  it('builds AdapterInfo for a CC session', () => {
    const info = ccAdapterInfo('sess-1', '/repo')
    expect(info).toMatchObject({ harness: 'mcp.adapter.cc', session: 'sess-1', resumeRef: 'sess-1', workspace: '/repo' })
    expect(info.nativeTools).toBe(CC_NATIVE_TOOLS)
  })

  it('declares the per-launch handle when given, and omits it when not', () => {
    const withHandle = ccAdapterInfo('sess-1', '/repo', 'launch-h1')
    expect(withHandle.handle).toBe('launch-h1')
    expect('handle' in ccAdapterInfo('sess-1', '/repo')).toBe(false)
  })

  it('asserts resume when told, and OMITS it otherwise (so the daemon infers)', () => {
    const resumed = ccAdapterInfo('sess-1', '/repo', undefined, true)
    expect(resumed.resume).toBe(true)
    expect('resume' in ccAdapterInfo('sess-1', '/repo')).toBe(false)
    expect('resume' in ccAdapterInfo('sess-1', '/repo', undefined, false)).toBe(false)
  })

  // The native-tool allowlist no longer rides AdapterInfo — it resolves daemon-side from the active
  // profile (the native twin of typed `tools`). The adapter forwards only the profile locator below.

  it('forwards the agent-profile locator when given, and omits it for a bare launch', () => {
    const withProfile = ccAdapterInfo('sess-1', '/repo', undefined, undefined, 'sample')
    expect(withProfile.profile).toBe('sample')
    expect('profile' in ccAdapterInfo('sess-1', '/repo')).toBe(false)
  })

})
