// The CC launch command shape — the adapter's launch-side contribution.
//
// "Adapters only adapt": au-mcp/sdk owns `buildLaunchEnv` (the session handle + the `AU_MCP_*`
// env) and the `materialize` driver; this turns the harness-agnostic `{env, pluginDirs}` into a
// runnable Claude Code invocation. It is the LAUNCH-side twin of `ccTransform` (the skills->files
// mapping) — a second harness (codex, opencode) is a second function like this one, no new core.
// See [[spec - agent launch surface - one owned env contract, hard defaults over profiles, a
// launcher split like gen::au-harness]].

import { LAUNCH_ENV } from '@arsumbris/au-mcp-sdk'

/** Where the launcher finds the harness bits (the spawning launcher's tool-paths). */
export interface CcLaunchPaths {
  /** The `claude` binary (PATH name or absolute). */
  binary: string
  /** The `au-mcp-adapter-cc` plugin dir (CC loads it as `--plugin-dir`). */
  adapterDir: string
}

/** A runnable Claude Code launch: the env, the binary, its argv, and a ready shell command. */
export interface CcLaunch {
  /** The session env, plus `CLAUDE_PROJECT_DIR` (CC's project dir = the workspace entry). */
  env: Record<string, string>
  /** The binary to spawn. */
  binary: string
  /** Args after the binary: `--resume <id>` (resume only), then the adapter, then one
   *  `--plugin-dir` per materialized dir. */
  argv: string[]
  /** A ready, env-prefixed, shell-quoted command string (for a terminal pane). */
  command: string
}

/** Launch-shape options: RESUME an existing CC session by its id (the durable session id from
 *  `list-dormant`, which CC preserves across `--resume`). Absent -> a fresh launch. The env is
 *  built the same either way: a fresh `AU_MCP_SESSION` handle is fine, since the kernel keys the
 *  durable session by CC's restored `session_id`, not the handle, and re-binds the handle at open. */
export interface CcLaunchOpts {
  resume?: string
}

/** POSIX single-quote a shell argument (safe for arbitrary paths/values). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Assemble a Claude Code launch from the harness-agnostic `{env, pluginDirs}`.
 *
 * argv passes the adapter first, then one `--plugin-dir` per materialized dir (skills + inject).
 * `CLAUDE_PROJECT_DIR` is set to the workspace (CC's project-dir semantics, and the adapter's
 * fallback locator). `command` is env-prefixed + shell-quoted for a terminal pane; a caller
 * preferring a structured spawn uses `{env, binary, argv}` directly.
 */
export function ccLaunchCommand(
  env: Record<string, string>,
  pluginDirs: string[],
  paths: CcLaunchPaths,
  opts: CcLaunchOpts = {},
): CcLaunch {
  const fullEnv = { ...env, CLAUDE_PROJECT_DIR: env[LAUNCH_ENV.WORKSPACE] }
  // `--resume <id>` first (resume only): CC restores that session_id, whose SessionStart re-opens the
  // SAME durable kernel session, so the daemon detects the resume and rehydrates.
  const argv = opts.resume ? ['--resume', opts.resume] : []
  argv.push('--plugin-dir', paths.adapterDir)
  for (const dir of pluginDirs) argv.push('--plugin-dir', dir)
  const envPrefix = Object.entries(fullEnv)
    .map(([k, v]) => `${k}=${shellQuote(v)}`)
    .join(' ')
  const command = `${envPrefix} ${shellQuote(paths.binary)} ${argv.map(shellQuote).join(' ')}`
  return { env: fullEnv, binary: paths.binary, argv, command }
}
