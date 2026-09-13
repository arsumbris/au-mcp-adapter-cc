// Lift the touched-file pin out of CC's tool response.
//
// A file-op MUTATION (write_file / edit_file) returns, through the gate, a structured
// result `{ message, touched: { path, commit?, priorCommit? } }` (au-mcp's `mutationResult`;
// a DELETE also carries `priorCommit`, the last-live commit the tombstone pin resolves at). CC
// delivers a tool's result to the PostToolUse hook as an MCP content array,
// `[{ type: 'text', text }]`, where `text` is that result JSON-stringified (the
// mcp-server shim flattens a non-string result to one text block). So to recover the
// pin we concatenate the text block(s) and parse the `touched` field back out.
//
// This is CC-shaped I/O (the adapter's job): the SDK owns the `FileOpTouch` contract
// and the `pinnedFileTarget` syntax; here we only translate CC's transport into that
// contract. A read (numbered text), an error (a plain string), or any non-mutation
// result carries no `touched` and yields null — the caller then leaves `target` unset.

import type { FileOpTouch } from '@arsumbris/au-mcp-sdk'

/** Concatenate the text of an MCP content array, or pass a bare string through. */
function responseText(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse
  if (Array.isArray(toolResponse)) {
    return (toolResponse as Array<{ text?: unknown }>)
      .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
      .join('')
  }
  return ''
}

/** Parse the file-op `touched` pin material out of a CC tool response, or null. */
export function extractTouch(toolResponse: unknown): FileOpTouch | null {
  const text = responseText(toolResponse).trim()
  if (!text || text[0] !== '{') return null // fast-path: only a JSON object can carry `touched`
  let parsed: { touched?: unknown }
  try {
    parsed = JSON.parse(text) as { touched?: unknown }
  } catch {
    return null // not JSON (a read's numbered listing, an error string)
  }
  const t = parsed?.touched
  if (t && typeof t === 'object' && typeof (t as FileOpTouch).path === 'string') {
    return t as FileOpTouch
  }
  return null
}
