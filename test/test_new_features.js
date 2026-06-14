import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import db, {
  insertMemory,
  insertVector,
  getMemory,
  getAnyMemoryById,
  logContradiction,
  getProvenance,
  incrementAgentStat,
  getAllAgentStats,
  closeDatabase
} from '../src/database.js';
import { generateEmbedding } from '../src/embeddings.js';
import { searchHybrid, consolidateMemories } from '../src/search.js';
import { createAttestation, verifyChainIntegrity } from '../src/attestation.js';

test.before(() => {
  db.exec('DELETE FROM contradictions; DELETE FROM provenance; DELETE FROM agent_stats; DELETE FROM attestations; DELETE FROM edges; DELETE FROM entities; DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM memories_fts;');
});

test.after(() => {
  closeDatabase();
});

test('Production-Grade Feature Enhancements', async (t) => {
  let memId1, memId2;

  await t.test('Feature 1: Bi-temporal model and contradictions', () => {
    // 1. Insert a memory
    memId1 = insertMemory('System utilizes Node.js version 18', 1.0, {
      source_type: 'manual',
      confidence: 1.0
    });

    const mem1 = getMemory(memId1);
    assert.ok(mem1);
    assert.equal(mem1.valid_until, null, 'Memory is active by default');

    // 2. Insert contradicting memory
    memId2 = insertMemory('System utilizes Node.js version 22', 1.0, {
      source_type: 'agent',
      source_id: 'claude-agent',
      confidence: 1.0
    });

    logContradiction(memId1, memId2, 'Upgrade node version');

    // 3. Verify old memory is archived (getMemory filters by valid_until IS NULL)
    const activeMem1 = getMemory(memId1);
    assert.equal(activeMem1, null, 'Old memory should be archived and not returned in normal get');

    // 4. Verify old memory can still be accessed via getAnyMemoryById
    const archivedMem1 = getAnyMemoryById(memId1);
    assert.ok(archivedMem1);
    assert.ok(archivedMem1.valid_until !== null, 'Old memory has valid_until set');

    // 5. Verify contradiction is logged
    const contradiction = db.prepare('SELECT * FROM contradictions WHERE old_memory_id = ?').get(memId1);
    assert.ok(contradiction);
    assert.equal(contradiction.new_memory_id, memId2);
    assert.equal(contradiction.resolution_reason, 'Upgrade node version');
  });

  await t.test('Feature 2: Provenance Tracking', () => {
    const prov1 = getProvenance(memId1);
    assert.ok(prov1);
    assert.equal(prov1.source_type, 'manual');
    assert.equal(prov1.confidence, 1.0);

    const prov2 = getProvenance(memId2);
    assert.ok(prov2);
    assert.equal(prov2.source_type, 'agent');
    assert.equal(prov2.source_id, 'claude-agent');
    assert.equal(prov2.confidence, 1.0);
  });

  await t.test('Feature 3: Agent Reputation System', () => {
    // 1. Trigger stats increments
    incrementAgentStat('test-agent', 'created');
    incrementAgentStat('test-agent', 'confirmed');
    incrementAgentStat('test-agent', 'contradicted');

    const stats = getAllAgentStats();
    const testAgent = stats.find(s => s.agent_id === 'test-agent');
    assert.ok(testAgent);
    assert.equal(testAgent.memories_created, 1);
    assert.equal(testAgent.memories_confirmed, 1);
    assert.equal(testAgent.memories_contradicted, 1);
    // reputation = (1 + 1) / (1 + 1) = 1.0
    assert.equal(testAgent.reputation_score, 1.0);
  });

  await t.test('Feature 4: Cryptographic Attestation', () => {
    // 1. Create a dummy search list to attest
    const dummyMemories = [
      { id: memId2, content: 'System utilizes Node.js version 22', hybrid_score: 0.95 }
    ];

    const attestation = createAttestation('Node version query', dummyMemories, 'claude-agent', 'session-abc');
    assert.ok(attestation.attestation_id);
    assert.ok(attestation.signature);
    assert.ok(attestation.hash);
    assert.equal(attestation.query, 'Node version query');

    // 2. Verify signature and chain
    const verification = verifyChainIntegrity(attestation.attestation_id);
    assert.ok(verification.valid, `Should be valid, error: ${verification.error}`);
  });

  await t.test('Feature 7: Memory Consolidation', async () => {
    // Insert three identical/very similar memories and their vectors
    const dup1 = insertMemory('The compiler flags are set to optimization level O3', 0.8);
    const emb1 = await generateEmbedding('The compiler flags are set to optimization level O3');
    insertVector(dup1, emb1);

    const dup2 = insertMemory('The compiler optimization flags are set to level O3', 0.6);
    const emb2 = await generateEmbedding('The compiler optimization flags are set to level O3');
    insertVector(dup2, emb2);

    const dup3 = insertMemory('Compiler flags are configured for O3 optimization level', 0.5);
    const emb3 = await generateEmbedding('Compiler flags are configured for O3 optimization level');
    insertVector(dup3, emb3);

    // Run consolidation
    const report = await consolidateMemories();
    assert.ok(report.success);
    assert.equal(report.consolidated_groups, 1, 'Should consolidate the similar memories group');

    // dup1 was the canonical one (highest importance 0.8)
    const activeCanonical = getMemory(dup1);
    assert.ok(activeCanonical, 'Canonical memory should remain active');
    
    // Check that duplicates are archived
    assert.equal(getMemory(dup2), null, 'Duplicate 2 should be archived');
    assert.equal(getMemory(dup3), null, 'Duplicate 3 should be archived');

    // Verification of contradiction links
    const contradictionLink = db.prepare('SELECT * FROM contradictions WHERE old_memory_id = ?').get(dup2);
    assert.ok(contradictionLink);
    assert.equal(contradictionLink.new_memory_id, dup1);
  });
});
