#!/usr/bin/env node
// `au-mcp-adapter-cc gen-inject --workspace <entry>` — the launcher's hook into the inject
// capability, the always-on-context twin of `gen-skills`.
//
// Deliberately THIN, exactly as gen-skills is. All orchestration and IO belong to au-mcp's
// `materializeInjects` driver; this parses args, supplies the CC transform, and prints the
// resulting plugin dirs.
//
// Contract with the au-host launcher:
// - stdout is the plugin dirs, ONE PER LINE (one for injects: a single `au-inject` plugin).
//   The launcher adds a `--plugin-dir` per line to its `claude` command.
// - exit 0 with EMPTY stdout when the workspace has no injects. Not an error.
// - diagnostics go to stderr, so capturing stdout stays safe.
// - the engine daemon must already be up on <entry>; ENSURING that is the launcher's job.
//
// `--inject <owner:name>` materializes ONLY the selected subset (repeatable and/or
// comma-split); absent = all. This is the axis a host agent-profile drives.

import { resolve } from 'node:path'

import { injectManifest, materializeInjects } from '@arsumbris/au-mcp'
import { LAUNCH_ENV } from '@arsumbris/au-mcp-sdk'

import { injectTransform } from '../src/inject-cc.ts'

const USAGE =
  'usage: gen-inject --workspace <entry> [--manifest] [--inject <owner:name> ...]\n' +
  '  (entry = the folder-repo the engine was started on)'

function parseWorkspace(argv: string[]): string | null {
  const i = argv.indexOf('--workspace')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  return process.env[LAUNCH_ENV.WORKSPACE] ?? null
}

/** The `--inject` selection: every value after a `--inject` flag up to the next flag, comma-split. */
function parseSelect(argv: string[]): string[] | undefined {
  const keys: string[] = []
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--inject') continue
    seen = true
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) {
      keys.push(...argv[j].split(',').map((k) => k.trim()).filter(Boolean))
    }
  }
  return seen ? keys : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const workspace = parseWorkspace(argv)
  if (!workspace) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }
  const entry = resolve(workspace)

  // Manifest mode: enumerate the discovered injects (key/owner/name/description/role/bytes +
  // skipped-with-reasons) as JSON, write nothing. The host renders its inject picker from this.
  if (argv.includes('--manifest')) {
    process.stdout.write(`${JSON.stringify(await injectManifest(entry))}\n`)
    return
  }

  const select = parseSelect(argv)
  const result = await materializeInjects(entry, 'cc', injectTransform, select ? { select } : {})

  // Never silently dropped: an instance that claimed mcp.inject but could not be assembled
  // is a real authoring error the human needs to see.
  for (const { path, reason } of result.skipped) {
    process.stderr.write(`gen-inject: skipped ${path} — ${reason}\n`)
  }
  if (result.collected.length > 0) {
    process.stderr.write(`gen-inject: swept ${result.collected.length} dead-socket gen tree(s)\n`)
  }
  // The OUT-OF-BAND overflow channel: a profile over its slot budget loses content on every
  // launch. Surface it to the HUMAN on stderr (the agent gets the same set in-band), so an
  // over-budget profile is visible where it is set. A host launcher reads the same `dropped`
  // set off the structured result.
  if (result.dropped.length > 0) {
    process.stderr.write(
      `gen-inject: BUDGET EXCEEDED — ${result.dropped.length} block(s) not injected: ${result.dropped
        .map((d) => d.addr)
        .join(', ')}\n`,
    )
  }

  for (const dir of result.pluginDirs) process.stdout.write(`${dir}\n`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `gen-inject failed: ${message}\n` +
      'Is the engine daemon running on this workspace? The launcher must bring it up first.\n',
  )
  process.exit(1)
})
