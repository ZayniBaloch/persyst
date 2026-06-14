#!/usr/bin/env node

/**
 * Persyst MCP Server — Entry Point
 * 
 * A local-first memory server for coding agents.
 * Starts the MCP server on stdio transport.
 * 
 * Usage:
 *   node index.js          (direct — starts MCP server)
 *   npx persyst-mcp        (via npm — starts MCP server)
 *   npx persyst-mcp setup  (install Claude Code hooks)
 *   npx persyst-mcp init   (initialize workspace rules & git hooks)
 *   npx persyst-mcp ingest (manually ingest git commits)
 *   persyst-mcp            (if installed globally)
 */

// Handle subcommands before starting the server
const subcommand = process.argv[2];

if (subcommand === 'setup') {
  // Delegate to the setup CLI
  await import('./bin/setup.js');
} else if (subcommand === 'aider') {
  // Shift 'aider' from process.argv so aider.js gets the correct arguments
  process.argv.splice(2, 1);
  await import('./bin/aider.js');
} else if (subcommand === 'init') {
  // Delegate to the rules init CLI
  await import('./bin/init.js');
} else if (subcommand === 'ingest') {
  // Shift 'ingest' from process.argv so ingest.js gets the correct arguments
  process.argv.splice(2, 1);
  await import('./bin/ingest.js');
} else if (subcommand === 'extract') {
  // Shift 'extract' from process.argv so extract.js gets the correct arguments
  process.argv.splice(2, 1);
  await import('./bin/extract.js');
} else if (subcommand === 'worker') {
  // Run the background extraction worker directly
  await import('./bin/extract-worker.js');
} else {
  // Default: start the MCP server
  const { startServer } = await import('./src/server.js');
  await startServer().catch(err => {
    console.error('❌ Persyst failed to start:', err.message);
    process.exit(1);
  });
}
