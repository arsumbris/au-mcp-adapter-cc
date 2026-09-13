import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startDaemon } from '@arsumbris/au-mcp'
import { buildLaunchEnv, createDaemonClient, connectSocket, socketPath } from '@arsumbris/au-mcp-sdk'
import { ccAdapterInfo } from '../src/surface.ts'
import { ccLaunchCommand } from '../src/launch-cc.ts'

it('closed CC sessions carry a host-forwardable recipe and resume the same durable session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'au-cc-history-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const daemon = await startDaemon({ workspace, plugins: [] })
  const transport = await connectSocket(socketPath(workspace))
  const client = createDaemonClient(transport)
  try {
    const session = randomUUID()
    await client.sessionOpen(ccAdapterInfo(session, workspace))
    expect((await client.listDormant()).some(item => item.id === session)).toBe(false)
    await client.sessionClose(session)
    const closed = (await client.listDormant()).find(item => item.id === session)!
    expect(closed.harness).toBe('mcp.adapter.cc')
    expect(closed.resumeRef).toBe(session)
    // Same adapter-opaque field the host forwards to the launch entrypoint's --resume flag.
    const { env } = buildLaunchEnv({ workspace })
    const launch = ccLaunchCommand(env, [], { binary: 'claude', adapterDir: '/adapter' }, { resume: closed.resumeRef })
    expect(launch.argv.slice(0, 2)).toEqual(['--resume', session])
    await client.sessionOpen(ccAdapterInfo(session, workspace, undefined, true))
    expect((await client.listDormant()).some(item => item.id === session)).toBe(false)
    await client.sessionClose(session)
    const closedAgain = (await client.listDormant()).find(item => item.id === session)!
    expect(closedAgain.resumeRef).toBe(closed.resumeRef)
    expect(closedAgain.run).toBeGreaterThan(closed.run)
  } finally {
    client.dispose()
    transport.close()
    await daemon.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
