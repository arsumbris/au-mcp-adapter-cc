import { describe, it, expect } from 'vitest'
import { LAUNCH_ENV, buildLaunchEnv } from '@arsumbris/au-mcp-sdk'
import { ccLaunchCommand } from '../src/launch-cc.ts'

describe('ccLaunchCommand', () => {
  const paths = { binary: 'claude', adapterDir: '/opt/au-mcp-adapter-cc' }

  it('passes the adapter first, then one --plugin-dir per materialized dir', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', session: 's1' })
    const { argv } = ccLaunchCommand(env, ['/gen/skill/a', '/gen/inject/b'], paths)
    expect(argv).toEqual([
      '--plugin-dir', '/opt/au-mcp-adapter-cc',
      '--plugin-dir', '/gen/skill/a',
      '--plugin-dir', '/gen/inject/b',
    ])
  })

  it('sets CLAUDE_PROJECT_DIR to the workspace and preserves the AU_MCP_* env', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', session: 's1', profile: 'sample' })
    const launch = ccLaunchCommand(env, [], paths)
    expect(launch.env.CLAUDE_PROJECT_DIR).toBe('/ws')
    expect(launch.env[LAUNCH_ENV.SESSION]).toBe('s1')
    expect(launch.env[LAUNCH_ENV.PROFILE]).toBe('sample')
    expect(launch.binary).toBe('claude')
  })

  it('preserves the agent-profile locator through the command transform', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', session: 's1', profile: 'sample' })
    expect(ccLaunchCommand(env, [], paths).env[LAUNCH_ENV.PROFILE]).toBe('sample')
  })

  it('no materialized dirs -> just the adapter', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', session: 's1' })
    expect(ccLaunchCommand(env, [], paths).argv).toEqual(['--plugin-dir', '/opt/au-mcp-adapter-cc'])
  })

  it('resume: prepends --resume <id> before the plugin dirs', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', session: 's1' })
    const { argv } = ccLaunchCommand(env, ['/gen/a'], paths, { resume: 'sess-abc' })
    expect(argv).toEqual([
      '--resume', 'sess-abc',
      '--plugin-dir', '/opt/au-mcp-adapter-cc',
      '--plugin-dir', '/gen/a',
    ])
  })

  it('resume absent -> no --resume in argv (a fresh launch)', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', session: 's1' })
    expect(ccLaunchCommand(env, [], paths, {}).argv).not.toContain('--resume')
    expect(ccLaunchCommand(env, [], paths).argv).not.toContain('--resume')
  })

  it('resume: the command string carries --resume before the binary args', () => {
    const { env } = buildLaunchEnv({ workspace: '/ws', session: 's1' })
    const { command } = ccLaunchCommand(env, [], { binary: 'claude', adapterDir: '/opt/ad' }, { resume: 'sess-abc' })
    expect(command).toContain(`'claude' '--resume' 'sess-abc' '--plugin-dir' '/opt/ad'`)
  })

  it('command is an env-prefixed, shell-quoted, runnable string', () => {
    const { env } = buildLaunchEnv({ workspace: '/a b/ws', session: 's1' })
    const { command } = ccLaunchCommand(env, ['/gen/x'], { binary: '/usr/bin/claude', adapterDir: '/opt/ad' })
    expect(command).toContain(`${LAUNCH_ENV.SESSION}='s1'`)
    expect(command).toContain(`CLAUDE_PROJECT_DIR='/a b/ws'`) // spaces survive quoting
    expect(command).toContain(`'/usr/bin/claude' '--plugin-dir' '/opt/ad' '--plugin-dir' '/gen/x'`)
  })

  it('escapes an embedded single quote (the exact case the POSIX quoting guards)', () => {
    const { env } = buildLaunchEnv({ workspace: `/a'b/ws`, session: 's1' })
    const { command } = ccLaunchCommand(env, [`/g'x`], { binary: 'claude', adapterDir: '/opt/ad' })
    // POSIX: close the quote, an escaped literal ', reopen — `'a'\''b'`.
    expect(command).toContain(`CLAUDE_PROJECT_DIR='/a'\\''b/ws'`)
    expect(command).toContain(`'/g'\\''x'`)
  })
})
