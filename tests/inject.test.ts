import { describe, it, expect } from 'vitest'
import { buildNativeRestrictionNote } from '../src/bridge.ts'

describe('buildNativeRestrictionNote (native-restricted-session injection)', () => {
  it('returns null when native tools are unrestricted', () => {
    expect(buildNativeRestrictionNote({ denyNative: false })).toBeNull()
  })

  it('injects the "use the gate" note when native tools are restricted, and never says "caged"', () => {
    const ctx = buildNativeRestrictionNote({ denyNative: true })
    expect(ctx).toMatch(/restricted native-tool set/)
    expect(ctx).toMatch(/Native file\/shell tools are not available/)
    expect(ctx).toMatch(/gate/)
    expect(ctx).not.toMatch(/caged/i)
  })

  it('names no tool, since the session tool set varies per launch', () => {
    // An inventory here would promise tools a scoped session may not have. The gate's own
    // instructions carry the generated catalogue; this note states the posture only.
    const ctx = buildNativeRestrictionNote({ denyNative: true }) ?? ''
    for (const tool of ['read_file', 'write_file', 'edit_file', 'glob', 'grep_files', 'au_']) {
      expect(ctx).not.toContain(tool)
    }
  })
})
