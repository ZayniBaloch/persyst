/**
 * git.js — Git Commit Ingestion
 * 
 * Reads git log from a repository and converts commits into memories.
 * Useful for giving coding agents context about a project's history.
 * 
 * Each commit becomes a memory like:
 *   "[abc1234] Fix login bug — by John on 2024-01-15"
 * 
 * Deduplicates by commit hash so you can ingest safely multiple times.
 */

import { execSync } from 'child_process';

/**
 * Read the N most recent git commits from a repository.
 * 
 * @param {string} repoPath - Absolute path to the git repo
 * @param {number} count - Number of commits to read (default: 20)
 * @returns {Array<{hash: string, message: string, author: string, date: string, fullText: string}>}
 */
export function getRecentCommits(repoPath, count = 20) {
  try {
    // Use a delimiter to split commits reliably
    const DELIM = '---PERSYST-COMMIT---';
    const format = `${DELIM}%n%H%n%an%n%ai%n%s%n%b`;

    const output = execSync(
      `git log -n ${count} --pretty=format:"${format}"`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10000,      // 10s timeout
        stdio: ['pipe', 'pipe', 'pipe']  // Suppress stderr
      }
    );

    // Parse the output into commit objects
    const commits = [];
    const blocks = output.split(DELIM).filter(b => b.trim());

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 4) continue;

      const hash = lines[0].trim();
      const author = lines[1].trim();
      const date = lines[2].trim().split(' ')[0]; // Just the date part
      const subject = lines[3].trim();
      const body = lines.slice(4).join(' ').trim();

      // Build a readable memory string
      const fullText = body
        ? `[${hash.slice(0, 7)}] ${subject} — by ${author} on ${date}. ${body}`
        : `[${hash.slice(0, 7)}] ${subject} — by ${author} on ${date}`;

      commits.push({ hash, message: subject, author, date, fullText });
    }

    return commits;
  } catch (err) {
    // Not a git repo, or git not installed
    const message = err.message || String(err);
    if (message.includes('not a git repository')) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }
    if (message.includes('ENOENT') || message.includes('not recognized')) {
      throw new Error('Git is not installed or not in PATH');
    }
    throw new Error(`Failed to read git log: ${message}`);
  }
}

/**
 * Get changed files from a specific commit.
 * Useful for linking commits to file entities.
 * 
 * @param {string} repoPath - Absolute path to the git repo
 * @param {string} hash - Full commit hash
 * @returns {string[]} List of changed file paths
 */
export function getCommitFiles(repoPath, hash) {
  try {
    const output = execSync(
      `git diff-tree --no-commit-id --name-only -r ${hash}`,
      {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
