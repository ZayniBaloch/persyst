import test from 'node:test';
import assert from 'node:assert/strict';
import { getRecentCommits } from '../src/git.js';
import { execSync } from 'child_process';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

let tempRepo;

test.before(() => {
  // Create a temporary git repo to test against
  tempRepo = mkdtempSync(join(tmpdir(), 'persyst-test-repo-'));
  
  // Init git and configure user
  execSync('git init', { cwd: tempRepo });
  execSync('git config user.name "Test User"', { cwd: tempRepo });
  execSync('git config user.email "test@example.com"', { cwd: tempRepo });

  // Commit 1: Normal commit
  writeFileSync(join(tempRepo, 'file1.txt'), 'Hello');
  execSync('git add .', { cwd: tempRepo });
  execSync('git commit -m "Add file1"', { cwd: tempRepo });

  // Commit 2: Multi-line commit with special characters
  writeFileSync(join(tempRepo, 'file2.txt'), 'World');
  execSync('git add .', { cwd: tempRepo });
  execSync('git commit -m "Add file2 🚀" -m "This is the body." -m "Contains \'quotes\' and \\"double quotes\\""', { cwd: tempRepo });
});

test.after(() => {
  if (tempRepo) {
    rmSync(tempRepo, { recursive: true, force: true });
  }
});

test('Git Ingestion Module', async (t) => {
  await t.test('Reads recent commits correctly', async () => {
    const commits = await getRecentCommits(tempRepo, 10);
    
    assert.equal(commits.length, 2);
    
    // Most recent commit is first
    assert.equal(commits[0].author, 'Test User');
    assert.ok(commits[0].message.includes('Add file2'));
    assert.ok(commits[0].fullText.includes('This is the body.'));
    assert.ok(commits[0].fullText.includes('double quotes'));
    
    // Older commit
    assert.equal(commits[1].message, 'Add file1');
  });

  await t.test('Respects count limit', async () => {
    const commits = await getRecentCommits(tempRepo, 1);
    assert.equal(commits.length, 1);
    assert.ok(commits[0].message.includes('Add file2'));
  });

  await t.test('Throws meaningful error for non-git directory', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'persyst-empty-'));
    await assert.rejects(async () => {
      await getRecentCommits(emptyDir, 10);
    }, /Not a git repository|Failed to read git log/);
    
    rmSync(emptyDir, { recursive: true, force: true });
  });
});
