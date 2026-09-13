// The transcript lifter — recovers what hooks cannot see by rescanning CC's
// transcript: assistant messages (text/thinking), belt-one attempts ("No such
// tool available"), and failed/errored calls (PostToolUse fires only on success).
// Ported from old au-cc lib/lift.mjs; the direct disk write becomes a daemon `observe`.
//
// DEDUP IS THE KERNEL'S (decision 2609131240): each emitted event carries an opaque `dedupeKey`
// (the assistant `uuid` / the `tool_use_id`) and the kernel records each key at most once per
// session. So the lifter holds NO correctness state and never reads the ledger — the old per-session
// `.state` cache + lift-lock + ledger-pin read (under `<workspace>/operations/.state/`) are gone.
//
// INCREMENTAL READ (decision 2609131309): the lifter reads only the NEW TAIL of the transcript since
// last time, via a per-machine byte-offset cursor in the device dir ($HOME/.arsumbris/au-mcp-adapter-cc/
// lift/), so a long session is LINEAR instead of re-parsing the whole transcript each PostToolUse. The
// cursor is a PURE perf cache: any miss (no/corrupt cursor, transcript rotation, resume) falls back to
// a full rescan and the kernel dedupes any re-emit. It advances only when the observe reached the
// daemon, so a transient down-daemon re-reads the same tail next hook rather than skipping events. A
// `pending` map of unresolved tool_use_ids carries name/input across hooks so a failed/unavailable
// result still enriches even when its tool_use entry is behind the cursor (parallel calls).
//
// ORDERING: a lifted event carries the transcript's PRODUCTION time as `at` (see `entry.timestamp`
// below), so its timestamp is correct. Its POSITION is not: a lift runs at PostToolUse, so a lifted
// assistant message is appended AFTER events that happened later. Append order therefore never
// matches production order, and a consumer must order by `at`, tie-broken by `seq`, not by position.

import { readFileSync, existsSync, openSync, readSync, fstatSync, closeSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EventKind, auDeviceDir, type MessageBlock } from '@arsumbris/au-mcp-sdk'
import { CcEventKind } from './vocabulary-cc.ts'
import { sendRehydrate, observeEvents, agentFields } from './bridge.ts'

/** The per-agent attribution stamped onto every event lifted from a SUBAGENT transcript.
 *  Empty ({}) for the main transcript, so main-agent events stay in the top-level thread. */
export type AgentStamp = { agent_id?: string; agent_type?: string }

/** One event recovered from the transcript, ready for `observe`. `dedupeKey` is the opaque
 *  idempotency token (uuid / tool_use_id) the kernel dedupes on; `at` is the transcript time. */
export interface LiftedEvent {
  kind: string
  data: unknown
  at?: string
  dedupeKey?: string
}

/** Unresolved tool calls carried across hooks: `tool_use_id -> {name, input}`, so a later
 *  failed/unavailable result enriches even when its tool_use entry is behind the read cursor. */
export type PendingTools = Record<string, { name: string | null; input: unknown }>

/** The per-machine read cursor for one transcript file (a PURE perf cache; see the header). */
interface LiftCursor {
  /** The transcript path this cursor is for; a mismatch (resume/rotation) forces a full rescan. */
  transcriptPath: string
  /** Byte offset read up to (at a line boundary). */
  offset: number
  /** Unresolved tool calls at that offset. */
  pending: PendingTools
}

interface TranscriptBlock {
  type?: string
  id?: string
  name?: string
  input?: unknown
  text?: string
  thinking?: string
  tool_use_id?: string
  is_error?: boolean
  content?: unknown
}
interface TranscriptEntry {
  type?: string
  uuid?: string
  /** ISO-8601 authored time of this entry — carried onto a lifted event's `at`. */
  timestamp?: string
  message?: { content?: TranscriptBlock[] }
}

// --- the per-machine read cursor (device dir, pure perf cache) ---------------

const shortHash = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** The cursor base dir: `$HOME/.arsumbris/au-mcp-adapter-cc/lift/`, beside the socket + crash-recovery,
 *  out of the workspace. Overridable via `AU_MCP_ADAPTER_LIFT_DIR` for isolated tests (mirrors the
 *  kernel's `AU_MCP_RECOVERY_DIR`), so a test never writes a cursor into the real `$HOME`. */
function cursorDir(): string {
  return process.env.AU_MCP_ADAPTER_LIFT_DIR ?? auDeviceDir('au-mcp-adapter-cc', 'lift')
}

/** `<cursor dir>/<hash(transcriptPath)>.json`. Keyed by transcript PATH, so the main transcript and
 *  each subagent transcript get their own, and a resume (new path) is a fresh cursor. */
function cursorFile(transcriptPath: string): string {
  return join(cursorDir(), `${shortHash(transcriptPath)}.json`)
}

/** Load the cursor for a transcript. A missing/corrupt file, or one for a DIFFERENT path, reads as a
 *  fresh cursor (offset 0, empty pending) -> a full rescan, which the kernel dedupes. */
function readCursor(transcriptPath: string): LiftCursor {
  const fresh: LiftCursor = { transcriptPath, offset: 0, pending: {} }
  try {
    const c = JSON.parse(readFileSync(cursorFile(transcriptPath), 'utf8')) as Partial<LiftCursor>
    if (c.transcriptPath !== transcriptPath || typeof c.offset !== 'number' || c.offset < 0) return fresh
    return { transcriptPath, offset: c.offset, pending: c.pending && typeof c.pending === 'object' ? c.pending : {} }
  } catch {
    return fresh
  }
}

/** Persist the cursor. Best-effort: a failed write just means a fuller re-read next hook (kernel
 *  dedupes), never lost events. */
function writeCursor(cursor: LiftCursor): void {
  try {
    mkdirSync(cursorDir(), { recursive: true })
    writeFileSync(cursorFile(cursor.transcriptPath), JSON.stringify(cursor))
  } catch {
    /* best-effort cache */
  }
}

/** A lift cursor is a PURE cache, so it can be swept by age. This keeps the device dir from accruing
 *  one file per transcript ever seen (main, subagent, orphaned). Called on session-end. A swept-live
 *  cursor just forces one rescan (the kernel dedupes). `now` injectable for tests. */
const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function sweepCursors(now: number = Date.now(), maxAgeMs: number = CURSOR_MAX_AGE_MS): void {
  try {
    const dir = cursorDir()
    for (const f of readdirSync(dir)) {
      try {
        const p = join(dir, f)
        if (now - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p)
      } catch {
        /* racing another sweep / already gone */
      }
    }
  } catch {
    /* no dir yet */
  }
}

/**
 * Read the transcript from `offset` to EOF. Returns the WHOLE tail as `text` (so a complete-but-
 * unterminated final entry is still lifted; a torn mid-write line is harmlessly skipped by the
 * caller's `JSON.parse`), and `newOffset` = the byte just past the last NEWLINE, i.e. only past
 * fully-terminated lines. A trailing unterminated line is thus included in `text` but NOT passed by
 * `newOffset`, so it is re-read next hook (and the kernel dedupes any re-emit) until it terminates —
 * no line is ever skipped. A file shorter than `offset` (rotation/truncation) resets to a full read
 * from 0. Returns null when the file cannot be read.
 */
export function readTail(transcriptPath: string, offset: number): { text: string; newOffset: number } | null {
  let fd: number | undefined
  try {
    fd = openSync(transcriptPath, 'r')
    const size = fstatSync(fd).size
    const start = offset <= size ? offset : 0 // shorter than offset -> rotated/truncated -> full reread
    const len = size - start
    if (len <= 0) return { text: '', newOffset: start }
    const buf = Buffer.allocUnsafe(len)
    const bytesRead = readSync(fd, buf, 0, len, start)
    const slice = buf.subarray(0, bytesRead) // honour the actual count; never toString an uninitialized tail
    const lastNl = slice.lastIndexOf(0x0a) // last '\n' — the end of the last fully-terminated line
    return { text: slice.toString('utf8'), newOffset: lastNl === -1 ? start : start + lastNl + 1 }
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* ignore */ }
  }
}

// --- the pure extraction core ------------------------------------------------

/**
 * Pure: parse a slice of transcript (JSONL) against the `pending` tool-call map and return the
 * hook-invisible events plus the UPDATED pending map. No dedup (the kernel does that), no IO.
 *
 * `pending` carries unresolved `tool_use_id -> {name, input}` from earlier slices, so a failed /
 * unavailable result whose tool_use is behind the read cursor still enriches. A tool_use is added on
 * sight and removed once its result is seen (success drops it silently; error/unavailable emits then
 * drops). What remains is the new pending set.
 *
 * `agent` stamps every emitted event's `data` with a subagent's `agent_id`/`agent_type` (normalized by
 * `agentFields`); the MAIN transcript passes nothing. Covers all three kinds uniformly (assistant,
 * failed, unavailable), including the adapter-owned `tool_unavailable` that has no SDK type.
 */
export function extractLiftedFrom(
  text: string,
  pending: PendingTools,
  agent: AgentStamp = {},
): { events: LiftedEvent[]; pending: PendingTools } {
  const open: PendingTools = { ...pending }

  // Pass 1: parse entries; index every tool_use (name/input) into the open map.
  const entries: TranscriptEntry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    entries.push(entry)
    for (const block of entry.message?.content ?? []) {
      if (block?.type === 'tool_use' && block.id) open[block.id] = { name: block.name ?? null, input: block.input ?? null }
    }
  }

  const events: LiftedEvent[] = []

  for (const entry of entries) {
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    // Assistant text + thinking blocks. Keyed on the entry uuid.
    if (entry.type === 'assistant' && entry.uuid) {
      const blocks: MessageBlock[] = content
        .filter((b) => b?.type === 'text' || b?.type === 'thinking')
        .map((b): MessageBlock =>
          b.type === 'text' ? { kind: 'text', text: b.text ?? '' } : { kind: 'thinking', text: b.thinking ?? '' },
        )
        .filter((b) => b.text.trim().length > 0)
      if (blocks.length > 0) {
        events.push({ kind: EventKind.AssistantMessage, data: { uuid: entry.uuid, blocks, ...agent }, at: entry.timestamp, dedupeKey: entry.uuid })
      }
    }

    // tool_results: resolve against the open map, emit the hook-invisible ones, then drop from pending.
    for (const block of content) {
      if (block?.type !== 'tool_result' || !block.tool_use_id) continue
      const resultText = Array.isArray(block.content)
        ? (block.content as Array<{ text?: string }>).map((c) => c?.text ?? '').join('\n')
        : typeof block.content === 'string'
          ? block.content
          : ''
      const attempt = open[block.tool_use_id]
      if (resultText.includes('No such tool available')) {
        events.push({
          kind: CcEventKind.ToolUnavailable,
          data: { tool: attempt?.name ?? null, input: attempt?.input ?? null, tool_use_id: block.tool_use_id, belt: 'surface', ...agent },
          at: entry.timestamp,
          dedupeKey: block.tool_use_id,
        })
      } else if (block.is_error === true) {
        events.push({
          kind: EventKind.ToolFailed,
          data: { tool: attempt?.name ?? null, input: attempt?.input ?? null, tool_use_id: block.tool_use_id, error: resultText, ...agent },
          at: entry.timestamp,
          dedupeKey: block.tool_use_id,
        })
      }
      delete open[block.tool_use_id] // resolved (success, error, or unavailable) -> no longer pending
    }
  }

  return { events, pending: open }
}

/** Pure: lift every hook-invisible event from a WHOLE transcript (the full-rescan path + the testable
 *  core). Equivalent to `extractLiftedFrom(text, {}, agent).events`. */
export function extractLifted(transcriptText: string, agent: AgentStamp = {}): LiftedEvent[] {
  return extractLiftedFrom(transcriptText, {}, agent).events
}

// --- the IO entry points -----------------------------------------------------

/** Read the new transcript tail, emit its hook-invisible events, and advance the cursor — but only
 *  when the observe reached the daemon (else re-read the same tail next hook; the kernel dedupes).
 *  `observe` is injectable for tests; production uses `observeEvents`. */
export async function liftFromPath(
  payload: Record<string, unknown> | null,
  transcriptPath: string,
  agent: AgentStamp,
  observe: typeof observeEvents = observeEvents,
): Promise<void> {
  const cursor = readCursor(transcriptPath)
  const tail = readTail(transcriptPath, cursor.offset)
  if (!tail) return // unreadable transcript; try again next hook
  const priorPending = tail.newOffset < cursor.offset ? {} : cursor.pending // rotation reset drops stale pending
  const { events, pending } = extractLiftedFrom(tail.text, priorPending, agent)
  const flushed = await observe(payload, events)
  if (flushed) writeCursor({ transcriptPath, offset: tail.newOffset, pending })
}

/** Rescan the session transcript and observe any hook-invisible events (assistant text, belt-one
 *  attempts, failed calls). Incremental: reads only the new tail; the kernel dedupes by `dedupeKey`. */
export async function liftTranscript(payload: Record<string, unknown> | null): Promise<void> {
  const transcriptPath = typeof payload?.transcript_path === 'string' ? payload.transcript_path : undefined
  if (!transcriptPath || !existsSync(transcriptPath)) return
  await liftFromPath(payload, transcriptPath, {})
}

/**
 * Lift a SUBAGENT's own transcript on `SubagentStop` and merge it into the PARENT session's ledger,
 * each event stamped with the subagent's `agent_id`/`agent_type`.
 *
 * The subagent shares the parent session id (one ledger). Its separate transcript arrives as
 * `agent_transcript_path` (only SubagentStop carries it), so it gets its OWN read cursor. We lift the
 * SAME hook-invisible slice as the main lift: assistant messages, failed, unavailable. A subagent's
 * SUCCESSFUL tool calls are already captured live via its own PostToolUse hooks, so they are skipped.
 *
 * Skipped quietly (capture never breaks the hook) when: no `agent_id` (the internal/synthetic-subagent
 * case, unattributable), or no/unreadable `agent_transcript_path`. Dedup is kernel-side by `dedupeKey`,
 * so the main lift and a subagent lift can run concurrently without racing.
 */
export async function liftSubagentTranscript(payload: Record<string, unknown> | null): Promise<void> {
  const agent = agentFields(payload)
  if (!agent.agent_id) return // no agent id → unattributable (internal/synthetic subagent); skip
  const transcriptPath = typeof payload?.agent_transcript_path === 'string' ? payload.agent_transcript_path : undefined
  if (!transcriptPath || !existsSync(transcriptPath)) return
  await liftFromPath(payload, transcriptPath, agent)
}

/**
 * On a RESUME, replay the transcript's observable conversation to the daemon so `consultTrace` shows
 * the prior run(s). The kernel injects it inert (read-only, governance refused, read-views untouched)
 * AND seeds its per-session dedupe set from each replayed event's `dedupeKey`, so the run's first live
 * re-lift of the same events no-ops.
 *
 * Called from the SessionStart hook only when CC reports `source === 'resume'`. A no-op if the
 * transcript is absent or holds nothing observable. Best-effort: a down daemon just means a resumed
 * run starts with an empty trace, never a broken hook.
 */
export async function rehydrateSession(payload: Record<string, unknown> | null): Promise<void> {
  const transcriptPath = typeof payload?.transcript_path === 'string' ? payload.transcript_path : undefined
  if (!transcriptPath || !existsSync(transcriptPath)) return
  const events = extractObservable(readFileSync(transcriptPath, 'utf8'))
  await sendRehydrate(payload, events)
}

/** One observable event reconstructed from the transcript for resume replay: identity-free
 *  (the transcript carries no `(run, seq)`), so it is `{kind, data, at, dedupeKey}` — the daemon stamps
 *  `(run, seq)`. Mirrors the SDK `ReplayEvent`; declared here to keep lift.ts import-light. */
export interface ObservableEvent {
  kind: string
  data: unknown
  at?: string
  /** Opaque idempotency token (uuid / tool_use_id). On replay the kernel does NOT dedupe these, it
   *  SEEDS its seen-set from them, so a later live re-lift of the same events no-ops. */
  dedupeKey?: string
}

/**
 * Reconstruct the WHOLE observable conversation from a transcript, for `sessionRehydrate` replay on
 * resume. DISTINCT from `extractLifted`: that recovers only the hook-INVISIBLE slice (assistant text,
 * belt-one attempts, error results). This emits the FULL observable turn sequence — user prompts,
 * assistant messages, tool calls, failed calls. Replay is INERT: the kernel injects these read-only
 * into a fresh run's live log (never the ledger, never observe), so a resumed run shows the prior
 * conversation without double-recording it, and it SEEDS the kernel's dedupe set from `dedupeKey`.
 *
 * Events come out in transcript (production) order, each carrying its entry `timestamp` as `at` — the
 * authoritative order key the kernel and lift sort by. The `dedupeKey` matches what `extractLifted`
 * emits (assistant uuid, tool tool_use_id), so a post-resume re-lift of the same events no-ops.
 */
export function extractObservable(transcriptText: string): ObservableEvent[] {
  const entries: TranscriptEntry[] = []
  // tool_use_id -> its result (text + error flag), for enriching a ToolCall / emitting a ToolFailed.
  const resultById = new Map<string, { text: string; isError: boolean }>()
  for (const line of transcriptText.split('\n')) {
    if (!line.trim()) continue
    let entry: TranscriptEntry
    try {
      entry = JSON.parse(line) as TranscriptEntry
    } catch {
      continue
    }
    entries.push(entry)
    for (const block of entry.message?.content ?? []) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        const text = Array.isArray(block.content)
          ? (block.content as Array<{ text?: string }>).map((c) => c?.text ?? '').join('\n')
          : typeof block.content === 'string'
            ? block.content
            : ''
        resultById.set(block.tool_use_id, { text, isError: block.is_error === true })
      }
    }
  }

  const out: ObservableEvent[] = []
  for (const entry of entries) {
    const content = entry.message?.content
    const at = entry.timestamp

    // A user turn: a real PROMPT (a string, or text blocks) — NOT a tool-result carrier (a user-role
    // entry whose only blocks are tool_result). Emit the prompt text when present. No dedupeKey: a
    // user_prompt is never re-lifted, so nothing collides with it.
    if (entry.type === 'user') {
      const raw = (entry.message as { content?: unknown })?.content
      const prompt =
        typeof raw === 'string'
          ? raw
          : Array.isArray(content)
            ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
            : ''
      if (prompt.trim().length > 0) out.push({ kind: EventKind.UserPrompt, data: { prompt }, at })
    }

    if (!Array.isArray(content)) continue

    if (entry.type === 'assistant') {
      // Assistant text/thinking -> one AssistantMessage (same shape + key the lifter uses).
      const blocks: MessageBlock[] = content
        .filter((b) => b?.type === 'text' || b?.type === 'thinking')
        .map((b): MessageBlock => (b.type === 'text' ? { kind: 'text', text: b.text ?? '' } : { kind: 'thinking', text: b.thinking ?? '' }))
        .filter((b) => b.text.trim().length > 0)
      if (blocks.length > 0) out.push({ kind: EventKind.AssistantMessage, data: { uuid: entry.uuid, blocks }, at, dedupeKey: entry.uuid })

      // Each tool_use -> a ToolCall, enriched with its result (response / error) when the transcript
      // holds one. A failed result becomes a ToolFailed instead (matching the live capture split).
      // Both keyed on the tool_use_id, matching the lifter's tool_failed key.
      for (const block of content) {
        if (block?.type !== 'tool_use' || !block.id) continue
        const result = resultById.get(block.id)
        if (result?.isError) {
          out.push({
            kind: EventKind.ToolFailed,
            data: { tool: block.name ?? null, input: block.input ?? null, tool_use_id: block.id, error: result.text },
            at,
            dedupeKey: block.id,
          })
        } else {
          out.push({
            kind: EventKind.ToolCall,
            data: { tool: block.name ?? null, input: block.input ?? null, tool_use_id: block.id, response: result?.text ?? null },
            at,
            dedupeKey: block.id,
          })
        }
      }
    }
  }
  return out
}
