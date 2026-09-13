#!/usr/bin/env node
// Stop -> lift the transcript (recover what hooks can't see), then report the turn ended.
// No event of its own: the transcript lift appends the events, and the turn-end REPORT is a
// lifecycle signal rather than an observation. What it causes (a span-index lift, when the
// workspace configures `turn-close`) is the daemon's policy, not this hook's business.
import { readPayload, reportTurnEnd } from '../src/bridge.ts'
import { liftTranscript } from '../src/lift.ts'

const payload = await readPayload(process.stdin)
await liftTranscript(payload)
// AFTER the transcript lift, so the turn's assistant messages are already in the ledger and
// a lift triggered here indexes a complete turn rather than one missing its own reasoning.
await reportTurnEnd(payload)
process.exit(0)
