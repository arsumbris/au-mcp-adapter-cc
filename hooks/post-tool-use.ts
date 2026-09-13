#!/usr/bin/env node
// PostToolUse -> tool_call event (the completed call + its response) + a lift
// pass to recover what hooks can't see (assistant messages, belt-one, failures).
import { EventKind, pinnedFileTarget, commitReferent } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, agentFields } from '../src/bridge.ts'
import { liftTranscript } from '../src/lift.ts'
import { extractTouch } from '../src/touched.ts'
import { CC_FILE_ACCESS } from '../src/surface.ts'

const payload = await readPayload(process.stdin)
// A file-op MUTATION carries its touched-file pin (`{ touched: { path, commit } }`) in
// the gate result; lift it into the append-only `target` edge. A read / error / non-file
// tool yields no touch here (target stays unset on this path). NOTE a READ is still pinned,
// just not here: the daemon stamps a read's `target` SERVER-SIDE at observe from the
// `content` read's commit (no adapter round-trip), so the hook deliberately handles only
// the mutation result.
const touch = extractTouch(payload.tool_response)
const target = pinnedFileTarget(touch) ?? undefined
// The file access, from the two sources that know it. A touch only ever comes back from a
// MUTATION, and it now carries its own direction (write / delete / rename) stamped by the
// gate — the layer that knows the verb — so the adapter FORWARDS it rather than hardcoding
// (older gates omit it -> fall back to `write`). Otherwise CC's own native-tool table says
// it, which is harness-specific naming and therefore the adapter's business — stating it
// here is what spares every consumer downstream from classifying a tool NAME.
const access = target ? (touch?.access ?? 'write') : CC_FILE_ACCESS[String(payload.tool_name ?? '')]
// A rename carries its OLD path (`from`) so the name-history edge rides a stamped field.
const from = touch?.from
// A DELETE's `target` pins the readable LAST-LIVE commit (`touch.priorCommit`), so the produced
// DELETION commit (`touch.commit`) can't be read back off `target` for `span.commits`. Forward it
// as a `[[::@sha]]` referent on `committed`. `priorCommit` is the delete discriminator: only a
// delete sets it, so `committed` rides only a delete (unset for write / edit / rename, whose
// `target` already pins the produced commit).
const committed = touch?.priorCommit ? (commitReferent(touch.commit) ?? undefined) : undefined
// The observe round-trip returns any mediator `review` text — the POST-tool announcement channel
// (B2-i). A mediator watching this completed tool_call can attach "gate cleared → now at X" or, the
// sharp case, a SILENT failed gate's "⚠ still at s_make — exit gate unmet: …" to the tool's OWN
// result. We surface it as PostToolUse `additionalContext`, the post-run twin of the PreToolUse
// inject path — so failure announces itself instead of training the agent that "no card = done".
const reviewText = await observeEvent(payload, EventKind.ToolCall, {
  tool: payload.tool_name ?? null,
  input: payload.tool_input ?? null,
  tool_use_id: payload.tool_use_id ?? null,
  response: payload.tool_response ?? null,
  ...(target ? { target } : {}),
  ...(access ? { access } : {}),
  ...(from ? { from } : {}),
  ...(committed ? { committed } : {}),
  // WHICH agent made the call: present for a subagent's tool hook, absent for the main agent.
  ...agentFields(payload),
})
if (reviewText) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reviewText },
    }),
  )
}
await liftTranscript(payload)
process.exit(0)
