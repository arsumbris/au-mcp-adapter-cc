import { describe, it, expect, afterEach } from 'vitest'
import { resolveContext, readPayload, resolveSessionHandle, buildHandleMissingNote, resolveResume, agentFields } from '../src/bridge.ts'

const ORIGINAL = process.env.CLAUDE_PROJECT_DIR
const ORIGINAL_HANDLE = process.env.AU_MCP_SESSION
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_PROJECT_DIR
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL
  if (ORIGINAL_HANDLE === undefined) delete process.env.AU_MCP_SESSION
  else process.env.AU_MCP_SESSION = ORIGINAL_HANDLE
})

describe('resolveSessionHandle (AU_MCP_SESSION)', () => {
  it('returns the trimmed handle when set', () => {
    process.env.AU_MCP_SESSION = '  launch-h1  '
    expect(resolveSessionHandle()).toBe('launch-h1')
  })
  it('returns undefined when unset or empty', () => {
    delete process.env.AU_MCP_SESSION
    expect(resolveSessionHandle()).toBeUndefined()
    process.env.AU_MCP_SESSION = '   '
    expect(resolveSessionHandle()).toBeUndefined()
  })
})

describe('buildHandleMissingNote (fail-legible session-start warning)', () => {
  it('names the env, imperatively tells the agent to surface it, and prescribes no wrapper', () => {
    const note = buildHandleMissingNote()
    expect(note).toContain('AU_MCP_SESSION')
    expect(note).toMatch(/FIRST action|surface/i)
    expect(note).not.toContain('au-claude') // launcher-agnostic
  })
})

async function* lines(...chunks: string[]): AsyncGenerator<string> {
  for (const c of chunks) yield c
}

describe('hook context resolution', () => {
  it('resolves workspace + session from the payload', () => {
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveContext({ cwd: '/repo', session_id: 'sess-1' })).toEqual({
      workspace: '/repo',
      session: 'sess-1',
    })
  })

  it('CLAUDE_PROJECT_DIR overrides the payload cwd', () => {
    process.env.CLAUDE_PROJECT_DIR = '/override'
    expect(resolveContext({ cwd: '/repo', session_id: 's' }).workspace).toBe('/override')
  })

  it('falls back to a placeholder session when absent', () => {
    delete process.env.CLAUDE_PROJECT_DIR
    expect(resolveContext({}).session).toBe('unknown-session')
  })
})

describe('resolveResume (SessionStart source)', () => {
  it('is true only for a resume source', () => {
    expect(resolveResume({ source: 'resume' })).toBe(true)
    expect(resolveResume({ source: 'startup' })).toBe(false)
    expect(resolveResume({ source: 'clear' })).toBe(false)
    expect(resolveResume({})).toBe(false) // a non-SessionStart hook carries no source
    expect(resolveResume(null)).toBe(false)
  })
})

describe('agentFields (per-call subagent attribution)', () => {
  it('forwards a subagent payload’s agent_id + agent_type', () => {
    expect(agentFields({ agent_id: 'a0cb05e8', agent_type: 'general-purpose' })).toEqual({
      agent_id: 'a0cb05e8',
      agent_type: 'general-purpose',
    })
  })

  it('is empty for a main-agent call (fields absent), so it spreads to nothing', () => {
    expect(agentFields({})).toEqual({})
    expect(agentFields(null)).toEqual({})
  })

  it('carries each field independently and ignores non-string shapes', () => {
    expect(agentFields({ agent_id: 'a1' })).toEqual({ agent_id: 'a1' })
    expect(agentFields({ agent_type: 'code-reviewer' })).toEqual({ agent_type: 'code-reviewer' })
    expect(agentFields({ agent_id: 42 as unknown as string })).toEqual({})
  })
})

describe('readPayload', () => {
  it('parses JSON streamed across chunks', async () => {
    const payload = await readPayload(lines('{"session_id":', '"s1","cwd":"/v"}'))
    expect(payload).toEqual({ session_id: 's1', cwd: '/v' })
  })

  it('never throws on unparseable input', async () => {
    const payload = await readPayload(lines('not json'))
    expect(payload).toEqual({ unparseable: 'not json' })
  })
})
