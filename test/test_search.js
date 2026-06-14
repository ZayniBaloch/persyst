import test from 'node:test';
import assert from 'node:assert/strict';
import { generateEmbedding } from '../src/embeddings.js';
import db, {
  insertMemory,
  insertVector,
  closeDatabase
} from '../src/database.js';
import { searchHybrid } from '../src/search.js';

test.before(async () => {
  db.exec('DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM memories_fts;');

  // Insert test data
  const data = [
    'The quick brown fox jumps over the lazy dog',
    'React is a popular frontend library for building user interfaces',
    'Vue is an alternative to React for building UIs',
    'The server uses Node.js and Express',
    'Dark mode is preferred by many users for reading at night',
    'Night theme reduces eye strain in low light'
  ];

  for (const text of data) {
    const id = insertMemory(text);
    const embedding = await generateEmbedding(text);
    insertVector(id, embedding);
  }
});

test.after(() => {
  closeDatabase();
});

test('Hybrid Search Engine', async (t) => {
  await t.test('Semantic Search: understands synonyms without keyword overlap', async () => {
    // "night theme" and "dark mode" have no matching keywords (excluding stop words)
    // but should be semantically similar.
    const results = await searchHybrid('night theme', 5);
    
    const contents = results.map(r => r.content);
    assert.ok(contents.some(c => c.includes('Dark mode')), 'Found semantic match');
    assert.ok(contents.some(c => c.includes('Night theme')), 'Found exact match');
  });

  await t.test('Keyword Search Dominance: exact keywords rank higher', async () => {
    // Both mention React, but one is specifically about React
    const results = await searchHybrid('React', 5);
    
    assert.ok(results.length > 0);
    // The top result should be the one prominently about React
    assert.ok(results[0].content.includes('React is a popular frontend library') || results[0].content.includes('Vue is an alternative to React'));
    
    // Check that keyword_match flag is set
    assert.equal(results[0].keyword_match, true);
  });

  await t.test('Score Boosting: hybrid score combines similarity and +0.2 keyword boost', async () => {
    const results = await searchHybrid('"Express" AND "server"', 5);
    
    const nodeHit = results.find(r => r.content.includes('Node.js and Express'));
    assert.ok(nodeHit);
    
    // similarity should be a string/number from fixed(4), e.g., '0.8500'
    const sim = parseFloat(nodeHit.similarity);
    const hybrid = parseFloat(nodeHit.hybrid_score);
    
    assert.equal(nodeHit.keyword_match, true);
    // Floating point math might not be EXACTLY +0.2 due to precision, so we check difference
    assert.ok(Math.abs((sim + 0.2) - hybrid) < 0.001, `Hybrid score ${hybrid} should be similarity ${sim} + 0.2`);
  });

  await t.test('Edge Cases: empty queries', async () => {
    // Should handle empty strings gracefully (either return empty or generic low score results)
    const results = await searchHybrid('', 3);
    // FTS5 might return nothing for empty, and vector search might return something for empty embedding.
    // The main thing is it shouldn't crash.
    assert.ok(Array.isArray(results));
  });

  await t.test('Edge Cases: special SQL characters in query', async () => {
    // FTS5 MATCH syntax can break with special characters like '*' or 'OR' or quotes if not escaped
    // better-sqlite3 parameterized queries should handle this safely, but let's test it.
    const results = await searchHybrid('User OR "drop table" *', 5);
    assert.ok(Array.isArray(results));
  });

  await t.test('Threshold Filtering: weak semantic matches with no keyword overlap are filtered out', async () => {
    // Search for something extremely unrelated that has no keyword overlap.
    // "quantum computing cryptography" should not match any of our database entries
    const results = await searchHybrid('quantum computing cryptography', 5);
    assert.equal(results.length, 0, 'Unrelated results should be filtered out by similarity threshold');
  });
});
