#!/usr/bin/env node
// SessionEnd -> final lift + session_end event + close the session in the daemon, then age-sweep the
// lift cursors. No .state cache to reap: the lifter is stateless (dedup is kernel-side, decision
// 2609131240). The device-dir lift cursors are a pure cache, so an age-sweep here bounds their growth
// (main + subagent + orphaned) without any per-session bookkeeping (decision 2609131309).
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, closeSession } from '../src/bridge.ts'
import { liftTranscript, sweepCursors } from '../src/lift.ts'

const payload = await readPayload(process.stdin)
await liftTranscript(payload)
await observeEvent(payload, EventKind.SessionEnd, { reason: payload.reason ?? null })
await closeSession(payload)
sweepCursors()
process.exit(0)
