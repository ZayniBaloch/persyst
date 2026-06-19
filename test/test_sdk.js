import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Persyst } from '../src/sdk.js';
import db, { closeDatabase } from '../src/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const serverPath = join(__dirname, '..', 'index.js');
const TEST_PORT = 4322;

test.before(() => {
  // Clear any existing test data in main process memory
  db.exec('DELETE FROM memories; DELETE FROM memories_vec; DELETE FROM contradictions; DELETE FROM provenance;');
});

test.after(() => {
  closeDatabase();
});

test('Persyst Developer SDK & Context Upgrades', async (t) => {
  
  await t.test('1. Library Mode (Offline Direct SQLite Access)', async () => {
    // Force library mode explicitly to run offline
    const sdk = new Persyst({ mode: 'library' });
    
    // Test track event
    const trackRes = await sdk.track({
      sessionId: 'test_session_1',
      workflow: 'auth_workflow',
      event: 'login_error',
      metadata: {
        userId: 'u_9921',
        reason: 'invalid_credentials'
      },
      importance: 0.8,
      shared: true
    });
    
    assert.ok(trackRes.success, 'Library mode track should succeed');
    assert.ok(trackRes.id > 0, 'Should return a valid memory ID');

    // Test context retrieval with debugging intent
    const contextRes = await sdk.context({
      sessionId: 'test_session_1',
      workflow: 'auth_workflow',
      query: 'User experienced a login crash on the main login screen',
      intent: 'debugging'
    });

    assert.equal(contextRes.intent, 'debugging', 'Should identify or match debugging intent');
    assert.equal(contextRes.urgency, 'high', 'Should classify crash as high urgency');
    assert.ok(contextRes.suggested_actions.length > 0, 'Should generate suggested actions');
    assert.ok(contextRes.suggested_actions.includes('Inspect the recent error logs and verify SQLite/system constraints.'), 'Should contain relevant action');
    assert.ok(contextRes.context.includes('[Intent: debugging | Urgency: high]'), 'Plaintext context should include header');
    assert.ok(contextRes.context.includes('[Suggested Actions]'), 'Plaintext context should include actions block');
  });

  await t.test('2. Urgency and Intent Classification Heuristics', async () => {
    const sdk = new Persyst({ mode: 'library' });

    // Test critical urgency & database intent
    const contextDb = await sdk.context({
      query: 'CRITICAL database deadlock error occurred, panic immediately!',
    });

    assert.equal(contextDb.intent, 'database_management', 'Should infer database intent');
    assert.equal(contextDb.urgency, 'critical', 'Should infer critical urgency');
    assert.ok(contextDb.suggested_actions.includes('CAUTION: Address security, vulnerability, or critical stability factors immediately.'), 'Should include safety warning');

    // Test UI intent and medium urgency
    const contextUi = await sdk.context({
      query: 'tweak CSS layout margin alignment for the button styles',
    });

    assert.equal(contextUi.intent, 'ui_styling', 'Should infer ui_styling intent');
    assert.equal(contextUi.urgency, 'medium', 'Should infer medium urgency');
  });

  await t.test('3. Gateway Mode (Through HTTP Gateway Server)', async () => {
    // Start HTTP server in a separate process in test environment
    const serverProcess = spawn('node', [serverPath], {
      env: { ...process.env, PORT: TEST_PORT, NODE_ENV: 'test' },
      stdio: 'inherit'
    });

    // Wait for HTTP Gateway server to spin up
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
      // Force gateway mode or let it autodetect (will autodetect gateway since port 4321 is now active)
      const sdk = new Persyst({ mode: 'gateway', port: TEST_PORT });

      // Track a deployment event
      const trackRes = await sdk.track({
        sessionId: 'deploy_session',
        workflow: 'ci_cd',
        event: 'vercel_deployment_success',
        metadata: {
          url: 'https://appraise-web.vercel.app',
          commit: 'c94f48b'
        }
      });

      assert.ok(trackRes.success, 'Gateway mode track should succeed');

      // Query context for deployment
      const contextRes = await sdk.context({
        sessionId: 'deploy_session',
        workflow: 'ci_cd',
        query: 'Check status of the deployment on Vercel',
        intent: 'deployment'
      });

      assert.equal(contextRes.intent, 'deployment', 'Gateway context should match deployment intent');
      assert.ok(contextRes.context.includes('Event: vercel_deployment_success'), 'Gateway context should return memories');
    } finally {
      // Cleanup: Stop the server process
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
});
