// @arsumbris/au-mcp-adapter-cc — the Claude Code adapter for the au-mcp kernel.
//
// Declares CC's native tool surface + bridges CC hooks to the daemon. Holds no
// deny/trace/mode logic. Built across Phase 5a (see the plan):
// - CC native surface + its extended event kinds (5a.4) ✓
// - the hook -> daemon bridge                     (5a.5) ✓
// - the 8 hook scripts                            (5a.6, hooks/*.ts)
// - the transcript lifter                         (5a.7)

export * from './surface.ts'
export * from './vocabulary-cc.ts'
export * from './bridge.ts'
export { buildTools, toolName, type McpToolDescriptor } from './advertise.ts'
export { runMcpServer } from './mcp-server.ts'
