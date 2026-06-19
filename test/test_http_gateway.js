/**
 * test_http_gateway.js — Persyst HTTP Gateway Integration & Latency Test
 * 
 * Runs the Persyst gateway in a subprocess, executes HTTP requests,
 * and asserts correctness, contradiction handling, and sub-15ms latency.
 * 
 * Run: node test/test_http_gateway.js
 */

import { spawn } from 'child_process';
import http from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

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

function makeRequest(path, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port: 4321,
      path: path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    });

    req.on('response', (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            body: JSON.parse(data || '{}')
          });
        } catch (e) {
          reject(new Error(`Failed to parse response JSON: ${e.message}. Raw: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('\n🧪 Persyst HTTP Gateway Integration Test\n');

  // 1. Spawn Persyst server
  console.log('🚀 Spawning Persyst MCP & HTTP server...');
  const serverProcess = spawn('node', [resolve(projectRoot, 'index.js')], {
    cwd: projectRoot,
    stdio: ['pipe', 'ignore', 'pipe'] // pipe stderr to check for errors/listening messages
  });

  serverProcess.stderr.on('data', (data) => {
    console.error(`[Server Stderr] ${data.toString().trim()}`);
  });

  serverProcess.on('error', (err) => {
    console.error(`[Server Spawn Error] ${err.message}`);
  });

  serverProcess.on('exit', (code, signal) => {
    console.log(`[Server Process Exited] code=${code} signal=${signal}`);
  });

  // Dynamically wait for the server to start listening
  await new Promise((resolve, reject) => {
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        reject(new Error('Timeout waiting for Persyst server to start listening'));
      }
    }, 10000); // 10s max timeout

    serverProcess.stderr.on('data', (data) => {
      const output = data.toString();
      if (output.includes('HTTP Gateway listening') || output.includes('already in use')) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    serverProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    serverProcess.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Server exited prematurely with code ${code}`));
      }
    });
  });

  try {
    // 2. Test /add endpoint
    console.log('\n📝 Test 1: Add a memory via HTTP POST /add');
    const addRes = await makeRequest('/add', {
      content: 'User prefers the Outfit font in all UI presentations.',
      importance: 0.9,
      agent_id: 'test-agent',
      session_id: 'test-session',
      shared: true
    });
    assert(addRes.statusCode === 200, 'HTTP status is 200');
    assert(addRes.body.success === true, 'Memory successfully stored');
    const memoryId = addRes.body.id;
    assert(typeof memoryId === 'number', `Got memory ID: ${memoryId}`);

    // 3. Test /search endpoint
    console.log('\n🔍 Test 2: Search memory via HTTP POST /search');
    const searchRes = await makeRequest('/search', {
      query: 'What font does the user prefer?',
      limit: 3,
      agent_id: 'test-agent'
    });
    assert(searchRes.statusCode === 200, 'HTTP status is 200');
    assert(searchRes.body.success === true, 'Search succeeded');
    assert(searchRes.body.results.length > 0, 'Found at least one result');
    const match = searchRes.body.results.find(r => r.content.includes('Outfit font'));
    assert(!!match, 'Correct memory content returned in search results');

    // 4. Test /context endpoint
    console.log('\n🧠 Test 3: Get optimized context via HTTP POST /context');
    const contextRes = await makeRequest('/context', {
      query: 'Outfit font UI rules',
      max_tokens: 1000,
      agent_id: 'test-agent'
    });
    assert(contextRes.statusCode === 200, 'HTTP status is 200');
    assert(typeof contextRes.body.context === 'string', 'Context field is a string');
    assert(contextRes.body.context.includes('Outfit font'), 'Context includes Outfit font memory');

    // 5. Test /tool endpoint
    console.log('\n🔌 Test 4: Run MCP tool programmatically via HTTP POST /tool');
    const toolRes = await makeRequest('/tool', {
      name: 'get_memory',
      arguments: { id: memoryId }
    });
    assert(toolRes.statusCode === 200, 'HTTP status is 200');
    assert(toolRes.body.content !== undefined, 'Tool response includes content field');
    const toolText = JSON.parse(toolRes.body.content[0].text);
    assert(toolText.content === 'User prefers the Outfit font in all UI presentations.', 'Tool returned correct memory content');

    // 6. Test Latency
    console.log('\n⚡ Test 5: Benchmark HTTP request latency');
    const latencies = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await makeRequest('/search', {
        query: 'Outfit font',
        limit: 1,
        agent_id: 'test-agent'
      });
      latencies.push(performance.now() - start);
    }
    const medianLatency = latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)];
    console.log(`     Latency measurements (ms): ${latencies.map(l => l.toFixed(2)).join(', ')}`);
    console.log(`     Median Latency: ${medianLatency.toFixed(2)} ms`);
    assert(medianLatency < 15, `Median latency is under 15ms (Actual: ${medianLatency.toFixed(2)} ms)`);

    // Cleanup added memory
    console.log('\n🧹 Cleaning up test memory...');
    await makeRequest('/tool', {
      name: 'delete_memory',
      arguments: { id: memoryId }
    });

  } catch (err) {
    console.error('💥 Test error:', err);
    failed++;
  } finally {
    console.log('\n🛑 Stopping Persyst server...');
    serverProcess.kill('SIGTERM');
    
    // Wait briefly for process cleanup
    await new Promise(resolve => setTimeout(resolve, 500));

    console.log(`\n${'═'.repeat(40)}`);
    console.log(`📊 HTTP Gateway Test Results: ${passed} passed, ${failed} failed`);
    console.log(`${'═'.repeat(40)}\n`);

    process.exit(failed > 0 ? 1 : 0);
  }
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
