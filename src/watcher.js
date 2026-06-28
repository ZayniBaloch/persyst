/**
 * watcher.js — Persyst Automatic Log Watcher Daemon
 * 
 * Periodically scans configured log directories for coding agents (Antigravity, Roo-Code, etc.),
 * reads new appends/messages from transcripts, runs heuristics to extract high-value memories,
 * and stores them in the local database.
 */

import { join, resolve } from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs';
import {
  getWatchPosition,
  upsertWatchPosition,
  insertMemory,
  insertVector,
  memoryExists,
  deleteMemory
} from './database.js';
import { generateEmbedding } from './embeddings.js';
import { extractHeuristic, hasExtractableSignals } from './extractor-heuristic.js';
import { searchHybrid } from './search.js';
import { searchCache } from './cache.js';
import { memoryEventBus } from './events.js';
import { logInfo } from './text-utils.js';
import chokidar from 'chokidar';

// Config path: ~/.persyst/config.json (overridable for tests)
const CONFIG_FILE = process.env.PERSYST_CONFIG_FILE || join(homedir(), '.persyst', 'config.json');

let chokidarWatcher = null;
const DEDUP_THRESHOLD = 0.80;

/**
 * Load configured directories to watch. Generates a default config if missing.
 * @returns {Array<string>} List of directory paths to scan
 */
export function loadWatchedDirs() {
  const defaultDirs = [
    join(homedir(), '.gemini', 'antigravity-ide', 'brain').replace(/\\/g, '/')
  ];

  // Also probe standard paths for Cline / Roo Code
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    const rooPath = join(appData, 'Roo-Code', 'tasks').replace(/\\/g, '/');
    if (existsSync(rooPath)) defaultDirs.push(rooPath);
    const clinePath = join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks').replace(/\\/g, '/');
    if (existsSync(clinePath)) defaultDirs.push(clinePath);
  } else if (platform === 'darwin') {
    const rooPath = join(homedir(), 'Library', 'Application Support', 'Roo-Code', 'tasks');
    if (existsSync(rooPath)) defaultDirs.push(rooPath);
    const clinePath = join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
    if (existsSync(clinePath)) defaultDirs.push(clinePath);
  } else {
    const rooPath = join(homedir(), '.config', 'Roo-Code', 'tasks');
    if (existsSync(rooPath)) defaultDirs.push(rooPath);
    const clinePath = join(homedir(), '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks');
    if (existsSync(clinePath)) defaultDirs.push(clinePath);
  }

  try {
    if (existsSync(CONFIG_FILE)) {
      const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
      if (Array.isArray(config.watch_dirs)) {
        return config.watch_dirs;
      }
    }
  } catch (_) {
    // Fail-safe: rewrite or fallback
  }

  // Create default config file if it does not exist
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify({ watch_dirs: defaultDirs }, null, 2));
  } catch (_) {}

  return defaultDirs;
}

/**
 * Scan a single transcript file in JSONL format (Antigravity).
 * @param {string} filePath 
 */
async function processJsonlFile(filePath) {
  try {
    const stat = statSync(filePath);
    const lastPos = getWatchPosition(filePath);

    if (stat.size <= lastPos) return;

    // Read only new content appended to the file (Bug C fix)
    const length = stat.size - lastPos;
    let text = '';
    if (length > 0) {
      const newContentBuffer = Buffer.alloc(length);
      const fd = openSync(filePath, 'r');
      try {
        readSync(fd, newContentBuffer, 0, length, lastPos);
      } finally {
        closeSync(fd);
      }
      text = newContentBuffer.toString('utf8');
    }

    const lines = text.split('\n');
    let addedCount = 0;
    let processedOffset = lastPos;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastLine = i === lines.length - 1;

      // Empty trailing line after a newline is expected; skip it without treating it as partial.
      if (!line.trim()) {
        if (!isLastLine) processedOffset += line.length + 1;
        continue;
      }

      let record;
      try {
        record = JSON.parse(line);
      } catch (_) {
        // If the last line fails to parse, it may be partially written. Leave processedOffset
        // before this line so the next scan re-reads it from the start.
        if (!isLastLine) processedOffset += line.length + 1;
        continue;
      }

      // Commit the bytes for this line (including the newline that produced the split).
      processedOffset += line.length + 1;

      // Check if it's user prompt or assistant response
      if (
        record.content &&
        (record.type === 'USER_INPUT' || record.type === 'PLANNER_RESPONSE' || record.source === 'MODEL')
      ) {
        // Strip XML/markdown wrapper tags (like <USER_REQUEST> or <ADDITIONAL_METADATA>)
        const cleanText = record.content.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();
        if (cleanText.length < 15 || !hasExtractableSignals(cleanText)) continue;

        const facts = extractHeuristic(cleanText);
        for (const fact of facts) {
          // Verify against exact duplicate (Bug A fix: check namespace 'shared')
          if (memoryExists(fact.content, 'shared')) continue;

          // Verify against semantic similarity (Bug B fix: check namespace 'shared')
          const similar = await searchHybrid(fact.content, 1, null, null, 'shared');
          if (similar.length > 0 && parseFloat(similar[0].similarity) >= DEDUP_THRESHOLD) {
            continue;
          }

          // Insert memory with provenance (written to project namespace or 'shared')
          const watcherNs = process.env.PERSYST_PROJECT || 'shared';
          const id = insertMemory(fact.content, fact.confidence, {
            source_type: 'agent',
            source_id: record.source === 'MODEL' ? 'antigravity-worker' : 'user-dialogue',
            confidence: fact.confidence
          }, watcherNs);

          try {
            const embedding = await generateEmbedding(fact.content);
            insertVector(id, embedding);
          } catch (embedErr) {
            console.error(`[persyst-watcher] Embedding failed for fact #${id}: ${embedErr.message}`);
            // Clean up: delete the memory so we don't have orphaned entries
            try { deleteMemory(id); } catch (_) {}
            continue;
          }

          addedCount++;
          console.error(`[persyst-watcher] Auto-extracted fact: "${fact.content}" (Memory #${id})`);
          memoryEventBus.emit('memory_added', { id, content: fact.content, namespace: watcherNs, source: 'watcher-antigravity' });
        }
      }
    }

    if (addedCount > 0) {
      searchCache.invalidate();
    }

    // Persist the byte offset up to the last successfully parsed complete line.
    // Do not advance past an incomplete trailing line so it is re-read on the next scan.
    upsertWatchPosition(filePath, processedOffset);
    return addedCount;
  } catch (err) {
    console.error(`[persyst-watcher] Failed to process JSONL file ${filePath}: ${err.message}`);
    return 0;
  }
}

/**
 * Scan a single task file in JSON format (Roo Code / Cline).
 * @param {string} filePath 
 */
async function processJsonFile(filePath) {
  try {
    const lastMsgCount = getWatchPosition(filePath);

    // Read full JSON (JSON objects are written entirely, not appended)
    const contentText = readFileSync(filePath, 'utf8');
    let task;
    try {
      task = JSON.parse(contentText);
    } catch (_) {
      return; // incomplete JSON, try again later
    }

    const history = task.history;
    if (!Array.isArray(history) || history.length <= lastMsgCount) return;

    let addedCount = 0;
    // Process only newly added messages
    for (let i = lastMsgCount; i < history.length; i++) {
      const msg = history[i];
      if (!msg.content || typeof msg.content !== 'string' || !hasExtractableSignals(msg.content)) continue;

      // Filter out system message structures
      if (msg.role === 'user' || msg.role === 'assistant') {
        const facts = extractHeuristic(msg.content);
        for (const fact of facts) {
          const watcherNs = process.env.PERSYST_PROJECT || 'shared';
          if (memoryExists(fact.content, watcherNs)) continue;

          const similar = await searchHybrid(fact.content, 1, null, null, watcherNs);
          if (similar.length > 0 && parseFloat(similar[0].similarity) >= DEDUP_THRESHOLD) {
            continue;
          }

          const id = insertMemory(fact.content, fact.confidence, {
            source_type: 'agent',
            source_id: msg.role === 'assistant' ? 'roo-worker' : 'user-dialogue',
            confidence: fact.confidence
          }, watcherNs);

          try {
            const embedding = await generateEmbedding(fact.content);
            insertVector(id, embedding);
          } catch (embedErr) {
            console.error(`[persyst-watcher] Embedding failed for fact #${id}: ${embedErr.message}`);
            try { deleteMemory(id); } catch (_) {}
            continue;
          }

          addedCount++;
          console.error(`[persyst-watcher] Auto-extracted fact: "${fact.content}" (Memory #${id})`);
          memoryEventBus.emit('memory_added', { id, content: fact.content, namespace: watcherNs, source: 'watcher-roo' });
        }
      }
    }

    if (addedCount > 0) {
      searchCache.invalidate();
    }

    // Persist message count index
    upsertWatchPosition(filePath, history.length);
    return addedCount;
  } catch (err) {
    console.error(`[persyst-watcher] Failed to process JSON file ${filePath}: ${err.message}`);
    return 0;
  }
}

/**
 * Find files ending with a given extension recursively in a folder up to a certain depth.
 * @param {string} dir 
 * @param {string} ext 
 * @param {number} depth 
 * @returns {Array<string>}
 */
function findFiles(dir, ext, depth = 3) {
  const results = [];
  if (depth < 0) return results;

  try {
    if (!existsSync(dir)) return results;
    const items = readdirSync(dir);
    for (const item of items) {
      const path = join(dir, item);
      let stat;
      try { stat = statSync(path); } catch (_) { continue; }

      if (stat.isDirectory()) {
        results.push(...findFiles(path, ext, depth - 1));
      } else if (item.endsWith(ext)) {
        results.push(path);
      }
    }
  } catch (_) {}

  return results;
}

/**
 * Perform a single scan of watched directories.
 */
export async function scanDirectories() {
  const watchDirs = loadWatchedDirs();
  let totalAdded = 0;

  for (const dir of watchDirs) {
    if (!existsSync(dir)) continue;

    // Scan for JSONL (Antigravity transcripts)
    const jsonlFiles = findFiles(dir, 'transcript.jsonl', 3);
    for (const file of jsonlFiles) {
      totalAdded += await processJsonlFile(file);
    }

    // Scan for JSON (Roo Code / Cline task files)
    const jsonFiles = findFiles(dir, '.json', 2);
    for (const file of jsonFiles) {
      // Avoid processing general configurations/settings files
      if (file.includes('tasks')) {
        totalAdded += await processJsonFile(file);
      }
    }
  }

  // Auto-consolidate memories if new ones were added to keep prompt context slim
  if (totalAdded > 0) {
    try {
      console.error(`[persyst-watcher] Running automatic memory consolidation sweep...`);
      const { consolidateMemories } = await import('./search.js');
      const report = await consolidateMemories();
      console.error(`[persyst-watcher] Auto-consolidation complete: merged ${report.consolidated_groups} duplicate groups.`);
    } catch (e) {
      console.error(`[persyst-watcher] Auto-consolidation failed: ${e.message}`);
    }
  }

  // Run periodic auto-expiry check on every folder scan (fast query)
  try {
    const { archiveExpiredMemories } = await import('./database.js');
    archiveExpiredMemories();
  } catch (e) {
    console.error(`[persyst-watcher] Auto-expiry execution failed: ${e.message}`);
  }
}

/**
 * Handle a file addition or modification event from Chokidar.
 * @param {string} filePath 
 */
async function handleFileChange(filePath) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  let addedCount = 0;
  
  if (normalizedPath.endsWith('transcript.jsonl')) {
    addedCount = await processJsonlFile(filePath);
  } else if (normalizedPath.endsWith('.json') && normalizedPath.includes('tasks')) {
    addedCount = await processJsonFile(filePath);
  }

  if (addedCount > 0) {
    try {
      console.error(`[persyst-watcher] Running automatic memory consolidation sweep...`);
      const { consolidateMemories } = await import('./search.js');
      const report = await consolidateMemories();
      console.error(`[persyst-watcher] Auto-consolidation complete: merged ${report.consolidated_groups} duplicate groups.`);
    } catch (e) {
      console.error(`[persyst-watcher] Auto-consolidation failed: ${e.message}`);
    }
  }

  // Run periodic auto-expiry check on every change (fast query)
  try {
    const { archiveExpiredMemories } = await import('./database.js');
    archiveExpiredMemories();
  } catch (e) {
    console.error(`[persyst-watcher] Auto-expiry execution failed: ${e.message}`);
  }
}

/**
 * Start the background log watcher daemon.
 */
export function startWatcher() {
  if (chokidarWatcher) return;

  logInfo('[persyst-watcher] Starting background log watcher daemon (Chokidar)...');
  const watchDirs = loadWatchedDirs();

  // Run initial scan, then start watching
  scanDirectories()
    .catch(err => {
      console.error(`[persyst-watcher] Initial scan failed: ${err.message}`);
    })
    .then(() => {
      if (chokidarWatcher) return;
      chokidarWatcher = chokidar.watch(watchDirs, {
        persistent: true,
        ignoreInitial: true, // we already ran scanDirectories
        awaitWriteFinish: {
          stabilityThreshold: 300,
          pollInterval: 100
        }
      });

      chokidarWatcher.on('add', filePath => {
        handleFileChange(filePath).catch(err => {
          console.error(`[persyst-watcher] Error handling added file ${filePath}:`, err);
        });
      });

      chokidarWatcher.on('change', filePath => {
        handleFileChange(filePath).catch(err => {
          console.error(`[persyst-watcher] Error handling changed file ${filePath}:`, err);
        });
      });

      chokidarWatcher.on('error', err => {
        console.error(`[persyst-watcher] Chokidar watcher error: ${err.message}`);
      });
    });
}

/**
 * Stop the background log watcher daemon.
 */
export function stopWatcher() {
  if (chokidarWatcher) {
    chokidarWatcher.close().catch(() => {});
    chokidarWatcher = null;
    logInfo('[persyst-watcher] Background log watcher daemon stopped.');
  }
}
