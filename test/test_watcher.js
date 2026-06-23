import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'path';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import db, { closeDatabase, getMemoryById, getWatchPosition } from '../src/database.js';
import { extractHeuristic } from '../src/extractor-heuristic.js';
import { scanDirectories, loadWatchedDirs } from '../src/watcher.js';

const TEST_DIR = join(process.cwd(), 'test_watcher_temp');
const CONFIG_PATH = join(TEST_DIR, 'persyst-config.json');

// Point the watcher at an isolated config file so we never touch the user's real config.
process.env.PERSYST_CONFIG_FILE = CONFIG_PATH;

test.before(() => {
  // Clear tables
  db.exec('DELETE FROM watched_files; DELETE FROM memories; DELETE FROM memories_vec; DELETE FROM memories_fts;');
  mkdirSync(TEST_DIR, { recursive: true });
});

test.after(() => {
  closeDatabase();
  try {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  } catch (_) {}
  delete process.env.PERSYST_CONFIG_FILE;
});

test('Cognitive Noise Filter & Log Watcher', async (t) => {
  
  await t.test('Cognitive Filter: filters questions, pronouns, and chitchat', () => {
    // 1. Should extract valid technical preferences
    const valid1 = extractHeuristic('I decided to use PostgreSQL for our backend database');
    assert.ok(valid1.length >= 1);
    assert.ok(valid1[0].content.includes('PostgreSQL'));

    const valid2 = extractHeuristic('User said we should always use camelCase naming in JavaScript files');
    assert.ok(valid2.length >= 1);
    assert.ok(valid2[0].content.includes('camelCase'));

    // 2. Should block questions
    const question1 = extractHeuristic('What is the best way to connect PostgreSQL?');
    assert.equal(question1.length, 0, 'Questions should be filtered');

    const question2 = extractHeuristic('How do you compile this code?');
    assert.equal(question2.length, 0, 'Questions should be filtered');

    // 3. Should block chitchat without tech concepts
    const chitchat = extractHeuristic('I prefer to eat pizza for lunch today');
    assert.equal(chitchat.length, 0, 'Non-tech chitchat should be filtered');

    const vague = extractHeuristic('Decision: we should always do this');
    assert.equal(vague.length, 0, 'Vague pronoun references should be filtered');
  });

  await t.test('Log Watcher: parses new JSONL transcript appends and tracks offsets', async () => {
    const transcriptFile = join(TEST_DIR, 'transcript.jsonl');

    // Write isolated mock config pointing to our TEST_DIR
    const testConfig = { watch_dirs: [TEST_DIR.replace(/\\/g, '/')] };
    writeFileSync(CONFIG_PATH, JSON.stringify(testConfig, null, 2));

    // 1. Write initial lines to transcript
    const line1 = JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: 'I prefer TypeScript over JavaScript for all new source code files'
    }) + '\n';

    writeFileSync(transcriptFile, line1);

    // Run directories scan
    await scanDirectories();

    // Verify memory stored
    const offset1 = getWatchPosition(transcriptFile);
    assert.ok(offset1 > 0);

    // Retrieve memories
    const count = db.prepare('SELECT COUNT(*) as count FROM memories').get().count;
    assert.equal(count, 1, 'Should extract 1 memory from user input');

    const memory = db.prepare('SELECT * FROM memories LIMIT 1').get();
    assert.ok(memory.content.includes('TypeScript'));

    // 2. Scan again without file changes — should not duplicate
    await scanDirectories();
    const count2 = db.prepare('SELECT COUNT(*) as count FROM memories').get().count;
    assert.equal(count2, 1, 'Should not duplicate memory on re-scan');

    // 3. Append another line
    const line2 = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'Decision: We decided to adopt TailwindCSS for styling components'
    }) + '\n';

    writeFileSync(transcriptFile, line1 + line2);

    // Scan again
    await scanDirectories();

    // Verify offset updated
    const offset2 = getWatchPosition(transcriptFile);
    assert.ok(offset2 > offset1);

    // Verify second memory stored
    const count3 = db.prepare('SELECT COUNT(*) as count FROM memories').get().count;
    assert.equal(count3, 2, 'Should extract second memory from appends');

    const tailwindMem = db.prepare("SELECT * FROM memories WHERE content LIKE '%TailwindCSS%'").get();
    assert.ok(tailwindMem);
  });

});
