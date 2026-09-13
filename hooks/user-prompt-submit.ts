#!/usr/bin/env node
// UserPromptSubmit -> user_prompt event (the turn boundary). permission_mode is
// CC-specific (rides as an extra field on the payload).
//
// GOVERNANCE (Phase 6, P6-O2): an `@file` mention inlines file content with NO tool call,
// so the gate never sees it — an ungoverned read. This hook fires BEFORE expansion + sees
// the raw prompt, so in a native-restricted session (denyNative) it BLOCKS the
// prompt, steering the user to the gate's read_file_pinned. Block is all-or-nothing (CC can't
// strip just the mention); an ungoverned session is unaffected.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent, sessionGuards } from '../src/bridge.ts'
import { hasFileMention } from '../src/mentions.ts'

const payload = await readPayload(process.stdin)
const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''

if (hasFileMention(prompt) && (await sessionGuards(payload)).denyNative) {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        'This session is governed: @file mentions bypass the au gate (they inline file content untraced, with no tool call). Remove the @ and ask me to read the file — I will use the governed read_file_pinned tool.',
    }),
  )
  process.exit(0)
}

await observeEvent(payload, EventKind.UserPrompt, {
  prompt: payload.prompt ?? null,
  permission_mode: payload.permission_mode ?? null,
})
process.exit(0)
