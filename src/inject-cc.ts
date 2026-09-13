// The CC shape for materialized injects — the adapter's ONLY contribution to the inject
// capability.
//
// "Adapters only adapt": au-mcp owns discovery, path derivation, the atomic write, the GC,
// and the lifecycle. The single harness-specific question is "what files does Claude Code
// want on disk so this context lands at session start", and that is this file: a PURE
// injects -> files mapping, with no filesystem, path, or GC code. au-mcp writes what this
// returns.
//
// The CC delivery vehicle for always-on context is a synthetic PLUGIN carrying SessionStart
// HOOKS. Unlike skills (one plugin per owner, for slash-command namespacing), injects need
// no namespace — they are never invoked by name — so all injects share ONE plugin. Each
// SLOT (a budget-sized bundle of one or more rendered blocks) becomes one content file plus
// one SessionStart hook that runs the adapter's trusted emitter against that file.
//
// The packing (blocks -> budget-sized slots + the overflow set) is au-mcp's neutral
// `packBlocks`; this file supplies only the CC-specific parts — the block RENDERING (the
// addressed envelope), the per-slot BUDGET (CC caps each hook near 10K chars), and the file
// SHAPING (plugin.json + hooks.json + content files). "Adapters only adapt."
//
// See [[spec - mcp.inject - typed instances whose bodies land in context at session start,
// hop-expanded and packed across generated hook slots::au-harness]].

import * as path from 'node:path'

import { packBlocks, type DroppedInject, type InjectBlock, type InjectTree, type PackBlock } from '@arsumbris/au-mcp'

/** The single synthetic plugin every inject's hook lives under. */
const PLUGIN = 'au-inject'

/**
 * The per-slot character budget: headroom under Claude Code's ~10K-char per-hook output cap,
 * for the JSON `additionalContext` envelope the emitter adds and the block wrapper tags.
 * Matches the value eidos packs its session-start units at.
 */
const CC_SLOT_BUDGET = 8500

/**
 * The trusted emitter CC runs for every slot, resolved to an ABSOLUTE path at gen time.
 * It is an adapter file, never part of the generated (package-authored) tree — the command
 * CC runs is always ours, the content is always data. Baked absolute because the gen tree
 * is ephemeral (re-derived per launch) and never portable.
 */
const EMITTER = path.resolve(import.meta.dirname, '../hooks/inject-emit.ts')

/** The default transform: CC's slot budget, uncapped (a profile passes `maxSlots` later). */
export function injectTransform(blocks: InjectBlock[]): InjectTree {
  return renderInjectTree(blocks, { budget: CC_SLOT_BUDGET })
}

/**
 * Render expanded blocks to the CC plugin tree, packing them into budget-sized slots.
 *
 * The blocks arrive already expanded (seed + hops) from au-mcp; this only RENDERS each block's
 * addressed envelope and packs. Budget + `maxSlots` are parameters (not the hardcoded default)
 * so the packing is testable at small sizes and a profile can cap the prepaid cost. When a
 * `maxSlots` cap drops blocks, a final IN-BAND overflow slot names them for the agent, and
 * `dropped` carries the same set OUT to the launcher for the human.
 */
export function renderInjectTree(blocks: InjectBlock[], opts: { budget: number; maxSlots?: number }): InjectTree {
  if (blocks.length === 0) return { files: [], pluginRoots: [], dropped: [] }

  const packBlockList: PackBlock[] = blocks.map((b) => {
    const addr = `[[${b.stem}::${b.repo}]]`
    return { key: b.key, addr, text: injectedBlock(addr, b.body) }
  })

  const { slots, dropped } = packBlocks(packBlockList, opts)
  // The overflow notice is meta, not content, so it rides a final slot OUTSIDE the cap — the
  // agent must always be told what it is missing, even when the budget was the thing exceeded.
  const slotTexts = dropped.length > 0 ? [...slots, overflowNotice(dropped)] : slots

  const files: InjectTree['files'] = [
    { relPath: `${PLUGIN}/.claude-plugin/plugin.json`, content: pluginManifest(blocks.length, slotTexts.length) },
  ]
  const hookEntries = slotTexts.map((text, i) => {
    const stem = `slot-${i + 1}`
    files.push({ relPath: `${PLUGIN}/content/${stem}.md`, content: text.endsWith('\n') ? text : `${text}\n` })
    // `${CLAUDE_PLUGIN_ROOT}` expands to the plugin dir, where the content file lands. The
    // command is the trusted emitter (absolute), so package content never runs as code.
    return {
      hooks: [
        {
          type: 'command',
          command: `node --experimental-strip-types "${EMITTER}" "\${CLAUDE_PLUGIN_ROOT}/content/${stem}.md"`,
        },
      ],
    }
  })

  files.push({ relPath: `${PLUGIN}/hooks/hooks.json`, content: hooksJson(hookEntries) })
  return { files, pluginRoots: [PLUGIN], dropped }
}

/** The synthetic plugin manifest. Its `name` is fixed — injects need no per-owner namespace. */
function pluginManifest(blockCount: number, slotCount: number): string {
  const description =
    `Always-on session context generated from ${blockCount} injected block${blockCount === 1 ? '' : 's'}` +
    ` across ${slotCount} slot${slotCount === 1 ? '' : 's'}.`
  return `${JSON.stringify({ name: PLUGIN, version: '0.0.0', description }, null, 2)}\n`
}

/** The plugin's SessionStart hook registration — one entry per slot. */
function hooksJson(entries: unknown[]): string {
  return `${JSON.stringify({ hooks: { SessionStart: entries } }, null, 2)}\n`
}

/**
 * One block: the inject body wrapped in an ADDRESSED envelope.
 *
 * The envelope is not decoration. Verbatim concatenated prose with no attribution reads to the
 * agent as an instruction from the user; the tags mark the block as INJECTED CONTEXT and carry
 * its source as a `[[stem::repo]]` wikilink — a RESOLVABLE address, so the agent both knows
 * what this is and holds the exact object to follow or re-read. The address is repeated on the
 * close tag so a block boundary stays unambiguous once many blocks share a slot.
 */
function injectedBlock(addr: string, body: string): string {
  return `<injected file ${addr}>\n\n${body.trim()}\n\n</injected file ${addr}>\n`
}

/**
 * The IN-BAND overflow notice: a final slot naming every dropped block by its resolvable
 * address, so the agent knows exactly what the budget cut and can follow it. Same addressing
 * vocabulary as the injected blocks — the report and the blocks speak one language.
 */
function overflowNotice(dropped: DroppedInject[]): string {
  const list = dropped.map((d) => `- ${d.addr}`).join('\n')
  return (
    '<injected budget-overflow>\n\n' +
    `The always-on context budget was exceeded, so ${dropped.length} block${dropped.length === 1 ? ' was' : 's were'} ` +
    'NOT injected. Read them if relevant to the task:\n\n' +
    `${list}\n\n` +
    '</injected budget-overflow>\n'
  )
}
