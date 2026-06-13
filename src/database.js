/**
 * database.js — SQLite Database Setup & CRUD Operations
 * 
 * This file handles everything database-related:
 * - Opens SQLite connection at ~/.persyst/persyst.db
 * - Loads the sqlite-vec extension for vector search
 * - Creates all tables (memories, FTS5 index, vector index)
 * - Exports simple CRUD functions for other modules to use
 * 
 * IMPORTANT: better-sqlite3 is SYNCHRONOUS. No async/await here.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

// ============================================================
// DATABASE LOCATION
// Store in ~/.persyst/ so data persists across sessions
// ============================================================

const DB_DIR = join(homedir(), '.persyst');
mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = process.env.NODE_ENV === 'test' ? ':memory:' : join(DB_DIR, 'persyst.db');

// ============================================================
// INITIALIZE CONNECTION
// ============================================================

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // Better performance for concurrent reads
db.pragma('foreign_keys = ON');    // Enforce referential integrity

// Load sqlite-vec BEFORE creating any vec0 tables
sqliteVec.load(db);

console.error(`[persyst] Database: ${DB_PATH}`);

// ============================================================
// CREATE TABLES
// ============================================================

// --- Main memories table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id              INTEGER PRIMARY KEY,
    content         TEXT    NOT NULL,
    importance_score REAL   DEFAULT 1.0,
    created_at      INTEGER DEFAULT (unixepoch()),
    last_accessed   INTEGER DEFAULT (unixepoch()),
    access_count    INTEGER DEFAULT 0
  )
`);

// --- FTS5 full-text search index (keyword search with BM25) ---
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='id'
  )
`);

// --- FTS5 auto-sync triggers ---
// These keep the FTS index in sync when memories are added/updated/deleted.
// Using try/catch because "CREATE TRIGGER IF NOT EXISTS" isn't supported.

try {
  db.exec(`
    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
    BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
} catch (e) { /* trigger already exists */ }

try {
  db.exec(`
    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories
    BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    END
  `);
} catch (e) { /* trigger already exists */ }

try {
  db.exec(`
    CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories
    BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content)
      VALUES (new.id, new.content);
    END
  `);
} catch (e) { /* trigger already exists */ }

// --- Vector table for semantic search (384-dim embeddings) ---
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
    embedding float[384]
  )
`);

// --- Knowledge Graph: entities + edges ---
// Entities are the "nouns" — people, files, tech, concepts
db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

// Edges connect entities to memories (or entities to entities)
db.exec(`
  CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY,
    source_id   INTEGER NOT NULL,
    target_id   INTEGER NOT NULL,
    relation    TEXT NOT NULL,
    source_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch())
  )
`);

console.error('[persyst] Schema initialized ✓');

// ============================================================
// PREPARED STATEMENTS
// Pre-compile SQL for performance. better-sqlite3 is synchronous.
// ============================================================

const stmts = {
  // -- Insert --
  insertMemory: db.prepare(
    'INSERT INTO memories (content, importance_score) VALUES (?, ?)'
  ),
  insertVec: db.prepare(
    'INSERT INTO memories_vec (rowid, embedding) VALUES (?, ?)'
  ),

  // -- Read --
  getById: db.prepare(
    'SELECT * FROM memories WHERE id = ?'
  ),
  getRecent: db.prepare(
    'SELECT * FROM memories ORDER BY created_at DESC LIMIT ?'
  ),
  getImportant: db.prepare(
    'SELECT * FROM memories ORDER BY importance_score DESC LIMIT ?'
  ),

  // -- Update --
  updateContent: db.prepare(
    'UPDATE memories SET content = ? WHERE id = ?'
  ),

  // -- Delete --
  deleteMemory: db.prepare(
    'DELETE FROM memories WHERE id = ?'
  ),
  deleteVec: db.prepare(
    'DELETE FROM memories_vec WHERE rowid = ?'
  ),

  // -- Memory Lifecycle --
  boost: db.prepare(`
    UPDATE memories
    SET access_count    = access_count + 1,
        importance_score = MIN(importance_score + 0.1, 2.0),
        last_accessed   = unixepoch()
    WHERE id = ?
  `),
  decay: db.prepare(`
    UPDATE memories
    SET importance_score = importance_score * 0.95
    WHERE (? - last_accessed) > 604800
  `),

  // -- Search --
  searchFts: db.prepare(`
    SELECT rowid AS id, rank
    FROM memories_fts
    WHERE memories_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
  searchVec: db.prepare(`
    SELECT rowid, distance
    FROM memories_vec
    WHERE embedding MATCH ?
    AND k = ?
  `),

  // -- Entity CRUD --
  insertEntity: db.prepare(
    'INSERT OR IGNORE INTO entities (name, type) VALUES (?, ?)'
  ),
  getEntityByName: db.prepare(
    'SELECT * FROM entities WHERE name = ?'
  ),
  getEntityById: db.prepare(
    'SELECT * FROM entities WHERE id = ?'
  ),
  getAllEntities: db.prepare(
    'SELECT * FROM entities ORDER BY created_at DESC LIMIT ?'
  ),
  deleteEntity: db.prepare(
    'DELETE FROM entities WHERE id = ?'
  ),

  // -- Edges --
  insertEdge: db.prepare(
    'INSERT INTO edges (source_id, target_id, relation, source_type, target_type) VALUES (?, ?, ?, ?, ?)'
  ),
  getEdgesBySource: db.prepare(
    'SELECT * FROM edges WHERE source_id = ? AND source_type = ?'
  ),
  getEdgesByTarget: db.prepare(
    'SELECT * FROM edges WHERE target_id = ? AND target_type = ?'
  ),
  deleteEdgesByMemory: db.prepare(
    `DELETE FROM edges WHERE
     (source_id = ? AND source_type = 'memory') OR
     (target_id = ? AND target_type = 'memory')`
  ),

  // -- Dedup --
  findMemoryByContent: db.prepare(
    'SELECT id FROM memories WHERE content LIKE ? LIMIT 1'
  )
};

// ============================================================
// CRUD FUNCTIONS
// Simple, one-purpose functions. No magic.
// ============================================================

/**
 * Insert a new memory into the memories table.
 * FTS5 index is auto-updated via trigger.
 * @returns {number} The new memory's ID
 */
export function insertMemory(content, importance = 1.0) {
  const result = stmts.insertMemory.run(content, importance);
  return Number(result.lastInsertRowid);
}

/**
 * Store an embedding vector for a memory.
 * @param {number} id - Memory ID (used as rowid in vec table)
 * @param {Float32Array} embedding - 384-dim embedding vector
 */
export function insertVector(id, embedding) {
  // better-sqlite3 needs Buffer, sqlite-vec needs BigInt for rowid
  stmts.insertVec.run(BigInt(id), Buffer.from(embedding.buffer));
}

/**
 * Get a memory by ID. Boosts its importance on access.
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemory(id) {
  const memory = stmts.getById.get(id);
  if (memory) boostMemory(id);
  return memory || null;
}

/**
 * Get a memory by ID WITHOUT boosting. Used internally for search results.
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemoryById(id) {
  return stmts.getById.get(id) || null;
}

/**
 * Update a memory's content. FTS5 index auto-updates via trigger.
 * Caller must also update the vector embedding separately.
 * @returns {boolean} true if the memory existed and was updated
 */
export function updateMemoryContent(id, content) {
  const result = stmts.updateContent.run(content, id);
  return result.changes > 0;
}

/**
 * Delete a vector embedding by memory ID.
 */
export function deleteVec(id) {
  try { stmts.deleteVec.run(BigInt(id)); } catch (e) { /* may not exist */ }
}

/**
 * Delete a memory and its vector embedding.
 * FTS5 index auto-updates via trigger.
 * @returns {boolean} true if the memory existed and was deleted
 */
export function deleteMemory(id) {
  deleteVec(id);  // Remove vector first (no cascades on virtual tables)
  const result = stmts.deleteMemory.run(id);
  return result.changes > 0;
}

/**
 * Get the N most recently created memories.
 */
export function getRecentMemories(limit = 10) {
  return stmts.getRecent.all(limit);
}

/**
 * Get the N most important memories (by importance_score).
 */
export function getImportantMemories(limit = 10) {
  return stmts.getImportant.all(limit);
}

// ============================================================
// MEMORY LIFECYCLE
// ============================================================

/**
 * Boost a memory's importance when it's accessed.
 * Increments access_count, adds 0.1 to importance (max 2.0),
 * and updates last_accessed timestamp.
 */
export function boostMemory(id) {
  stmts.boost.run(id);
}

/**
 * Apply temporal decay to old memories.
 * Reduces importance by 5% for memories not accessed in 7+ days.
 * Called automatically every hour by the server.
 */
export function applyTemporalDecay() {
  const now = Math.floor(Date.now() / 1000);
  const result = stmts.decay.run(now);
  if (result.changes > 0) {
    console.error(`[persyst] Decay applied to ${result.changes} memories`);
  }
}

// ============================================================
// SEARCH HELPERS (used by search.js)
// ============================================================

/**
 * Keyword search using FTS5 with BM25 ranking.
 * @returns {Array<{id: number, rank: number}>}
 */
export function searchKeyword(query, limit = 10) {
  try {
    return stmts.searchFts.all(query, limit);
  } catch (e) {
    // FTS5 can throw on special characters in query
    return [];
  }
}

/**
 * Vector similarity search using sqlite-vec KNN.
 * @param {Float32Array} embedding - Query vector (384-dim)
 * @returns {Array<{rowid: number, distance: number}>}
 */
export function searchVector(embedding, limit = 10) {
  return stmts.searchVec.all(Buffer.from(embedding.buffer), limit);
}

// ============================================================
// ENTITY FUNCTIONS (Knowledge Graph)
// ============================================================

/**
 * Create a named entity (person, tech, file, concept, etc.).
 * Silently skips if entity with that name already exists.
 * @returns {number|null} The entity ID, or null if already existed
 */
export function insertEntity(name, type) {
  const result = stmts.insertEntity.run(name, type);
  if (result.changes === 0) {
    // Already exists — return existing ID
    const existing = stmts.getEntityByName.get(name);
    return existing ? existing.id : null;
  }
  return Number(result.lastInsertRowid);
}

/**
 * Get an entity by its name.
 */
export function getEntityByName(name) {
  return stmts.getEntityByName.get(name) || null;
}

/**
 * Get an entity by its ID.
 */
export function getEntityById(id) {
  return stmts.getEntityById.get(id) || null;
}

/**
 * Get all entities, most recent first.
 */
export function getAllEntities(limit = 50) {
  return stmts.getAllEntities.all(limit);
}

/**
 * Delete an entity and its edges.
 */
export function deleteEntity(id) {
  stmts.deleteEntity.run(id);
}

/**
 * Create an edge connecting two nodes (entity↔entity or entity↔memory).
 */
export function insertEdge(sourceId, targetId, relation, sourceType, targetType) {
  stmts.insertEdge.run(sourceId, targetId, relation, sourceType, targetType);
}

/**
 * Get all memories linked to an entity.
 */
export function getMemoriesByEntity(entityId) {
  // Find edges where this entity is the source pointing to memories
  const edges = stmts.getEdgesBySource.all(entityId, 'entity');
  const memoryEdges = edges.filter(e => e.target_type === 'memory');
  return memoryEdges.map(e => stmts.getById.get(e.target_id)).filter(Boolean);
}

/**
 * Check if a memory with similar content already exists.
 * Used for deduplication during git ingestion.
 * @param {string} pattern - SQL LIKE pattern to match
 * @returns {boolean}
 */
export function memoryExists(pattern) {
  return stmts.findMemoryByContent.get(pattern) !== undefined;
}

/**
 * Delete a memory and clean up its edges.
 */
export function deleteMemoryFull(id) {
  stmts.deleteEdgesByMemory.run(id, id);
  deleteVec(id);
  const result = stmts.deleteMemory.run(id);
  return result.changes > 0;
}

// ============================================================
// CLEANUP
// ============================================================

/**
 * Close the database connection. Call on shutdown.
 */
export function closeDatabase() {
  db.close();
  console.error('[persyst] Database closed');
}

export default db;
