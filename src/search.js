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
  getMemoriesByEntity,
  getAllEntities
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
export async function searchHybrid(queryText, limit = 5, agentId = null, sessionId = null, namespace = null, skipAttestation = false) {
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
  // Include namespace in cache key to prevent cross-namespace cache hits
  const cacheKey = LRUCache.key(`${namespace || 'all'}:${queryText}`, limit);
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

  // --- Step 4: Fetch full details, apply namespace filter, reputation adjust, sort and return top N ---
  const finalResults = combined
    .map(r => {
      // Use namespace-aware getMemoryById to filter by agent namespace
      const memory = getMemoryById(r.id, namespace);
      if (!memory) return null; // Memory was archived, deleted, or not in namespace

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

  // Generate cryptographic attestation for audit trails (skip if called internally)
  let attestation = null;
  if (!skipAttestation) {
    attestation = createAttestation(queryText, mmrResults, agentId, sessionId);
    mmrResults.attestation = attestation;
  }

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
export async function getOptimizedContext(queryText, maxTokens, agentId = null, sessionId = null, namespace = null) {
  // Extract entities mentioned in the query text to seed the graph search directly
  const entities = getAllEntities(100);
  const matchedEntityIds = new Set();
  for (const ent of entities) {
    const entNameLower = ent.name.toLowerCase();
    if (queryText.toLowerCase().includes(entNameLower)) {
      matchedEntityIds.add(ent.id);
    }
  }

  // 1. Run hybrid search to fetch top 5 memories as seeds (skip attestation to avoid double-write)
  const searchHits = await searchHybrid(queryText, 5, agentId, sessionId, namespace, true);
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
  }

  // 2. Perform Graph Hop (multi-hop traversal) globally
  const hopQueue = [];
  const visitedNodes = new Set(); // Stores "type:id" keys

  // Seed with matched entities from query text
  for (const entId of matchedEntityIds) {
    const key = `entity:${entId}`;
    if (!visitedNodes.has(key)) {
      visitedNodes.add(key);
      hopQueue.push({ id: entId, type: 'entity', depth: 0 });
    }
  }

  // Seed with search hit memories
  for (const hit of searchHits) {
    const key = `memory:${hit.id}`;
    if (!visitedNodes.has(key)) {
      visitedNodes.add(key);
      hopQueue.push({ id: hit.id, type: 'memory', depth: 0 });
    }
  }

  // BFS to traverse memories and entities uniformly up to depth 4
  while (hopQueue.length > 0) {
    const { id, type, depth } = hopQueue.shift();
    if (depth >= 4) continue;

    const connectedEdges = db.prepare(`
      SELECT * FROM edges 
      WHERE (source_id = ? AND source_type = ?)
         OR (target_id = ? AND target_type = ?)
    `).all(id, type, id, type);

    for (const edge of connectedEdges) {
      let nextId, nextType;
      if (edge.source_id === id && edge.source_type === type) {
        nextId = edge.target_id;
        nextType = edge.target_type;
      } else {
        nextId = edge.source_id;
        nextType = edge.source_type;
      }

      const key = `${nextType}:${nextId}`;
      if (!visitedNodes.has(key)) {
        visitedNodes.add(key);
        hopQueue.push({ id: nextId, type: nextType, depth: depth + 1 });
      }
    }
  }

  // Now collect all hopped memories from the visited nodes
  for (const key of visitedNodes) {
    const [type, idStr] = key.split(':');
    if (type === 'memory') {
      const memId = Number(idStr);
      if (candidates.has(memId)) continue; // Keep search hit info

      // Check namespace filter if present
      const other = getMemoryById(memId, namespace);
      if (!other) continue;

      let baseScore = 0.4;
      if (searchHits.length > 0) {
        const maxSearchScore = Math.max(...searchHits.map(h => parseFloat(h.hybrid_score)));
        baseScore = maxSearchScore * 0.5;
      }

      const otherProv = getProvenance(memId);
      candidates.set(memId, {
        id: other.id,
        content: other.content,
        importance_score: other.importance_score,
        created_at: other.created_at,
        last_accessed: other.last_accessed,
        score: baseScore,
        provenance: otherProv,
        source: 'hop'
      });
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
 * Analyze relationship between two similar memories based on token sets.
 * @param {string} a - Content of memory A
 * @param {string} b - Content of memory B
 * @returns {{ type: 'duplicate'|'subset'|'contradiction'|'different', keep?: 'a'|'b'|'canonical' }}
 */
function checkRelationship(a, b) {
  const getWords = (text) => new Set(text.toLowerCase().split(/\s+/).map(w => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")).filter(Boolean));
  const wordsA = getWords(a);
  const wordsB = getWords(b);

  if (wordsA.size === 0 || wordsB.size === 0) return { type: 'duplicate', keep: 'a' };

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const overlapA = intersection / wordsA.size;
  const overlapB = intersection / wordsB.size;

  const union = wordsA.size + wordsB.size - intersection;
  const jaccard = 1 - (intersection / union);

  if (jaccard === 0) {
    return { type: 'duplicate', keep: 'a' };
  }

  // Contradiction: similar topic, differing key terms
  if (jaccard > 0.15 && jaccard < 0.5) {
    return { type: 'contradiction' };
  }

  // Subset check
  if (overlapA > 0.85 && wordsB.size > wordsA.size) {
    return { type: 'subset', keep: 'b' };
  }
  if (overlapB > 0.85 && wordsA.size > wordsB.size) {
    return { type: 'subset', keep: 'a' };
  }

  // Duplicate
  if (jaccard < 0.25) {
    return { type: 'duplicate', keep: 'canonical' };
  }

  return { type: 'different' };
}

/**
 * Performs memory consolidation by merging highly similar memories.
 * Bug 6 fix: DB mutations are wrapped in a transaction for atomicity.
 */
export async function consolidateMemories(namespace = null) {
  const query = namespace
    ? "SELECT * FROM memories WHERE valid_until IS NULL AND (namespace = ? OR namespace = 'shared')"
    : 'SELECT * FROM memories WHERE valid_until IS NULL';
  const activeMemories = namespace
    ? db.prepare(query).all(namespace)
    : db.prepare(query).all();
  const consolidated = [];
  const visited = new Set();

  for (const mem of activeMemories) {
    if (visited.has(mem.id)) continue;

    // Search for similar memories
    const embedding = db.prepare('SELECT embedding FROM memories_vec WHERE rowid = ?').get(mem.id);
    if (!embedding) continue;

    const hits = db.prepare(`
      SELECT rowid AS id, distance
      FROM memories_vec
      WHERE embedding MATCH ?
      AND k = 10
    `).all(embedding.embedding);

    const group = [];
    for (const hit of hits) {
      if (visited.has(Number(hit.id))) continue;
      const sim = Math.max(0, 1 - (hit.distance * hit.distance) / 2);
      if (sim > 0.80) {
        const other = db.prepare('SELECT * FROM memories WHERE id = ? AND valid_until IS NULL').get(Number(hit.id));
        if (other) {
          group.push(other);
        }
      }
    }

    if (group.length > 1) {
      // Sort group by trust score (confidence * reputation) desc, then importance_score desc, then id desc
      const getTrust = (m) => {
        const prov = getProvenance(m.id);
        let reputation = 1.0;
        if (prov && prov.source_type === 'agent' && prov.source_id) {
          const agentRow = db.prepare('SELECT reputation_score FROM agent_stats WHERE agent_id = ?').get(prov.source_id);
          if (agentRow) reputation = agentRow.reputation_score;
        }
        return (prov ? prov.confidence : 1.0) * reputation;
      };

      const groupWithTrust = group.map(m => ({ ...m, trust: getTrust(m) }));
      groupWithTrust.sort((a, b) => b.trust - a.trust || b.importance_score - a.importance_score || a.id - b.id);

      // Resolve the group sequentially
      let canonical = groupWithTrust[0];
      const archivedIds = [];
      visited.add(canonical.id);

      for (let i = 1; i < groupWithTrust.length; i++) {
        const current = groupWithTrust[i];
        const rel = checkRelationship(canonical.content, current.content);

        if (rel.type === 'contradiction') {
          // Resolve contradiction: keep canonical, archive current
          db.prepare('UPDATE memories SET valid_until = unixepoch() WHERE id = ?').run(current.id);
          db.prepare('INSERT INTO contradictions (old_memory_id, new_memory_id, resolution_reason) VALUES (?, ?, ?)')
            .run(current.id, canonical.id, `Consolidated contradiction: resolved in favor of canonical #${canonical.id}`);

          // Apply reputation changes since it's a cross-agent contradiction
          const oldProv = getProvenance(current.id);
          const newProv = getProvenance(canonical.id);
          if (oldProv && oldProv.source_type === 'agent' && oldProv.source_id) {
            const isSelf = newProv && newProv.source_type === 'agent' && newProv.source_id === oldProv.source_id;
            if (!isSelf) {
              db.prepare('UPDATE agent_stats SET memories_contradicted = memories_contradicted + 1 WHERE agent_id = ?').run(oldProv.source_id);
              db.prepare('UPDATE agent_stats SET reputation_score = (memories_confirmed + 1.0) / (memories_contradicted + 1.0) WHERE agent_id = ?').run(oldProv.source_id);
              if (newProv && newProv.source_type === 'agent') {
                db.prepare('UPDATE agent_stats SET memories_confirmed = memories_confirmed + 1 WHERE agent_id = ?').run(newProv.source_id);
                db.prepare('UPDATE agent_stats SET reputation_score = (memories_confirmed + 1.0) / (memories_contradicted + 1.0) WHERE agent_id = ?').run(newProv.source_id);
              }
            }
          }

          archivedIds.push(current.id);
          visited.add(current.id);
        } else if (rel.type === 'subset') {
          if (rel.keep === 'b') {
            // current (B) is a superset of canonical (A). Swap them
            db.prepare('UPDATE memories SET valid_until = unixepoch() WHERE id = ?').run(canonical.id);
            db.prepare('INSERT INTO contradictions (old_memory_id, new_memory_id, resolution_reason) VALUES (?, ?, ?)')
              .run(canonical.id, current.id, `Consolidated subset: replaced by more detailed #${current.id}`);

            archivedIds.push(canonical.id);
            canonical = current;
          } else {
            // canonical is superset
            db.prepare('UPDATE memories SET valid_until = unixepoch() WHERE id = ?').run(current.id);
            db.prepare('INSERT INTO contradictions (old_memory_id, new_memory_id, resolution_reason) VALUES (?, ?, ?)')
              .run(current.id, canonical.id, `Consolidated subset: subsumed by more detailed #${canonical.id}`);

            archivedIds.push(current.id);
          }
          visited.add(current.id);
        } else if (rel.type === 'duplicate') {
          db.prepare('UPDATE memories SET valid_until = unixepoch() WHERE id = ?').run(current.id);
          db.prepare('INSERT INTO contradictions (old_memory_id, new_memory_id, resolution_reason) VALUES (?, ?, ?)')
            .run(current.id, canonical.id, `Consolidated duplicate of #${canonical.id}`);

          archivedIds.push(current.id);
          visited.add(current.id);
        }
      }

      if (archivedIds.length > 0) {
        consolidated.push({
          canonical_id: canonical.id,
          merged_content: canonical.content,
          archived_ids: archivedIds
        });
      }
    }
  }

  return {
    success: true,
    consolidated_groups: consolidated.length,
    details: consolidated
  };
}
