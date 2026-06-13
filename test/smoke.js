/**
 * smoke.js — Persyst Smoke Test
 * 
 * Quick test to verify everything works end-to-end:
 *   1. Insert 10 sample memories (with embeddings)
 *   2. Semantic search: "night theme" should find "dark mode"
 *   3. Keyword search: "React" should find React memories
 *   4. Get recent + important memories
 *   5. Delete a memory and verify it's gone
 * 
 * Run: node test/smoke.js
 */

import { generateEmbedding } from '../src/embeddings.js';
import {
  insertMemory,
  insertVector,
  getMemory,
  deleteMemory,
  getRecentMemories,
  getImportantMemories
} from '../src/database.js';
import { searchHybrid } from '../src/search.js';

// ============================================================
// TEST DATA
// ============================================================

const SAMPLE_MEMORIES = [
  'User prefers dark mode in all applications',
  'The API endpoint /users should return JSON format',
  'Database migration failed last Tuesday, need to retry',
  'User said React is better than Vue for this project',
  'The production server runs on Ubuntu 22.04 with Node.js 18',
  'Never use eval() in production code',
  'User wants OAuth2 with GitHub and Google providers',
  'The CI pipeline runs on GitHub Actions with Node 18',
  'Database schema v2 adds user_preferences table',
  'User prefers function components over class components in React'
];

// ============================================================
// TEST RUNNER
// ============================================================

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n🧪 Persyst Smoke Test\n');

  // ----------------------------------------------------------
  // Test 1: Insert memories
  // ----------------------------------------------------------
  console.log('📝 Test 1: Insert 10 memories with embeddings');
  const ids = [];
  for (const content of SAMPLE_MEMORIES) {
    const id = insertMemory(content);
    const embedding = await generateEmbedding(content);
    insertVector(id, embedding);
    ids.push(id);
  }
  assert(ids.length === 10, `Inserted ${ids.length} memories`);

  // ----------------------------------------------------------
  // Test 2: Get memory by ID
  // ----------------------------------------------------------
  console.log('\n🔍 Test 2: Get memory by ID');
  const memory = getMemory(ids[0]);
  assert(memory !== null, 'Memory retrieved successfully');
  assert(memory.content === SAMPLE_MEMORIES[0], 'Content matches');

  // ----------------------------------------------------------
  // Test 3: Semantic search — "night theme" should find "dark mode"
  // ----------------------------------------------------------
  console.log('\n🧠 Test 3: Semantic search');
  const semanticResults = await searchHybrid('night theme', 3);
  const foundDarkMode = semanticResults.some(r =>
    r.content.includes('dark mode')
  );
  assert(foundDarkMode, '"night theme" → finds "dark mode" (semantic match)');

  // ----------------------------------------------------------
  // Test 4: Keyword search — "React" should find React memories
  // ----------------------------------------------------------
  console.log('\n🔤 Test 4: Keyword search');
  const keywordResults = await searchHybrid('React', 5);
  const foundReact = keywordResults.some(r => r.content.includes('React'));
  assert(foundReact, '"React" → finds React memories (keyword match)');

  // ----------------------------------------------------------
  // Test 5: Recent memories
  // ----------------------------------------------------------
  console.log('\n⏱️  Test 5: Get recent memories');
  const recent = getRecentMemories(5);
  assert(recent.length === 5, `Got ${recent.length} recent memories`);

  // ----------------------------------------------------------
  // Test 6: Important memories
  // ----------------------------------------------------------
  console.log('\n⭐ Test 6: Get important memories');
  const important = getImportantMemories(5);
  assert(important.length === 5, `Got ${important.length} important memories`);

  // ----------------------------------------------------------
  // Test 7: Delete memory
  // ----------------------------------------------------------
  console.log('\n🗑️  Test 7: Delete memory');
  const deleted = deleteMemory(ids[0]);
  assert(deleted, 'Memory deleted successfully');
  const gone = getMemory(ids[0]);
  assert(gone === null, 'Deleted memory returns null');

  // ----------------------------------------------------------
  // Cleanup: remove remaining test memories
  // ----------------------------------------------------------
  for (const id of ids.slice(1)) {
    deleteMemory(id);
  }

  // ----------------------------------------------------------
  // Summary
  // ----------------------------------------------------------
  console.log(`\n${'═'.repeat(40)}`);
  console.log(`📊 Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(40)}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

// Run it
runTests().catch(err => {
  console.error('💥 Test crashed:', err);
  process.exit(1);
});
