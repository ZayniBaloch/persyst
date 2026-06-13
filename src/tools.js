/**
 * tools.js — MCP Tool Definitions & Handlers
 * 
 * Defines all 7 tools that AI agents can call via MCP:
 * 
 *   1. add_memory         — Store a new memory
 *   2. search_memories    — Hybrid keyword + semantic search
 *   3. get_memory         — Get one memory by ID
 *   4. update_memory      — Update content (re-embeds automatically)
 *   5. delete_memory      — Remove a memory permanently
 *   6. get_recent_memories    — Latest N memories
 *   7. get_important_memories — Top N by importance
 * 
 * Uses Zod schemas for input validation (required by McpServer).
 */

import { z } from 'zod';
import { generateEmbedding } from './embeddings.js';
import {
  insertMemory,
  insertVector,
  getMemory,
  updateMemoryContent,
  deleteMemory,
  deleteVec,
  getRecentMemories,
  getImportantMemories
} from './database.js';
import { searchHybrid } from './search.js';

/**
 * Register all MCP tools on the server.
 * @param {McpServer} server - The MCP server instance
 */
export function registerTools(server) {

  // ========================================
  // 1. ADD MEMORY
  // ========================================
  server.tool(
    'add_memory',
    'Store a new memory. It will be searchable by both keywords and meaning.',
    {
      content: z.string().describe('The memory content to store'),
      importance: z.number().min(0).max(1).default(1.0)
        .describe('Importance score from 0 (low) to 1 (high)')
    },
    async ({ content, importance }) => {
      const id = insertMemory(content, importance);
      const embedding = await generateEmbedding(content);
      insertVector(id, embedding);

      return text({ success: true, id, message: `Memory #${id} stored` });
    }
  );

  // ========================================
  // 2. SEARCH MEMORIES
  // ========================================
  server.tool(
    'search_memories',
    'Search memories using hybrid keyword + semantic search. Finds exact matches AND similar meanings (e.g. "dark mode" finds "night theme").',
    {
      query: z.string().describe('What to search for'),
      limit: z.number().default(5).describe('Max results (default: 5)')
    },
    async ({ query, limit }) => {
      const results = await searchHybrid(query, limit);
      return text({ results, count: results.length });
    }
  );

  // ========================================
  // 3. GET MEMORY
  // ========================================
  server.tool(
    'get_memory',
    'Get a specific memory by its ID. Boosts its importance automatically.',
    {
      id: z.number().describe('Memory ID to retrieve')
    },
    async ({ id }) => {
      const memory = getMemory(id);
      if (!memory) return text({ error: `Memory #${id} not found` });
      return text(memory);
    }
  );

  // ========================================
  // 4. UPDATE MEMORY
  // ========================================
  server.tool(
    'update_memory',
    'Update the content of an existing memory. Automatically re-generates the search embedding.',
    {
      id: z.number().describe('Memory ID to update'),
      content: z.string().describe('New memory content')
    },
    async ({ id, content }) => {
      const updated = updateMemoryContent(id, content);
      if (!updated) return text({ error: `Memory #${id} not found` });

      // Re-generate embedding for updated content
      const embedding = await generateEmbedding(content);
      deleteVec(id);
      insertVector(id, embedding);

      return text({ success: true, id, message: `Memory #${id} updated` });
    }
  );

  // ========================================
  // 5. DELETE MEMORY
  // ========================================
  server.tool(
    'delete_memory',
    'Permanently delete a memory by its ID.',
    {
      id: z.number().describe('Memory ID to delete')
    },
    async ({ id }) => {
      const deleted = deleteMemory(id);
      if (!deleted) return text({ error: `Memory #${id} not found` });
      return text({ success: true, id, message: `Memory #${id} deleted` });
    }
  );

  // ========================================
  // 6. GET RECENT MEMORIES
  // ========================================
  server.tool(
    'get_recent_memories',
    'Get the most recently created memories, newest first.',
    {
      limit: z.number().default(10).describe('How many to return (default: 10)')
    },
    async ({ limit }) => {
      const memories = getRecentMemories(limit);
      return text({ memories, count: memories.length });
    }
  );

  // ========================================
  // 7. GET IMPORTANT MEMORIES
  // ========================================
  server.tool(
    'get_important_memories',
    'Get memories ranked by importance score, highest first.',
    {
      limit: z.number().default(10).describe('How many to return (default: 10)')
    },
    async ({ limit }) => {
      const memories = getImportantMemories(limit);
      return text({ memories, count: memories.length });
    }
  );
}

// ============================================================
// HELPER
// ============================================================

/** Format a response as MCP text content */
function text(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}
