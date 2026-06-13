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

import { pipeline } from '@huggingface/transformers';

// The embedding pipeline (lazy-loaded on first use)
let extractor = null;

/**
 * Load the embedding model. Called automatically on first use.
 * First run downloads the model (~50MB). Subsequent runs use cache.
 */
async function loadModel() {
  if (extractor) return;

  console.error('[persyst] Loading embedding model (first run downloads ~50MB)...');
  extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  console.error('[persyst] Embedding model loaded ✓');
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

  const output = await extractor(text, {
    pooling: 'mean',     // Average all token embeddings into one vector
    normalize: true      // Normalize to unit length (required for cosine similarity)
  });

  // output.data is already a flat Float32Array from the tensor
  return new Float32Array(output.data);
}
