/**
 * server.js — MCP Server, Local HTTP Gateway & Swarm Hub
 *
 * Creates the MCP server, registers all tools, and connects via stdio.
 * Also runs a local HTTP/JSON Gateway on port 4321 (configurable) to support:
 *   - Agentic swarms without subprocess overhead
 *   - IDE context injection via /system-prompt
 *   - Real-time event streaming via SSE (/events)
 *   - Batch operations for high-throughput swarm agents
 *   - Optional API key authentication for remote/multi-host setups
 *
 * Environment variables:
 *   PORT             — HTTP gateway port (default: 4321)
 *   PERSYST_HOST     — Bind address (default: 127.0.0.1, use 0.0.0.0 for Docker/remote)
 *   PERSYST_API_KEY  — Optional auth token. If set, all endpoints (except /health) require
 *                      Authorization: Bearer <token>
 *
 * All logging goes to stderr via console.error().
 */

import http from 'http';
import { URL } from 'url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, cleanupWatchers, addMemoryInternal, executeToolInternal } from './tools.js';
import {
  applyTemporalDecay,
  closeDatabase,
  getActiveMemoryCount,
  getNamespaceStats,
  getAllAgentStats
} from './database.js';
import { consolidateMemories, searchHybrid, getOptimizedContext } from './search.js';
import { startWatcher, stopWatcher } from './watcher.js';
import { verifyChainIntegrity } from './attestation.js';
import { memoryEventBus } from './events.js';

// Track server birth time for uptime reporting
const SERVER_START_TIME = Date.now();

// Active SSE client response objects
const sseClients = new Set();

// ============================================================
// SYSTEM PROMPT FORMATTER
// ============================================================

/**
 * Format optimized context data into a structured system-prompt block.
 * Supports three output formats: 'text', 'markdown', 'json'.
 *
 * @param {Object} contextData - Result from getOptimizedContext()
 * @param {string} format - 'text' | 'markdown' | 'json'
 * @param {string|null} agentId
 * @returns {string}
 */
function formatSystemPrompt(contextData, format, agentId) {
  const { memories, suggested_actions } = contextData;
  const now = new Date().toLocaleString('en-US', { hour12: false }).replace(',', '');
  const count = memories.length;

  if (format === 'json') {
    return JSON.stringify({ ...contextData, generated_at: new Date().toISOString() }, null, 2);
  }

  // Group memories by category prefix
  const groups = {
    'Rules & Conventions':   [],
    'Architecture & Stack':  [],
    'Decisions':             [],
    'Preferences':           [],
    'Context':               []
  };

  for (const m of memories) {
    const c = m.content;
    if (/^(?:Rule|Config):/i.test(c))          groups['Rules & Conventions'].push(c);
    else if (/^(?:Stack|Architecture):/i.test(c)) groups['Architecture & Stack'].push(c);
    else if (/^Decision:/i.test(c))              groups['Decisions'].push(c);
    else if (/^Preference:/i.test(c))            groups['Preferences'].push(c);
    else                                          groups['Context'].push(c);
  }

  if (format === 'markdown') {
    let md = `# Persyst Memory Context\n`;
    md += `> ${count} memories | Updated: ${now}`;
    if (agentId) md += ` | Agent: \`${agentId}\``;
    md += '\n\n';

    for (const [section, items] of Object.entries(groups)) {
      if (items.length === 0) continue;
      md += `## ${section}\n`;
      for (const item of items) md += `- ${item}\n`;
      md += '\n';
    }

    if (suggested_actions.length > 0) {
      md += `## Suggested Actions\n`;
      for (const a of suggested_actions) md += `- ${a}\n`;
      md += '\n';
    }

    md += `---\n*Refresh: \`curl http://127.0.0.1:4321/system-prompt?format=markdown\`*\n`;
    return md;
  }

  // Plain text (default) — safe to paste into any IDE custom instructions
  let text = `=== PERSYST MEMORY CONTEXT ===\n`;
  text += `Updated: ${now} | ${count} memories`;
  if (agentId) text += ` | Agent: ${agentId}`;
  text += '\n\n';

  for (const [section, items] of Object.entries(groups)) {
    if (items.length === 0) continue;
    text += `[${section.toUpperCase()}]\n`;
    for (const item of items) text += `• ${item}\n`;
    text += '\n';
  }

  if (suggested_actions.length > 0) {
    text += `[SUGGESTED ACTIONS]\n`;
    for (const a of suggested_actions) text += `• ${a}\n`;
    text += '\n';
  }

  text += `=== END MEMORY CONTEXT ===\n`;
  text += `Refresh: curl http://127.0.0.1:${process.env.PORT || '4321'}/system-prompt\n`;
  return text;
}

// ============================================================
// REQUEST HANDLERS
// ============================================================

async function handleGetRequest(req, res, url) {
  const path = url.pathname;

  // ----------------------------------------------------------
  // GET /health — server liveness check for orchestrators
  // ----------------------------------------------------------
  if (path === '/health') {
    const uptime = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    let memories = 0;
    try { memories = getActiveMemoryCount(); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      version: '2.2.5',
      uptime_seconds: uptime,
      memories,
      sse_clients: sseClients.size
    }));
    return;
  }

  // ----------------------------------------------------------
  // GET /stats — memory and agent statistics
  // ----------------------------------------------------------
  if (path === '/stats') {
    try {
      const namespaces = getNamespaceStats();
      const agents = getAllAgentStats();
      const uptime = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uptime_seconds: uptime, namespaces, agents }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ----------------------------------------------------------
  // GET /system-prompt — formatted memory context for IDE injection
  //
  // Query params:
  //   query      — search query (default: broad project context)
  //   max_tokens — token budget (default: 1500)
  //   agent_id   — restrict to this agent's namespace
  //   format     — 'text' (default) | 'markdown' | 'json'
  // ----------------------------------------------------------
  if (path === '/system-prompt') {
    try {
      const query = url.searchParams.get('query') ||
        'project conventions architecture preferences rules stack decisions';
      const maxTokens = Math.max(100, parseInt(url.searchParams.get('max_tokens') || '1500', 10));
      const agentId = url.searchParams.get('agent_id') || null;
      const format = url.searchParams.get('format') || 'text';

      const contextData = await getOptimizedContext(
        query, maxTokens, agentId, null, agentId || null, null
      );

      const output = formatSystemPrompt(contextData, format, agentId);

      const contentTypeMap = {
        json: 'application/json',
        markdown: 'text/markdown; charset=utf-8',
        text: 'text/plain; charset=utf-8'
      };
      res.writeHead(200, {
        'Content-Type': contentTypeMap[format] || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(output);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ----------------------------------------------------------
  // GET /events — Server-Sent Events stream of memory changes
  //
  // Clients subscribe once and receive real-time push notifications
  // for memory_added, memory_deleted, memories_consolidated events.
  //
  // Example (Python):
  //   import sseclient, requests
  //   for event in sseclient.SSEClient('http://127.0.0.1:4321/events'):
  //       print(event.event, event.data)
  //
  // Example (Node.js):
  //   const es = new EventSource('http://127.0.0.1:4321/events');
  //   es.addEventListener('memory_added', e => console.log(JSON.parse(e.data)));
  // ----------------------------------------------------------
  if (path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'  // Prevents nginx from buffering SSE
    });

    // Send initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({
      ok: true,
      timestamp: new Date().toISOString(),
      server_version: '2.2.5'
    })}\n\n`);

    sseClients.add(res);

    // Heartbeat every 15s to keep connection alive through proxies
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch (_) { clearInterval(heartbeat); }
    }, 15000);

    const onAdded = (data) => {
      try { res.write(`event: memory_added\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };
    const onDeleted = (data) => {
      try { res.write(`event: memory_deleted\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };
    const onConsolidated = (data) => {
      try { res.write(`event: memories_consolidated\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };

    memoryEventBus.on('memory_added', onAdded);
    memoryEventBus.on('memory_deleted', onDeleted);
    memoryEventBus.on('memories_consolidated', onConsolidated);

    req.on('close', () => {
      clearInterval(heartbeat);
      memoryEventBus.off('memory_added', onAdded);
      memoryEventBus.off('memory_deleted', onDeleted);
      memoryEventBus.off('memories_consolidated', onConsolidated);
      sseClients.delete(res);
      console.error(`[persyst-sse] Client disconnected. Active: ${sseClients.size}`);
    });

    console.error(`[persyst-sse] Client connected. Active: ${sseClients.size}`);
    return; // Keep connection alive — do NOT end response
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
}

async function handlePostRequest(req, res, payload) {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;

  // ----------------------------------------------------------
  // POST /remember — quick one-liner memory save
  //
  // The user explicitly wants to save something. No extraction,
  // no filtering, no pattern matching. Just store it.
  //
  // Body: { content: string, importance?: number, namespace?: string }
  //   OR: plain text body (e.g. from curl --data "don't forget X")
  //
  // Example:
  //   curl -X POST http://127.0.0.1:4321/remember \
  //        -H 'Content-Type: text/plain' \
  //        --data 'SSL cert expires March 15'
  // ----------------------------------------------------------
  if (path === '/remember') {
    // Support both plain text and JSON bodies
    let content, importance, namespace;
    if (typeof payload === 'string') {
      content = payload.trim();
      importance = 1.0;
      namespace = 'shared';
    } else {
      content = payload.content || payload.text || payload.note || payload.message;
      importance = payload.importance || 1.0;
      namespace = payload.namespace || 'shared';
    }

    if (!content) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No content provided. Pass plain text or { content: "..." }' }));
      return;
    }

    // Prefix with Note: if not already categorized
    const normalizedContent = /^(?:Note|Reminder|Rule|Decision|Preference|Stack|Architecture|Config|Warning|FYI):/i.test(content.trim())
      ? content.trim()
      : `Note: ${content.trim()}`;

    const result = await addMemoryInternal({
      content: normalizedContent,
      importance,
      agent_id: payload.agent_id || null,
      session_id: payload.session_id || null,
      shared: payload.shared !== false
    });

    if (!result.error) {
      memoryEventBus.emit('memory_added', {
        id: result.id,
        content: normalizedContent,
        namespace: result.namespace || namespace,
        source: 'user-explicit'
      });
    }

    res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ----------------------------------------------------------
  // POST /search
  // ----------------------------------------------------------
  if (path === '/search') {
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

  // ----------------------------------------------------------
  // POST /add
  // ----------------------------------------------------------
  if (path === '/add') {
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
      // Broadcast to SSE subscribers
      memoryEventBus.emit('memory_added', {
        id: result.id,
        content,
        namespace: result.namespace,
        source: agent_id || 'http'
      });
    }
    res.end(JSON.stringify(result));
    return;
  }

  // ----------------------------------------------------------
  // POST /context
  // ----------------------------------------------------------
  if (path === '/context') {
    const { query, max_tokens = 2000, agent_id, session_id, intent } = payload;
    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required field: query' }));
      return;
    }
    const context = await getOptimizedContext(query, max_tokens, agent_id, session_id, agent_id || null, intent);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(context));
    return;
  }

  // ----------------------------------------------------------
  // POST /tool — generic MCP tool invocation
  // ----------------------------------------------------------
  if (path === '/tool') {
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

  // ----------------------------------------------------------
  // POST /verify — chain integrity check
  // ----------------------------------------------------------
  if (path === '/verify') {
    const attestationId = payload?.attestation_id;
    const result = verifyChainIntegrity(attestationId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }

  // ----------------------------------------------------------
  // POST /batch/add — store multiple memories in one round trip
  //
  // Body: { memories: [{ content, importance?, agent_id?, shared? }, ...] }
  // Returns: { success, results: [...], stored, skipped, errors }
  //
  // Designed for:
  //   - Swarm agents ingesting session summaries in bulk
  //   - Migration tools
  //   - CI pipelines storing build/test results
  // ----------------------------------------------------------
  if (path === '/batch/add') {
    const { memories } = payload;
    if (!Array.isArray(memories) || memories.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'memories must be a non-empty array' }));
      return;
    }

    // Hard cap: prevent abuse
    if (memories.length > 200) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Batch size exceeds maximum of 200' }));
      return;
    }

    const results = [];
    let stored = 0;
    let skipped = 0;
    let errors = 0;

    for (const mem of memories) {
      const { content, importance = 1.0, agent_id, session_id, shared = true } = mem;
      if (!content) {
        results.push({ error: 'Missing content', input: mem });
        errors++;
        continue;
      }
      try {
        const result = await addMemoryInternal({ content, importance, agent_id, session_id, shared });
        results.push(result);
        if (result.error) {
          errors++;
        } else if (result.message && result.message.includes('already exists')) {
          skipped++;
        } else {
          stored++;
          memoryEventBus.emit('memory_added', {
            id: result.id,
            content,
            namespace: result.namespace,
            source: agent_id || 'batch'
          });
        }
      } catch (err) {
        results.push({ error: err.message, input: mem });
        errors++;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, results, stored, skipped, errors }));
    return;
  }

  // ----------------------------------------------------------
  // POST /batch/search — run multiple queries in one round trip
  //
  // Body: { queries: string[] | Array<{query, limit?, agent_id?}>, limit?: number }
  // Returns: { results: { "<query>": [...memories] } }
  //
  // Designed for:
  //   - Swarm agents loading context for multiple topics at once
  //   - Parallel memory retrieval without sequential round trips
  // ----------------------------------------------------------
  if (path === '/batch/search') {
    const { queries, limit = 5 } = payload;
    if (!Array.isArray(queries) || queries.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'queries must be a non-empty array' }));
      return;
    }

    if (queries.length > 50) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Batch query size exceeds maximum of 50' }));
      return;
    }

    // Run all searches in parallel for speed
    const searchPromises = queries.map(async (q) => {
      if (typeof q === 'string') {
        return { key: q, results: await searchHybrid(q, limit, null, null, null) };
      } else if (q && typeof q === 'object' && q.query) {
        return {
          key: q.query,
          results: await searchHybrid(q.query, q.limit || limit, q.agent_id || null, null, q.agent_id || null)
        };
      }
      return { key: String(q), results: [] };
    });

    const settled = await Promise.allSettled(searchPromises);
    const results = {};
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        results[s.value.key] = s.value.results;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, results }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Endpoint Not Found' }));
}

// ============================================================
// MAIN SERVER STARTUP
// ============================================================

/**
 * Start the Persyst MCP server & HTTP Gateway.
 */
export async function startServer() {
  // --- Create MCP server ---
  const server = new McpServer({
    name: 'persyst',
    version: '2.2.5'
  });

  // --- Register all tools ---
  const registeredCount = registerTools(server);
  console.error(`[persyst] ${registeredCount} tools registered ✓`);

  // --- Start background log watcher daemon (skip in test mode) ---
  if (process.env.NODE_ENV !== 'test') {
    startWatcher();
  }

  // --- Gateway configuration ---
  const httpPort = parseInt(process.env.PORT || '4321', 10);
  const httpHost = process.env.PERSYST_HOST || '127.0.0.1';
  const configuredApiKey = process.env.PERSYST_API_KEY || null;

  if (configuredApiKey) {
    console.error(`[persyst] API key auth enabled — endpoints require Authorization: Bearer <key>`);
  }
  if (httpHost !== '127.0.0.1') {
    console.error(`[persyst] ⚠️  Gateway bound to ${httpHost} — ensure PERSYST_API_KEY is set for security`);
  }

  // --- Start local HTTP Gateway ---
  const httpServer = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API key authentication middleware
    // /health is always public (for orchestrators / Docker health checks)
    if (configuredApiKey) {
      const urlPath = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      if (urlPath !== '/health') {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (token !== configuredApiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'Unauthorized. Set header: Authorization: Bearer <PERSYST_API_KEY>'
          }));
          return;
        }
      }
    }

    // Route GET requests (no body reading needed)
    if (req.method === 'GET') {
      try {
        const url = new URL(req.url || '/', `http://${httpHost}`);
        handleGetRequest(req, res, url).catch(err => {
          try {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          } catch (_) {}
        });
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request URL' }));
      }
      return;
    }

    // Route POST requests
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed. Use POST or GET.' }));
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        // Handle both JSON and plain-text bodies (plain text used by /remember)
        const contentType = req.headers['content-type'] || '';
        let payload;
        if (contentType.includes('text/plain')) {
          payload = body.trim(); // Will be handled as string in /remember
        } else {
          payload = JSON.parse(body || '{}');
        }
        await handlePostRequest(req, res, payload);
      } catch (err) {
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } catch (_) {}
      }
    });
  });

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[persyst] HTTP Gateway port ${httpPort} already in use. Stdio MCP server will continue.`);
    } else {
      console.error('[persyst] HTTP Gateway error:', err.message);
    }
  });

  httpServer.listen(httpPort, httpHost, () => {
    console.error(`[persyst] HTTP Gateway listening on http://${httpHost}:${httpPort} ✓`);
    console.error(`[persyst] Endpoints: /health /stats /system-prompt /events /remember /search /add /context /tool /verify /batch/add /batch/search`);
  });

  // --- Start temporal decay timer (every hour) ---
  const decayTimer = setInterval(applyTemporalDecay, 3600000);

  // --- Start daily consolidation sweep ---
  const consolidationTimer = setInterval(async () => {
    console.error('[persyst] Running scheduled daily memory consolidation sweep...');
    try {
      const report = await consolidateMemories();
      console.error(`[persyst] Consolidation sweep: consolidated ${report.consolidated_groups} duplicate groups.`);
      if (report.consolidated_groups > 0) {
        memoryEventBus.emit('memories_consolidated', {
          consolidated_groups: report.consolidated_groups,
          details: report.details
        });
      }
    } catch (err) {
      console.error('[persyst] Daily consolidation sweep failed:', err.message);
    }
  }, 86400000);

  // --- Graceful shutdown ---
  const shutdown = () => {
    console.error('[persyst] Shutting down...');
    clearInterval(decayTimer);
    clearInterval(consolidationTimer);
    stopWatcher();
    cleanupWatchers();

    // Close all SSE connections gracefully
    for (const client of sseClients) {
      try {
        client.write(`event: server_shutdown\ndata: ${JSON.stringify({ message: 'Server shutting down' })}\n\n`);
        client.end();
      } catch (_) {}
    }
    sseClients.clear();

    httpServer.close();
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
