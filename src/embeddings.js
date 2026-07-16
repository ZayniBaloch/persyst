/**
 * embeddings.js — Local Embedding Generation
 * 
 * Uses @huggingface/transformers with the all-MiniLM-L6-v2 model
 * to generate 384-dimensional embeddings entirely on your machine.
 * 
 * - No API keys needed
 * - No cloud calls
 * - Model downloads once (~50MB), then cached locally
 * - Returns Float32Array ready for sqlite-vec
 */

import './setup-wasm.js';
import { env, pipeline } from '@huggingface/transformers';

// Disable WASM caching to prevent blob: URL ESM dynamic import error in Node.js
env.useWasmCache = false;

// The embedding pipeline (lazy-loaded on first use)
let extractor = null;
let useFallbackEmbeddings = false;
let modelLoadAttempted = false;

const EMBEDDING_DIMENSIONS = 384;
const SYNONYM_MAP = new Map([
  ['night', 'dark'],
  ['theme', 'mode'],
  ['colour', 'color'],
  ['colours', 'colors']
]);

import { logInfo } from './text-utils.js';

/**
 * Load the embedding model. Called automatically on first use.
 * First run downloads the model (~50MB). Subsequent runs use cache.
 */
async function loadModel() {
  if (extractor || useFallbackEmbeddings || modelLoadAttempted) return;
  modelLoadAttempted = true;

  logInfo('[persyst] Loading embedding model (first run downloads ~50MB)...');
  try {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    logInfo('[persyst] Embedding model loaded ✓');
  } catch (error) {
    useFallbackEmbeddings = true;
    const message = error instanceof Error ? error.message : String(error);
    logInfo(`[persyst] Embedding model unavailable, using deterministic fallback embeddings (${message})`);
  }
}

function hashToken(token) {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function normalizeToken(token) {
  const lower = token.toLowerCase();
  return SYNONYM_MAP.get(lower) || lower;
}

function generateFallbackEmbedding(text) {
  const vec = new Float32Array(EMBEDDING_DIMENSIONS);
  const tokens = String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean)
    .map(normalizeToken);

  if (tokens.length === 0) {
    return vec;
  }

  for (const token of tokens) {
    const idx = hashToken(token) % EMBEDDING_DIMENSIONS;
    vec[idx] += 1;
  }

  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Generate a 384-dimensional embedding for the given text.
 * 
 * @param {string} text - The text to embed
 * @returns {Promise<Float32Array>} - Normalized 384-dim embedding vector
 * 
 * @example
 *   const vec = await generateEmbedding("User prefers dark mode");
 *   // vec is a Float32Array with 384 values
 *   // Use vec.buffer to insert into sqlite-vec
 */
export async function generateEmbedding(text) {
  await loadModel();

  if (useFallbackEmbeddings || !extractor) {
    return generateFallbackEmbedding(text);
  }

  try {
    const output = await extractor(text, {
      pooling: 'mean',     // Average all token embeddings into one vector
      normalize: true      // Normalize to unit length (required for cosine similarity)
    });

    // output.data is already a flat Float32Array from the tensor
    return new Float32Array(output.data);
  } catch (error) {
    useFallbackEmbeddings = true;
    const message = error instanceof Error ? error.message : String(error);
    logInfo(`[persyst] Embedding inference failed, using deterministic fallback embeddings (${message})`);
    return generateFallbackEmbedding(text);
  }
}
