/**
 * database.js — SQLite Database Setup & CRUD Operations
 * 
 * This file handles everything database-related:
 * - Opens SQLite connection at ~/.persyst/persyst.db
 * - Loads the sqlite-vec extension for vector search
 * - Creates all tables (memories, FTS5 index, vector index)
 * - Runs schema migrations for production-grade bi-temporal model
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
// Store in ~/.persyst/ per default to persist across sessions
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
db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O for faster reads

// Load sqlite-vec BEFORE creating any vec0 tables
sqliteVec.load(db);

console.error(`[persyst] Database: ${DB_PATH}`);

// ============================================================
// CREATE TABLES & SCHEMA MIGRATIONS
// ============================================================

// --- Main memories table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id              INTEGER PRIMARY KEY,
    content         TEXT    NOT NULL,
    importance_score REAL   DEFAULT 1.0,
    created_at      INTEGER DEFAULT (unixepoch()),
    last_accessed   INTEGER DEFAULT (unixepoch()),
    access_count    INTEGER DEFAULT 0,
    valid_from      INTEGER DEFAULT (unixepoch()),
    valid_until     INTEGER DEFAULT NULL,
    assertion_time  INTEGER DEFAULT (unixepoch())
  )
`);

// --- Migrations for bi-temporal validity on existing tables ---
try {
  db.exec('ALTER TABLE memories ADD COLUMN valid_from INTEGER DEFAULT (unixepoch())');
} catch (e) { /* Column already exists */ }

try {
  db.exec('ALTER TABLE memories ADD COLUMN valid_until INTEGER DEFAULT NULL');
} catch (e) { /* Column already exists */ }

try {
  db.exec('ALTER TABLE memories ADD COLUMN assertion_time INTEGER DEFAULT (unixepoch())');
} catch (e) { /* Column already exists */ }

// --- Contradictions table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS contradictions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    old_memory_id     INTEGER NOT NULL,
    new_memory_id     INTEGER NOT NULL,
    resolved_at       INTEGER DEFAULT (unixepoch()),
    resolution_reason TEXT
  )
`);

// --- Provenance table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS provenance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id   INTEGER NOT NULL,
    source_type TEXT NOT NULL, -- agent | git | manual | api
    source_id   TEXT,          -- agent name or git hash
    created_at  INTEGER DEFAULT (unixepoch()),
    confidence  REAL NOT NULL
  )
`);

// --- Agent Stats table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_stats (
    agent_id              TEXT PRIMARY KEY,
    memories_created      INTEGER DEFAULT 0,
    memories_confirmed    INTEGER DEFAULT 0,
    memories_contradicted INTEGER DEFAULT 0,
    reputation_score      REAL DEFAULT 1.0,
    last_active           INTEGER DEFAULT (unixepoch())
  )
`);

// --- Migration: add domain column to agent_stats ---
try {
  db.exec('ALTER TABLE agent_stats ADD COLUMN domain TEXT DEFAULT "general"');
} catch (e) { /* Column already exists */ }

// --- Attestations table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS attestations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    attestation_id     TEXT NOT NULL UNIQUE,
    query              TEXT NOT NULL,
    timestamp          TEXT NOT NULL,
    memories_retrieved TEXT NOT NULL,
    agent_id           TEXT,
    session_id         TEXT,
    signature          TEXT NOT NULL,
    previous_hash      TEXT,
    hash               TEXT NOT NULL
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
db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch())
  )
`);

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
  insertProvenance: db.prepare(
    'INSERT INTO provenance (memory_id, source_type, source_id, confidence) VALUES (?, ?, ?, ?)'
  ),
  insertContradiction: db.prepare(
    'INSERT INTO contradictions (old_memory_id, new_memory_id, resolution_reason) VALUES (?, ?, ?)'
  ),
  upsertAgent: db.prepare(`
    INSERT INTO agent_stats (agent_id) VALUES (?)
    ON CONFLICT(agent_id) DO UPDATE SET last_active = unixepoch()
  `),
  incrementCreated: db.prepare(
    'UPDATE agent_stats SET memories_created = memories_created + 1 WHERE agent_id = ?'
  ),
  incrementConfirmed: db.prepare(
    'UPDATE agent_stats SET memories_confirmed = memories_confirmed + 1 WHERE agent_id = ?'
  ),
  incrementContradicted: db.prepare(
    'UPDATE agent_stats SET memories_contradicted = memories_contradicted + 1 WHERE agent_id = ?'
  ),
  recalculateReputation: db.prepare(
    'UPDATE agent_stats SET reputation_score = (memories_confirmed + 1.0) / (memories_contradicted + 1.0) WHERE agent_id = ?'
  ),
  insertAttestation: db.prepare(`
    INSERT INTO attestations (
      attestation_id, query, timestamp, memories_retrieved,
      agent_id, session_id, signature, previous_hash, hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  // -- Read --
  getById: db.prepare(
    'SELECT * FROM memories WHERE id = ? AND valid_until IS NULL'
  ),
  getAnyById: db.prepare(
    'SELECT * FROM memories WHERE id = ?'
  ),
  getRecent: db.prepare(
    'SELECT * FROM memories WHERE valid_until IS NULL ORDER BY created_at DESC LIMIT ?'
  ),
  getImportant: db.prepare(
    'SELECT * FROM memories WHERE valid_until IS NULL ORDER BY importance_score DESC LIMIT ?'
  ),
  getProvenance: db.prepare(
    'SELECT * FROM provenance WHERE memory_id = ?'
  ),
  getAllAgentStats: db.prepare(
    'SELECT * FROM agent_stats ORDER BY reputation_score DESC'
  ),
  getAttestation: db.prepare(
    'SELECT * FROM attestations WHERE attestation_id = ?'
  ),
  getLastAttestation: db.prepare(
    'SELECT * FROM attestations ORDER BY id DESC LIMIT 1'
  ),
  getAttestationsByDate: db.prepare(
    'SELECT * FROM attestations WHERE timestamp >= ? AND timestamp <= ? ORDER BY id ASC'
  ),

  // -- Update --
  updateContent: db.prepare(
    'UPDATE memories SET content = ? WHERE id = ?'
  ),
  archiveMemory: db.prepare(
    'UPDATE memories SET valid_until = unixepoch() WHERE id = ?'
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
    'SELECT id FROM memories WHERE content = ? AND valid_until IS NULL LIMIT 1'
  ),

  // -- Hash-prefix lookup for git dedup (Bug 1 fix) --
  findMemoryByHashPrefix: db.prepare(
    'SELECT id FROM memories WHERE content LIKE ? AND valid_until IS NULL LIMIT 1'
  ),

  // -- Active memory count --
  getActiveMemoryCount: db.prepare(
    'SELECT COUNT(*) as count FROM memories WHERE valid_until IS NULL'
  ),

  // -- Memory History Chain (Feature 6: prepared statements) --
  getContradictionAncestors: db.prepare(
    'SELECT old_memory_id FROM contradictions WHERE new_memory_id = ?'
  ),
  getContradictionDescendants: db.prepare(
    'SELECT new_memory_id FROM contradictions WHERE old_memory_id = ?'
  )
};

// ============================================================
// CRUD FUNCTIONS
// Simple, one-purpose functions. No magic.
// ============================================================

/**
 * Insert a new memory into the memories table and log its provenance.
 * @returns {number} The new memory's ID
 */
export function insertMemory(content, importance = 1.0, provenanceInfo = null) {
  const result = stmts.insertMemory.run(content, importance);
  const id = Number(result.lastInsertRowid);

  // Provenance Info handling
  const source_type = provenanceInfo?.source_type || 'manual';
  const source_id = provenanceInfo?.source_id || null;
  const confidence = provenanceInfo?.confidence !== undefined ? provenanceInfo.confidence : 1.0;

  stmts.insertProvenance.run(id, source_type, source_id, confidence);

  // Agent Stats handling
  if (source_type === 'agent' && source_id) {
    incrementAgentStat(source_id, 'created');
  }

  return id;
}

/**
 * Store an embedding vector for a memory.
 * @param {number} id - Memory ID (used as rowid in vec table)
 * @param {Float32Array} embedding - 384-dim embedding vector
 */
export function insertVector(id, embedding) {
  stmts.insertVec.run(BigInt(id), Buffer.from(embedding.buffer));
}

/**
 * Get a memory by ID. Boosts its importance on access.
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemory(id) {
  const memory = stmts.getById.get(id);
  if (memory) {
    boostMemory(id);
    // Fetch and link provenance info
    const prov = getProvenance(id);
    memory.provenance = prov;
  }
  return memory || null;
}

/**
 * Get a memory by ID WITHOUT boosting or checking bi-temporal validity.
 * @returns {object|null} The memory row, or null if not found
 */
export function getAnyMemoryById(id) {
  const memory = stmts.getAnyById.get(id);
  if (memory) {
    memory.provenance = getProvenance(id);
  }
  return memory || null;
}

/**
 * Get a memory by ID WITHOUT boosting. Used internally for search results.
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemoryById(id) {
  const memory = stmts.getById.get(id);
  if (memory) {
    memory.provenance = getProvenance(id);
  }
  return memory || null;
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
 * Delete a memory, its vector embedding, and all associated graph edges.
 * FTS5 index auto-updates via trigger.
 * @returns {boolean} true if the memory existed and was deleted
 */
export function deleteMemory(id) {
  stmts.deleteEdgesByMemory.run(id, id);
  deleteVec(id);  // Remove vector first (no cascades on virtual tables)
  const result = stmts.deleteMemory.run(id);
  return result.changes > 0;
}

/**
 * Get the N most recently created memories.
 */
export function getRecentMemories(limit = 10) {
  const rows = stmts.getRecent.all(limit);
  rows.forEach(r => {
    r.provenance = getProvenance(r.id);
  });
  return rows;
}

/**
 * Get the N most important memories (by importance_score).
 */
export function getImportantMemories(limit = 10) {
  const rows = stmts.getImportant.all(limit);
  rows.forEach(r => {
    r.provenance = getProvenance(r.id);
  });
  return rows;
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
 * Create a named entity (person, tech, project, concept, file).
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
 * Check if a memory with exact content already exists.
 * Used for deduplication.
 * @param {string} content - Exact content to match
 * @returns {boolean}
 */
export function memoryExists(content) {
  return stmts.findMemoryByContent.get(content) !== undefined;
}

/**
 * Check if a memory exists by hash prefix pattern (LIKE query).
 * Used for git commit deduplication where we match `[hashPrefix]%`.
 * @param {string} pattern - SQL LIKE pattern to match (e.g. '[abc1234]%')
 * @returns {boolean}
 */
export function memoryExistsByHashPrefix(pattern) {
  return stmts.findMemoryByHashPrefix.get(pattern) !== undefined;
}

/**
 * Get count of active (non-archived) memories.
 * @returns {number}
 */
export function getActiveMemoryCount() {
  return stmts.getActiveMemoryCount.get().count;
}

// ============================================================
// DEDUPLICATION BY EXACT CONTENT
// ============================================================

/**
 * Find memory by exact content.
 * @param {string} content
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemoryByContent(content) {
  const row = stmts.findMemoryByContent.get(content);
  return row ? getMemoryById(row.id) : null;
}

// ============================================================
// TEMPORAL CONTRADICTIONS & AGENT STATS & ATTESTATIONS CRUD
// ============================================================

/**
 * Archive a memory and log the contradiction.
 */
export function logContradiction(oldMemoryId, newMemoryId, reason = '') {
  stmts.archiveMemory.run(oldMemoryId);
  stmts.insertContradiction.run(oldMemoryId, newMemoryId, reason);

  // Track that the agent's memory was contradicted
  const oldProvenance = getProvenance(oldMemoryId);
  if (oldProvenance && oldProvenance.source_type === 'agent' && oldProvenance.source_id) {
    incrementAgentStat(oldProvenance.source_id, 'contradicted');
  }
}

/**
 * Get provenance for a memory.
 */
export function getProvenance(memoryId) {
  return stmts.getProvenance.get(memoryId) || null;
}

/**
 * Update agent reputation counters.
 */
export function incrementAgentStat(agentId, action) {
  stmts.upsertAgent.run(agentId);
  if (action === 'created') {
    stmts.incrementCreated.run(agentId);
  } else if (action === 'confirmed') {
    stmts.incrementConfirmed.run(agentId);
  } else if (action === 'contradicted') {
    stmts.incrementContradicted.run(agentId);
  }
  stmts.recalculateReputation.run(agentId);
}

/**
 * Get all agent stats.
 */
export function getAllAgentStats() {
  return stmts.getAllAgentStats.all();
}

/**
 * Upsert agent signature / record attestation in database.
 */
export function insertAttestation(att) {
  stmts.insertAttestation.run(
    att.attestation_id,
    att.query,
    att.timestamp,
    JSON.stringify(att.memories_retrieved),
    att.agent_id || null,
    att.session_id || null,
    att.signature,
    att.previous_hash || null,
    att.hash
  );
}

/**
 * Retrieve a specific attestation by ID.
 */
export function getAttestationById(attestationId) {
  return stmts.getAttestation.get(attestationId) || null;
}

/**
 * Retrieve the last attestation logged for chaining.
 */
export function getLastAttestation() {
  return stmts.getLastAttestation.get() || null;
}

/**
 * Retrieve attestations within a timestamp range.
 */
export function getAttestationsByDateRange(startDate, endDate) {
  return stmts.getAttestationsByDate.all(startDate, endDate);
}

/**
 * Traverses contradictions to get historical versions of a memory.
 */
export function getMemoryHistoryChain(memoryId) {
  const versions = new Set();
  const queue = [memoryId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (versions.has(currentId)) continue;
    versions.add(currentId);

    // Find ancestors (replaced by current) — using prepared statement
    const ancestors = stmts.getContradictionAncestors.all(currentId);
    ancestors.forEach(a => {
      if (!versions.has(a.old_memory_id)) queue.push(a.old_memory_id);
    });

    // Find descendants (replaces current) — using prepared statement
    const descendants = stmts.getContradictionDescendants.all(currentId);
    descendants.forEach(d => {
      if (!versions.has(d.new_memory_id)) queue.push(d.new_memory_id);
    });
  }

  const ids = Array.from(versions);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT m.*, p.source_type, p.source_id, p.confidence 
    FROM memories m
    LEFT JOIN provenance p ON m.id = p.memory_id
    WHERE m.id IN (${placeholders})
    ORDER BY m.created_at ASC
  `).all(...ids);

  return rows;
}

/**
 * Search all memories FTS (including archived memories).
 */
export function searchAllMemoriesFts(queryText, limit = 10) {
  try {
    return stmts.searchFts.all(queryText, limit);
  } catch (e) {
    return [];
  }
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
