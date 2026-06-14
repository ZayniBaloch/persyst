/**
 * Test: Per-agent namespace isolation
 * Verifies that agent-specific memories are isolated from each other
 * while shared memories remain visible to all.
 */

import {
  insertMemory, insertVector, getRecentMemories,
  memoryExists, getMemoryById, getActiveMemoryCount,
  getNamespaceStats, getMemoryByContent
} from '../src/database.js';
import { generateEmbedding } from '../src/embeddings.js';
import { searchHybrid } from '../src/search.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.log(`  ❌ ${msg}`); failed++; }
}

async function run() {
  console.log('\n🧪 Namespace Isolation Test\n');

  // 1. Insert shared memory
  console.log('📝 Step 1: Insert shared memory');
  const sharedId = insertMemory('Project uses PostgreSQL for the database', 1.0, {
    source_type: 'agent', source_id: 'setup', confidence: 1.0
  }, 'shared');
  const sharedEmb = await generateEmbedding('Project uses PostgreSQL for the database');
  insertVector(sharedId, sharedEmb);
  assert(sharedId > 0, `Shared memory inserted (id=${sharedId})`);

  // 2. Insert agent-a specific memory
  console.log('\n📝 Step 2: Insert agent-a private memory');
  const agentAId = insertMemory('Agent A prefers tabs over spaces', 0.8, {
    source_type: 'agent', source_id: 'agent-a', confidence: 1.0
  }, 'agent-a');
  const agentAEmb = await generateEmbedding('Agent A prefers tabs over spaces');
  insertVector(agentAId, agentAEmb);
  assert(agentAId > 0, `Agent-a memory inserted (id=${agentAId})`);

  // 3. Insert agent-b specific memory
  console.log('\n📝 Step 3: Insert agent-b private memory');
  const agentBId = insertMemory('Agent B prefers spaces over tabs', 0.8, {
    source_type: 'agent', source_id: 'agent-b', confidence: 1.0
  }, 'agent-b');
  const agentBEmb = await generateEmbedding('Agent B prefers spaces over tabs');
  insertVector(agentBId, agentBEmb);
  assert(agentBId > 0, `Agent-b memory inserted (id=${agentBId})`);

  // 4. Test: agent-a sees shared + own, NOT agent-b
  console.log('\n🔍 Step 4: Agent-a namespace visibility');
  const recentA = getRecentMemories(50, 'agent-a');
  const recentAIds = recentA.map(m => m.id);
  assert(recentAIds.includes(sharedId), 'Agent-a sees shared memory');
  assert(recentAIds.includes(agentAId), 'Agent-a sees own memory');
  assert(!recentAIds.includes(agentBId), 'Agent-a does NOT see agent-b memory');

  // 5. Test: agent-b sees shared + own, NOT agent-a
  console.log('\n🔍 Step 5: Agent-b namespace visibility');
  const recentB = getRecentMemories(50, 'agent-b');
  const recentBIds = recentB.map(m => m.id);
  assert(recentBIds.includes(sharedId), 'Agent-b sees shared memory');
  assert(recentBIds.includes(agentBId), 'Agent-b sees own memory');
  assert(!recentBIds.includes(agentAId), 'Agent-b does NOT see agent-a memory');

  // 6. Test: no namespace = sees all
  console.log('\n🔍 Step 6: Global (no namespace) visibility');
  const recentAll = getRecentMemories(50, null);
  const recentAllIds = recentAll.map(m => m.id);
  assert(recentAllIds.includes(sharedId), 'Global sees shared');
  assert(recentAllIds.includes(agentAId), 'Global sees agent-a');
  assert(recentAllIds.includes(agentBId), 'Global sees agent-b');

  // 7. Test: getMemoryById with namespace filter
  console.log('\n🔍 Step 7: getMemoryById namespace filtering');
  assert(getMemoryById(agentAId, 'agent-a') !== null, 'Agent-a can get own memory by ID');
  assert(getMemoryById(agentAId, 'agent-b') === null, 'Agent-b cannot get agent-a memory by ID');
  assert(getMemoryById(sharedId, 'agent-a') !== null, 'Agent-a can get shared memory by ID');
  assert(getMemoryById(sharedId, 'agent-b') !== null, 'Agent-b can get shared memory by ID');

  // 8. Test: dedup is namespace-aware
  console.log('\n🔍 Step 8: Namespace-aware dedup');
  assert(memoryExists('Agent A prefers tabs over spaces', 'agent-a'), 'Dedup finds agent-a memory in agent-a namespace');
  assert(!memoryExists('Agent A prefers tabs over spaces', 'agent-b'), 'Dedup does NOT find agent-a memory in agent-b namespace');

  // 9. Test: namespace stats
  console.log('\n📊 Step 9: Namespace stats');
  const stats = getNamespaceStats();
  assert(stats.length > 0, `Got ${stats.length} namespace(s)`);
  for (const s of stats) {
    console.log(`    ${s.namespace}: ${s.count} memories`);
  }

  // 10. Search with namespace
  console.log('\n🔍 Step 10: Hybrid search with namespace');
  const searchA = await searchHybrid('tabs spaces preference', 5, 'agent-a', null, 'agent-a');
  const foundOwnPref = searchA.some(r => r.content.includes('tabs over spaces'));
  const foundOtherPref = searchA.some(r => r.content.includes('spaces over tabs'));
  assert(foundOwnPref, 'Agent-a search finds own tab preference');
  assert(!foundOtherPref, 'Agent-a search does NOT find agent-b tab preference');

  console.log(`\n════════════════════════════════════════`);
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`════════════════════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
