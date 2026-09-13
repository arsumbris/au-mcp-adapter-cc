#!/usr/bin/env node
// SubagentStop -> lift the SUBAGENT's own transcript into the PARENT ledger, stamped with agent_id.
//
// A subagent shares the parent's session_id (one ledger) but its MESSAGES + FAILED/UNAVAILABLE
// calls are not hook-visible — they live in a SEPARATE transcript CC names only here, as
// `agent_transcript_path`. Its SUCCESSFUL tool calls are already captured live via the subagent's
// own PostToolUse (stamped with agent_id), so this lift recovers ONLY the invisible slice and does
// NOT re-emit them. No event of its own: like Stop, this is a transcript-lift trigger.
//
// liftSubagentTranscript degrades quietly (no agent_id -> internal/synthetic subagent, no path,
// unreadable, or lock held), so this hook never breaks the run.
import { readPayload } from '../src/bridge.ts'
import { liftSubagentTranscript } from '../src/lift.ts'

const payload = await readPayload(process.stdin)
await liftSubagentTranscript(payload)
process.exit(0)
