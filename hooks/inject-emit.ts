#!/usr/bin/env node
// The inject emitter — the trusted, content-agnostic entrypoint every generated inject
// hook runs.
//
// A generated `au-inject` plugin ships one SessionStart hook per slot, and each runs THIS
// file with one argument: the absolute path of a slot's content file inside the plugin.
// The emitter reads that file and wraps it verbatim in the SessionStart `additionalContext`
// envelope. That is all it does.
//
// The split matters for trust: the COMMAND CC runs is always this adapter file, never
// package-authored code. The package contributes only DATA (the content file), which this
// trusted entrypoint emits. So an inject can put text in front of the agent but can never
// run code at launch — unlike a loadable tool. See [[spec - mcp.inject - typed instances
// whose bodies land in context at session start, hop-expanded and packed across generated
// hook slots::au-harness]].

import * as fs from 'node:fs'

const file = process.argv[2]
if (!file) {
  process.stderr.write('inject-emit: missing content-file argument\n')
  process.exit(2)
}

// A missing content file is a torn / half-swept gen tree, not a reason to fail the launch.
// Emit nothing and exit clean: a slot that cannot be read simply contributes no context.
let content: string
try {
  content = fs.readFileSync(file, 'utf8')
} catch {
  process.exit(0)
}

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: content } }),
)
process.exit(0)
