import { describe, it, expect } from 'vitest'
import { extractLifted, extractObservable } from '../src/lift.ts'

const transcript = [
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    message: {
      content: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'hmm' },
        { type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/x' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ text: 'boom' }] }] },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a2',
    message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Frob', input: {} }] },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', content: 'No such tool available' }] },
  }),
  '', // blank line tolerated
].join('\n')

describe('transcript lifter', () => {
  it('lifts assistant messages, failed calls, and belt-one attempts', () => {
    const events = extractLifted(transcript)
    expect(events.map((e) => e.kind)).toEqual(['assistant_message', 'tool_failed', 'tool_unavailable'])

    expect(events[0].data).toMatchObject({
      uuid: 'a1',
      blocks: [
        { kind: 'text', text: 'hello' },
        { kind: 'thinking', text: 'hmm' },
      ],
    })
    expect(events[1].data).toMatchObject({ tool: 'Read', tool_use_id: 'tu1', error: 'boom' })
    expect(events[2].data).toMatchObject({ tool: 'Frob', tool_use_id: 'tu2', belt: 'surface' })
  })

  it('tags each event with its opaque dedupeKey (assistant uuid / tool_use_id)', () => {
    const events = extractLifted(transcript)
    expect(events.map((e) => e.dedupeKey)).toEqual(['a1', 'tu1', 'tu2'])
  })

  it('carries each entry’s transcript timestamp onto the lifted event’s `at`', () => {
    const ts = '2026-06-22T12:55:01.000Z'
    const tx = JSON.stringify({ type: 'assistant', uuid: 'a9', timestamp: ts, message: { content: [{ type: 'text', text: 'hi' }] } })
    const events = extractLifted(tx)
    expect(events[0].at).toBe(ts) // real authored time, not lift/capture time
  })

  it('skips an assistant entry with no text/thinking blocks', () => {
    const events = extractLifted(transcript)
    expect(events.filter((e) => e.kind === 'assistant_message').map((e) => (e.data as { uuid: string }).uuid)).toEqual(['a1'])
  })

  it('is stateless: a second pass re-emits the SAME events (dedup is the kernel’s job now)', () => {
    const first = extractLifted(transcript)
    const second = extractLifted(transcript)
    expect(second.map((e) => e.dedupeKey)).toEqual(first.map((e) => e.dedupeKey))
    expect(second).toHaveLength(first.length) // no local dedup: every candidate is re-emitted, keyed for the kernel
  })

  it('tolerates unparseable lines', () => {
    const events = extractLifted('garbage\n' + transcript)
    expect(events).toHaveLength(3)
  })
})

describe('agent stamp (subagent transcript lift)', () => {
  const AGENT = { agent_id: 'a0cb05e8', agent_type: 'general-purpose' }

  it('stamps agent_id + agent_type on EVERY emitted kind when an agent is passed', () => {
    const events = extractLifted(transcript, AGENT)
    expect(events.map((e) => e.kind)).toEqual(['assistant_message', 'tool_failed', 'tool_unavailable'])
    for (const e of events) expect(e.data).toMatchObject(AGENT) // assistant, failed, AND unavailable
  })

  it('leaves events unstamped when no agent is passed (the main-transcript path)', () => {
    const events = extractLifted(transcript)
    for (const e of events) {
      expect((e.data as { agent_id?: string }).agent_id).toBeUndefined()
      expect((e.data as { agent_type?: string }).agent_type).toBeUndefined()
    }
  })

  it('never emits a SUCCESSFUL tool call — so a subagent lift cannot double-record its live-hooked calls', () => {
    // a subagent's Read that SUCCEEDED: captured live via its PostToolUse; must NOT be re-lifted.
    const tx = [
      JSON.stringify({ type: 'assistant', uuid: 's1', message: { content: [{ type: 'tool_use', id: 'ok1', name: 'Read', input: { file_path: '/x' } }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ok1', content: [{ text: 'file contents' }] }] } }),
    ].join('\n')
    const events = extractLifted(tx, AGENT)
    expect(events.map((e) => e.kind)).not.toContain('tool_call') // the successful call is not re-emitted
    expect(events).toHaveLength(0) // nothing hook-invisible here (no assistant text, no failure)
  })
})

describe('extractObservable (resume replay)', () => {
  const ts = '2026-08-09T10:00:00.000Z'
  const convo = [
    JSON.stringify({ type: 'user', timestamp: ts, message: { content: 'fix the auth bug' } }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a1',
      timestamp: ts,
      message: {
        content: [
          { type: 'text', text: 'on it' },
          { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/auth.ts' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: ts,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ text: 'edited' }] }] },
    }),
    JSON.stringify({
      type: 'assistant',
      uuid: 'a2',
      timestamp: ts,
      message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'npm test' } }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: ts,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ text: 'FAIL' }] }] },
    }),
  ].join('\n')

  it('emits the WHOLE observable conversation in transcript order', () => {
    const events = extractObservable(convo)
    expect(events.map((e) => e.kind)).toEqual([
      'user_prompt', // the string-content prompt
      'assistant_message', // a1's text
      'tool_call', // tu1, enriched with its result
      'tool_failed', // tu2's error result
    ])
    expect(events.every((e) => e.at === ts)).toBe(true)
  })

  it('carries dedupeKeys that MATCH the lifter, so a post-resume re-lift no-ops kernel-side', () => {
    const events = extractObservable(convo)
    // user_prompt is never re-lifted -> no key; assistant + tool events key on uuid / tool_use_id,
    // exactly what extractLifted emits, so the kernel's seeded set catches the re-lift.
    expect(events.map((e) => e.dedupeKey)).toEqual([undefined, 'a1', 'tu1', 'tu2'])
  })

  it('enriches a tool_call with its result and carries prompt/tool detail', () => {
    const events = extractObservable(convo)
    expect(events[0].data).toEqual({ prompt: 'fix the auth bug' })
    expect(events[2].data).toMatchObject({ tool: 'Edit', tool_use_id: 'tu1', response: 'edited' })
    expect(events[3].data).toMatchObject({ tool: 'Bash', tool_use_id: 'tu2', error: 'FAIL' })
  })

  it('treats a user entry with only tool_result blocks as NOT a prompt', () => {
    const onlyResult = JSON.stringify({
      type: 'user',
      timestamp: ts,
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }] },
    })
    expect(extractObservable(onlyResult)).toEqual([])
  })

  it('tolerates unparseable lines', () => {
    expect(extractObservable('garbage\n' + convo).map((e) => e.kind)).toEqual([
      'user_prompt',
      'assistant_message',
      'tool_call',
      'tool_failed',
    ])
  })
})
