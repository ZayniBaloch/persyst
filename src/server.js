/**
 * server.js — MCP Server Setup
 * 
 * Creates the MCP server, registers all tools, and connects
 * via stdio transport (the standard MCP communication method).
 * 
 * IMPORTANT: Never write to stdout — it's reserved for MCP protocol.
 * All logging goes to stderr via console.error().
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools.js';
import { applyTemporalDecay, closeDatabase } from './database.js';

/**
 * Start the Persyst MCP server.
 * This is called from index.js (the entry point).
 */
export async function startServer() {
  // --- Create MCP server ---
  const server = new McpServer({
    name: 'persyst',
    version: '1.0.0'
  });

  // --- Register all 7 tools ---
  registerTools(server);
  console.error('[persyst] 7 tools registered ✓');

  // --- Start temporal decay timer ---
  // Runs every hour: reduces importance of memories not accessed in 7+ days
  const decayTimer = setInterval(applyTemporalDecay, 3600000);

  // --- Graceful shutdown ---
  const shutdown = () => {
    console.error('[persyst] Shutting down...');
    clearInterval(decayTimer);
    closeDatabase();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Connect via stdio ---
  // This is how Claude Code, Cursor, and Aider communicate with us
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[persyst] MCP server running on stdio ✓');
  console.error('[persyst] Ready to receive tool calls');
}
