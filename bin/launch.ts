#!/usr/bin/env node
// The CC LAUNCHER entrypoint — `au-mcp-adapter-cc launch`.
//
// Thin, like `gen-skills`/`gen-inject`: it composes the au-mcp-owned core (the `materialize`
// driver + `buildLaunchEnv`) with the CC command transform (`ccLaunchCommand`), and prints a
// ready launch. The spawning launcher (au-host) provides its tool-paths (the `claude` binary);
// the adapter dir is self-located.
//
// Contract with the spawning launcher: stdout is ONE JSON object
//   { session, binary, argv, env, command }
// Spawn `{binary, argv, env}`, or run `command` in a terminal pane. Diagnostics go to stderr.
//
// The engine daemon must be up on the entry (materialize reads the type graph). A materialize
// failure DEGRADES to no plugin dirs and the launch still proceeds — parity with gen-skills.
//
// See [[spec - agent launch surface - one owned env contract, hard defaults over profiles, a
// launcher split like gen::au-harness]].

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { materialize, materializeInjects } from '@arsumbris/au-mcp'
import { buildLaunchEnv, LAUNCH_ENV } from '@arsumbris/au-mcp-sdk'

import { ccTransform } from '../src/skills-cc.ts'
import { injectTransform } from '../src/inject-cc.ts'
import { ccLaunchCommand } from '../src/launch-cc.ts'

const USAGE =
  'usage: launch --workspace <entry> --binary <claude> [--adapter <dir>]\n' +
  '              [--native-tools <a,b>] [--skills <owner:name> ...] [--inject <owner:name> ...]\n' +
  '              [--profile <locator>] [--resume <session-id>]\n' +
  '  (entry = the folder-repo the engine was started on; adapter dir is self-located if omitted)\n' +
  '  (--native-tools is tri-state: absent = all; present-empty = none; list = only those)\n' +
  '  (tool VISIBILITY is set by the --profile agent-profile\'s `tools`, not a launch flag; see the tool-visibility spec)\n' +
  '  (--resume <id> resumes a dormant CC session by its id from `list-dormant`; pass its --profile back to restore the surface)'

/** The value after a flag, or undefined when the flag is absent. */
function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i !== -1 ? argv[i + 1] : undefined
}

/** A repeatable, comma-split selection (`--skills a:b,c:d` == `--skills a:b --skills c:d`); absent -> undefined. */
function parseSelect(argv: string[], name: string): string[] | undefined {
  const keys: string[] = []
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== name) continue
    seen = true
    for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) {
      keys.push(...argv[j].split(',').map((k) => k.trim()).filter(Boolean))
    }
  }
  return seen ? keys : undefined
}

/** Materialize skills or inject, degrading to no dirs (with a stderr hint) rather than failing the launch. */
async function safeDirs(label: string, run: () => Promise<{ pluginDirs: string[] }>): Promise<string[]> {
  try {
    return (await run()).pluginDirs
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`launch: ${label} skipped (${message}); is the engine daemon up on this workspace?\n`)
    return []
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)

  const workspace = flagValue(argv, '--workspace') ?? process.env[LAUNCH_ENV.WORKSPACE]
  const binary = flagValue(argv, '--binary')
  if (!workspace || !binary) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }
  const entry = resolve(workspace)
  // The adapter dir is the plugin root CC loads (`<adapter>/bin/launch.ts` -> `<adapter>`).
  const adapterDir = flagValue(argv, '--adapter') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')

  // Tool VISIBILITY is NOT a launch flag (plan 2609072337): restriction is the --profile
  // agent-profile's typed `tools`, resolved by the daemon from the graph. The launcher forwards
  // only the profile locator. See the tool-visibility spec + [[todo - 2609080017 - reconsider an
  // inline-by-value --profile-data ad-hoc launch channel]] for a future ad-hoc path.
  // Tool restriction — typed `tools` AND native `nativeToolAllowlist` — is no longer a launch flag:
  // both resolve daemon-side from the active agent-profile (--profile). The launcher carries no
  // allowlist; a restricted session names a profile that declares one.
  const skills = parseSelect(argv, '--skills')
  const inject = parseSelect(argv, '--inject')
  // Absent = all; a present-but-empty flag = NONE (a real, but easy-to-typo, selection). Hint, since
  // a silently skill-less/inject-less session is hard to spot.
  if (skills?.length === 0) process.stderr.write('launch: --skills present with no values -> NO skills selected (empty, not "all"); omit --skills for all.\n')
  if (inject?.length === 0) process.stderr.write('launch: --inject present with no values -> NO injects selected (empty, not the default set); omit --inject for the default.\n')

  // The active agent-profile locator (--profile). The daemon resolves it from the graph at
  // session-open to read the session's typed `hooks` / `hookConfig`; absent = a bare launch.
  // (Per-hook config is typed on the profile now — the untyped --plugin-config is retired.)
  const profile = flagValue(argv, '--profile')

  // RESUME an existing CC session by its id (from `list-dormant`). The host filters that list by
  // `harness` (only offers CC sessions here) and passes the recorded `--profile` back, so this
  // launcher stays thin: it just threads `--resume <id>` into the command. A fresh AU_MCP_SESSION
  // handle is minted regardless — the kernel keys the durable session by CC's restored `session_id`.
  const resume = flagValue(argv, '--resume')

  const skillDirs = await safeDirs('skills', () => materialize(entry, 'cc', ccTransform, skills ? { select: skills } : {}))
  const injectDirs = await safeDirs('inject', () => materializeInjects(entry, 'cc', injectTransform, inject ? { select: inject } : {}))

  const { env, session } = buildLaunchEnv({ workspace: entry, profile })
  const launch = ccLaunchCommand(env, [...skillDirs, ...injectDirs], { binary, adapterDir }, { resume })

  process.stdout.write(`${JSON.stringify({ session, ...(resume ? { resume } : {}), ...launch })}\n`)
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`launch failed: ${message}\n`)
  process.exit(1)
})
