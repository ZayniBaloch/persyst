/**
 * tools.js — MCP Tool Definitions & Handlers
 * 
 * Defines all 19 tools that AI agents can call via MCP.
 * 
 * v2.0 changes:
 * - Bug 1: Uses memoryExistsByHashPrefix for git dedup
 * - Bug 3: Exports cleanupWatchers for graceful shutdown
 * - Bug 7 + Feature 4: Memory content size validation
 * - Feature 1: Cache invalidation on write operations
 * - Feature 2: Contradiction detection on add_memory
 */

import { z } from 'zod';
import { generateEmbedding } from './embeddings.js';
import db, {
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
  memoryExists,
  memoryExistsByHashPrefix,
  getMemoryByContent,
  boostMemory,
  logContradiction,
  getProvenance,
  incrementAgentStat,
  getAllAgentStats,
  getAttestationsByDateRange,
  getMemoryHistoryChain,
  searchAllMemoriesFts,
  getAnyMemoryById,
  searchVector,
  getMemoryById,
  getActiveMemoryCount,
  getNamespaceStats
} from './database.js';
import { searchHybrid, getOptimizedContext, consolidateMemories } from './search.js';
import { getRecentCommits } from './git.js';
import { verifyChainIntegrity } from './attestation.js';
import { searchCache } from './cache.js';
import { memoryEventBus } from './events.js';

// ============================================================
// CONSTANTS
// ============================================================

/** Maximum allowed memory content length (10,000 characters) */
const MAX_MEMORY_CONTENT_LENGTH = 10000;

/** Minimum content length (must have actual content) */
const MIN_MEMORY_CONTENT_LENGTH = 1;

// ============================================================
// WATCHER REGISTRY
// ============================================================

// In-memory registry of active git watchers
const watchers = new Map();

/**
 * Clean up all active git watchers. Called during graceful shutdown.
 * (Bug 3 fix: prevents memory leak from orphaned setInterval handles)
 */
export function cleanupWatchers() {
  for (const [repoPath, intervalId] of watchers.entries()) {
    clearInterval(intervalId);
    console.error(`[persyst-watcher] Stopped watching: ${repoPath}`);
  }
  watchers.clear();
}

// ============================================================
// VALIDATION HELPERS
// ============================================================

/**
 * Validate memory content for size and emptiness.
 * @param {string} content - The content to validate
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
function validateMemoryContent(content) {
  if (!content || content.trim().length < MIN_MEMORY_CONTENT_LENGTH) {
    return { valid: false, error: 'Memory content cannot be empty or whitespace-only.' };
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    return {
      valid: false,
      error: `Memory content exceeds maximum length of ${MAX_MEMORY_CONTENT_LENGTH} characters (got ${content.length}). Please split into smaller memories.`
    };
  }
  return { valid: true };
}

/**
 * Internal logic for storing a new memory (dedup, vector creation, contradiction detection).
 * Shared by both the stdio MCP tool and the HTTP Gateway server.
 */
export async function addMemoryInternal({ content, importance = 1.0, agent_id, session_id, shared = true }) {
  try {
    const normalizedAgentId = agent_id ? agent_id.toLowerCase() : null;

    // Bug 7 + Feature 4: Validate content size
    const validation = validateMemoryContent(content);
    if (!validation.valid) {
      return { error: validation.error };
    }

    // Derive namespace from agent_id and shared flag
    const namespace = (shared || !normalizedAgentId) ? 'shared' : normalizedAgentId;

    // Deduplication check (namespace-aware)
    const existing = getMemoryByContent(content, namespace);
    if (existing) {
      // Re-attribute provenance to the calling agent if it was previously auto-attributed to log-watcher
      const prov = getProvenance(existing.id);
      if (prov && (prov.source_id === 'antigravity-worker' || prov.source_id === 'user-dialogue') && normalizedAgentId) {
        try {
          db.prepare("UPDATE provenance SET source_type = 'agent', source_id = ?, confidence = 1.0 WHERE memory_id = ?")
            .run(normalizedAgentId, existing.id);
          incrementAgentStat(normalizedAgentId, 'created');
        } catch (e) {
          console.error(`[persyst] Re-attribute provenance error: ${e.message}`);
        }
      }
      boostMemory(existing.id);
      return {
        success: true,
        id: existing.id,
        namespace,
        message: `Memory #${existing.id} already exists. Boosted importance.`
      };
    }

    const id = insertMemory(content, importance, {
      source_type: normalizedAgentId ? 'agent' : 'manual',
      source_id: normalizedAgentId,
      confidence: 1.0
    }, namespace);

    const embedding = await generateEmbedding(content);
    insertVector(id, embedding);

    // Feature 1: Invalidate search cache on write
    searchCache.invalidate();

    // Broadcast to SSE subscribers (HTTP gateway + SSE clients)
    memoryEventBus.emit('memory_added', { id, content, namespace, source: normalizedAgentId || 'manual' });

    // Feature 2: Contradiction Detection
    let contradictions = [];
    try {
      const similarHits = searchVector(embedding, 20);
      for (const hit of similarHits) {
        const hitId = Number(hit.rowid);
        if (hitId === id) continue; // Skip self

        const sim = Math.max(0, 1 - (hit.distance * hit.distance) / 2);
        if (sim > 0.70) {
          const existingMemory = getMemoryById(hitId, namespace);
          if (!existingMemory) continue;

          const jaccard = jaccardDistance(content, existingMemory.content);
          // Contradiction: similar topic (high similarity), but differing key terms
          if (jaccard > 0 && jaccard < 0.65) {
            // Fetch provenances for trust calculation
            const oldProv = getProvenance(hitId);
            let oldReputation = 1.0;
            if (oldProv && oldProv.source_type === 'agent' && oldProv.source_id) {
              const agentRow = db.prepare('SELECT reputation_score FROM agent_stats WHERE agent_id = ?').get(oldProv.source_id);
              if (agentRow) oldReputation = agentRow.reputation_score;
            }

            let newReputation = 1.0;
            if (normalizedAgentId) {
              const agentRow = db.prepare('SELECT reputation_score FROM agent_stats WHERE agent_id = ?').get(normalizedAgentId);
              if (agentRow) newReputation = agentRow.reputation_score;
            }

            const trustOld = (oldProv ? oldProv.confidence : 1.0) * oldReputation;
            const trustNew = 1.0 * newReputation; // New confidence is 1.0

            const isSelfUpdate = oldProv && oldProv.source_type === 'agent' && oldProv.source_id === normalizedAgentId;

            if (isSelfUpdate || trustNew > trustOld) {
              // New is preferred
              logContradiction(hitId, id, `Auto-detected contradiction: new memory is more trustworthy (similarity: ${sim.toFixed(3)}, content_diff: ${jaccard.toFixed(3)})`);
              contradictions.push({
                old_memory_id: hitId,
                old_content_preview: existingMemory.content.slice(0, 100),
                similarity: sim.toFixed(4),
                content_difference: jaccard.toFixed(4),
                resolution: 'replaced_old'
              });
            } else {
              // Old is preferred
              logContradiction(id, hitId, `Auto-detected contradiction: existing memory is more trustworthy (similarity: ${sim.toFixed(3)}, content_diff: ${jaccard.toFixed(3)})`);
              contradictions.push({
                old_memory_id: hitId,
                old_content_preview: existingMemory.content.slice(0, 100),
                similarity: sim.toFixed(4),
                content_difference: jaccard.toFixed(4),
                resolution: 'kept_old'
              });
              break; // New memory was archived, stop contradiction check
            }
          }
        }
      }
    } catch (e) {
      console.error(`[persyst] Contradiction detection error: ${e.message}`);
    }

    const result = { success: true, id, namespace, message: `Memory #${id} stored` };
    if (contradictions.length > 0) {
      result.contradictions_detected = contradictions;
      result.message += `. Detected ${contradictions.length} contradiction(s) — older memories archived.`;
    }

    return result;
  } catch (err) {
    return { error: err.message };
  }
}

const toolHandlers = new Map();

/**
 * Programmatically execute any registered MCP tool.
 * Used by the HTTP Gateway server to route requests to tool handlers.
 */
export async function executeToolInternal(name, args) {
  const handler = toolHandlers.get(name);
  if (!handler) {
    throw new Error(`Tool ${name} not found`);
  }
  return await handler(args);
}

/**
 * Register all MCP tools on the server.
 * @param {McpServer} server - The MCP server instance
 * @returns {number} The total count of registered tools
 */
export function registerTools(server) {
  let count = 0;
  const originalTool = server.tool.bind(server);
  server.tool = (...args) => {
    const name = args[0];
    const handler = args[args.length - 1];
    if (typeof handler === 'function') {
      toolHandlers.set(name, handler);
    }
    originalTool(...args);
    count++;
  };

  // ============================================================
  // CORE TOOLS
  // ============================================================

  // 1. ADD MEMORY
  server.tool(
    'add_memory',
    'Store a new memory. CRITICAL: Call this tool proactively to store important milestones, architectural decisions, and explicit user preferences. Always specify your agent name as agent_id to support namespace isolation.',
    {
      content: z.string().describe('The memory content to store'),
      importance: z.number().min(0).max(1).default(1.0).describe('Importance score from 0 (low) to 1 (high)'),
      agent_id: z.string().optional().describe('Agent ID for provenance tracking and namespace isolation'),
      session_id: z.string().optional().describe('Session ID'),
      shared: z.boolean().default(true).describe('If true, memory is visible to all agents. If false, only visible to this agent.')
    },
    async ({ content, importance, agent_id, session_id, shared }) => {
      const res = await addMemoryInternal({ content, importance, agent_id, session_id, shared });
      if (res.error) {
        return text({ error: res.error });
      }
      return text(res);
    }
  );

  // 2. SEARCH MEMORIES
  server.tool(
    'search_memories',
    'Search memories using hybrid keyword + semantic search with cryptographic attestation. CRITICAL: Call this tool at the start of a session or task to retrieve relevant user preferences, coding guidelines, and past decisions.',
    {
      query: z.string().describe('What to search for'),
      limit: z.number().int().min(1).default(5).describe('Max results (default: 5)'),
      agent_id: z.string().optional().describe('Agent ID — filters results to this agent\'s namespace + shared'),
      session_id: z.string().optional().describe('Session ID')
    },
    async ({ query, limit, agent_id, session_id }) => {
      try {
        // Derive namespace from agent_id (null = search all)
        const namespace = agent_id || null;
        const results = await searchHybrid(query, limit, agent_id, session_id, namespace);
        return text({
          results,
          count: results.length,
          namespace: namespace || 'all',
          attestation: results.attestation
        });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 3. GET MEMORY
  server.tool(
    'get_memory',
    'Get a specific memory by its ID. Boosts its importance automatically.',
    {
      id: z.number().describe('Memory ID to retrieve')
    },
    async ({ id }) => {
      try {
        const memory = getMemory(id);
        if (!memory) return text({ error: `Memory #${id} not found` });
        return text(memory);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 4. UPDATE MEMORY
  server.tool(
    'update_memory',
    'Update the content of an existing memory. Archives the old content and saves the new version.',
    {
      id: z.number().describe('Memory ID to update'),
      content: z.string().describe('New memory content'),
      agent_id: z.string().optional().describe('Agent ID making this update')
    },
    async ({ id, content, agent_id }) => {
      try {
        const normalizedAgentId = agent_id ? agent_id.toLowerCase() : null;

        // Bug 7 + Feature 4: Validate content size
        const validation = validateMemoryContent(content);
        if (!validation.valid) {
          return text({ error: validation.error });
        }

        const oldMemory = getMemory(id);
        if (!oldMemory) return text({ error: `Memory #${id} not found` });

        // Retrieve old agent_id from provenance
        const oldProv = getProvenance(id);
        const resolvedAgentId = normalizedAgentId || (oldProv && oldProv.source_type === 'agent' ? oldProv.source_id : null);

        // Insert new version
        const newId = insertMemory(
          content,
          oldMemory.importance_score,
          {
            source_type: resolvedAgentId ? 'agent' : 'manual',
            source_id: resolvedAgentId,
            confidence: 1.0
          },
          oldMemory.namespace || 'shared',
          id
        );

        const embedding = await generateEmbedding(content);
        insertVector(newId, embedding);

        // Record contradiction and archive the old one
        logContradiction(id, newId, 'Content updated via update_memory');

        // Feature 1: Invalidate search cache on write
        searchCache.invalidate();

        return text({
          success: true,
          id: newId,
          message: `Memory #${id} updated. New version stored as #${newId}`
        });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 5. DELETE MEMORY
  server.tool(
    'delete_memory',
    'Permanently delete a memory by its ID.',
    {
      id: z.number().describe('Memory ID to delete')
    },
    async ({ id }) => {
      try {
        const deleted = deleteMemory(id);
        if (!deleted) return text({ error: `Memory #${id} not found` });

        // Feature 1: Invalidate search cache on write
        searchCache.invalidate();

        // Broadcast deletion to SSE subscribers
        memoryEventBus.emit('memory_deleted', { id });

        return text({ success: true, id, message: `Memory #${id} deleted` });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 6. GET RECENT MEMORIES
  server.tool(
    'get_recent_memories',
    'Get the most recently created memories, newest first. Filtered by agent namespace if agent_id is provided.',
    {
      limit: z.number().int().min(1).default(10).describe('How many to return (default: 10)'),
      agent_id: z.string().optional().describe('Agent ID — filters to this agent\'s namespace + shared')
    },
    async ({ limit, agent_id }) => {
      try {
        const namespace = agent_id || null;
        const memories = getRecentMemories(limit, namespace);
        return text({ memories, count: memories.length, namespace: namespace || 'all' });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 7. GET IMPORTANT MEMORIES
  server.tool(
    'get_important_memories',
    'Get memories ranked by importance score, highest first. Filtered by agent namespace if agent_id is provided.',
    {
      limit: z.number().int().min(1).default(10).describe('How many to return (default: 10)'),
      agent_id: z.string().optional().describe('Agent ID — filters to this agent\'s namespace + shared')
    },
    async ({ limit, agent_id }) => {
      try {
        const namespace = agent_id || null;
        const memories = getImportantMemories(limit, namespace);
        return text({ memories, count: memories.length, namespace: namespace || 'all' });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 8. INGEST GIT COMMITS
  server.tool(
    'ingest_git_commits',
    'Import recent git commits, parse PR/file links, and categorize decisions.',
    {
      repo_path: z.string().describe('Absolute path to the git repository'),
      count: z.number().default(20).describe('Number of recent commits to import (default: 20)')
    },
    async ({ repo_path, count }) => {
      try {
        const commits = await getRecentCommits(repo_path, count);
        let added = 0;
        let skipped = 0;

        for (const commit of commits) {
          const hashPrefix = commit.hash.slice(0, 7);
          // Bug 1 fix: use LIKE-based query for hash prefix matching
          if (memoryExistsByHashPrefix(`[${hashPrefix}]%`)) {
            skipped++;
            continue;
          }

          // Insert memory with provenance
          const id = insertMemory(commit.fullText, commit.importance, {
            source_type: 'git',
            source_id: commit.hash,
            confidence: 0.8
          });

          const embedding = await generateEmbedding(commit.fullText);
          insertVector(id, embedding);

          // Link Author
          const authorId = insertEntity(commit.author, 'person');
          if (authorId) {
            insertEdge(authorId, id, 'authored', 'entity', 'memory');
          }

          // Link Files Touched
          for (const file of commit.files) {
            const fileId = insertEntity(file, 'file');
            if (fileId) {
              insertEdge(fileId, id, 'touches', 'entity', 'memory');
            }
          }

          added++;
        }

        // Feature 1: Invalidate search cache after git ingestion
        if (added > 0) searchCache.invalidate();

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

  // 9. ADD ENTITY
  server.tool(
    'add_entity',
    'Create a named entity (person, tech, project, concept, file).',
    {
      name: z.string().describe('Entity name (e.g. "React", "auth-service")'),
      type: z.string().describe('Entity type: person, tech, project, concept, file')
    },
    async ({ name, type }) => {
      try {
        const id = insertEntity(name, type);
        return text({ success: true, id, name, type, message: `Entity "${name}" created` });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 10. LINK ENTITY TO MEMORY
  server.tool(
    'link_entity_memory',
    'Connect an entity to a memory with a relationship label.',
    {
      entity_name: z.string().describe('Name of the entity'),
      memory_id: z.number().describe('ID of the memory to link'),
      relation: z.string().default('mentions').describe('Relationship type')
    },
    async ({ entity_name, memory_id, relation }) => {
      try {
        const entity = getEntityByName(entity_name);
        if (!entity) return text({ error: `Entity "${entity_name}" not found.` });

        const memory = getMemory(memory_id);
        if (!memory) return text({ error: `Memory #${memory_id} not found` });

        insertEdge(entity.id, memory_id, relation, 'entity', 'memory');
        return text({ success: true, entity: entity_name, memory_id, relation });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 11. SEARCH BY ENTITY
  server.tool(
    'search_by_entity',
    'Find all memories linked to a specific entity.',
    {
      entity_name: z.string().describe('Name of the entity to search for')
    },
    async ({ entity_name }) => {
      try {
        const entity = getEntityByName(entity_name);
        if (!entity) return text({ error: `Entity "${entity_name}" not found` });

        const memories = getMemoriesByEntity(entity.id);
        return text({ entity, memories, count: memories.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // ============================================================
  // PRODUCTION-GRADE / NEW TOOLS
  // ============================================================

  // 12. GET MEMORY HISTORY
  server.tool(
    'get_memory_history',
    'Retrieve all versions of a memory, including archived versions and contradictions.',
    {
      query: z.string().describe('The content or search query to find the memory versions for')
    },
    async ({ query }) => {
      try {
        let hits = [];
        const queryAsId = Number(query);
        if (!isNaN(queryAsId) && Number.isInteger(queryAsId)) {
          const mem = getAnyMemoryById(queryAsId);
          if (mem) {
            hits.push({ id: mem.id });
          }
        }

        if (hits.length === 0) {
          hits = searchAllMemoriesFts(query, 5);
        }

        // Fallback to LIKE query on memories content if FTS is empty or fails
        if (hits.length === 0) {
          try {
            const likeRows = db.prepare("SELECT id FROM memories WHERE content LIKE ? LIMIT 5").all(`%${query}%`);
            hits = likeRows;
          } catch (_) {}
        }

        if (hits.length === 0) {
          return text({ message: 'No memories matching query found.' });
        }

        const histories = {};
        const seenChainKeys = new Set();
        for (const hit of hits) {
          const chain = getMemoryHistoryChain(hit.id);
          if (chain.length === 0) continue;

          // Deduplicate chains to prevent duplicate entries in history response
          const chainKey = chain.map(c => c.id).sort((a, b) => a - b).join(',');
          if (seenChainKeys.has(chainKey)) continue;
          seenChainKeys.add(chainKey);

          // Decorate chain versions with semantic diffs from the previous version
          for (let idx = 0; idx < chain.length; idx++) {
            if (idx > 0) {
              chain[idx].diff_from_previous = diffWords(chain[idx - 1].content, chain[idx].content);
            } else {
              chain[idx].diff_from_previous = null;
            }
          }
          histories[hit.id] = chain;
        }

        return text({ query, histories });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 13. GET AGENT STATS
  server.tool(
    'get_agent_stats',
    'Retrieve reputation statistics and activity logs for all active agents.',
    {},
    async () => {
      try {
        const stats = getAllAgentStats();
        return text({ stats, count: stats.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 14. EXPORT AUDIT LOG
  server.tool(
    'export_audit_log',
    'Exports query attestation log records within a timestamp range for compliance audits.',
    {
      start_date: z.string().describe('Start date ISO8601 (e.g. 2026-06-01T00:00:00Z)'),
      end_date: z.string().describe('End date ISO8601')
    },
    async ({ start_date, end_date }) => {
      try {
        const logs = getAttestationsByDateRange(start_date, end_date);
        return text({ logs, count: logs.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 15. VERIFY ATTESTATION
  server.tool(
    'verify_attestation',
    'Verify the Ed25519 signature and hash-chain integrity of a specific attestation.',
    {
      attestation_id: z.string().describe('The UUID of the attestation to verify')
    },
    async ({ attestation_id }) => {
      try {
        const report = verifyChainIntegrity(attestation_id);
        return text(report);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 16. GET FILE HISTORY
  server.tool(
    'get_file_history',
    'Fetch all commit memories and architectural choices that modified a specific file.',
    {
      file_path: z.string().describe('Relative or absolute file path')
    },
    async ({ file_path }) => {
      try {
        const entity = getEntityByName(file_path);
        if (!entity) return text({ message: `No git history entity found for file: ${file_path}`, memories: [] });

        const memories = getMemoriesByEntity(entity.id);
        return text({ file_path, memories, count: memories.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 17. WATCH GIT REPO
  server.tool(
    'watch_git_repo',
    'Subscribe to and poll a repository for changes, auto-ingesting new commits every 5 minutes.',
    {
      repo_path: z.string().describe('Absolute path to the repository')
    },
    async ({ repo_path }) => {
      try {
        if (watchers.has(repo_path)) {
          return text({ success: true, message: `Repository ${repo_path} is already being watched.` });
        }

        const intervalId = setInterval(async () => {
          console.error(`[persyst-watcher] Running scheduled ingestion for: ${repo_path}`);
          try {
            const result = await getRecentCommits(repo_path, 10);
            let added = 0;
            for (const commit of result) {
              const hashPrefix = commit.hash.slice(0, 7);
              // Bug 1 fix: use LIKE-based query for hash prefix matching
              if (memoryExistsByHashPrefix(`[${hashPrefix}]%`)) continue;

              const id = insertMemory(commit.fullText, commit.importance, {
                source_type: 'git',
                source_id: commit.hash,
                confidence: 0.8
              });
              const embedding = await generateEmbedding(commit.fullText);
              insertVector(id, embedding);

              const authorId = insertEntity(commit.author, 'person');
              if (authorId) insertEdge(authorId, id, 'authored', 'entity', 'memory');

              for (const file of commit.files) {
                const fileId = insertEntity(file, 'file');
                if (fileId) insertEdge(fileId, id, 'touches', 'entity', 'memory');
              }
              added++;
            }
            if (added > 0) {
              searchCache.invalidate();
              console.error(`[persyst-watcher] Ingested ${added} new commits from ${repo_path}`);
            }
          } catch (e) {
            console.error(`[persyst-watcher] Ingestion failed for ${repo_path}: ${e.message}`);
          }
        }, 300000); // 5 minutes

        watchers.set(repo_path, intervalId);
        return text({ success: true, message: `Started watching repository at ${repo_path}` });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 18. GET OPTIMIZED CONTEXT
  server.tool(
    'get_optimized_context',
    'Compile a condensed context prompt within a token budget by hopping the knowledge graph and ranking by temporal decay + agent reputation. CRITICAL: Invoke this tool at the start of a task to load all relevant conventions and decisions.',
    {
      query: z.string().describe('The search query context'),
      max_tokens: z.number().default(4000).describe('Token budget for LLM context compression (default: 4000)'),
      agent_id: z.string().optional().describe('Agent ID requesting context — filters to this agent\'s namespace + shared'),
      session_id: z.string().optional().describe('Session ID'),
      intent: z.string().optional().describe('The active task intent / category (e.g. debugging, ui_styling, database_management)')
    },
    async ({ query, max_tokens, agent_id, session_id, intent }) => {
      try {
        const namespace = agent_id || null;
        const contextData = await getOptimizedContext(query, max_tokens, agent_id, session_id, namespace, intent);
        return text(contextData);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 19. CONSOLIDATE MEMORIES
  server.tool(
    'consolidate_memories',
    'Manually trigger the semantic deduplication sweep to merge highly similar memories (similarity > 0.85).',
    {},
    async () => {
      try {
        const report = await consolidateMemories();
        return text(report);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // Restore original method and return count
  server.tool = originalTool;
  return count;
}

// ============================================================
// HELPERS
// ============================================================

/** Format a response as MCP text content */
function text(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}

/**
 * Compute Jaccard distance between two text strings.
 * Used for contradiction detection — higher distance means more different content.
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Distance score between 0 (identical) and 1 (completely different)
 */
function jaccardDistance(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  if (union === 0) return 0;
  return 1 - (intersection / union);
}

/**
 * Compute word-level diff between two text strings using dynamic programming.
 * Highlights additions as [+added+] and deletions as [-deleted-].
 * @param {string} oldStr - Original text
 * @param {string} newStr - New version of text
 * @returns {string} Diff string
 */
function diffWords(oldStr, newStr) {
  const oldWords = oldStr.split(/(\s+)/);
  const newWords = newStr.split(/(\s+)/);
  
  const dp = Array(oldWords.length + 1).fill(0).map(() => Array(newWords.length + 1).fill(0));
  
  for (let i = 1; i <= oldWords.length; i++) {
    for (let j = 1; j <= newWords.length; j++) {
      if (oldWords[i-1] === newWords[j-1]) {
        dp[i][j] = dp[i-1][j-1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }
  }
  
  let i = oldWords.length;
  let j = newWords.length;
  const result = [];
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i-1] === newWords[j-1]) {
      result.unshift({ type: 'common', value: oldWords[i-1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.unshift({ type: 'added', value: newWords[j-1] });
      j--;
    } else {
      result.unshift({ type: 'removed', value: oldWords[i-1] });
      i--;
    }
  }

  // Combine consecutive items of the same type
  const combined = [];
  for (const part of result) {
    if (combined.length > 0 && combined[combined.length - 1].type === part.type) {
      combined[combined.length - 1].value += part.value;
    } else {
      combined.push({ ...part });
    }
  }

  return combined.map(part => {
    if (part.type === 'added') return `[+${part.value}+]`;
    if (part.type === 'removed') return `[-${part.value}-]`;
    return part.value;
  }).join('');
}
