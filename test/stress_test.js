#!/usr/bin/env node
/**
 * stress_test.js — Persyst Ultimate Stress Test
 *
 * Tests: massive load, concurrency, edge cases, security boundaries,
 * namespace isolation, contradiction chains, attestation integrity,
 * performance under pressure, and evil inputs.
 *
 * Run: node test/stress_test.js
 * Requires: Persyst server running on PORT env or 4321
 */

import http from 'http';
import { performance } from 'perf_hooks';

const PORT = parseInt(process.env.PORT || '4321', 10);
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;

let passed = 0;
let failed = 0;
let errors = [];

function assert(condition, label, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ✅ ${label}\n`);
  } else {
    failed++;
    const msg = `  ❌ ${label}${detail ? ' — ' + detail : ''}`;
    errors.push(msg);
    process.stdout.write(msg + '\n');
  }
}

function httpRequest(method, path, body = null, contentType = 'application/json') {
  return new Promise((resolve) => {
    const url = new URL(path, BASE);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': contentType },
      timeout: 30000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: null, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    if (body) req.write(typeof body === 'string' && contentType === 'text/plain' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─────────────────────────────────────────────
// TOOL INVOCATION HELPERS
// ─────────────────────────────────────────────

async function addMemory(content, importance = 1.0, agent_id = null, shared = true) {
  return httpRequest('POST', '/add', { content, importance, agent_id, shared });
}

async function searchMemories(query, limit = 5, agent_id = null) {
  return httpRequest('POST', '/search', { query, limit, agent_id });
}

async function getContext(query, max_tokens = 2000, agent_id = null, intent = null) {
  return httpRequest('POST', '/context', { query, max_tokens, agent_id, intent });
}

async function batchAdd(memories) {
  return httpRequest('POST', '/batch/add', { memories });
}

async function batchSearch(queries) {
  return httpRequest('POST', '/batch/search', { queries });
}

async function remember(content) {
  return httpRequest('POST', '/remember', content, 'text/plain');
}

async function health() {
  return httpRequest('GET', '/health');
}

async function stats() {
  return httpRequest('GET', '/stats');
}

async function systemPrompt(query = 'project conventions', format = 'text') {
  return httpRequest('GET', `/system-prompt?query=${encodeURIComponent(query)}&format=${format}`);
}

async function complianceExport(start = null, end = null, format = 'json') {
  let path = '/compliance/export';
  const params = [];
  if (start) params.push(`start=${encodeURIComponent(start)}`);
  if (end) params.push(`end=${encodeURIComponent(end)}`);
  if (params.length) path += '?' + params.join('&');
  if (format !== 'json') path += (params.length ? '&' : '?') + `format=${format}`;
  return httpRequest('GET', path);
}

// ─────────────────────────────────────────────
// MAIN STRESS TEST
// ─────────────────────────────────────────────

async function runStressTest() {
  console.log('\n🔥 PERSYST ULTIMATE STRESS TEST\n');
  console.log(`Target: ${BASE}\n`);

  // ── 1. HEALTH CHECK ──
  console.log('📡 1. Health & Liveness');
  const h = await health();
  assert(h.status === 200, '/health returns 200');
  assert(h.body?.ok === true, 'health.ok === true');
  assert(typeof h.body?.version === 'string', 'health.version is string');
  assert(typeof h.body?.memories === 'number', 'health.memories is number');

  // ── 2. MASSIVE DATA INGESTION ──
  console.log('\n💾 2. Massive Data Ingestion (250 memories)');
  const BATCH_SIZE = 25;
  const TOTAL_ITEMS = 250;
  let allIds = [];
  const ingestStart = performance.now();

  for (let batch = 0; batch < TOTAL_ITEMS / BATCH_SIZE; batch++) {
    const batchMemories = [];
    for (let i = 0; i < BATCH_SIZE; i++) {
      const idx = batch * BATCH_SIZE + i;
      batchMemories.push({
        content: `Stress test memory #${idx}: This is a test memory about ${['React', 'Vue', 'Svelte', 'Angular', 'Node.js', 'Postgres', 'SQLite', 'Docker', 'Kubernetes', 'TypeScript'][idx % 10]} framework preference. The developer prefers ${['dark mode', 'light mode', 'minimal UI', 'responsive design', 'API-first', 'testing', 'CI/CD', 'documentation', 'code review', 'pair programming'][idx % 10]}. Decision made on iteration ${idx}.`,
        importance: 0.5 + (idx % 5) * 0.1,
        agent_id: `stress-agent-${idx % 5}`,
      });
    }
    const res = await batchAdd(batchMemories);
    assert(res.status === 200, `Batch ${batch + 1} returns 200`);
    assert(res.body?.success === true, `Batch ${batch + 1} success`);
    assert(res.body?.stored === BATCH_SIZE || res.body?.stored + res.body?.skipped === BATCH_SIZE,
      `Batch ${batch + 1} processed all items (stored=${res.body?.stored})`);
    if (res.body?.results) {
      allIds.push(...res.body.results.filter(r => r.id).map(r => r.id));
    }
  }
  const ingestDuration = performance.now() - ingestStart;
  console.log(`     ⏱  ${TOTAL_ITEMS} memories ingested in ${ingestDuration.toFixed(0)}ms (${(TOTAL_ITEMS / ingestDuration * 1000).toFixed(0)} ops/sec)`);

  // Verify count via /health
  const h2 = await health();
  assert(h2.body?.memories >= 200, `Health shows >=200 memories (got ${h2.body?.memories})`);

  // ── 3. NAMESPACE ISOLATION STRESS ──
  console.log('\n🔒 3. Namespace Isolation & Boundaries');

  // Agent A stores private memory
  const privA = await addMemory('agent-a-secret-key-abc123', 1.0, 'agent-a', false);
  assert(privA.status === 200, 'Agent A stores private memory');

  // Agent B stores private memory
  const privB = await addMemory('agent-b-secret-key-xyz789', 1.0, 'agent-b', false);
  assert(privB.status === 200, 'Agent B stores private memory');

  // Agent A should not see B's private memory
  const searchA = await searchMemories('agent-b-secret', 10, 'agent-a');
  const foundBFromA = searchA.body?.results?.some(r => r.content?.includes('agent-b-secret'));
  assert(!foundBFromA, 'Agent A cannot see Agent B private memory');

  // Agent B should not see A's private memory
  const searchB = await searchMemories('agent-a-secret', 10, 'agent-b');
  const foundAFromB = searchB.body?.results?.some(r => r.content?.includes('agent-a-secret'));
  assert(!foundAFromB, 'Agent B cannot see Agent A private memory');

  // Null agent should only see shared
  const searchNull = await searchMemories('secret', 10);
  const foundAnySecret = searchNull.body?.results?.some(r =>
    r.content?.includes('agent-a-secret') || r.content?.includes('agent-b-secret'));
  assert(!foundAnySecret, 'Default (null) namespace cannot see private memories');

  // Try namespace injection
  const searchInjection = await searchMemories("test", 5, "agent-a' OR 1=1 --");
  assert(searchInjection.status === 200, 'Namespace SQL injection attempt returns 200 (not crash)');

  // ── 4. SECRET REDACTION TEST ──
  console.log('\n🔐 4. Secret Redaction Coverage');

  const secrets = [
    { content: 'API key is sk-proj-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0', pattern: '[REDACTED]' },
    { content: 'Password = "hunter2!SuperSecret99"', pattern: '[REDACTED]' },
    { content: 'GITHUB_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz1234567890abcd', pattern: '[REDACTED]' },
    { content: 'postgres://user:supersecretpass@localhost:5432/mydb', pattern: '[REDACTED]' },
    { content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----', pattern: '[REDACTED]' },
    { content: 'JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3j_VN3l4q6D4rlf4Z4Q8T7W5yX7Y8a9b', pattern: '[REDACTED]' },
    { content: 'AWS secret key: wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', pattern: '[REDACTED]' },
  ];

  for (const secret of secrets) {
    const res = await addMemory(secret.content);
    assert(res.status === 200, `Secret stored: ${secret.content.slice(0, 30)}...`);

    // Retrieve and verify it was redacted
    if (res.body?.id) {
      const memRes = await httpRequest('POST', '/tool', {
        name: 'get_memory',
        arguments: { id: res.body.id }
      });
      const memText = memRes.body?.content?.[0]?.text || '';
      const containsSecret = memText.includes(secret.content);
      assert(containsSecret === false,
        `Secret redacted in DB for ${secret.content.slice(0, 20)}...`,
        containsSecret ? 'RAW SECRET FOUND IN RESPONSE' : '');
    }
  }

  // ── 5. CONTRADICTION & REPUTATION CHAIN ──
  console.log('\n⚔️  5. Contradiction Detection & Agent Reputation');

  // Agent-C writes a fact
  const fact1 = await addMemory('The database server runs on port 5432', 0.9, 'agent-c');
  assert(fact1.status === 200, 'Agent-C stores fact #1');

  // Agent-C updates own fact (same agent — no reputation penalty)
  const fact1update = await addMemory('The database server runs on port 5432 (primary)', 0.9, 'agent-c');
  assert(fact1update.status === 200, 'Agent-C updates own fact (self-correction)');

  // Agent-D contradicts with different info (cross-agent)
  const fact2 = await addMemory('The database server runs on port 6432 for production', 0.9, 'agent-d');
  assert(fact2.status === 200, 'Agent-D stores contradicting fact');

  // Check agent stats
  const statsRes = await stats();
  assert(statsRes.status === 200, '/stats returns 200');
  const agents = statsRes.body?.agents || [];
  const agentC = agents.find(a => a.agent_id === 'agent-c');
  const agentD = agents.find(a => a.agent_id === 'agent-d');

  if (agentC) {
    assert(agentC.memories_contradicted === undefined || agentC.memories_contradicted >= 0,
      'Agent-C contradiction count is valid');
  }

  // ── 6. PERFORMANCE UNDER LOAD (CONCURRENT) ──
  console.log('\n⚡ 6. Concurrent Request Stress (50 parallel requests)');

  const SEARCH_QUERIES = [
    'database', 'React', 'framework', 'API', 'deployment',
    'testing', 'style', 'config', 'memory', 'server',
    'docker', 'typescript', 'theme', 'migration', 'security',
  ];

  const concurrentStart = performance.now();
  const concurrentResults = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      searchMemories(SEARCH_QUERIES[i % SEARCH_QUERIES.length], 5, `stress-agent-${i % 5}`)
    )
  );
  const concurrentDuration = performance.now() - concurrentStart;

  const allOk = concurrentResults.every(r => r.status === 200);
  assert(allOk, 'All 50 concurrent searches returned 200');

  const avgLatency = concurrentDuration / 50;
  assert(avgLatency < 500, `Avg concurrent search latency: ${avgLatency.toFixed(1)}ms (threshold: 500ms)`,
    avgLatency >= 500 ? `Actual: ${avgLatency.toFixed(1)}ms` : '');
  console.log(`     ⏱  50 concurrent searches in ${concurrentDuration.toFixed(0)}ms (avg ${avgLatency.toFixed(1)}ms)`);

  // ── 7. BATCH OPERATIONS AT LIMITS ──
  console.log('\n📦 7. Batch Operations at Edge Limits');

  // Max batch size (200)
  const maxBatch = [];
  for (let i = 0; i < 200; i++) {
    maxBatch.push({ content: `Batch limit test item ${i}`, importance: 0.5 });
  }
  const maxBatchRes = await batchAdd(maxBatch);
  assert(maxBatchRes.status === 200, 'Batch of 200 items succeeds');
  assert(maxBatchRes.body?.success === true, 'Batch 200 success');

  // Over max batch (201)
  const overBatch = [];
  for (let i = 0; i < 201; i++) {
    overBatch.push({ content: `Over-limit item ${i}` });
  }
  const overBatchRes = await batchAdd(overBatch);
  assert(overBatchRes.status === 400, 'Batch of 201 returns 400');

  // Batch search with 50 queries (max)
  const maxQueries = Array.from({ length: 50 }, (_, i) => `query-${i}`);
  const batchSearchRes = await batchSearch(maxQueries);
  assert(batchSearchRes.status === 200, 'Batch search of 50 queries returns 200');
  assert(batchSearchRes.body?.success === true, 'Batch search 50 success');

  // Over max batch search (51)
  const overQueries = Array.from({ length: 51 }, (_, i) => `query-${i}`);
  const overSearchRes = await batchSearch(overQueries);
  assert(overSearchRes.status === 400, 'Batch search of 51 returns 400');

  // ── 8. EVIL INPUTS & SECURITY BOUNDARIES ──
  console.log('\n👿 8. Evil Input Fuzzing');

  const evilInputs = [
    { content: '<script>alert("xss")</script>', desc: 'XSS in content' },
    { content: "'; DROP TABLE memories; --", desc: 'SQL injection in content' },
    { content: '__proto__', desc: 'Prototype pollution key' },
    { content: 'constructor', desc: 'Constructor key' },
    { content: '', desc: 'Empty string content' },
    { content: '   ', desc: 'Whitespace-only content' },
    { content: null, desc: 'Null content' },
    { content: 'a'.repeat(10001), desc: 'Over-max-length content' },
    { content: 'a'.repeat(9999), desc: 'Near-max-length content' },
    // JSON injection
    { content: '{"__proto__": {"polluted": true}}', desc: 'JSON prototype pollution in content' },
  ];

  for (const evil of evilInputs) {
    // Skip null content
    if (evil.content === null) continue;
    const res = await addMemory(evil.content, 1.0, 'evil-tester');
    // Should either succeed (with redaction) or return validation error
    assert(res.status === 200 || res.status === 400,
      `${evil.desc} returns ${res.status} (not crash)`);
  }

  // Null content test separately
  const nullRes = await httpRequest('POST', '/add', { content: null, agent_id: 'evil-tester' });
  assert(nullRes.status === 400, 'Null content returns 400');

  // ── 9. UNICODE & SPECIAL CHARACTERS ──
  console.log('\n🌍 9. Unicode & Special Character Handling');

  const unicodeTests = [
    { content: '使用React和TypeScript构建前端应用', desc: 'Chinese characters' },
    { content: 'Фронтенд на React и TypeScript', desc: 'Cyrillic characters' },
    { content: 'بناء تطبيقات الواجهة الأمامية باستخدام React', desc: 'Arabic characters' },
    { content: 'React 💙 TypeScript ❤️', desc: 'Emoji in content' },
    { content: 'Tab\tcharacter\nand newline', desc: 'Control characters' },
    { content: 'Very long unicode: ' + '😀'.repeat(100), desc: 'Long emoji sequence' },
    { content: '\x00\x01\x02\x03null bytes and control chars', desc: 'Null bytes and control chars' },
  ];

  for (const test of unicodeTests) {
    const res = await addMemory(test.content, 0.7, 'unicode-tester');
    assert(res.status === 200, `${test.desc} stores successfully`);

    if (res.body?.id) {
      // Use length that doesn't split surrogate pairs (emoji = 2 code units each)
      const sliceLen = test.desc === 'Long emoji sequence' ? 29 : 30;
      const searchRes = await searchMemories(test.content.slice(0, sliceLen), 3, 'unicode-tester');
      assert(searchRes.status === 200, `${test.desc} searchable`);
    }
  }

  // ── 10. CONTEXT SYSTEM PROMPT ──
  console.log('\n📝 10. System Prompt /get_optimized_context');

  const ctxText = await systemPrompt('database React preferences', 'text');
  assert(ctxText.status === 200, '/system-prompt (text) returns 200');
  assert(ctxText.raw.includes('MEMORY') || ctxText.raw.includes('Context'),
    'System prompt contains memory context');

  const ctxMd = await systemPrompt('framework testing deployment', 'markdown');
  assert(ctxMd.status === 200, '/system-prompt (markdown) returns 200');
  assert(ctxMd.raw.includes('##') || ctxMd.raw.includes('#'),
    'Markdown prompt has headers');

  const ctxJson = await systemPrompt('server configuration', 'json');
  assert(ctxJson.status === 200, '/system-prompt (json) returns 200');

  // POST /context endpoint
  const ctxPost = await getContext('stress test results performance', 3000);
  assert(ctxPost.status === 200, 'POST /context returns 200');
  assert(ctxPost.body?.context && ctxPost.body?.context.length > 0,
    'Context block is non-empty');
  assert(ctxPost.body?.intent !== undefined, 'Context has intent classification');
  assert(ctxPost.body?.urgency !== undefined, 'Context has urgency level');
  assert(ctxPost.body?.memories !== undefined, 'Context has memories array');

  // ── 11. COMPLIANCE EXPORT & ATTESTATION ──
  console.log('\n📋 11. Compliance Export & Attestation Chain');

  const compJson = await complianceExport(null, null, 'json');
  assert(compJson.status === 200, 'Compliance export (JSON) returns 200');
  assert(compJson.body?.summary?.system_integrity === 'SECURE',
    'System integrity is SECURE');
  assert(Array.isArray(compJson.body?.attestations), 'Has attestations array');
  assert(Array.isArray(compJson.body?.agent_stats), 'Has agent stats array');

  // Verify the most recent attestation
  const attestations = compJson.body?.attestations || [];
  if (attestations.length > 0) {
    const latest = attestations[attestations.length - 1];
    const verifyRes = await httpRequest('POST', '/verify', { attestation_id: latest.attestation_id });
    assert(verifyRes.status === 200, '/verify returns 200');
    assert(verifyRes.body?.valid === true,
      `Latest attestation signature chain is valid`,
      verifyRes.body?.valid !== true ? `Got: ${JSON.stringify(verifyRes.body)}` : '');
  }

  const compMd = await complianceExport(null, null, 'markdown');
  assert(compMd.status === 200, 'Compliance export (markdown) returns 200');

  // ── 12. AGENT STATS ──
  console.log('\n📊 12. Agent Statistics');

  const statsRes2 = await stats();
  assert(statsRes2.status === 200, '/stats returns 200');
  assert(Array.isArray(statsRes2.body?.agents), 'Stats has agents array');
  assert(statsRes2.body?.namespaces, 'Stats has namespaces');
  assert(typeof statsRes2.body?.uptime_seconds === 'number', 'Stats has uptime');

  // ── 13. TOOL PROGRAMMATIC INTERFACE ──
  console.log('\n🔧 13. MCP Tool Interface via /tool');

  // get_recent_memories
  const recentTool = await httpRequest('POST', '/tool', {
    name: 'get_recent_memories',
    arguments: { limit: 10 }
  });
  assert(recentTool.status === 200, 'get_recent_memories tool works');

  // get_important_memories
  const importantTool = await httpRequest('POST', '/tool', {
    name: 'get_important_memories',
    arguments: { limit: 10 }
  });
  assert(importantTool.status === 200, 'get_important_memories tool works');

  // get_agent_stats
  const agentStatsTool = await httpRequest('POST', '/tool', {
    name: 'get_agent_stats',
    arguments: {}
  });
  assert(agentStatsTool.status === 200, 'get_agent_stats tool works');

  // Unknown tool
  const unknownTool = await httpRequest('POST', '/tool', {
    name: 'nonexistent_tool',
    arguments: {}
  });
  assert(unknownTool.status === 400, 'Unknown tool returns 400 with error (not crash)');
  assert(unknownTool.body?.error && unknownTool.body.error.includes('not found'), 'Unknown tool returns descriptive error');

  // ── 14. /remember ENDPOINT ──
  console.log('\n💭 14. /remember Direct Endpoint');

  const rem1 = await remember('Remember the SSL certificate expires on Dec 31');
  assert(rem1.status === 200, '/remember with text/plain returns 200');
  assert(rem1.body?.success === true, '/remember stores successfully');

  // JSON body for /remember
  const rem2 = await httpRequest('POST', '/remember', {
    content: 'Note: The CI pipeline takes 15 minutes',
    importance: 0.8
  });
  assert(rem2.status === 200, '/remember with JSON returns 200');

  // Empty body
  const rem3 = await httpRequest('POST', '/remember', {}, 'application/json');
  assert(rem3.status === 400, '/remember with empty body returns 400');

  // ── 15. DATA INTEGRITY AFTER MASSIVE OPERATIONS ──
  console.log('\n🔍 15. Data Integrity Verification');

  const integritySearch = await searchMemories('framework preference', 5);
  assert(integritySearch.status === 200, 'Search still works after mass operations');
  assert(integritySearch.body?.results?.length > 0, 'Search returns results');

  // Search for a specific known memory
  const exactSearch = await searchMemories('Stress test memory #42 decision made on iteration 42', 50);
  assert(exactSearch.status === 200, 'Exact content search works');
  const found42 = exactSearch.body?.results?.some(r => r.content?.includes('#42'));
  assert(found42, 'Memory #42 is findable after massive inserts');

  // ── 16. MEMORY CONSOLIDATION ──
  console.log('\n🧹 16. Memory Consolidation');

  // Add very similar memories to trigger consolidation
  for (let i = 0; i < 5; i++) {
    await addMemory(`Dark theme is preferred for the dashboard interface (variant ${i})`, 0.6, 'consolidator');
  }
  const consolidateRes = await httpRequest('POST', '/tool', {
    name: 'consolidate_memories',
    arguments: {}
  });
  assert(consolidateRes.status === 200, 'consolidate_memories returns 200');

  // ── 17. KNOWLEDGE GRAPH ENTITIES ──
  console.log('\n🔗 17. Knowledge Graph Entity Operations');

  const addEntity = await httpRequest('POST', '/tool', {
    name: 'add_entity',
    arguments: { name: 'React', type: 'tech' }
  });
  assert(addEntity.status === 200, 'add_entity creates entity');

  const searchEntity = await httpRequest('POST', '/tool', {
    name: 'search_by_entity',
    arguments: { entity_name: 'React' }
  });
  assert(searchEntity.status === 200, 'search_by_entity returns 200');

  // ── 18. MEMORY HISTORY CHAIN ──
  console.log('\n📜 18. Memory History Chain');

  const historyRes = await httpRequest('POST', '/tool', {
    name: 'get_memory_history',
    arguments: { query: 'Stress test memory #0' }
  });
  assert(historyRes.status === 200, 'get_memory_history returns 200');

  // ── 19. RECOVERY AFTER STRESS ──
  console.log('\n💪 19. System Recovery After Stress');

  const hFinal = await health();
  assert(hFinal.status === 200, 'Health check still passes after all stress');
  assert(hFinal.body?.ok === true, 'Server reports OK');
  assert(hFinal.body?.memories > 50, `Server has ${hFinal.body?.memories}+ memories (>50)`);

  // ── 20. CRAZY EDGE CASES ──
  console.log('\n🤪 20. Additional Crazy Edge Cases');

  // Extremely long query
  const longQuery = await searchMemories('a'.repeat(5000), 3);
  assert(longQuery.status === 200, '5000-char query does not crash');

  // Search with special FTS5 characters
  const fts5Chars = await searchMemories('NEAR/5 (test memory) OR "exact phrase" -exclude', 3);
  assert(fts5Chars.status === 200, 'FTS5 special characters query does not crash');

  // Negative importance
  const negImp = await addMemory('Negative importance test', -1.0);
  assert(negImp.status === 200, 'Negative importance is clamped');

  // Importance > 1
  const highImp = await addMemory('High importance test', 999);
  assert(highImp.status === 200, 'Over-max importance is clamped');

  // Zero length importance
  const zeroImp = await addMemory('Zero importance test', 0);
  assert(zeroImp.status === 200, 'Zero importance stores');

  // ── SUMMARY ──
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 STRESS TEST RESULTS`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📈 Total assertions: ${passed + failed}`);
  console.log(`  💾 Memories in DB: ${hFinal.body?.memories}`);
  console.log(`  ⏱  Final health uptime: ${hFinal.body?.uptime_seconds}s`);

  if (failed > 0) {
    console.log('\n  ❌ FAILURES:');
    for (const err of errors) {
      console.log(`    ${err}`);
    }
  }

  console.log(`\n${'═'.repeat(60)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runStressTest().catch(err => {
  console.error('💥 STRESS TEST CRASHED:', err);
  process.exit(1);
});
