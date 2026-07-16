#!/usr/bin/env node

/**
 * persyst-hook.js — Claude Code Hook for Persyst Memory (PAMP-Enhanced)
 * 
 * Automatically injects relevant memories into Claude Code's context
 * on SessionStart and UserPromptSubmit events, and queues conversation
 * turns for async background extraction on Stop events.
 * 
 * PAMP Integration (Persyst Auto-Memory Pipeline):
 *   - Tier 1: Agent-explicit add_memory calls (existing, unchanged)
 *   - Tier 2: Heuristic regex extraction on UserPromptSubmit (sync, zero-cost)
 *   - Tier 3: Async LLM extraction via background worker (spawned on Stop)
 * 
 * How it works:
 *   1. Claude Code sends a JSON payload on stdin with hook_event_name, session_id, etc.
 *   2. This script connects to the Persyst MCP server via StdioClientTransport.
 *   3. It calls get_optimized_context or search_memories to retrieve relevant memories.
 *   4. It returns a JSON response on stdout with additionalContext for Claude Code to inject.
 *   5. On Stop: queues the conversation text for background LLM extraction.
 * 
 * Installation:
 *   npx persyst-mcp setup
 * 
 * Manual registration in ~/.claude/settings.json:
 *   { "hooks": { "SessionStart": [...], "UserPromptSubmit": [...], "Stop": [...] } }
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, resolve, join } from 'path';
import { spawn } from 'child_process';
import { writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// CONFIGURATIONS
// ============================================================

// Minimum prompt length to trigger memory search (skip "y", "ok", "/run", etc.)
const MIN_PROMPT_LENGTH = 15;

// Maximum time to wait for Persyst MCP connection (ms)
const CONNECTION_TIMEOUT = 8000;

// Hard timeout for the entire hook execution (ms)
// Claude Code will kill the hook if it exceeds this
const MAX_HOOK_LATENCY_MS = 500;

// Maximum active queue jobs before skipping worker spawn
const MAX_QUEUE_JOBS = 20;

// Queue directory for background extraction jobs
const QUEUE_DIR = join(homedir(), '.persyst', 'queue');

// ============================================================
// STDIN READER
// ============================================================

/**
 * Read the full JSON payload from stdin.
 * Claude Code sends the hook context as a single JSON object.
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error(`Failed to parse stdin JSON: ${e.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

// ============================================================
// MCP CLIENT CONNECTION
// ============================================================

let isHttpAvailable = true;
let stdioClient = null;

async function getStdioClient() {
  if (stdioClient) return stdioClient;
  stdioClient = await connectToPersyst();
  return stdioClient;
}

function callToolViaHttp(toolName, args, timeoutMs = 150) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ name: toolName, arguments: args });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 4321,
      path: '/tool',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error('HTTP timeout'));
    });

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP status ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Connect to the Persyst MCP server as a client.
 * Uses StdioClientTransport to spawn and communicate with the server.
 */
async function connectToPersyst() {
  // Resolve the path to Persyst's index.js
  let persystPath = '{{PERSYST_INDEX_PATH}}';
  if (persystPath.startsWith('{{')) {
    persystPath = resolve(__dirname, '..', 'index.js');
  }

  const transport = new StdioClientTransport({
    command: 'node',
    args: [persystPath]
  });

  const client = new Client({
    name: 'persyst-hook',
    version: '1.0.0'
  });

  // Connect with a timeout
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Persyst connection timeout')), CONNECTION_TIMEOUT)
    )
  ]);

  return client;
}

/**
 * Call a Persyst MCP tool and parse the JSON result.
 */
async function callTool(client, toolName, args) {
  if (isHttpAvailable) {
    try {
      const httpResult = await callToolViaHttp(toolName, args, 150);
      if (httpResult && httpResult.content && httpResult.content[0] && httpResult.content[0].text) {
        return JSON.parse(httpResult.content[0].text);
      }
    } catch (err) {
      isHttpAvailable = false;
      process.stderr.write(`[persyst-hook] HTTP Gateway call failed (${err.message}). Falling back to stdio client.\n`);
    }
  }

  const activeClient = await getStdioClient();
  const result = await activeClient.callTool({ name: toolName, arguments: args });
  if (result.content && result.content[0] && result.content[0].text) {
    return JSON.parse(result.content[0].text);
  }
  return null;
}

// ============================================================
// PAMP: QUEUE MANAGEMENT
// ============================================================

/**
 * Count active job files in the queue directory.
 * Used for worker pool protection — don't spawn if overloaded.
 * @returns {number}
 */
function countQueueJobs() {
  try {
    if (!existsSync(QUEUE_DIR)) return 0;
    return readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json')).length;
  } catch (_) {
    return 0;
  }
}

/**
 * Write a conversation turn to the extraction queue.
 * @param {string} text - The conversation text to extract from
 * @param {Object} meta - Metadata (session_id, agent_id, etc.)
 */
function enqueueJob(text, meta = {}) {
  try {
    mkdirSync(QUEUE_DIR, { recursive: true });

    const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const jobFile = join(QUEUE_DIR, `${jobId}.json`);

    writeFileSync(jobFile, JSON.stringify({
      text,
      session_id: meta.session_id || null,
      agent_id: meta.agent_id || 'claude-code',
      namespace: meta.namespace || 'shared',
      cwd: meta.cwd || null,
      queued_at: new Date().toISOString(),
      _retries: 0
    }, null, 2));

    return jobId;
  } catch (err) {
    // Non-critical — log and continue
    process.stderr.write(`[persyst-hook] Queue write failed: ${err.message}\n`);
    return null;
  }
}

/**
 * Spawn the background extraction worker as a detached process.
 * The worker runs independently — hook doesn't wait for it.
 */
function spawnWorker() {
  // Check queue depth first
  const queueDepth = countQueueJobs();
  if (queueDepth > MAX_QUEUE_JOBS) {
    process.stderr.write(`[persyst-hook] Queue overloaded (${queueDepth} jobs), skipping worker spawn.\n`);
    return;
  }

  try {
    let workerPath = '{{PERSYST_WORKER_PATH}}';
    if (workerPath.startsWith('{{')) {
      workerPath = resolve(__dirname, '..', 'bin', 'extract-worker.js');
    }

    const child = spawn('node', [workerPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    });

    // Unref so the hook can exit without waiting for the worker
    child.unref();
  } catch (err) {
    process.stderr.write(`[persyst-hook] Worker spawn failed: ${err.message}\n`);
  }
}

// ============================================================
// EVENT HANDLERS
// ============================================================

/**
 * Handle SessionStart: load project-wide context and ingest git history.
 */
async function handleSessionStart(input) {
  const cwd = input.cwd || process.cwd();
  const repoName = cwd.replace(/\\/g, '/').split('/').pop();

  const contextResult = await callTool(null, 'get_optimized_context', {
    query: `Project ${repoName} conventions, architecture, user preferences, coding rules`,
    max_tokens: 2000,
    agent_id: 'claude-code',
    session_id: input.session_id || undefined
  });

  // 2. Ingest recent git commits (best-effort, don't fail if not a git repo)
  try {
    await callTool(null, 'ingest_git_commits', {
      repo_path: cwd,
      count: 15
    });
  } catch (_) {
    // Not a git repo or git not available — that's fine
  }

  // 3. Build the additional context string
  let additionalContext = '';
  if (contextResult && contextResult.context) {
    additionalContext = contextResult.context;
  }

  // 4. Get memory count for status line
  let memoryCount = 0;
  try {
    const recentResult = await callTool(null, 'get_recent_memories', { limit: 1 });
    if (recentResult && recentResult.count !== undefined) {
      // The count from get_recent is just the returned count, not total
      // Use a search to estimate total active memories
      const importantResult = await callTool(null, 'get_important_memories', { limit: 100 });
      memoryCount = importantResult?.count || 0;
    }
  } catch (_) {
    // Non-critical
  }

  if (additionalContext) {
    additionalContext = `[Persyst Memory: ${memoryCount} memories loaded for project "${repoName}"]\n${additionalContext}`;
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: additionalContext || undefined
    }
  };
}

/**
 * Handle UserPromptSubmit: search for memories relevant to the user's prompt.
 * Also runs Tier 2 heuristic extraction inline (zero-cost).
 */
async function handleUserPromptSubmit(input) {
  const prompt = input.prompt || '';

  // Skip trivial prompts (commands, confirmations, short inputs)
  if (prompt.trim().length < MIN_PROMPT_LENGTH) {
    return {};
  }

  // --- Tier 2: Run heuristic extraction inline (sync, zero-cost) ---
  // We don't store results here — we queue them alongside the LLM job.
  // This just detects if there's extractable signal in the prompt.
  let heuristicFacts = [];
  try {
    const { extractHeuristic } = await import('../src/extractor-heuristic.js');
    heuristicFacts = extractHeuristic(prompt);
  } catch (_) {
    // Heuristic module not available — Tier 3 will handle it
  }

  // Queue the prompt for Tier 3 background extraction (non-blocking)
  enqueueJob(prompt, {
    session_id: input.session_id,
    agent_id: 'claude-code',
    cwd: input.cwd
  });

  // --- Memory Retrieval (existing behavior) ---
  // Use search_memories for speed on per-prompt lookups (faster than get_optimized_context)
  const searchResult = await callTool(null, 'search_memories', {
    query: prompt.slice(0, 200), // Truncate very long prompts for search efficiency
    limit: 5,
    agent_id: 'claude-code',
    session_id: input.session_id || undefined
  });

  if (!searchResult || !searchResult.results || searchResult.results.length === 0) {
    return {};
  }

  // Format memories as context
  let contextLines = ['=== PERSYST MEMORY (auto-retrieved) ==='];
  for (const mem of searchResult.results) {
    contextLines.push(`• [Memory #${mem.id}] ${mem.content}`);
  }

  // Add heuristic extraction notice if any facts were detected
  if (heuristicFacts.length > 0) {
    contextLines.push('');
    contextLines.push(`[PAMP: ${heuristicFacts.length} fact signal(s) detected, queued for extraction]`);
  }

  contextLines.push('=== END MEMORY ===');

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contextLines.join('\n')
    }
  };
}

/**
 * Handle Stop: queue the final conversation turn for background extraction
 * and spawn the worker to process the queue.
 */
async function handleStop(input) {
  // The Stop event may include conversation_turns or transcript data
  const transcript = input.transcript || input.conversation || '';

  if (transcript && typeof transcript === 'string' && transcript.length > MIN_PROMPT_LENGTH) {
    enqueueJob(transcript, {
      session_id: input.session_id,
      agent_id: 'claude-code',
      cwd: input.cwd
    });
  }

  // Spawn background worker to process all queued jobs
  spawnWorker();

  return {};
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

async function main() {
  try {
    const input = await readStdin();
    const eventName = input.hook_event_name;

    // Handle Stop event without MCP connection (just queue + spawn)
    if (eventName === 'Stop') {
      const response = await handleStop(input);
      console.log(JSON.stringify(response));
      return;
    }

    // Only handle events we care about
    if (eventName !== 'SessionStart' && eventName !== 'UserPromptSubmit') {
      console.log(JSON.stringify({}));
      return;
    }

    const hookStart = Date.now();

    let response;
    if (eventName === 'SessionStart') {
      response = await handleSessionStart(input);
    } else if (eventName === 'UserPromptSubmit') {
      // Apply hard timeout for prompt-time hook execution
      response = await Promise.race([
        handleUserPromptSubmit(input),
        new Promise((resolve) =>
          setTimeout(() => {
            process.stderr.write(`[persyst-hook] UserPromptSubmit hit ${MAX_HOOK_LATENCY_MS}ms timeout, returning partial.\n`);
            resolve({});
          }, MAX_HOOK_LATENCY_MS - (Date.now() - hookStart))
        )
      ]);
    } else {
      response = {};
    }

    console.log(JSON.stringify(response));

  } catch (err) {
    // Hooks must NEVER break Claude Code — always fail silently
    console.error(`[persyst-hook] Error: ${err.message}`);
    console.log(JSON.stringify({}));
  } finally {
    // Clean up MCP connection
    if (stdioClient) {
      try { await stdioClient.close(); } catch (_) {}
    }
    process.exit(0);
  }
}

main();
