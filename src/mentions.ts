// Detect CC `@file` mentions in a raw prompt (Phase 6, P6-O2).
//
// CC inlines an `@path` file into the prompt at submit time with NO tool call, so the
// gate (a PreToolUse hook) never sees it — an ungoverned read. The `UserPromptSubmit`
// hook fires BEFORE expansion and sees the RAW prompt, so it can detect + block the
// mention there (only when the session is governed).
//
// HEURISTIC: match `@` at a word boundary followed by a path-like token (one containing
// a `.` or `/`). This catches `@notes/hello.md` / `@hello.md` / `@./x` while skipping
// `@name` mentions and `user@host.com` emails (the `@` there is not at a word boundary).
// It can over/under-match; a governed session errs toward blocking. CC's own `@`-parser
// is authoritative but not reachable from a hook, hence the heuristic.

const FILE_MENTION = /(?:^|\s)@[^\s]*[./][^\s]*/

/** Does the prompt contain a path-like `@file` mention? */
export function hasFileMention(prompt: string): boolean {
  return FILE_MENTION.test(prompt)
}
