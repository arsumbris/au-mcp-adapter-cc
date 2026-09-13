import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractLifted, extractLiftedFrom, readTail, liftFromPath, sweepCursors, type LiftedEvent, type PendingTools } from '../src/lift.ts'

// A tool_use is written in an assistant entry; its result arrives in a LATER user entry. Under
// incremental reads with parallel calls, the tool_use can be behind the cursor when its result is
// read, so the `pending` map must carry name/input across slices.
const assistantWithToolUse = (uuid: string, id: string, name: string) =>
  JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'tool_use', id, name, input: { k: 1 } }] } })
const errorResult = (id: string, text: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: [{ text }] }] } })
const okResult = (id: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ text: 'ok' }] }] } })

describe('extractLiftedFrom (incremental core)', () => {
  it('with empty pending over the whole transcript, matches extractLifted', () => {
    const tx = [assistantWithToolUse('a1', 'tu1', 'Frob'), errorResult('tu1', 'boom')].join('\n')
    const { events } = extractLiftedFrom(tx, {})
    expect(events).toEqual(extractLifted(tx))
    expect(events.map((e) => e.kind)).toEqual(['tool_failed'])
    expect(events[0].data).toMatchObject({ tool: 'Frob', tool_use_id: 'tu1', error: 'boom' })
  })

  it('carries an unresolved tool_use forward as pending, then enriches its LATER result slice', () => {
    // Slice 1: the assistant's tool_use only (its result has not arrived yet).
    const slice1 = extractLiftedFrom(assistantWithToolUse('a1', 'tu1', 'Frob'), {})
    expect(slice1.events).toHaveLength(0) // a bare tool_use is not hook-invisible; nothing to emit
    expect(slice1.pending).toEqual({ tu1: { name: 'Frob', input: { k: 1 } } }) // carried forward

    // Slice 2 (a later hook): only the error result. The tool_use is behind the cursor, but pending
    // supplies name/input, so the failed event is still fully enriched.
    const slice2 = extractLiftedFrom(errorResult('tu1', 'boom'), slice1.pending)
    expect(slice2.events.map((e) => e.kind)).toEqual(['tool_failed'])
    expect(slice2.events[0].data).toMatchObject({ tool: 'Frob', tool_use_id: 'tu1', error: 'boom' })
    expect(slice2.events[0].dedupeKey).toBe('tu1')
    expect(slice2.pending).toEqual({}) // resolved -> dropped
  })

  it('drops a SUCCESSFUL call from pending without emitting it', () => {
    const s1 = extractLiftedFrom(assistantWithToolUse('a1', 'tu1', 'Read'), {})
    const s2 = extractLiftedFrom(okResult('tu1'), s1.pending)
    expect(s2.events).toHaveLength(0) // success is captured live via PostToolUse, never lifted
    expect(s2.pending).toEqual({}) // still resolved + dropped, so pending stays small
  })

  it('stamps a subagent agent on incrementally-lifted events', () => {
    const AGENT = { agent_id: 'a0', agent_type: 'general-purpose' }
    const s1 = extractLiftedFrom(assistantWithToolUse('a1', 'tu1', 'Frob'), {}, AGENT)
    const s2 = extractLiftedFrom(errorResult('tu1', 'boom'), s1.pending, AGENT)
    expect(s2.events[0].data).toMatchObject(AGENT)
  })
})

describe('readTail (byte-offset tail read)', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'au-lift-')), 'transcript.jsonl')

  it('reads all complete lines from offset 0 and reports the offset past the last newline', () => {
    const f = file()
    const body = 'line-one\nline-two\n'
    writeFileSync(f, body)
    const r = readTail(f, 0)!
    expect(r.text).toBe(body)
    expect(r.newOffset).toBe(Buffer.byteLength(body)) // just past the final '\n'
  })

  it('reads only the NEW tail on a subsequent call from the prior offset', () => {
    const f = file()
    writeFileSync(f, 'line-one\n')
    const first = readTail(f, 0)!
    appendFileSync(f, 'line-two\nline-three\n')
    const second = readTail(f, first.newOffset)!
    expect(second.text).toBe('line-two\nline-three\n') // not line-one
  })

  it('includes a trailing unterminated line in text but does NOT advance the offset past it', () => {
    const f = file()
    writeFileSync(f, 'complete\ntrailing-no-newline')
    const r = readTail(f, 0)!
    // The trailing line IS parsed (a complete-but-unterminated final entry must still be lifted; a
    // torn mid-write line is skipped by JSON.parse) ...
    expect(r.text).toBe('complete\ntrailing-no-newline')
    // ... but the offset stops at the last newline, so the trailing line is re-read next hook (kernel
    // dedupes any re-emit) until it terminates. No line is ever skipped.
    expect(r.newOffset).toBe(Buffer.byteLength('complete\n'))
    // A subsequent read from that offset re-includes the trailing line, now with more appended.
    appendFileSync(f, '-done\nnext\n')
    const r2 = readTail(f, r.newOffset)!
    expect(r2.text).toBe('trailing-no-newline-done\nnext\n')
  })

  it('resets to a full read when the file is shorter than the offset (rotation/truncation)', () => {
    const f = file()
    writeFileSync(f, 'fresh\n')
    const r = readTail(f, 9999)! // offset past EOF
    expect(r.text).toBe('fresh\n')
    expect(r.newOffset).toBe(Buffer.byteLength('fresh\n'))
  })

  it('counts bytes, not chars, so a multibyte line advances the offset correctly', () => {
    const f = file()
    const body = '{"t":"café ☕"}\n' // multibyte
    writeFileSync(f, body)
    const r = readTail(f, 0)!
    expect(r.newOffset).toBe(Buffer.byteLength(body))
    expect(Buffer.byteLength(body)).toBeGreaterThan(body.length) // proves multibyte
  })
})

// A pending map with a never-resolved call stays small and is simply carried; documents the bound.
describe('pending bound', () => {
  it('retains only unresolved calls', () => {
    const tx = [
      assistantWithToolUse('a1', 'done', 'Read'),
      okResult('done'), // resolved -> dropped
      assistantWithToolUse('a2', 'open', 'Frob'), // no result yet -> stays
    ].join('\n')
    const { pending } = extractLiftedFrom(tx, {} as PendingTools)
    expect(Object.keys(pending)).toEqual(['open'])
  })
})

describe('liftFromPath (cursor orchestration)', () => {
  const ORIG = process.env.AU_MCP_ADAPTER_LIFT_DIR
  beforeEach(() => {
    process.env.AU_MCP_ADAPTER_LIFT_DIR = mkdtempSync(join(tmpdir(), 'au-lift-cursor-'))
  })
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AU_MCP_ADAPTER_LIFT_DIR
    else process.env.AU_MCP_ADAPTER_LIFT_DIR = ORIG
  })

  const assistantText = (uuid: string, text: string) =>
    JSON.stringify({ type: 'assistant', uuid, message: { content: [{ type: 'text', text }] } })
  const writeTranscript = (lines: string[]): string => {
    const f = join(mkdtempSync(join(tmpdir(), 'au-tx-')), 'transcript.jsonl')
    writeFileSync(f, lines.join('\n') + '\n')
    return f
  }
  const collector = (flushed: boolean) => {
    const seen: LiftedEvent[] = []
    const observe = async (_p: unknown, events: LiftedEvent[]): Promise<boolean> => {
      seen.push(...events)
      return flushed
    }
    return { seen, observe: observe as unknown as Parameters<typeof liftFromPath>[3] }
  }
  const onlyCursor = () => {
    const d = process.env.AU_MCP_ADAPTER_LIFT_DIR!
    const files = readdirSync(d)
    return files.length === 0 ? null : (JSON.parse(readFileSync(join(d, files[0]), 'utf8')) as { offset: number; pending: PendingTools })
  }

  it('advances the cursor on a successful flush: a second lift emits nothing new', async () => {
    const f = writeTranscript([assistantText('a1', 'hi')])
    const { seen, observe } = collector(true)
    await liftFromPath(null, f, {}, observe)
    await liftFromPath(null, f, {}, observe)
    expect(seen.map((e) => e.dedupeKey)).toEqual(['a1']) // recorded once; cursor advanced past it
  })

  it('does NOT advance the cursor on a failed flush: the next lift re-reads the same tail', async () => {
    const f = writeTranscript([assistantText('a1', 'hi')])
    const { seen, observe } = collector(false) // daemon unreachable
    await liftFromPath(null, f, {}, observe)
    await liftFromPath(null, f, {}, observe)
    expect(seen.map((e) => e.dedupeKey)).toEqual(['a1', 'a1']) // re-emitted; the kernel would dedupe live
    expect(onlyCursor()).toBeNull() // nothing persisted while the daemon is down
  })

  it('resets pending on transcript rotation (a file shorter than the saved offset)', async () => {
    // First lift over a transcript that leaves tu1 OPEN (a bare tool_use, no result) -> pending {tu1}.
    const f = writeTranscript([assistantWithToolUse('a1', 'tu1', 'Frob')])
    const { observe } = collector(true)
    await liftFromPath(null, f, {}, observe)
    expect(onlyCursor()?.pending).toHaveProperty('tu1')

    // Rotate: replace with a SHORTER transcript. readTail sees a file shorter than the saved offset,
    // resets to a full read from 0, and liftFromPath drops the stale pending.
    writeFileSync(f, assistantText('b1', 'fresh') + '\n')
    await liftFromPath(null, f, {}, observe)
    expect(onlyCursor()?.pending).not.toHaveProperty('tu1') // stale pending cleared on rotation
  })
})

describe('sweepCursors', () => {
  const ORIG = process.env.AU_MCP_ADAPTER_LIFT_DIR
  afterEach(() => {
    if (ORIG === undefined) delete process.env.AU_MCP_ADAPTER_LIFT_DIR
    else process.env.AU_MCP_ADAPTER_LIFT_DIR = ORIG
  })

  it('removes cursor files older than the window, keeps recent ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'au-sweep-'))
    process.env.AU_MCP_ADAPTER_LIFT_DIR = dir
    mkdirSync(dir, { recursive: true })
    const old = join(dir, 'old.json')
    const recent = join(dir, 'recent.json')
    writeFileSync(old, '{}')
    writeFileSync(recent, '{}')
    const now = Date.now()
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000)
    utimesSync(old, tenDaysAgo, tenDaysAgo)
    sweepCursors(now)
    expect(existsSync(old)).toBe(false) // past the 7-day window
    expect(existsSync(recent)).toBe(true) // fresh -> kept
  })
})
