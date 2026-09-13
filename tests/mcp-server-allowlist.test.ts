// Tool visibility END TO END, through a really-spawned MCP server process.
//
// This exercises the path a CC session actually takes: a separate `mcp-server.ts` process
// carrying an `AU_MCP_PROFILE` LOCATOR, speaking MCP stdio to a real daemon over a real socket.
//
// Visibility is PROFILE-derived (plan 2609072337), not an `AU_MCP_TOOLS` env: the shim advertises
// at startup BEFORE session-open, so it forwards the opaque profile locator and the DAEMON resolves
// the `tools` allowlist from the profile graph. This test proves that path is live over the real
// process boundary — a filter that works at the daemon handle can still be dead end to end if the
// shim never forwards the locator. The daemon reads the profile catalog from the injected broker
// below (no live engine needed). See the tool-visibility spec.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startDaemon, type RunningDaemon, type EngineBroker } from '@arsumbris/au-mcp'
import type { Plugin } from '@arsumbris/au-mcp-sdk'

const BIN = resolve(fileURLToPath(new URL('../bin/mcp-server.ts', import.meta.url)))

const tool = (name: string, guidance?: string): Plugin => ({
  manifest: { id: `mcp.${name}`, name, contractVersion: 0, kind: 'tool', ...(guidance ? { guidance } : {}) },
  invoke: async (input) => ({ content: input }),
})

/** One agent-profile row, as `instances_of('agent-profile')` returns it. */
const profileRow = (name: string, tools: string[]) => ({
  path: `/ws/${name}.md`,
  fields: { name, tools: tools.map((t) => `[[mcp.tool.${t}]]`) },
})

// The daemon's profile catalog (served from the broker below). A test selects one by AU_MCP_PROFILE;
// no profile = unrestricted. `available: true` so the daemon actually resolves the profile (a bare
// default broker reports the engine down -> unrestricted). `validate_value` -> [] so an advertised
// tool's invoke still proceeds (no live engine to type-check against); everything else -> [].
const PROFILE_CATALOGUE = [
  profileRow('p_read', ['read_file_pinned']),
  profileRow('p_two', ['read_file_pinned', 'au_typed']),
  profileRow('p_empty', []),
  profileRow('p_typesys', ['au_type_system', 'read_file_pinned']),
]
const profileBroker: EngineBroker = {
  socketPath: '/fake/engine.sock',
  available: () => true,
  read: async (op, args) =>
    op === 'instances_of' && (args as { type?: string })?.type === 'agent-profile'
      ? { result: PROFILE_CATALOGUE }
      : { result: [] },
  mutate: async () => ({}),
}

/** Spawn the real shim against `workspace`, with `AU_MCP_PROFILE` set only when defined. */
// `handle`: the AU_MCP_SESSION the shim needs to start. Defaults to a test value; pass null to OMIT
// it (the fail-closed path). Explicitly managed (not left to the outer env) so it stays deterministic.
async function connectShim(workspace: string, profile?: string, handle: string | null = 'test-handle'): Promise<Client> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    AU_MCP_WORKSPACE: workspace,
  }
  delete env.AU_MCP_TOOLS // retired; ensure a stray outer value never leaks in
  if (profile === undefined) delete env.AU_MCP_PROFILE
  else env.AU_MCP_PROFILE = profile
  if (handle === null) delete env.AU_MCP_SESSION
  else env.AU_MCP_SESSION = handle
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--experimental-strip-types', BIN],
    env,
  })
  const client = new Client({ name: 'allowlist-test', version: '0' })
  await client.connect(transport)
  return client
}

describe('profile-derived tool visibility through a spawned mcp-server process', () => {
  const running: RunningDaemon[] = []
  const clients: Client[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    for (const d of running.splice(0)) d.stop()
  })

  async function daemonWith(...names: string[]): Promise<string> {
    const ws = await tempWorkspace()
    running.push(await startDaemon({ workspace: ws, broker: profileBroker, plugins: names.map((n) => tool(n)) }))
    return ws
  }

  async function advertised(workspace: string, profile?: string): Promise<string[]> {
    const client = await connectShim(workspace, profile)
    clients.push(client)
    const { tools } = await client.listTools()
    return tools.map((t) => t.name).sort()
  }

  it('advertises exactly the profile-selected tools', async () => {
    const ws = await daemonWith('shout', 'read_file_pinned', 'au_typed')
    expect(await advertised(ws, 'p_two')).toEqual(['au_typed', 'read_file_pinned'])
  })

  it('DEGRADES LEGIBLY when AU_MCP_SESSION is absent (tools still listed, every call refuses with the fix)', async () => {
    // The mandatory-session-handle contract, fail-LEGIBLE: a launch without the handle (bare `claude`)
    // must not silently serve session-less, but exiting hides the reason (a "failed" server the human
    // only sees via /mcp). Instead the shim stays up, still LISTS the real gate (so an agent sees it),
    // and REFUSES every call with an actionable message — surfacing the problem at the point of use.
    const ws = await daemonWith('shout', 'read_file_pinned')
    const client = await connectShim(ws, undefined, null) // no handle -> degraded, but connects
    clients.push(client)
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['read_file_pinned', 'shout'])
    const res = await client.callTool({ name: 'read_file_pinned', arguments: { file_path: '/x' } })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.content)).toContain('AU_MCP_SESSION')
  })

  it('advertises every tool when no profile is set', async () => {
    const ws = await daemonWith('shout', 'read_file_pinned')
    expect(await advertised(ws, undefined)).toEqual(['read_file_pinned', 'shout'])
  })

  it('advertises no tool when the profile restricts tools to the empty list', async () => {
    const ws = await daemonWith('shout', 'read_file_pinned')
    expect(await advertised(ws, 'p_empty')).toEqual([])
  })

  it('gives two concurrent shims on ONE daemon different tool sets', async () => {
    // The point of the whole mechanism: the profile is per-launch, so one daemon serves two launches
    // with different scopes at the same time (one restricted profile, one bare).
    const ws = await daemonWith('shout', 'read_file_pinned')
    const [restricted, full] = await Promise.all([advertised(ws, 'p_read'), advertised(ws, undefined)])
    expect(restricted).toEqual(['read_file_pinned'])
    expect(full).toEqual(['read_file_pinned', 'shout'])
  })

  it('names exactly the advertised tools in its instructions, and no others', async () => {
    // The spec claims a tool outside the allowlist is one "the agent never learns the name"
    // of. The instructions load at session start, so a hand-written catalogue there would
    // leak every name regardless of scope. This is the assertion that keeps the claim honest.
    const ws = await daemonWith('shout', 'read_file_pinned', 'au_typed')
    const client = await connectShim(ws, 'p_two')
    clients.push(client)

    const instructions = client.getInstructions() ?? ''
    expect(instructions).toContain('read_file_pinned')
    expect(instructions).toContain('au_typed')
    expect(instructions).not.toContain('shout')
  })

  it('carries a tool guidance note only when that tool is in the session', async () => {
    // Guidance is owned by the tool's def and rides the manifest, so it is scoped by the
    // same allowlist as the tool itself. No layer keys notes by tool name.
    const ws = await tempWorkspace()
    running.push(
      await startDaemon({
        workspace: ws,
        broker: profileBroker,
        plugins: [tool('au_type_system', 'Learn the type system here before authoring type-defs.'), tool('read_file_pinned')],
      }),
    )

    const withIt = await connectShim(ws, 'p_typesys') // au_type_system + read_file_pinned
    clients.push(withIt)
    expect(withIt.getInstructions() ?? '').toContain('before authoring type-defs')

    const without = await connectShim(ws, 'p_read') // read_file_pinned only
    clients.push(without)
    const text = without.getInstructions() ?? ''
    expect(text).not.toContain('before authoring type-defs')
    expect(text).not.toContain('au_type_system')
  })

  it('says so plainly when the session has no tools at all', async () => {
    const ws = await daemonWith('shout', 'read_file_pinned')
    const client = await connectShim(ws, 'p_empty')
    clients.push(client)

    expect(client.getInstructions() ?? '').toContain('No tools are available')
  })

  it('calls an advertised tool, and refuses one outside the profile', async () => {
    const ws = await daemonWith('shout', 'read_file_pinned')
    const client = await connectShim(ws, 'p_read')
    clients.push(client)

    const ok = await client.callTool({ name: 'read_file_pinned', arguments: { a: 1 } })
    expect(ok.isError).toBeFalsy()

    // `shout` is loaded in the daemon but the profile never advertised it to THIS shim, so the shim
    // refuses to forward it (the daemon's invoke gate — session state — is the other half, exercised
    // at the daemon level; here no SessionStart hook ran, so the shim's advertised-set guard is the
    // one under test end to end).
    const refused = await client.callTool({ name: 'shout', arguments: {} })
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused.content)).toContain('not available in this session')
  })
})

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-tools-e2e-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

describe('handle round-trip: a real spawned shim resolves its session through the daemon binding', () => {
  const running: RunningDaemon[] = []
  const clients: Client[] = []

  afterEach(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => {})
    for (const d of running.splice(0)) await d.stop()
  })

  it('the shim carries only AU_MCP_SESSION; the session bound to it resolves for the callable', async () => {
    // The whole point of the plan, end to end over the real process boundary: the shim knows only
    // the launch HANDLE (AU_MCP_SESSION), the SessionStart hook bound handle -> session, and the
    // daemon resolves the handle so a callable is handed the LIVE session — not the handle, not none.
    const ws = await tempWorkspace()
    const whoami: Plugin = {
      manifest: { id: 'mcp.whoami', name: 'whoami', contractVersion: 0, kind: 'tool' },
      invoke: async (_i, ctx) => ({ content: { session: ctx?.session ?? null } }),
    }
    const daemon = await startDaemon({ workspace: ws, plugins: [whoami] })
    running.push(daemon)
    // Simulate the SessionStart hook: bind handle 'h1' -> session 's1' (in-process, same daemon the
    // socket serves), exactly what the CC bridge does on session-open with AdapterInfo.handle.
    await daemon.daemon.handle(
      { kind: 'session-open', id: 1, info: { harness: 'mcp.adapter.cc', session: 's1', handle: 'h1', workspace: ws, nativeTools: [] } },
      { send: () => {}, onClose: () => {} },
    )
    // The shim is spawned with AU_MCP_SESSION=h1 (as au-claude / au-host set it) and carries ONLY that.
    const client = await connectShim(ws, undefined, 'h1')
    clients.push(client)
    const res = await client.callTool({ name: 'whoami', arguments: {} })
    const text = (res.content as Array<{ type: string; text: string }>)[0].text
    expect(JSON.parse(text)).toEqual({ session: 's1' }) // resolved h1 -> s1
  })
})
