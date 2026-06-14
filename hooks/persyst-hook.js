#!/usr/bin/env node

/**
 * persyst-hook.js — Claude Code Hook for Persyst Memory
 * 
 * Automatically injects relevant memories into Claude Code's context
 * on SessionStart and UserPromptSubmit events.
 * 
 * How it works:
 *   1. Claude Code sends a JSON payload on stdin with hook_event_name, session_id, cwd, etc.
 *   2. This script connects to the Persyst MCP server via StdioClientTransport.
 *   3. It calls get_optimized_context or search_memories to retrieve relevant memories.
 *   4. It returns a JSON response on stdout with additionalContext for Claude Code to inject.
 * 
 * Installation:
 *   npx persyst-mcp setup
 * 
 * Manual registration in ~/.claude/settings.json:
 *   { "hooks": { "SessionStart": [...], "UserPromptSubmit": [...] } }
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Minimum prompt length to trigger memory search (skip "y", "ok", "/run", etc.)
const MIN_PROMPT_LENGTH = 15;

// Maximum time to wait for Persyst MCP connection (ms)
const CONNECTION_TIMEOUT = 8000;

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

/**
 * Connect to the Persyst MCP server as a client.
 * Uses StdioClientTransport to spawn and communicate with the server.
 */
async function connectToPersyst() {
  // Resolve the path to Persyst's index.js relative to this hook file
  const persystPath = resolve(__dirname, '..', 'index.js');

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
  const result = await client.callTool({ name: toolName, arguments: args });
  if (result.content && result.content[0] && result.content[0].text) {
    return JSON.parse(result.content[0].text);
  }
  return null;
}

/**
 * Handle SessionStart: load project-wide context and ingest git history.
 */
async function handleSessionStart(client, input) {
  const cwd = input.cwd || process.cwd();
  const repoName = cwd.replace(/\\/g, '/').split('/').pop();

  // 1. Get project-wide memory context
  const contextResult = await callTool(client, 'get_optimized_context', {
    query: `Project ${repoName} conventions, architecture, user preferences, coding rules`,
    max_tokens: 2000,
    agent_id: 'claude-code',
    session_id: input.session_id || undefined
  });

  // 2. Ingest recent git commits (best-effort, don't fail if not a git repo)
  try {
    await callTool(client, 'ingest_git_commits', {
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
    const recentResult = await callTool(client, 'get_recent_memories', { limit: 1 });
    if (recentResult && recentResult.count !== undefined) {
      // The count from get_recent is just the returned count, not total
      // Use a search to estimate total active memories
      const importantResult = await callTool(client, 'get_important_memories', { limit: 100 });
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
 */
async function handleUserPromptSubmit(client, input) {
  const prompt = input.prompt || '';

  // Skip trivial prompts (commands, confirmations, short inputs)
  if (prompt.trim().length < MIN_PROMPT_LENGTH) {
    return {};
  }

  // Use search_memories for speed on per-prompt lookups (faster than get_optimized_context)
  const searchResult = await callTool(client, 'search_memories', {
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
  contextLines.push('=== END MEMORY ===');

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: contextLines.join('\n')
    }
  };
}

/**
 * Main entry point.
 */
async function main() {
  let client = null;

  try {
    const input = await readStdin();
    const eventName = input.hook_event_name;

    // Only handle events we care about
    if (eventName !== 'SessionStart' && eventName !== 'UserPromptSubmit') {
      console.log(JSON.stringify({}));
      return;
    }

    // Connect to Persyst
    client = await connectToPersyst();

    let response;
    if (eventName === 'SessionStart') {
      response = await handleSessionStart(client, input);
    } else if (eventName === 'UserPromptSubmit') {
      response = await handleUserPromptSubmit(client, input);
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
    if (client) {
      try { await client.close(); } catch (_) {}
    }
    process.exit(0);
  }
}

main();
