#!/usr/bin/env node
// `au-mcp-adapter-cc gen-skills --workspace <entry>` — the launcher's hook into the
// skills capability.
//
// Deliberately THIN. All orchestration and IO belong to au-mcp's `materialize` driver;
// this parses args, supplies the CC transform, and prints the resulting plugin dirs.
// The driver runs in this process, which is an execution-context detail — au-mcp still
// owns the behaviour, and never calls an adapter itself.
//
// Contract with the au-host launcher:
// - stdout is the per-owner plugin dirs, ONE PER LINE, nothing else. The launcher adds
//   a `--plugin-dir` per line to its `claude` command (CC's flag points at a single
//   plugin root, and we generate one plugin per owner repo).
// - exit 0 with EMPTY stdout when the workspace has no skills. Not an error: no skills
//   simply means CC launches with no extra ones.
// - diagnostics go to stderr, so capturing stdout stays safe.
// - the engine daemon must already be up on <entry>; ENSURING that is the launcher's
//   job, which it already does before building the `claude` command. We error clearly
//   rather than starting one.
//
// Two additive modes for host agent-profiles (message 260721200323):
// - `--manifest`: print JSON of the discovered skills (owner/name/description/allowed-tools
//   + skipped-with-reasons) to stdout, write nothing. The host renders its picker from this
//   instead of walking the generated CC trees.
// - `--skills <owner:name>`: materialize ONLY the selected subset (repeatable and/or
//   comma-split). No `--skills` = all, unchanged. The key round-trips from the manifest.

import { resolve } from 'node:path'

import { materialize, skillManifest } from '@arsumbris/au-mcp'
import { LAUNCH_ENV } from '@arsumbris/au-mcp-sdk'

import { ccTransform } from '../src/skills-cc.ts'

const USAGE =
  'usage: gen-skills --workspace <entry> [--manifest] [--skills <owner:name> ...]\n' +
  '  (entry = the folder-repo the engine was started on)'

function parseWorkspace(argv: string[]): string | null {
  const i = argv.indexOf('--workspace')
  if (i !== -1 && argv[i + 1]) return argv[i + 1]
  // AU_MCP_WORKSPACE is the same entry the MCP-server shim and the launcher already agree on.
  return process.env[LAUNCH_ENV.WORKSPACE] ?? null
}

/**
 * The `--skills` selection: every value after a `--skills` flag up to the next flag,
 * with each value also comma-split. So `--skills a:b,c:d` and `--skills a:b --skills c:d`
 * and `--skills a:b c:d` all yield the same set. Absent entirely => undefined (all).
 */
function parseSelect(argv: string[]): string[] | undefined {
  const keys: string[] = []
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--skills') continue
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

  // Manifest mode: enumerate, print JSON, write nothing.
  if (argv.includes('--manifest')) {
    const manifest = await skillManifest(entry)
    process.stdout.write(`${JSON.stringify(manifest)}\n`)
    return
  }

  const select = parseSelect(argv)
  const result = await materialize(entry, 'cc', ccTransform, select ? { select } : {})

  // Never silently dropped: an instance that claimed mcp.skill but could not be
  // assembled is a real authoring error the human needs to see.
  for (const { path, reason } of result.skipped) {
    process.stderr.write(`gen-skills: skipped ${path} — ${reason}\n`)
  }
  if (result.collected.length > 0) {
    process.stderr.write(`gen-skills: swept ${result.collected.length} dead-socket gen tree(s)\n`)
  }

  // THE contract: plugin dirs on stdout, one per line. Empty when there are no skills.
  for (const dir of result.pluginDirs) process.stdout.write(`${dir}\n`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `gen-skills failed: ${message}\n` +
      'Is the engine daemon running on this workspace? The launcher must bring it up first.\n',
  )
  process.exit(1)
})
