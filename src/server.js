/**
 * server.js — MCP Server Setup
 * 
 * Creates the MCP server, registers all tools, and connects
 * via stdio transport (the standard MCP communication method).
 * Sets up hourly temporal decay and daily consolidation background tasks.
 * 
 * IMPORTANT: Never write to stdout — it's reserved for MCP protocol.
 * All logging goes to stderr via console.error().
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, cleanupWatchers } from './tools.js';
import { applyTemporalDecay, closeDatabase } from './database.js';
import { consolidateMemories } from './search.js';

/**
 * Start the Persyst MCP server.
 * This is called from index.js (the entry point).
 */
export async function startServer() {
  // --- Create MCP server ---
  const server = new McpServer({
    name: 'persyst',
    version: '2.1.0'
  });

  // --- Register all tools ---
  const registeredCount = registerTools(server);
  console.error(`[persyst] ${registeredCount} tools registered ✓`);

  // --- Start temporal decay timer ---
  // Runs every hour: reduces importance of memories not accessed in 7+ days
  const decayTimer = setInterval(applyTemporalDecay, 3600000);

  // --- Start daily consolidation sweep ---
  // Runs every 24 hours: merges similar memories (similarity > 0.85)
  const consolidationTimer = setInterval(async () => {
    console.error('[persyst] Running scheduled daily memory consolidation sweep...');
    try {
      const report = await consolidateMemories();
      console.error(`[persyst] Consolidation sweep completed: consolidated ${report.consolidated_groups} duplicate groups.`);
    } catch (err) {
      console.error('[persyst] Daily consolidation sweep failed:', err.message);
    }
  }, 86400000);

  // --- Graceful shutdown (Bug 3 fix: also cleans up git watchers) ---
  const shutdown = () => {
    console.error('[persyst] Shutting down...');
    clearInterval(decayTimer);
    clearInterval(consolidationTimer);
    cleanupWatchers();  // Bug 3 fix: stop all git repo watchers
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Connect via stdio ---
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[persyst] MCP server running on stdio ✓');
  console.error('[persyst] Ready to receive tool calls');
}
