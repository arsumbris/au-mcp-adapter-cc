#!/usr/bin/env node
// Notification -> notification event.
import { EventKind } from '@arsumbris/au-mcp-sdk'
import { readPayload, observeEvent } from '../src/bridge.ts'

const payload = await readPayload(process.stdin)
await observeEvent(payload, EventKind.Notification, { message: payload.message ?? null })
process.exit(0)
