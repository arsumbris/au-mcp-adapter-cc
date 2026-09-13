// CC-specific event vocabulary — the adapter's EXTENSION of the SDK's generic
// vocabulary (decision 2606121303: the adapter extends with harness-specific kinds).
//
// Most CC events use the generic kinds + data shapes (from @arsumbris/au-mcp-sdk)
// directly. These are the genuinely CC-specific additions.
//
// KINDS, not leaf TYPES. There were once engine defs for these (`sessionEvent.cc.*` /
// `sessionEvent.external.cc.*`), from when the trace was a typed instance and every event
// carried a `type:` claim. The ledger is an unparsed asset now, so a kind string is the whole
// discriminator and the leaf names had nothing left to name.

import type { UserPromptData } from '@arsumbris/au-mcp-sdk'

/** CC-specific event kinds, beyond the SDK's generic set. */
export const CcEventKind = {
  /** Belt-one artifact: CC reported "No such tool available" (lifted from transcript). */
  ToolUnavailable: 'tool_unavailable',
  /** Capture-pipeline failure (lifter could not read the transcript, etc.). */
  CaptureError: 'capture_error',
} as const
export type CcEventKind = (typeof CcEventKind)[keyof typeof CcEventKind]

/** CC's user_prompt payload: the generic one plus CC's permission mode. */
export interface CcUserPromptData extends UserPromptData {
  permission_mode?: string
}
/** The `tool_unavailable` payload. */
export interface ToolUnavailableData {
  tool?: string
  input?: unknown
  tool_use_id?: string
  belt?: string
}
/** The `capture_error` payload. */
export interface CaptureErrorData {
  stage: string
  error: string
}
