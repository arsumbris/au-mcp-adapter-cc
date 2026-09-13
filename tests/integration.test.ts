// Phase 5a milestone: the bridge driving a REAL daemon with fake CC hook
// payloads — a CC session traced end to end on the new daemon.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { startDaemon, type RunningDaemon } from '@arsumbris/au-mcp'
import type { Plugin, SessionEvent } from '@arsumbris/au-mcp-sdk'
import { observeEvent, mediateAction, closeSession, sessionStartContext } from '../src/bridge.ts'
import { liftSubagentTranscript } from '../src/lift.ts'

const ORIGINAL = process.env.CLAUDE_PROJECT_DIR
const ORIG_LIFT = process.env.AU_MCP_ADAPTER_LIFT_DIR
// Isolate the transcript-lift cursor dir per test, so a lift never writes into the real $HOME.
beforeEach(() => {
  process.env.AU_MCP_ADAPTER_LIFT_DIR = mkdtempSync(join(tmpdir(), 'au-lift-cursor-'))
})
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_PROJECT_DIR
  else process.env.CLAUDE_PROJECT_DIR = ORIGINAL
  if (ORIG_LIFT === undefined) delete process.env.AU_MCP_ADAPTER_LIFT_DIR
  else process.env.AU_MCP_ADAPTER_LIFT_DIR = ORIG_LIFT
})

async function tempWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'au-mcp-cc-'))
  await mkdir(join(ws, '.arsumbris'), { recursive: true })
  return ws
}

describe('CC adapter bridge against a real daemon', () => {
  it('drives a real daemon: the bridge\'s events flow through to an observer (capture milestone)', async () => {
    const ws = await tempWorkspace()
    process.env.CLAUDE_PROJECT_DIR = ws
    // A stub OBSERVER stands in for the capture recorder. The recorder (ledger writer) now lives in
    // au-provenance as a loadable plugin, so a bare daemon writes no `operations/` ledger. This test
    // owns the bridge -> daemon -> observe PATH, not the recorder's on-disk format; injecting an
    // observer asserts events flow through, daemon-sequenced, with CC fields intact. (P3-O1.)
    const seen: SessionEvent[] = []
    const recorder: Plugin = {
      manifest: { id: 'mcp.test-recorder', name: 'rec', contractVersion: 0, kind: 'hook', shapes: ['observer'] },
      onEvent: (event) => {
        seen.push(event)
      },
    }
    const running: RunningDaemon = await startDaemon({ workspace: ws, plugins: [recorder] })
    const payload = { session_id: 's1', cwd: ws }
    try {
      await observeEvent(payload, 'session_start', { source: 'startup' })
      await observeEvent(payload, 'user_prompt', { prompt: 'hi', permission_mode: 'default' })
      // No redirect in the default daemon -> a native tool is allowed.
      const decision = await mediateAction(payload, { tool: 'Read', input: { file_path: '/x' } })
      expect(decision.kind).toBe('allow')
      await observeEvent(payload, 'tool_start', { tool: 'Read', tool_use_id: 'tu1' })

      // The observer saw the bridge's events, daemon-sequenced, with CC-specific fields verbatim.
      expect(seen.map((e) => e.kind)).toEqual(['session_start', 'user_prompt', 'tool_start'])
      expect(seen.map((e) => e.seq)).toEqual([1, 2, 3]) // daemon-assigned, monotonic
      expect((seen[1].data as Record<string, unknown>)?.permission_mode).toBe('default') // a CC field rides verbatim

      expect(running.daemon.sessionCount()).toBe(1)
      await closeSession(payload)
      expect(running.daemon.sessionCount()).toBe(0)
    } finally {
      await running.stop()
    }
  })

  it('forwards the daemon-computed session-start inject through sessionStartContext (end to end)', async () => {
    // A session-start hook injects a computed block at open; the bridge's sessionStartContext
    // fetches the daemon's stash verbatim. This is the adapter's whole job for the shape: forward.
    const ws = await tempWorkspace()
    process.env.CLAUDE_PROJECT_DIR = ws
    const starter: Plugin = {
      manifest: { id: 'mcp.notice', name: 'notice', contractVersion: 0, kind: 'hook', shapes: ['session-start'], tier: 'policy' },
      onSessionStart: () => ({ inject: ['⚠ 40 items of type task'] }),
    }
    const running: RunningDaemon = await startDaemon({ workspace: ws, plugins: [starter] })
    const payload = { session_id: 's1', cwd: ws }
    try {
      const { inject } = await sessionStartContext(payload)
      expect(inject).toEqual(['⚠ 40 items of type task'])
    } finally {
      await running.stop()
    }
  })

  it('sessionStartContext degrades to empty when no daemon is running', async () => {
    const ws = await tempWorkspace()
    process.env.CLAUDE_PROJECT_DIR = ws
    const payload = { session_id: 's1', cwd: ws }
    expect((await sessionStartContext(payload)).inject).toEqual([])
  })

  it('returns a mediator review as post-tool text through observeEvent (B2-i, end to end)', async () => {
    // The full post-tool channel: a mediator reviewing a completed tool_call, its text carried
    // back over the observe round-trip to the hook — which surfaces it as PostToolUse
    // additionalContext. Here we assert the value the hook is driven by.
    const ws = await tempWorkspace()
    process.env.CLAUDE_PROJECT_DIR = ws
    const reviewer: Plugin = {
      manifest: { id: 'mcp.reviewer', name: 'reviewer', contractVersion: 0, kind: 'hook', shapes: ['mediator'] },
      decide: () => ({ kind: 'allow' }),
      review: (event) => (event.kind === 'tool_call' ? { text: '⚠ gate unmet: required field size' } : undefined),
    }
    const running: RunningDaemon = await startDaemon({ workspace: ws, plugins: [reviewer] })
    const payload = { session_id: 's1', cwd: ws }
    try {
      const text = await observeEvent(payload, 'tool_call', { tool: 'write_file', tool_use_id: 'tu1' })
      expect(text).toBe('⚠ gate unmet: required field size')
      // An event the mediator declines to review -> no post-tool text.
      const none = await observeEvent(payload, 'tool_start', { tool: 'Read', tool_use_id: 'tu2' })
      expect(none).toBeUndefined()
    } finally {
      await running.stop()
    }
  })

  it('degrades quietly when no daemon is running', async () => {
    const ws = await tempWorkspace()
    process.env.CLAUDE_PROJECT_DIR = ws
    const payload = { session_id: 's1', cwd: ws }
    // observe must not throw; mediate must allow (never block the user).
    await expect(observeEvent(payload, 'user_prompt', { prompt: 'hi' })).resolves.toBeUndefined()
    expect((await mediateAction(payload, { tool: 'Read', input: {} })).kind).toBe('allow')
  })

  it('SubagentStop lift: a subagent transcript merges into the PARENT session, stamped with agent_id', async () => {
    const ws = await tempWorkspace()
    process.env.CLAUDE_PROJECT_DIR = ws
    const seen: SessionEvent[] = []
    const recorder: Plugin = {
      manifest: { id: 'mcp.test-recorder', name: 'rec', contractVersion: 0, kind: 'hook', shapes: ['observer'] },
      onEvent: (event) => seen.push(event),
    }
    const running: RunningDaemon = await startDaemon({ workspace: ws, plugins: [recorder] })
    // A subagent's OWN transcript: one assistant message + one FAILED tool call (the hook-invisible
    // slice). A SUCCESSFUL call would already be live-captured, so it must not be re-emitted here.
    const subTranscript = join(ws, 'subagents', 'agent-a0cb05e8.jsonl')
    await mkdir(join(ws, 'subagents'), { recursive: true })
    writeFileSync(
      subTranscript,
      [
        JSON.stringify({ type: 'assistant', uuid: 'sa1', message: { content: [{ type: 'text', text: 'I read the file.' }] } }),
        JSON.stringify({ type: 'assistant', uuid: 'sa2', message: { content: [{ type: 'tool_use', id: 'stu1', name: 'Read', input: { file_path: '/nope' } }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'stu1', is_error: true, content: [{ text: 'ENOENT' }] }] } }),
      ].join('\n'),
    )
    // A subagent shares the PARENT session_id; SubagentStop hands agent_id/type + the subagent path.
    const payload = {
      session_id: 's1',
      cwd: ws,
      agent_id: 'a0cb05e8',
      agent_type: 'general-purpose',
      agent_transcript_path: subTranscript,
    }
    try {
      await liftSubagentTranscript(payload)
      const lifted = seen.filter((e) => e.kind === 'assistant_message' || e.kind === 'tool_failed')
      expect(lifted.map((e) => e.kind)).toEqual(['assistant_message', 'tool_failed'])
      for (const e of lifted) {
        expect((e.data as Record<string, unknown>).agent_id).toBe('a0cb05e8')
        expect((e.data as Record<string, unknown>).agent_type).toBe('general-purpose')
      }
      expect(seen.some((e) => e.kind === 'tool_call')).toBe(false) // the successful call is NOT re-lifted
      expect(seen.every((e) => e.session === 's1')).toBe(true) // merged into the PARENT ledger
    } finally {
      await running.stop()
    }
  })

  it('SubagentStop lift: skips quietly with no agent_id (internal/synthetic subagent)', async () => {
    const ws = await tempWorkspace()
    process.env.CLAUDE_PROJECT_DIR = ws
    const seen: SessionEvent[] = []
    const recorder: Plugin = {
      manifest: { id: 'mcp.test-recorder', name: 'rec', contractVersion: 0, kind: 'hook', shapes: ['observer'] },
      onEvent: (event) => seen.push(event),
    }
    const running: RunningDaemon = await startDaemon({ workspace: ws, plugins: [recorder] })
    const subTranscript = join(ws, 'orphan.jsonl')
    writeFileSync(subTranscript, JSON.stringify({ type: 'assistant', uuid: 'x', message: { content: [{ type: 'text', text: 'hi' }] } }))
    try {
      // agent_transcript_path present but NO agent_id -> unattributable -> nothing observed.
      await liftSubagentTranscript({ session_id: 's1', cwd: ws, agent_transcript_path: subTranscript })
      expect(seen).toHaveLength(0)
    } finally {
      await running.stop()
    }
  })
})
