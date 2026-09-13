#!/usr/bin/env node
// SessionStart -> open the session (via the bridge's idempotent open) + a session_start
// event. The bridge declares CC's native surface on open + derives the native-tool allowlist.
//
// When this session RESTRICTS native tools, inject the "use the gate" note as session context, so
// the agent knows up front instead of only meeting a hard block. Unrestricted -> nothing injected.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, sessionGuards, sessionStartContext, buildNativeRestrictionNote, buildHandleMissingNote, resolveSessionHandle } from '../src/bridge.ts'
import { rehydrateSession } from '../src/lift.ts'

const payload = await readPayload(process.stdin)
await observeEvent(payload, EventKind.SessionStart, {
  source: payload.source ?? null,
  transcript: payload.transcript_path ?? null,
})

// On a RESUME, replay the prior run(s)' observable conversation from the transcript so consultTrace
// shows it (the governance slice is rehydrated daemon-side at session-open; this is the observable
// half the kernel deliberately does NOT persist). Best-effort, resume-only.
if (payload.source === 'resume') await rehydrateSession(payload)

// The session-start context is TWO layers, packed into one additionalContext:
//  1. the POSTURE note — a MISSING launch handle supersedes the native-restriction note (the gate is
//     non-functional, so a fail-legible warning, not "use the gate", is what the human must see).
//  2. the COMPUTED inject — the daemon's `session-start` hooks' output (e.g. "N instances of type T"),
//     fetched verbatim; the adapter forwards it, holding no knowledge of what a hook computed.
// The posture note leads (the handle-missing warning is highest-priority), then the computed blocks.
const note =
  resolveSessionHandle() === undefined ? buildHandleMissingNote() : buildNativeRestrictionNote(await sessionGuards(payload))
const { inject } = await sessionStartContext(payload)
const blocks = [note, ...inject].filter((b): b is string => typeof b === 'string' && b.length > 0)
if (blocks.length > 0) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: blocks.join('\n\n') } }),
  )
}
process.exit(0)
