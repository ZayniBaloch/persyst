/**
 * cache.js — LRU Query Result Cache
 * 
 * In-memory LRU cache for search results to avoid
 * re-computing embeddings for repeated queries.
 * 
 * - Configurable max size (default: 100 entries)
 * - Configurable TTL (default: 5 minutes)
 * - Automatic eviction of oldest entries when full
 * - Full invalidation on write operations
 */

import { logInfo } from './text-utils.js';

/**
 * Simple LRU (Least Recently Used) cache with TTL support.
 */
export class LRUCache {
  /**
   * @param {number} maxSize - Maximum number of entries (default: 100)
   * @param {number} ttlMs - Time-to-live in milliseconds (default: 300000 = 5 min)
   */
  constructor(maxSize = 100, ttlMs = 300000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  /**
   * Generate a cache key from query parameters.
   * @param {string} query - The search query
   * @param {number} limit - The result limit
   * @returns {string} Cache key
   */
  static key(query, limit) {
    return `${query}::${limit}`;
  }

  /**
   * Get a cached value if it exists and hasn't expired.
   * Moves the entry to the "most recently used" position.
   * 
   * @param {string} key - Cache key
   * @returns {*|null} Cached value or null if miss/expired
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL expiry
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    // Move to end (most recently used) by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);
    this.hits++;
    return entry.value;
  }

  /**
   * Store a value in the cache. Evicts oldest entry if at capacity.
   * 
   * @param {string} key - Cache key
   * @param {*} value - Value to cache
   */
  set(key, value) {
    // If key already exists, delete it first (to update position)
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }

    // Evict oldest (first) entry if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now()
    });
  }

  /**
   * Invalidate the entire cache. Called on write operations
   * (add_memory, update_memory, delete_memory) to ensure
   * search results are always fresh.
   */
  invalidate() {
    const size = this.cache.size;
    this.cache.clear();
    if (size > 0) {
      logInfo(`[persyst-cache] Invalidated ${size} cached entries`);
    }
  }

  /**
   * Get cache statistics for monitoring.
   * @returns {{ size: number, maxSize: number, ttlMs: number, hits: number, misses: number, hitRate: string }}
   */
  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? `${((this.hits / total) * 100).toFixed(1)}%` : '0%'
    };
  }
}

// Singleton instance for search results
export const searchCache = new LRUCache(100, 300000);
