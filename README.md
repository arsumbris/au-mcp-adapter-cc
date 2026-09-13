---
type: au.engine.readme::au-engine
tldr: The Claude Code adapter for the au-mcp kernel — a thin daemon client binding CC to the kernel, holding no policy of its own. It advertises the daemon's tools to CC, bridges CC's lifecycle hooks to daemon calls, and lifts transcripts. Bind another harness by writing your own adapter against the SDK's adapter contract.
---

# Repo Overview

## General Context
Before defining what `au-mcp-adapter-cc` is,
here is some general context of the environment it exists in.

- `arsumbris` is a framework for agentic knowledge work.
- `au-engine` serves a graph over a cross-repo substrate of typed files.
- `au-host` is the UI part of the framework.
- `au-mcp` is the agent layer's KERNEL daemon — mechanism-only, it ships zero tools of its own.
- `au-mcp-sdk` is the contract the kernel, every plugin, and every adapter speak.
- `au-mcp-core` is the bundled baseline plugin package — the default tools + governance floors.

`au-mcp-adapter-cc` is part of this `arsumbris` framework.
It is the Claude Code binding for the agent layer.


## What this is

`au-mcp-adapter-cc` is the **Claude Code adapter** for the `au-mcp` kernel.
- a THIN daemon client that binds Claude Code (CC) to the kernel.
- it implements the adapter contract from `@arsumbris/au-mcp-sdk/adapter`.
- it holds NO policy of its own.
  - no deny logic, no trace logic, no governance mode.
  - those live in the daemon and the generic plugins (`au-mcp-core`), which run against this adapter's declared surface.
- so a second harness reuses the same daemon and the same plugins by shipping its own adapter.

The adapter is what an agent harness is expected to provide.
- the kernel and the plugins are harness-agnostic.
- the one thing only the adapter can state is CC's harness-specific surface.
  - the native tools it DECLARES to the daemon, each mapped to its gate equivalent where one exists
    - (`Bash` / `Read` / `Write` / `Edit` / `Glob` / `Grep` / `NotebookEdit` / `Task` / `Skill`).
  - which of them touch a file, and in which direction.
  - the CC lifecycle hook events, translated to generic daemon calls.

This repo is also a type-authoring repo.
- it self-declares its `mcp.adapter.cc` node in `type/` (`extends mcp.adapter::au-mcp-sdk`).
- identity is the def's type name (`mcp.adapter.cc`); the live adapter reports that same name as `AdapterInfo.harness` (the launcher's join key), so there is no identity field.
- the def carries two metas:
  - `adapter-runtime-meta` — the executable name (`agentBinary: claude`) + the explicit entries a launcher invokes (`launchEntry` / `skillsEntry` / `injectEntry`).
  - `adapter-presentation-meta` — the label + description a launcher surfaces.
- a launcher (au-host) discovers this node off the engine, so the adapter is a dropped-in repo, not a hardcoded key. See [[spec - mcp.adapter type - the harness adapter as a discovered typed node::au-mcp-sdk]].

### What it binds

**The MCP-server shim** (`src/mcp-server.ts`, `bin/mcp-server.ts`)
- a stdio MCP server CC connects to (wired as the `au` server in `.mcp.json`, `alwaysLoad`).
- on startup it asks the daemon which callables are active and advertises each as a CC tool.
  - the tool name, description, and JSON-Schema input all come from the tool's own engine def, carried on the manifest.
  - the adapter forwards them. It holds no tool table of its own.
- a tool call just forwards `invoke` to the daemon and returns the result.
  - the daemon validates the input at the gate. The shim holds no validation logic.
- it also loads the standing session instructions, generated from what this session actually advertises.

**The hook bridge** (`src/bridge.ts`, `hooks/*.ts`)
- each CC hook is a short-lived process (see `hooks/hooks.json`).
  - it reads the hook payload, resolves the session + workspace, connects to the daemon, forwards one request, and exits.
- the lifecycle mapping:
  - `SessionStart` -> `session-open` (declaring CC's native surface + the native-tool allowlist) + a `session_start` observe. It also fetches the daemon's COMPUTED session-start inject (`session-start-context`) — the output of any `session-start` hooks (e.g. "N instances of type T") — and emits it as `additionalContext` after the posture note. The adapter forwards these blocks verbatim; it holds no knowledge of what a hook computed.
  - `UserPromptSubmit` / `PostToolUse` / `PreCompact` / `Notification` -> `observe`.
  - `PreToolUse` -> `mediate` (the daemon's allow / deny / inject becomes the CC hook decision).
  - `SubagentStop` / `Stop` / `SessionEnd` -> transcript lift + `turn-end` / `session-close`.
- best-effort at the HOOK layer, but the degradation is SURFACED, never silent.
  - a down daemon must never BREAK the user's CC session, so capture + mediation degrade rather than crash.
    - mediation fails OPEN when unreachable (CC stays usable, ungoverned for that turn), rather than fail-closed and wedging the editor.
  - but the problem is surfaced LOUDLY, matching au-mcp's fail-loud ethos:
    - a missing launch handle prepends a HIGHEST-PRIORITY standing note ("surface this to the user immediately") + refuses each gate call legibly + a SessionStart hook note.
    - a down daemon makes a gate tool call fail with a clear "restart the daemon" message.

**The transcript lifter** (`src/lift.ts`)
- rescans CC's transcript to recover what the hooks cannot see.
  - assistant text / thinking, "No such tool available" attempts, and failed calls (`PostToolUse` fires only on success).
- on a `--resume` / `--continue` launch it also replays the prior run's observable conversation to the daemon, so `consultTrace` sees it.

**The launch surface** (`bin/launch.ts`, `bin/gen-skills.ts`, `bin/gen-inject.ts`, `src/launch-cc.ts`)
- turns the harness-agnostic launch (owned by `au-mcp` + the SDK) into a runnable `claude` invocation.
- materializes typed `mcp.skill` / `mcp.inject` instances into per-owner CC plugin dirs.
  - one synthetic CC plugin per owner repo, so a skill is namespaced `/<owner>:<skill>` with no collisions.

**A CC-specific event vocabulary** (`src/vocabulary-cc.ts`)
- extends the SDK's generic session-event kinds with the genuinely CC-specific ones.
  - `tool_unavailable`, `capture_error`.
- most events use the SDK's generic kinds directly.
- these are TypeScript KINDS (a `CcEventKind` const + payload interfaces), NOT engine type-defs.


## How to use this

`au-mcp-adapter-cc` is a **Claude Code plugin**, not a standalone program.
- CC loads it with `--plugin-dir <path-to-this-repo>`.
- loading it wires both surfaces at once:
  - the `au` MCP server from `.mcp.json` (the gate tools).
  - the lifecycle hooks from `hooks/hooks.json` (capture + mediation).
- the hook scripts and the shim are TypeScript, run directly via `node --experimental-strip-types`. No build step.

For it to function, two things must be in place.
- the `au-mcp` daemon must be running for the workspace (the human or `au-host` starts it).
- the session must inherit its launch env.
  - the closed `AU_MCP_*` names, defined once in the SDK so the launcher (producer) and the adapter (reader) cannot drift.
  - `AU_MCP_WORKSPACE` (the entry folder), `AU_MCP_SESSION` (the per-launch handle), `AU_MCP_NATIVE_TOOLS`.
  - `AU_MCP_PROFILE` (the active agent-profile locator): forwarded opaquely as `AdapterInfo.profile`, the daemon resolves the profile from the graph to read its typed `hooks` / `hookConfig` AND its `tools` visibility allowlist. Absent = a bare launch, no profile (unrestricted).
  - tool VISIBILITY has no env of its own (the `AU_MCP_TOOLS` list is retired, plan 2609072337): the shim forwards the profile locator on `list-capabilities` (the advertise runs before session-open) and the daemon resolves the allowlist from the profile's `tools`. Restriction always names a saved `--profile`.
- a missing `AU_MCP_SESSION` handle DEGRADES rather than crashes.
  - the gate stays up and lists its tools, but every call refuses legibly, so the misconfiguration is surfaced at the point of use.

A launcher assembles all of this for you.
- `au-host` is the first-party launcher.
- `bin/launch.ts` is a bare CLI launcher.
  - it materializes skills + injects, builds the `AU_MCP_*` env, and prints one JSON launch (`{ session, binary, argv, env, command }`).
  - the caller spawns `{binary, argv, env}`, or runs `command` in a terminal pane.

Depends on:
- `@arsumbris/au-mcp-sdk` — the adapter contract + the wire client + the launch-env names.
- `@arsumbris/au-mcp` — the kernel-side launch drivers it composes (`materialize`, `buildLaunchEnv`, ...).
- `@modelcontextprotocol/sdk` — the MCP server the CC side speaks.

Consumed as **TypeScript source** — there is no build step.
- the family convention: `type: module`, run source, `tsc --noEmit` to typecheck, `vitest` to test.


## How to extend this

This repo is the **reference adapter**. You extend the agent layer for a new harness by writing your OWN adapter, in your own repo, against the same contract.

To bind a different agent harness to the daemon:
- implement the interface from `@arsumbris/au-mcp-sdk/adapter`.
  - declare your harness's native tool surface (the twin of `src/surface.ts`).
  - bridge your harness's hook / lifecycle I/O to the daemon (the twin of `src/bridge.ts`).
  - map the harness-agnostic launch into a runnable command for your harness (the twin of `src/launch-cc.ts`).
- hold no policy of your own.
  - the generic plugins run against your declared surface, so they carry over unchanged.
- add only the harness-specific event kinds your harness needs (the twin of `src/vocabulary-cc.ts`).

See `au-mcp-sdk`'s "Build a harness adapter" for the contract, and this repo as the worked example.

To add tools, hooks, skills, or injects instead of a whole harness, you do NOT touch this repo.
- build them against `@arsumbris/au-mcp-sdk` and mount them as workspace members.
- see `au-mcp-sdk`'s "How to extend this", or invoke its guides: `/au-mcp-sdk:build-a-plugin`, `/au-mcp-sdk:build-a-skill`, `/au-mcp-sdk:build-a-session-inject`.
