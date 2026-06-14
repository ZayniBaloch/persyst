import test from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import db, { closeDatabase, getMemoryById, getEntityByName } from '../src/database.js';

let server;
const handlers = {};

test.before(() => {
  db.exec('DELETE FROM edges; DELETE FROM entities; DELETE FROM memories_vec; DELETE FROM memories; DELETE FROM memories_fts;');
  server = new McpServer({ name: 'test', version: '1.0.0' });
  
  // Intercept tool registration to capture callbacks for unit testing
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

test('MCP Tools Handlers', async (t) => {
  await t.test('add_memory tool stores memory and vector', async () => {
    const handler = handlers['add_memory'];
    assert.ok(handler, 'add_memory handler should be registered');

    // Add unique memory
    const response = await handler({ content: 'Deduplicated unique memory content', importance: 0.9 });
    const result = JSON.parse(response.content[0].text);
    
    assert.ok(result.success);
    assert.ok(result.id);
    
    // Check if stored in DB
    const memory = getMemoryById(result.id);
    assert.equal(memory.content, 'Deduplicated unique memory content');
    assert.equal(memory.importance_score, 0.9);
  });

  await t.test('add_memory tool prevents duplicate memories and boosts existing', async () => {
    const handler = handlers['add_memory'];
    const content = 'Duplicate-prevention test memory';

    // Add first time
    const res1 = await handler({ content, importance: 0.5 });
    const data1 = JSON.parse(res1.content[0].text);
    
    // Add second time (identical content)
    const res2 = await handler({ content, importance: 0.8 });
    const data2 = JSON.parse(res2.content[0].text);

    // Should return success and the SAME ID
    assert.ok(data2.success);
    assert.equal(data1.id, data2.id, 'Should reuse the existing memory ID');
    assert.ok(data2.message.includes('already exists'));

    // Check that the memory's access count has incremented and importance boosted
    const memory = getMemoryById(data1.id);
    assert.equal(memory.access_count, 1);
    // Initial 0.5 + 0.1 boost = 0.6
    assert.equal(memory.importance_score, 0.6);
  });
});
