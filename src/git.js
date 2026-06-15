/**
 * git.js — Git Commit Ingestion & Analysis
 * 
 * Reads git log from a repository and converts commits into memories.
 * Performs commit categorization, file diff analysis, and imports notes.
 * 
 * IMPORTANT: Uses async execFile instead of execSync to avoid blocking
 * the Node.js event loop during git operations (Bug 4 fix).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Read the N most recent git commits from a repository.
 * 
 * @param {string} repoPath - Absolute path to the git repo
 * @param {number} count - Number of commits to read (default: 20)
 * @returns {Promise<Array<{hash: string, message: string, author: string, date: string, fullText: string, files: string[], importance: number}>>}
 */
export async function getRecentCommits(repoPath, count = 20) {
  try {
    // Use a delimiter to split commits reliably
    const DELIM = '---PERSYST-COMMIT---';
    const format = `${DELIM}%n%H%n%an%n%ai%n%s%n%b`;

    const { stdout: output } = await execFileAsync(
      'git',
      ['log', `-n`, `${count}`, `--pretty=format:${format}`],
      {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 10000,      // 10s timeout
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

      // Fetch git notes if available (represents PR metadata)
      const notes = await getGitNotes(repoPath, hash);

      // Build a readable memory string
      let fullText = body
        ? `[${hash.slice(0, 7)}] Commit: ${subject} — by ${author} on ${date}. ${body}`
        : `[${hash.slice(0, 7)}] Commit: ${subject} — by ${author} on ${date}`;

      if (notes) {
        fullText += ` [PR Notes] ${notes}`;
      }

      // Fetch files touched
      const files = await getCommitFiles(repoPath, hash);

      // Classify importance based on message
      const classification = classifyCommit(subject);

      commits.push({
        hash,
        message: subject,
        author,
        date,
        fullText,
        files,
        importance: classification.importance
      });
    }

    return commits;
  } catch (err) {
    const message = err.message || String(err);
    if (message.includes('not a git repository')) {
      throw new Error(`Not a git repository: ${repoPath}`);
    }
    if (message.includes('ENOENT') || message.includes('not recognized')) {
      throw new Error(
        'Git binary not found. Git is required to ingest commits.\n' +
        'Please install Git and ensure it is added to your system PATH:\n' +
        '  - Windows: Download from https://git-scm.com/download/win\n' +
        '  - macOS: Run `brew install git` or install Xcode Command Line Tools\n' +
        '  - Linux: Run `sudo apt-get install git` or equivalent.'
      );
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
 * @returns {Promise<string[]>} List of changed file paths
 */
export async function getCommitFiles(repoPath, hash) {
  try {
    const { stdout: output } = await execFileAsync(
      'git',
      ['diff-tree', '--no-commit-id', '--name-only', '-r', hash],
      {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 5000,
      }
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Fetch git notes (representing PR metadata or additional annotations).
 */
export async function getGitNotes(repoPath, hash) {
  try {
    const { stdout: output } = await execFileAsync(
      'git',
      ['notes', 'show', hash],
      {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 3000,
      }
    );
    return output.trim();
  } catch {
    return '';
  }
}

/**
 * Categorize commit and assign importance.
 */
export function classifyCommit(subject) {
  const s = subject.toLowerCase().trim();
  if (
    s.startsWith('feat:') ||
    s.startsWith('fix:') ||
    s.startsWith('refactor:') ||
    s.startsWith('breaking:') ||
    s.startsWith('decision:')
  ) {
    return { type: 'architectural', importance: 0.9 };
  }
  if (
    s.startsWith('chore:') ||
    s.startsWith('docs:') ||
    s.startsWith('test:') ||
    s.startsWith('style:') ||
    s.startsWith('ci:')
  ) {
    return { type: 'chore', importance: 0.4 };
  }
  return { type: 'other', importance: 0.6 };
}
