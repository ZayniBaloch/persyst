/**
 * tools.js — MCP Tool Definitions & Handlers
 * 
 * Defines all 11 tools that AI agents can call via MCP:
 * 
 *   Core (MVP):
 *   1. add_memory             — Store a new memory
 *   2. search_memories        — Hybrid keyword + semantic search
 *   3. get_memory             — Get one memory by ID
 *   4. update_memory          — Update content (re-embeds automatically)
 *   5. delete_memory          — Remove a memory permanently
 *   6. get_recent_memories    — Latest N memories
 *   7. get_important_memories — Top N by importance
 * 
 *   Advanced (Phase 3):
 *   8. ingest_git_commits     — Import git history as memories
 *   9. add_entity             — Create a named entity
 *  10. link_entity_memory     — Connect entity ↔ memory
 *  11. search_by_entity       — Find memories linked to an entity
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
  getImportantMemories,
  insertEntity,
  getEntityByName,
  insertEdge,
  getMemoriesByEntity,
  getAllEntities,
  memoryExists
} from './database.js';
import { searchHybrid } from './search.js';
import { getRecentCommits } from './git.js';

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

  // ========================================
  // 8. INGEST GIT COMMITS
  // ========================================
  server.tool(
    'ingest_git_commits',
    'Import recent git commits from a repository as memories. Each commit becomes a searchable memory. Deduplicates automatically — safe to call multiple times.',
    {
      repo_path: z.string().describe('Absolute path to the git repository'),
      count: z.number().default(20).describe('Number of recent commits to import (default: 20)')
    },
    async ({ repo_path, count }) => {
      try {
        const commits = getRecentCommits(repo_path, count);
        let added = 0;
        let skipped = 0;

        for (const commit of commits) {
          // Dedup by commit hash prefix
          const hashPrefix = commit.hash.slice(0, 7);
          if (memoryExists(`[${hashPrefix}]%`)) {
            skipped++;
            continue;
          }

          // Store commit as memory
          const id = insertMemory(commit.fullText, 0.6);
          const embedding = await generateEmbedding(commit.fullText);
          insertVector(id, embedding);

          // Auto-create author entity and link
          const authorId = insertEntity(commit.author, 'person');
          if (authorId) {
            insertEdge(authorId, id, 'authored', 'entity', 'memory');
          }

          added++;
        }

        return text({
          success: true,
          added,
          skipped,
          total_commits: commits.length,
          message: `Ingested ${added} commits (${skipped} already existed)`
        });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // ========================================
  // 9. ADD ENTITY
  // ========================================
  server.tool(
    'add_entity',
    'Create a named entity (person, tech, project, concept, file). Entities can be linked to memories for graph traversal.',
    {
      name: z.string().describe('Entity name (e.g. "React", "John", "auth-service")'),
      type: z.string().describe('Entity type: person, tech, project, concept, file')
    },
    async ({ name, type }) => {
      const id = insertEntity(name, type);
      return text({ success: true, id, name, type, message: `Entity "${name}" created` });
    }
  );

  // ========================================
  // 10. LINK ENTITY TO MEMORY
  // ========================================
  server.tool(
    'link_entity_memory',
    'Connect an entity to a memory with a relationship label (e.g. "mentions", "is_about", "decided_by").',
    {
      entity_name: z.string().describe('Name of the entity'),
      memory_id: z.number().describe('ID of the memory to link'),
      relation: z.string().default('mentions').describe('Relationship type (e.g. mentions, is_about, decided_by)')
    },
    async ({ entity_name, memory_id, relation }) => {
      const entity = getEntityByName(entity_name);
      if (!entity) return text({ error: `Entity "${entity_name}" not found. Create it first with add_entity.` });

      const memory = getMemory(memory_id);
      if (!memory) return text({ error: `Memory #${memory_id} not found` });

      insertEdge(entity.id, memory_id, relation, 'entity', 'memory');
      return text({ success: true, entity: entity_name, memory_id, relation, message: `Linked "${entity_name}" → memory #${memory_id}` });
    }
  );

  // ========================================
  // 11. SEARCH BY ENTITY
  // ========================================
  server.tool(
    'search_by_entity',
    'Find all memories linked to a specific entity. Returns memories connected via edges in the knowledge graph.',
    {
      entity_name: z.string().describe('Name of the entity to search for')
    },
    async ({ entity_name }) => {
      const entity = getEntityByName(entity_name);
      if (!entity) return text({ error: `Entity "${entity_name}" not found` });

      const memories = getMemoriesByEntity(entity.id);
      return text({ entity, memories, count: memories.length });
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
