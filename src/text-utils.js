/**
 * text-utils.js — Shared text-processing helpers used across Persyst.
 *
 * Keeping these in one place avoids duplicated logic and divergent behavior
 * between modules.
 */

/**
 * Compute Jaccard similarity between two text strings.
 * Uses word-level tokenization for efficiency.
 *
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Similarity score between 0 and 1
 */
export function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;

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
 * Compute Jaccard distance between two text strings.
 * Distance = 1 - similarity, so 0 means identical and 1 means completely different.
 *
 * @param {string} a - First text
 * @param {string} b - Second text
 * @returns {number} Distance score between 0 and 1
 */
export function jaccardDistance(a, b) {
  return 1 - jaccardSimilarity(a, b);
}

/**
 * Log informational messages to stderr only when PERSYST_DEBUG or DEBUG is enabled.
 * Prevents MCP hosts (Cursor, Antigravity, VS Code) from treating startup info logs as MCP errors.
 */
export function logInfo(...args) {
  if (process.env.PERSYST_DEBUG || process.env.DEBUG) {
    console.error(...args);
  }
}

