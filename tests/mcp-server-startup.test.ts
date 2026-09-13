// The GUARDED startup capabilities fetch (resolveStartupCapabilities).
//
// The bug this pins: a daemon SOCKET can exist before the daemon is READY (mid-discovery / dialing
// the engine) or drop mid-request, so `listCapabilities` can THROW even after a successful dial. An
// unhandled throw would exit the shim process, which Claude Code reports as `CONNECTION_CLOSED`. The
// guard must NEVER throw — it degrades (empty caps, null client) so the server still starts and
// self-heals on the next tool call.

import { describe, it, expect, vi } from 'vitest'
import { resolveStartupCapabilities } from '../src/mcp-server.ts'
import type { DaemonClient } from '@arsumbris/au-mcp-sdk'

/** A fake DaemonClient whose listCapabilities behaves per `impl`. */
function fakeClient(impl: () => Promise<{ callables: unknown[]; redirects: unknown[] }>): DaemonClient {
  return { listCapabilities: impl, dispose: () => {} } as unknown as DaemonClient
}

const CAPS = { callables: [{ id: 'mcp.x', name: 'x', contractVersion: 0, kind: 'tool' }], redirects: [] }

describe('resolveStartupCapabilities (never crashes the shim)', () => {
  it('null client -> degraded (empty caps), no reconnect attempted', async () => {
    const reconnect = vi.fn()
    const r = await resolveStartupCapabilities(null, '/ws', undefined, reconnect)
    expect(r.client).toBeNull()
    expect(r.caps).toEqual({ callables: [], redirects: [] })
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('happy path -> returns the daemon caps, no reconnect', async () => {
    const reconnect = vi.fn()
    const client = fakeClient(async () => CAPS)
    const r = await resolveStartupCapabilities(client, '/ws', undefined, reconnect)
    expect(r.client).toBe(client)
    expect(r.caps).toEqual(CAPS)
    expect(reconnect).not.toHaveBeenCalled()
  })

  it('first call THROWS, reconnect succeeds -> the retry caps (the daemon-still-starting race)', async () => {
    const first = fakeClient(async () => {
      throw new Error('daemon not ready')
    })
    const second = fakeClient(async () => CAPS)
    const reconnect = vi.fn(async () => second)
    const r = await resolveStartupCapabilities(first, '/ws', undefined, reconnect)
    expect(reconnect).toHaveBeenCalledOnce()
    expect(r.client).toBe(second)
    expect(r.caps).toEqual(CAPS)
  })

  it('first call throws, reconnect returns null -> DEGRADED, never throws', async () => {
    const first = fakeClient(async () => {
      throw new Error('boom')
    })
    const r = await resolveStartupCapabilities(first, '/ws', undefined, async () => null)
    expect(r.client).toBeNull()
    expect(r.caps).toEqual({ callables: [], redirects: [] })
  })

  it('first AND retry throw -> DEGRADED, never throws (a crash here would be CONNECTION_CLOSED)', async () => {
    const thrower = () => fakeClient(async () => {
      throw new Error('still not ready')
    })
    const r = await resolveStartupCapabilities(thrower(), '/ws', undefined, async () => thrower())
    expect(r.client).toBeNull()
    expect(r.caps).toEqual({ callables: [], redirects: [] })
  })
})
