import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { resolveProfile } from '../src/bridge.ts'

/** Isolate one launch-env axis: cleared before every case, restored after. */
function isolate(axis: 'TRACE' | 'PROFILE'): void {
  const name = `AU_MCP_${axis}`
  const saved = process.env[name]
  beforeEach(() => {
    delete process.env[name]
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[name]
    else process.env[name] = saved
  })
}

// Tool restriction — native `nativeToolAllowlist` AND typed `tools` — no longer rides a launch env
// (no AU_MCP_NATIVE_TOOLS / AU_MCP_TOOLS): both resolve daemon-side from the active agent-profile.
// The launch env carries only the profile LOCATOR (resolveProfile below); the shim forwards it and
// the daemon resolves both allowlists from the profile graph.

describe('resolveProfile (the active agent-profile locator: AU_MCP_PROFILE env only)', () => {
  isolate('PROFILE')

  it('undefined when the env is absent (a bare launch, no profile)', () => {
    expect(resolveProfile()).toBeUndefined()
  })

  it('undefined for an empty / whitespace-only value (not a profile)', () => {
    process.env.AU_MCP_PROFILE = '   '
    expect(resolveProfile()).toBeUndefined()
  })

  it('the trimmed locator when set', () => {
    process.env.AU_MCP_PROFILE = '  sample '
    expect(resolveProfile()).toBe('sample')
  })
})
