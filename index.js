#!/usr/bin/env node

/**
 * Persyst MCP Server — Entry Point
 * 
 * A local-first memory server for coding agents.
 * Starts the MCP server on stdio transport.
 * 
 * Usage:
 *   node index.js          (direct)
 *   npx persyst-mcp        (via npm)
 *   persyst-mcp            (if installed globally)
 */

import { startServer } from './src/server.js';

await startServer().catch(err => {
  console.error('❌ Persyst failed to start:', err.message);
  process.exit(1);
});
