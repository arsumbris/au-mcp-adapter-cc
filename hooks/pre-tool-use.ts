#!/usr/bin/env node
// PreToolUse -> ask the daemon to mediate, apply the decision as the hook output.
// deny -> CC blocks the tool (the daemon already traced tool_denied via redirect);
// allow/inject -> the tool runs, so capture a tool_start; inject adds context.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, mediateAction, observeEvent, agentFields } from '../src/bridge.ts'

const payload = await readPayload(process.stdin)
const tool = String(payload.tool_name ?? '')
const input = payload.tool_input ?? {}

const decision = await mediateAction(payload, { tool, input })

if (decision.kind === 'deny') {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    }),
  )
  process.exit(0)
}

if (decision.kind === 'ask') {
  // Defer to the HUMAN: CC surfaces a native approve/deny prompt for this tool call
  // (the human sees the tool + input + this reason). We do NOT capture a tool_start
  // here — approval is pending; if approved, the tool runs and PostToolUse captures
  // the completed tool_call (which downstream gating reads as "approved").
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: decision.reason,
      },
    }),
  )
  process.exit(0)
}

// The tool will run: capture its start.
await observeEvent(payload, EventKind.ToolStart, {
  tool,
  input,
  tool_use_id: payload.tool_use_id ?? null,
  // WHICH agent made the call: present for a subagent's tool hook, absent for the main agent.
  ...agentFields(payload),
})

// Both `inject` and an `allow` carrying a `note` (B2-iii, e.g. "approved by the human") surface
// their text as PreToolUse `additionalContext` on the allowed action — the note is a distinct,
// first-class allow-branch signal rather than free text riding an inject.
const extraContext = decision.kind === 'inject' ? decision.text : decision.kind === 'allow' ? decision.note : undefined
if (extraContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        additionalContext: extraContext,
      },
    }),
  )
}
process.exit(0)
