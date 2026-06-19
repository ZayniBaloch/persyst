/**
 * server.js — MCP Server & Local HTTP Gateway Setup
 * 
 * Creates the MCP server, registers all tools, and connects via stdio.
 * Also spins up a local HTTP/JSON Gateway on port 4321 to support low-latency
 * prompt hooks and local agent swarms without subprocess overhead.
 * 
 * All logging goes to stderr via console.error().
 */

import http from 'http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, cleanupWatchers, addMemoryInternal, executeToolInternal } from './tools.js';
import { applyTemporalDecay, closeDatabase } from './database.js';
import { consolidateMemories, searchHybrid, getOptimizedContext } from './search.js';
import { startWatcher, stopWatcher } from './watcher.js';
import { verifyChainIntegrity } from './attestation.js';

/**
 * Start the Persyst MCP server & HTTP Gateway.
 */
export async function startServer() {
  // --- Create MCP server ---
  const server = new McpServer({
    name: 'persyst',
    version: '2.2.1'
  });

  // --- Register all tools ---
  const registeredCount = registerTools(server);
  console.error(`[persyst] ${registeredCount} tools registered ✓`);

  // --- Start background log watcher daemon ---
  startWatcher();

  // --- Start local HTTP Gateway (port 4321) ---
  const httpPort = 4321;
  const httpServer = http.createServer((req, res) => {
    // CORS headers for local swarms and browser testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST.' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body || '{}');

        if (req.url === '/search') {
          const { query, limit = 5, agent_id, session_id } = payload;
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: query' }));
            return;
          }
          const results = await searchHybrid(query, limit, agent_id, session_id, agent_id || null);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, results }));
          return;
        }

        if (req.url === '/add') {
          const { content, importance = 1.0, agent_id, session_id, shared = true } = payload;
          if (!content) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: content' }));
            return;
          }
          const result = await addMemoryInternal({ content, importance, agent_id, session_id, shared });
          if (result.error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify(result));
          return;
        }

        if (req.url === '/context') {
          const { query, max_tokens = 2000, agent_id, session_id } = payload;
          if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: query' }));
            return;
          }
          const context = await getOptimizedContext(query, max_tokens, agent_id, session_id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(context));
          return;
        }

        if (req.url === '/tool') {
          const { name, arguments: args } = payload;
          if (!name) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing required field: name' }));
            return;
          }
          const result = await executeToolInternal(name, args || {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        if (req.url === '/verify') {
          const result = await verifyChainIntegrity();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[persyst] HTTP Gateway port ${httpPort} is already in use. Stdio MCP server will continue running.`);
    } else {
      console.error('[persyst] HTTP Gateway error:', err.message);
    }
  });

  httpServer.listen(httpPort, '127.0.0.1', () => {
    console.error(`[persyst] HTTP Gateway listening on http://127.0.0.1:${httpPort} ✓`);
  });

  // --- Start temporal decay timer ---
  // Runs every hour: reduces importance of memories not accessed in 7+ days
  const decayTimer = setInterval(applyTemporalDecay, 3600000);

  // --- Start daily consolidation sweep ---
  // Runs every 24 hours: merges similar memories
  const consolidationTimer = setInterval(async () => {
    console.error('[persyst] Running scheduled daily memory consolidation sweep...');
    try {
      const report = await consolidateMemories();
      console.error(`[persyst] Consolidation sweep completed: consolidated ${report.consolidated_groups} duplicate groups.`);
    } catch (err) {
      console.error('[persyst] Daily consolidation sweep failed:', err.message);
    }
  }, 86400000);

  // --- Graceful shutdown ---
  const shutdown = () => {
    console.error('[persyst] Shutting down...');
    clearInterval(decayTimer);
    clearInterval(consolidationTimer);
    stopWatcher();      // Stop background log watcher
    cleanupWatchers();  // Stop all git repo watchers
    httpServer.close(); // Close HTTP gateway
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
