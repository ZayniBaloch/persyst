/**
 * search.js — Hybrid Search & Context Optimization Engine
 * 
 * Combines keyword and semantic searches, integrates temporal decay,
 * applies agent reputation scores, generates cryptographic search attestations,
 * builds graph-hopped optimized LLM context prompts, and applies MMR
 * for diverse result retrieval.
 */

import db, {
  searchKeyword,
  searchVector,
  getMemoryById,
  boostMemory,
  getProvenance,
  getMemoriesByEntity
} from './database.js';
import { generateEmbedding } from './embeddings.js';
import { createAttestation } from './attestation.js';
import { searchCache, LRUCache } from './cache.js';

let lastDataVersion = 0;

/**
 * Search memories using both keyword and semantic strategies.
 * Results are cached in the LRU cache for repeated queries.
 * 
 * @param {string} queryText - What to search for
 * @param {number} limit - Max results to return (default: 5)
 * @param {string|null} agentId - Identifying string for the querying agent
 * @param {string|null} sessionId - Session identifier
 * @returns {Promise<Array>} Ranked search results (with .attestation property attached)
 */
export async function searchHybrid(queryText, limit = 5, agentId = null, sessionId = null) {
  // Sync in-memory cache with external DB changes using sqlite data_version
  try {
    const currentDataVersion = db.pragma('data_version', { simple: true });
    if (currentDataVersion !== lastDataVersion) {
      searchCache.invalidate();
      lastDataVersion = currentDataVersion;
    }
  } catch (_) {
    // Fallback if pragma fails
  }

  // --- Check LRU cache first (Feature 1) ---
  const cacheKey = LRUCache.key(queryText, limit);
  const cached = searchCache.get(cacheKey);
  if (cached) {
    console.error(`[persyst-cache] Cache HIT for query: "${queryText.slice(0, 50)}..."`);
    return cached;
  }

  // --- Step 1: Keyword search (fast, exact matches) ---
  const keywordHits = searchKeyword(queryText, limit * 2);
  const keywordIds = new Set(keywordHits.map(r => r.id));

  // --- Step 2: Semantic search (meaning-based) ---
  const queryEmbedding = await generateEmbedding(queryText);
  const vecHits = searchVector(queryEmbedding, limit * 2);

  const semanticResults = vecHits.map(r => ({
    id: r.rowid,
    distance: r.distance,
    // Convert L2 distance to 0-1 similarity score
    similarity: Math.max(0, 1 - (r.distance * r.distance) / 2)
  }));

  // --- Step 3: Merge results with keyword boost ---
  const combined = semanticResults
    .map(r => {
      const isKeywordMatch = keywordIds.has(r.id);
      return {
        id: r.id,
        similarity: r.similarity,
        hybrid_score: r.similarity + (isKeywordMatch ? 0.2 : 0),
        keyword_match: isKeywordMatch
      };
    })
    // Filter out low similarity semantic matches if they have no keyword match (threshold 0.30)
    .filter(r => r.keyword_match || r.similarity >= 0.30);

  // Add keyword-only hits that semantic search missed
  const semanticIds = new Set(semanticResults.map(r => r.id));
  for (const id of keywordIds) {
    if (!semanticIds.has(id)) {
      combined.push({
        id,
        similarity: 0,
        hybrid_score: 0.2,  // Keyword-only base score
        keyword_match: true
      });
    }
  }

  // --- Step 4: Fetch full details, apply reputation adjust, sort and return top N ---
  const finalResults = combined
    .map(r => {
      const memory = getMemoryById(r.id);
      if (!memory) return null; // Memory was archived or deleted

      // Boost memory access metrics
      boostMemory(r.id);

      // Fetch reputation stats for weighting
      let reputationScore = 1.0;
      let reputationWarning = false;
      const prov = memory.provenance;
      if (prov && prov.source_type === 'agent' && prov.source_id) {
        const agentRow = db.prepare('SELECT reputation_score FROM agent_stats WHERE agent_id = ?').get(prov.source_id);
        if (agentRow) {
          reputationScore = agentRow.reputation_score;
          if (reputationScore < 0.5) {
            reputationWarning = true;
          }
        }
      }

      // Final score formula: base_score * agent_reputation
      const finalScore = r.hybrid_score * reputationScore;

      return {
        id: memory.id,
        content: memory.content,
        importance_score: memory.importance_score,
        created_at: memory.created_at,
        last_accessed: memory.last_accessed,
        similarity: r.similarity.toFixed(4),
        hybrid_score: finalScore.toFixed(4),
        keyword_match: r.keyword_match,
        reputation_warning: reputationWarning,
        provenance: prov
      };
    })
    .filter(Boolean);

  // Sort by final score descending
  finalResults.sort((a, b) => parseFloat(b.hybrid_score) - parseFloat(a.hybrid_score));

  // --- Step 5: Apply MMR for diverse retrieval (Feature 3) ---
  const mmrResults = applyMMR(finalResults, limit);

  // Generate cryptographic attestation for audit trails
  const attestation = createAttestation(queryText, mmrResults, agentId, sessionId);

  // Attach attestation object directly to the array to preserve compatibility with existing tests
  mmrResults.attestation = attestation;

  // --- Store in LRU cache (Feature 1) ---
  searchCache.set(cacheKey, mmrResults);

  return mmrResults;
}

/**
 * Apply Maximal Marginal Relevance (MMR) re-ranking for diverse results.
 * 
 * MMR balances relevance with diversity by penalizing candidates that
 * are too similar to already-selected results.
 * 
 * @param {Array} candidates - Scored search results
 * @param {number} limit - Max results to return
 * @param {number} lambda - Trade-off parameter (0.7 = 70% relevance, 30% diversity)
 * @returns {Array} MMR-reranked results
 */
function applyMMR(candidates, limit, lambda = 0.7) {
  if (candidates.length <= limit) return candidates;

  const selected = [];
  const remaining = [...candidates];

  // Always pick the top-scored result first
  selected.push(remaining.shift());

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestMMRScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = parseFloat(candidate.hybrid_score);

      // Calculate max similarity to any already-selected result
      // Using content-based Jaccard similarity as a proxy
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candidate.content, sel.content);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }

      // MMR score = λ * relevance - (1 - λ) * max_similarity_to_selected
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;

      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      selected.push(remaining.splice(bestIdx, 1)[0]);
    } else {
      break;
    }
  }

  return selected;
}

/**
 * Compute Jaccard similarity between two text strings.
 * Uses word-level tokenization for efficiency.
 * 
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Similarity score between 0 and 1
 */
function jaccardSimilarity(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  
  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }
  
  const union = wordsA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Optimizes the retrieved context by walking the knowledge graph and compressing content to fit max_tokens.
 * 
 * @param {string} queryText - User's query
 * @param {number} maxTokens - Hard limit of tokens for context prompt
 * @param {string|null} agentId - Querying agent identifier
 * @param {string|null} sessionId - Current session ID
 */
export async function getOptimizedContext(queryText, maxTokens, agentId = null, sessionId = null) {
  // 1. Run hybrid search to fetch top 20 memories
  const searchHits = await searchHybrid(queryText, 20, agentId, sessionId);
  const candidates = new Map();

  for (const hit of searchHits) {
    candidates.set(hit.id, {
      id: hit.id,
      content: hit.content,
      importance_score: hit.importance_score,
      created_at: hit.created_at,
      last_accessed: hit.last_accessed,
      score: parseFloat(hit.hybrid_score),
      provenance: hit.provenance,
      source: 'search'
    });

    // 2. Perform Graph Hop
    const edges = db.prepare(`
      SELECT * FROM edges 
      WHERE (source_id = ? AND source_type = 'memory')
         OR (target_id = ? AND target_type = 'memory')
    `).all(hit.id, hit.id);

    const entityIds = [];
    for (const edge of edges) {
      if (edge.source_type === 'entity') entityIds.push(edge.source_id);
      if (edge.target_type === 'entity') entityIds.push(edge.target_id);
    }

    for (const entId of entityIds) {
      const otherMemories = getMemoriesByEntity(entId);
      for (const other of otherMemories) {
        if (other.id === hit.id) continue;
        if (candidates.has(other.id)) continue;

        const otherProv = getProvenance(other.id);
        candidates.set(other.id, {
          id: other.id,
          content: other.content,
          importance_score: other.importance_score,
          created_at: other.created_at,
          last_accessed: other.last_accessed,
          score: parseFloat(hit.hybrid_score) * 0.5, // 50% graph-hop penalty
          provenance: otherProv,
          source: 'hop'
        });
      }
    }
  }

  // 3. Apply Scoring Adjustments
  const now = Math.floor(Date.now() / 1000);
  const list = Array.from(candidates.values());

  for (const c of list) {
    // 3a. Temporal decay: score *= exp(-0.01 * hours_since_accessed)
    const hours = Math.max(0, (now - c.last_accessed) / 3600);
    c.score *= Math.exp(-0.01 * hours);

    // 3b. Agent reputation weighting
    let reputationScore = 1.0;
    if (c.provenance && c.provenance.source_type === 'agent' && c.provenance.source_id) {
      const agentRow = db.prepare('SELECT reputation_score FROM agent_stats WHERE agent_id = ?').get(c.provenance.source_id);
      if (agentRow) {
        reputationScore = agentRow.reputation_score;
      }
    }
    c.score *= reputationScore;
  }

  // 4. Sort candidates
  list.sort((a, b) => b.score - a.score);

  // 5. Compress context to fit maxTokens
  let currentTokens = 0;
  const accepted = [];

  for (const c of list) {
    // Heuristic: ~4 characters per token + format headers (~15 tokens)
    const estimatedTokens = Math.max(1, Math.ceil(c.content.length / 4) + 15);
    if (currentTokens + estimatedTokens > maxTokens) {
      continue;
    }
    currentTokens += estimatedTokens;
    accepted.push(c);
  }

  // 6. Format LLM injection context string
  let context = '=== RETRIEVED AGENT MEMORY CONTEXT ===\n';
  if (accepted.length === 0) {
    context += 'No relevant memories retrieved.\n';
  } else {
    for (const a of accepted) {
      let sourceTag = 'Source: manual';
      if (a.provenance) {
        sourceTag = `Source: ${a.provenance.source_type}${a.provenance.source_id ? ` (${a.provenance.source_id})` : ''}`;
      }
      context += `[Memory #${a.id}] (Score: ${a.score.toFixed(4)}, ${sourceTag})\n${a.content}\n---\n`;
    }
  }
  context += '=== END OF CONTEXT ===';

  // Bug 8 fix: Skip attestation when no results to avoid audit noise
  let attestation = null;
  if (accepted.length > 0) {
    attestation = createAttestation(queryText, accepted, agentId, sessionId);
  }

  return {
    context,
    memories: accepted,
    attestation
  };
}

/**
 * Performs memory consolidation by merging highly similar memories.
 * Bug 6 fix: DB mutations are wrapped in a transaction for atomicity.
 */
export async function consolidateMemories() {
  const activeMemories = db.prepare('SELECT * FROM memories WHERE valid_until IS NULL').all();
  const consolidated = [];
  const visited = new Set();

  // Pre-compile the transaction for atomic DB operations (Bug 6 fix)
  const archiveAndMerge = db.transaction((canonicalId, mergedContent, dupIds) => {
    // Update canonical memory with merged content
    db.prepare('UPDATE memories SET content = ?, last_accessed = unixepoch() WHERE id = ?').run(mergedContent, canonicalId);

    // Archive duplicates
    for (const dupId of dupIds) {
      db.prepare('UPDATE memories SET valid_until = unixepoch() WHERE id = ?').run(dupId);
      db.prepare('INSERT INTO contradictions (old_memory_id, new_memory_id, resolution_reason) VALUES (?, ?, ?)')
        .run(dupId, canonicalId, `Consolidated into canonical memory #${canonicalId}`);
    }
  });

  for (const mem of activeMemories) {
    if (visited.has(mem.id)) continue;

    // Search for similar memories
    const embedding = db.prepare('SELECT embedding FROM memories_vec WHERE rowid = ?').get(mem.id);
    if (!embedding) continue;

    // sqlite-vec similarity search
    const hits = db.prepare(`
      SELECT rowid AS id, distance
      FROM memories_vec
      WHERE embedding MATCH ?
      AND k = 10
    `).all(embedding.embedding);

    const duplicates = [];
    for (const hit of hits) {
      if (Number(hit.id) === mem.id) continue;
      if (visited.has(Number(hit.id))) continue;

      const sim = Math.max(0, 1 - (hit.distance * hit.distance) / 2);
      if (sim > 0.85) {
        const dupMemory = db.prepare('SELECT * FROM memories WHERE id = ? AND valid_until IS NULL').get(Number(hit.id));
        if (dupMemory) {
          duplicates.push(dupMemory);
        }
      }
    }

    if (duplicates.length > 0) {
      // Group found! Merge them.
      const allMemoriesInGroup = [mem, ...duplicates];

      // Sort by importance to pick canonical
      allMemoriesInGroup.sort((a, b) => b.importance_score - a.importance_score);
      const canonical = allMemoriesInGroup[0];
      const dupesToArchive = allMemoriesInGroup.slice(1);

      // Merge contents (unique sentences or concatenated text)
      const contents = allMemoriesInGroup.map(m => m.content.trim());
      const uniqueContents = Array.from(new Set(contents));
      const mergedContent = uniqueContents.join('. ').replace(/\.\./g, '.');

      // Generate new embedding OUTSIDE the transaction (async operation)
      const newEmbedding = await generateEmbedding(mergedContent);

      // Run atomic DB transaction for all mutations (Bug 6 fix)
      archiveAndMerge(canonical.id, mergedContent, dupesToArchive.map(d => d.id));

      // Update vector embedding (also outside transaction since vec0 tables have their own handling)
      db.prepare('DELETE FROM memories_vec WHERE rowid = ?').run(canonical.id);
      db.prepare('INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)').run(BigInt(canonical.id), Buffer.from(newEmbedding.buffer));

      for (const dup of dupesToArchive) {
        visited.add(dup.id);
      }

      visited.add(canonical.id);
      consolidated.push({
        canonical_id: canonical.id,
        merged_content: mergedContent,
        archived_ids: dupesToArchive.map(d => d.id)
      });
    }
  }

  return {
    success: true,
    consolidated_groups: consolidated.length,
    details: consolidated
  };
}
