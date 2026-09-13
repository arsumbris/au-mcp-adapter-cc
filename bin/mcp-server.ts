#!/usr/bin/env node
// The MCP-server shim entry. CC spawns this (see .mcp.json) and speaks MCP over
// stdio. It serves the workspace ENTRY, which under the schema-16 folder-repo model is
// the entry DIRECTORY (the folder carrying .arsumbris/repo.yaml). The daemon socket is
// hashed off that entry folder, so producer and consumer agree as long as both pass the
// same folder. Prefer AU_MCP_WORKSPACE (au-host passes the exact entry folder); else
// CLAUDE_PROJECT_DIR, CC's normalized project DIRECTORY, which now IS the correct entry
// (entry == root, so the old file-vs-dir socket mismatch is gone); else cwd.
// (History: pre-folder-repo the entry was a *.au-workspace.yaml FILE, so CLAUDE_PROJECT_DIR's
// dir-normalization hashed to the wrong socket — au-host message 260715160914. Folder-repo
// dissolved that conflation.)
import { resolve } from 'node:path'
import { LAUNCH_ENV } from '@arsumbris/au-mcp-sdk'
import { runMcpServer } from '../src/mcp-server.ts'

// A missing AU_MCP_SESSION no longer exits: the server starts DEGRADED (tools listed, every call
// refuses legibly) so the human sees WHY instead of a silent "failed" server. See runMcpServer.
await runMcpServer(resolve(process.env[LAUNCH_ENV.WORKSPACE] ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()))
