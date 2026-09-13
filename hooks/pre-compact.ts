#!/usr/bin/env node
// PreCompact -> compaction event.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent } from '../src/bridge.ts'

const payload = await readPayload(process.stdin)
await observeEvent(payload, EventKind.Compaction, {
  trigger: payload.trigger ?? null,
  custom_instructions: payload.custom_instructions ?? null,
})
process.exit(0)
