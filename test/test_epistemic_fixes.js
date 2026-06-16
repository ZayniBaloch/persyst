import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import db, {
  closeDatabase,
  getMemoryById,
  getAnyMemoryById,
  getProvenance,
  incrementAgentStat,
  insertEntity,
  insertEdge,
  insertMemory,
  insertVector
} from '../src/database.js';
import { generateEmbedding } from '../src/embeddings.js';
import { searchHybrid, getOptimizedContext, consolidateMemories } from '../src/search.js';
import { getRecentCommits } from '../src/git.js';

let server;
const handlers = {};

test.before(() => {
  db.exec('DELETE FROM contradictions; DELETE FROM provenance; DELETE FROM agent_stats; DELETE FROM attestations; DELETE FROM edges; DELETE FROM entities; DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM memories_fts;');
  server = new McpServer({ name: 'test-fixes', version: '1.0.0' });
  
  const originalTool = server.tool;
  server.tool = (name, desc, schema, callback) => {
    handlers[name] = callback;
    return originalTool.call(server, name, desc, schema, callback);
  };
  
  registerTools(server);
});

test.after(() => {
  closeDatabase();
});

test('Epistemic Resolutions & QA Stress-Test Fixes', async (t) => {
  
  await t.test('1. Cross-Agent Contradiction Detection (Trust scoring & case-insensitivity)', async () => {
    const addMemoryHandler = handlers['add_memory'];
    const getStatsHandler = handlers['get_agent_stats'];
    
    // 1a. Verify Case-Insensitivity of agent ID stats (AGENT-TRUSTED and agent-trusted map to same row)
    incrementAgentStat('agent-trusted', 'created');
    incrementAgentStat('agent-trusted', 'confirmed'); // reputation will be high: (1 + 1.0) / (0 + 1.0) = 2.0
    incrementAgentStat('AGENT-TRUSTED', 'confirmed'); // reputation will be even higher: (2 + 1.0) / (0 + 1.0) = 3.0
    
    incrementAgentStat('agent-untrusted', 'created');
    incrementAgentStat('agent-untrusted', 'contradicted'); // reputation will be low: (0 + 1.0) / (1 + 1.0) = 0.5

    const statsRes0 = await getStatsHandler();
    const stats0 = JSON.parse(statsRes0.content[0].text).stats;
    const trustedStats0 = stats0.find(s => s.agent_id === 'agent-trusted');
    assert.ok(trustedStats0);
    assert.equal(trustedStats0.memories_confirmed, 2, 'Case-insensitive stats should merge to same agent_id row');

    // 1b. Verify antigravity-worker is ignored from reputation updates
    incrementAgentStat('antigravity-worker', 'contradicted');
    const statsRes1 = await getStatsHandler();
    const stats1 = JSON.parse(statsRes1.content[0].text).stats;
    const workerStats = stats1.find(s => s.agent_id === 'antigravity-worker');
    assert.equal(workerStats, undefined, 'antigravity-worker should be ignored from reputation stats');

    // 1c. Insert memory as log-watcher (antigravity-worker) to test ghost re-attribution
    const watcherMemId = insertMemory('Persyst primary database is PostgreSQL.', 0.9, {
      source_type: 'agent',
      source_id: 'antigravity-worker',
      confidence: 0.8
    }, 'shared');
    const watcherEmb = await generateEmbedding('Persyst primary database is PostgreSQL.');
    insertVector(watcherMemId, watcherEmb);

    // Calling add_memory with agent-trusted (cased as AGENT-TRUSTED) should re-attribute it
    const resA = await addMemoryHandler({
      content: 'Persyst primary database is PostgreSQL.',
      agent_id: 'AGENT-TRUSTED',
      importance: 0.9,
      shared: true
    });
    const dataA = JSON.parse(resA.content[0].text);
    assert.ok(dataA.success);
    assert.equal(dataA.id, watcherMemId, 'Should return the existing memory ID');

    const updatedProv = getProvenance(watcherMemId);
    assert.equal(updatedProv.source_id, 'agent-trusted', 'Provenance should be re-attributed to calling agent in lowercase');

    // Agent Untrusted tries to store a contradictory fact
    const resB = await addMemoryHandler({
      content: 'Persyst primary database is MongoDB.',
      agent_id: 'agent-untrusted',
      importance: 0.9,
      shared: true
    });
    const dataB = JSON.parse(resB.content[0].text);
    assert.ok(dataB.success);
    assert.ok(dataB.message.includes('contradiction'));
    assert.equal(dataB.contradictions_detected[0].resolution, 'kept_old');

    // Verify Agent Trusted's memory is active, and Agent Untrusted's memory is archived immediately
    const memA = getMemoryById(dataA.id);
    assert.ok(memA, 'Trusted agent memory should remain active');
    
    const memB = getMemoryById(dataB.id);
    assert.equal(memB, null, 'Untrusted agent memory should be archived immediately');

    const archivedB = getAnyMemoryById(dataB.id);
    assert.ok(archivedB.valid_until !== null, 'Untrusted agent memory valid_until should be populated');

    // Verify reputation updates
    const statsRes2 = await getStatsHandler();
    const stats2 = JSON.parse(statsRes2.content[0].text).stats;
    const trustedStats = stats2.find(s => s.agent_id === 'agent-trusted');
    const untrustedStats = stats2.find(s => s.agent_id === 'agent-untrusted');
    
    assert.equal(trustedStats.memories_confirmed, 3, 'Trusted agent should be confirmed again');
    assert.equal(untrustedStats.memories_contradicted, 2, 'Untrusted agent contradicted should increment');
  });

  await t.test('2. Versioning Updates (Same Agent) does not penalize reputation', async () => {
    const addMemoryHandler = handlers['add_memory'];
    const updateMemoryHandler = handlers['update_memory'];
    
    // Create first version
    const res1 = await addMemoryHandler({
      content: 'App version is 1.0.0-beta.',
      agent_id: 'agent-updater',
      importance: 0.8,
      shared: true
    });
    const data1 = JSON.parse(res1.content[0].text);
    
    // Record initial stats
    incrementAgentStat('agent-updater', 'created');
    const statsBefore = db.prepare("SELECT * FROM agent_stats WHERE agent_id = 'agent-updater'").get();
    const initialContradicted = statsBefore ? statsBefore.memories_contradicted : 0;

    // Update memory content
    const res2 = await updateMemoryHandler({
      id: data1.id,
      content: 'App version is 1.0.0-release.',
      agent_id: 'agent-updater'
    });
    const data2 = JSON.parse(res2.content[0].text);
    assert.ok(data2.success);

    // Verify old version archived, new version active
    assert.equal(getMemoryById(data1.id), null);
    assert.ok(getMemoryById(data2.id));

    // Verify reputation not penalized
    const statsAfter = db.prepare("SELECT * FROM agent_stats WHERE agent_id = 'agent-updater'").get();
    assert.equal(statsAfter.memories_contradicted, initialContradicted, 'Contradicted count should not increase on self-update');
  });

  await t.test('3. Semantic Consolidation avoids Frankenstein concatenation', async () => {
    // Insert three highly similar/duplicate/subset memories
    const dup1 = insertMemory('The local build is optimized for release.', 0.9, { source_type: 'manual' }, 'shared');
    const emb1 = await generateEmbedding('The local build is optimized for release.');
    insertVector(dup1, emb1);

    const dup2 = insertMemory('Local build is configured for release optimization.', 0.8, { source_type: 'manual' }, 'shared');
    const emb2 = await generateEmbedding('Local build is configured for release optimization.');
    insertVector(dup2, emb2);

    const dup3 = insertMemory('The local build is optimized for release.', 0.5, { source_type: 'manual' }, 'shared');
    const emb3 = await generateEmbedding('The local build is optimized for release.');
    insertVector(dup3, emb3);

    // Run consolidation
    const consolidateHandler = handlers['consolidate_memories'];
    const res = await consolidateHandler();
    const data = JSON.parse(res.content[0].text);
    
    assert.ok(data.success);
    
    // Check that canonical one remains, others archived
    const active1 = getMemoryById(dup1);
    assert.ok(active1);
    assert.equal(getMemoryById(dup2), null, 'Duplicate should be consolidated');
    assert.equal(getMemoryById(dup3), null, 'Duplicate should be consolidated');

    // Confirm that the content is NOT concatenated into a Frankenstein sentence
    assert.equal(active1.content, 'The local build is optimized for release.', 'Canonical memory content should remain clean');
  });

  await t.test('4. Graph Hopping Traversal in Context Retrieval (depth 6 BFS / Implicit hopping)', async () => {
    // Create three entities without any explicit edges
    const entA = insertEntity('Entity-A', 'concept');
    const entB = insertEntity('Entity-B', 'concept');
    const entC = insertEntity('Entity-C', 'concept');

    // Memory 1 (Direct search hit) mentions Entity-A
    const memId1 = insertMemory('Compiler optimizations are configured for Entity-A.', 0.9, { source_type: 'manual' }, 'shared');
    const emb1 = await generateEmbedding('Compiler optimizations are configured for Entity-A.');
    insertVector(memId1, emb1);

    // Memory 2 connects Entity-A to Entity-B
    const memId2 = insertMemory('Entity-A is related to Entity-B.', 0.8, { source_type: 'manual' }, 'shared');
    const emb2 = await generateEmbedding('Entity-A is related to Entity-B.');
    insertVector(memId2, emb2);

    // Memory 3 connects Entity-B to Entity-C
    const memId3 = insertMemory('Entity-B is connected to Entity-C.', 0.8, { source_type: 'manual' }, 'shared');
    const emb3 = await generateEmbedding('Entity-B is connected to Entity-C.');
    insertVector(memId3, emb3);

    // Memory 4 (Hopped fact) mentions Entity-C (this is 6 hops away from starting memory 1: M1 -> A -> M2 -> B -> M3 -> C -> M4)
    const memId4 = insertMemory('Production server is hosted on Entity-C.', 0.8, { source_type: 'manual' }, 'shared');
    const emb4 = await generateEmbedding('Production server is hosted on Entity-C.');
    insertVector(memId4, emb4);

    // Run getOptimizedContext searching for M1's concept (without mentioning Entity-C in query)
    const getContextHandler = handlers['get_optimized_context'];
    const res = await getContextHandler({ query: 'Compiler optimizations', max_tokens: 4000 });
    const data = JSON.parse(res.content[0].text);

    // M4 should be retrieved via implicit graph hopping
    const hoppedMem = data.memories.find(m => m.id === memId4);
    assert.ok(hoppedMem, 'Memory 4 should be traversed and retrieved');
    assert.equal(hoppedMem.source, 'hop', 'Hopped memory should have source: "hop" provenance');
  });

  await t.test('5. Reliable History Tracing and Semantic Diffs', async () => {
    const addMemoryHandler = handlers['add_memory'];
    const updateMemoryHandler = handlers['update_memory'];
    const historyHandler = handlers['get_memory_history'];

    // Insert version 1
    const res1 = await addMemoryHandler({
      content: 'Server running on port 3000.',
      agent_id: 'agent-diff',
      importance: 0.7
    });
    const data1 = JSON.parse(res1.content[0].text);

    // Update to version 2
    const res2 = await updateMemoryHandler({
      id: data1.id,
      content: 'Server running on port 8080.',
      agent_id: 'agent-diff'
    });
    const data2 = JSON.parse(res2.content[0].text);

    // Retrieve history specifically using the ID of the new version
    const historyRes = await historyHandler({ query: String(data2.id) });
    const historyData = JSON.parse(historyRes.content[0].text);

    assert.ok(historyData.histories[data2.id], 'History should be found directly by ID');
    const chain = historyData.histories[data2.id];
    
    assert.equal(chain.length, 2, 'History chain should contain exactly 2 versions');
    
    // Check semantic diff on the second version
    const version2 = chain[1];
    assert.ok(version2.diff_from_previous);
    assert.ok(version2.diff_from_previous.includes('[-3000.-]'), 'Diff should show deleted port');
    assert.ok(version2.diff_from_previous.includes('[+8080.+]'), 'Diff should show added port');

    // Retrieve history using the new version's content (bidirectional content search)
    const historyRes2 = await historyHandler({ query: 'port 8080' });
    const historyData2 = JSON.parse(historyRes2.content[0].text);
    assert.ok(historyData2.histories[data2.id], 'History should be found by searching new content');
    assert.equal(historyData2.histories[data2.id].length, 2, 'History chain should contain exactly 2 versions');
  });

  await t.test('6. Graceful Git Fallback error messaging', async () => {
    await assert.rejects(async () => {
      await getRecentCommits('C:\\non-existent-directory-random-1234', 10);
    }, (err) => {
      return err.message.includes('Not a git repository') || 
             err.message.includes('Git binary not found') ||
             err.message.includes('Failed to read git log');
    });
  });

  await t.test('7. Content size cap (10KB limit)', async () => {
    const addMemoryHandler = handlers['add_memory'];
    const largeContent = 'A'.repeat(10005);
    const res = await addMemoryHandler({ content: largeContent, importance: 0.5 });
    const result = JSON.parse(res.content[0].text);
    assert.ok(result.error, 'Oversized content should be rejected with an error');
    assert.ok(result.error.includes('exceeds maximum length'), 'Error message should indicate size violation');
  });

  await t.test('8. Cryptographic Attestation double-write prevention', async () => {
    const getContextHandler = handlers['get_optimized_context'];
    
    const countBefore = db.prepare('SELECT COUNT(*) as count FROM attestations').get().count;
    await getContextHandler({ query: 'Compiler optimizations', max_tokens: 4000 });
    const countAfter = db.prepare('SELECT COUNT(*) as count FROM attestations').get().count;
    
    assert.equal(countAfter - countBefore, 1, 'Exactly one attestation should be created per context query');
  });
});
