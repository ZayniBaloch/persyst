/**
 * search.js — Hybrid Search Engine
 * 
 * Combines two search strategies for best results:
 * 
 *   1. KEYWORD SEARCH (FTS5 + BM25)
 *      → Finds exact word matches. Fast. "React" finds "React".
 * 
 *   2. SEMANTIC SEARCH (sqlite-vec + embeddings)
 *      → Finds by meaning. "dark mode" matches "night theme".
 * 
 *   3. HYBRID = keyword + semantic merged
 *      → Keyword matches get a +0.2 score boost on top of semantic score.
 *      → Best of both worlds.
 */

import { generateEmbedding } from './embeddings.js';
import {
  searchKeyword,
  searchVector,
  getMemoryById,
  boostMemory
} from './database.js';

// ============================================================
// HYBRID SEARCH (the main export)
// ============================================================

/**
 * Search memories using both keyword and semantic strategies.
 * 
 * How it works:
 *   1. Run FTS5 keyword search → get matching memory IDs
 *   2. Run vector semantic search → get memories ranked by meaning
 *   3. If a memory appears in BOTH, boost its score by +0.2
 *   4. Sort by combined score, return top N
 * 
 * @param {string} queryText - What to search for
 * @param {number} limit - Max results to return (default: 5)
 * @returns {Promise<Array>} Ranked search results with scores
 * 
 * @example
 *   const results = await searchHybrid("night theme", 5);
 *   // Will find memories about "dark mode" via semantic match
 */
export async function searchHybrid(queryText, limit = 5) {
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
    // For normalized vectors: cosine_sim = 1 - (L2_distance² / 2)
    similarity: Math.max(0, 1 - (r.distance * r.distance) / 2)
  }));

  // --- Step 3: Merge results with keyword boost ---
  const combined = semanticResults.map(r => ({
    id: r.id,
    similarity: r.similarity,
    hybrid_score: r.similarity + (keywordIds.has(r.id) ? 0.2 : 0),
    keyword_match: keywordIds.has(r.id)
  }));

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

  // --- Step 4: Sort by score, fetch full data, return top N ---
  combined.sort((a, b) => b.hybrid_score - a.hybrid_score);
  const topResults = combined.slice(0, limit);

  const results = topResults
    .map(r => {
      const memory = getMemoryById(r.id);
      if (!memory) return null;  // Memory was deleted between search and fetch

      // Boost importance since this memory was useful
      boostMemory(r.id);

      return {
        id: memory.id,
        content: memory.content,
        importance_score: memory.importance_score,
        created_at: memory.created_at,
        similarity: r.similarity.toFixed(4),
        hybrid_score: r.hybrid_score.toFixed(4),
        keyword_match: r.keyword_match
      };
    })
    .filter(Boolean);  // Remove nulls from deleted memories

  return results;
}
