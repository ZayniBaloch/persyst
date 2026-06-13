import test from 'node:test';
import assert from 'node:assert/strict';
import db, {
  insertMemory,
  getMemoryById,
  deleteMemoryFull,
  insertEntity,
  getEntityByName,
  insertEdge,
  getMemoriesByEntity,
  applyTemporalDecay,
  closeDatabase
} from '../src/database.js';

// Setup before tests
test.before(() => {
  // Clear any existing data in the in-memory DB just in case
  db.exec('DELETE FROM edges; DELETE FROM entities; DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM memories_fts;');
});

// Teardown after tests
test.after(() => {
  closeDatabase();
});

test('Database constraints and defaults', async (t) => {
  await t.test('insertMemory creates memory with default importance_score = 1.0', () => {
    const id = insertMemory('Test constraint memory');
    const memory = getMemoryById(id);
    assert.equal(memory.importance_score, 1.0);
    assert.equal(memory.access_count, 0);
  });

  await t.test('insertMemory respects custom importance_score', () => {
    const id = insertMemory('Important memory', 0.8);
    const memory = getMemoryById(id);
    assert.equal(memory.importance_score, 0.8);
  });
});

test('Temporal Decay', async (t) => {
  await t.test('Decay reduces importance by 5% after 7 days', () => {
    const id = insertMemory('Old memory');
    
    // Manually backdate last_accessed by 8 days
    const eightDaysInSeconds = 8 * 24 * 60 * 60;
    const now = Math.floor(Date.now() / 1000);
    db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?').run(now - eightDaysInSeconds, id);

    // Apply decay
    applyTemporalDecay();

    const decayedMemory = getMemoryById(id);
    // 1.0 * 0.95 = 0.95
    assert.equal(decayedMemory.importance_score, 0.95);
  });

  await t.test('Decay does NOT affect memories accessed recently', () => {
    const id = insertMemory('New memory');
    
    // Apply decay
    applyTemporalDecay();

    const memory = getMemoryById(id);
    assert.equal(memory.importance_score, 1.0);
  });
});

test('Knowledge Graph', async (t) => {
  await t.test('Entities are unique by name', () => {
    const id1 = insertEntity('TestEntity', 'concept');
    const id2 = insertEntity('TestEntity', 'concept');
    
    // Should return the existing ID
    assert.equal(id1, id2);
  });

  await t.test('getMemoriesByEntity fetches linked memories', () => {
    const memId1 = insertMemory('Graph memory 1');
    const memId2 = insertMemory('Graph memory 2');
    const entityId = insertEntity('GraphNode', 'concept');

    insertEdge(entityId, memId1, 'mentions', 'entity', 'memory');
    insertEdge(entityId, memId2, 'mentions', 'entity', 'memory');

    const linked = getMemoriesByEntity(entityId);
    assert.equal(linked.length, 2);
    
    const contents = linked.map(m => m.content);
    assert.ok(contents.includes('Graph memory 1'));
    assert.ok(contents.includes('Graph memory 2'));
  });

  await t.test('deleteMemoryFull cleans up edges', () => {
    const memId = insertMemory('Memory to delete');
    const entityId = insertEntity('DeleteNode', 'concept');

    insertEdge(entityId, memId, 'mentions', 'entity', 'memory');
    
    // Edge should exist
    let edges = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ?').all(entityId, memId);
    assert.equal(edges.length, 1);

    // Delete memory
    const deleted = deleteMemoryFull(memId);
    assert.ok(deleted);

    // Edge should be gone
    edges = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ?').all(entityId, memId);
    assert.equal(edges.length, 0);
  });
});
