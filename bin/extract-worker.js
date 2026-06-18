#!/usr/bin/env node

/**
 * extract-worker.js — PAMP Background Queue Worker
 * 
 * Processes extraction jobs from the disk-based queue at ~/.persyst/queue/.
 * Spawned as a detached child process by the hook — runs independently.
 * 
 * Lifecycle:
 *   1. Reads .json job files from ~/.persyst/queue/
 *   2. For each job: runs Tier 3 LLM extraction
 *   3. Deduplicates facts against existing memories (semantic check)
 *   4. Checks for recent agent-written memories to avoid race conditions
 *   5. Writes validated facts to the database
 *   6. Cleans up job file on success, increments retry on failure
 *   7. Exits when queue is empty
 * 
 * Safety bounds:
 *   - Max 3 retries per job before archiving to failed/
 *   - Queue trimming: deletes jobs older than 7 days
 *   - Max 50 jobs per worker run to prevent CPU starvation
 *   - Process lock file to prevent multiple concurrent workers
 */

import { homedir } from 'os';
import { join } from 'path';
import {
  readdirSync, readFileSync, writeFileSync, unlinkSync,
  mkdirSync, existsSync, statSync, renameSync
} from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import http from 'http';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// PATHS
// ============================================================

const PERSYST_DIR = join(homedir(), '.persyst');
const QUEUE_DIR = join(PERSYST_DIR, 'queue');
const FAILED_DIR = join(PERSYST_DIR, 'queue', 'failed');
const LOCK_FILE = join(QUEUE_DIR, '.worker.lock');
const LOG_FILE = join(PERSYST_DIR, 'worker.log');

mkdirSync(QUEUE_DIR, { recursive: true });
mkdirSync(FAILED_DIR, { recursive: true });

// ============================================================
// CONSTANTS
// ============================================================

const MAX_RETRIES = 3;
const MAX_JOBS_PER_RUN = 50;
const MAX_QUEUE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEDUP_SIMILARITY_THRESHOLD = 0.80;
const RECENT_MEMORY_WINDOW_S = 60; // Check last 60 seconds for agent race
const MIN_CONFIDENCE = 0.65;

// ============================================================
// LLM EXTRACTION PIPELINE (Tiers 1 & 2)
// ============================================================

const EXTRACTION_SYSTEM_PROMPT = `You are a precise developer memory extraction assistant.
Analyze the following developer conversation turn or transcript and extract any:
1. Explicit user preferences (e.g. "I prefer HSL colors", "I like clean UI")
2. Architectural decisions (e.g. "We decided to expose a gateway server on port 4321")
3. Project stack choices (e.g. "Using Node.js for backend")
4. Coding rules/styles (e.g. "Always use camelCase for variables")
5. Project config/settings (e.g. "Port is set to 4321")

Do not extract temporary tasks, questions, or vague conversational statements.
Do not invent facts. Only extract facts that are clearly stated or implied by the developer.

You MUST respond with a valid JSON array of objects, and absolutely NOTHING else. No markdown formatting, no explanation.
Each object must have the following fields:
- "content": A clean, concise statement of the preference/decision (e.g., "Preference: Use HSL tailwind colors"). Start the content with the prefix indicating the category: "Preference: ...", "Decision: ...", "Stack: ...", "Rule: ...", "Config: ...".
- "category": One of "preference", "decision", "stack", "naming", "architecture", "rule", "config".
- "confidence": A float value between 0.65 and 1.0 representing your confidence.

Example output:
[
  {
    "content": "Preference: Always use vanilla CSS for maximum control.",
    "category": "preference",
    "confidence": 0.95
  }
]`;

function parseJsonArray(text) {
  try {
    let clean = text.trim();
    if (clean.startsWith('```json')) {
      clean = clean.slice(7);
    } else if (clean.startsWith('```')) {
      clean = clean.slice(3);
    }
    if (clean.endsWith('```')) {
      clean = clean.slice(0, -3);
    }
    clean = clean.trim();
    const arr = JSON.parse(clean);
    if (Array.isArray(arr)) return arr;
    return [];
  } catch (err) {
    try {
      const start = text.indexOf('[');
      const end = text.lastIndexOf(']');
      if (start !== -1 && end !== -1) {
        const substring = text.slice(start, end + 1);
        const arr = JSON.parse(substring);
        if (Array.isArray(arr)) return arr;
      }
    } catch (_) {}
    return [];
  }
}

function extractAnthropic(text, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1000,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Extract facts from this transcript:\n\n${text}` }
      ]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      },
      timeout: 8000
    });

    req.on('response', (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`Anthropic error: ${parsed.error?.message || data}`));
            return;
          }
          const contentText = parsed.content?.[0]?.text || '';
          resolve(parseJsonArray(contentText));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Anthropic timeout')); });
    req.write(payload);
    req.end();
  });
}

function extractOpenAI(text, apiKey) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: `Extract facts from this transcript:\n\n${text}` }
      ],
      response_format: { type: 'json_object' }
    });

    const req = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 8000
    });

    req.on('response', (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode !== 200) {
            reject(new Error(`OpenAI error: ${parsed.error?.message || data}`));
            return;
          }
          const contentText = parsed.choices?.[0]?.message?.content || '';
          let obj = JSON.parse(contentText);
          if (Array.isArray(obj)) {
            resolve(obj);
          } else if (obj && typeof obj === 'object') {
            const key = Object.keys(obj).find(k => Array.isArray(obj[k]));
            if (key) {
              resolve(obj[key]);
            } else {
              resolve([]);
            }
          } else {
            resolve([]);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('OpenAI timeout')); });
    req.write(payload);
    req.end();
  });
}

function extractOllama(text, model) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        { role: 'user', content: `Extract facts from this transcript:\n\n${text}` }
      ],
      stream: false,
      format: 'json'
    });

    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 12000
    });

    req.on('response', (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            reject(new Error(`Ollama error: status ${res.statusCode}`));
            return;
          }
          const parsed = JSON.parse(data);
          const contentText = parsed.message?.content || '';
          let obj = JSON.parse(contentText);
          if (Array.isArray(obj)) {
            resolve(obj);
          } else if (obj && typeof obj === 'object') {
            const key = Object.keys(obj).find(k => Array.isArray(obj[k]));
            if (key) {
              resolve(obj[key]);
            } else {
              resolve([]);
            }
          } else {
            resolve([]);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.write(payload);
    req.end();
  });
}

function checkOllamaAlive() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/tags',
      method: 'GET',
      timeout: 1000
    });

    req.on('response', (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const models = parsed.models || [];
            resolve({ alive: true, models: models.map(m => m.name) });
          } catch (_) {
            resolve({ alive: true, models: [] });
          }
        });
      } else {
        resolve({ alive: false });
      }
    });

    req.on('error', () => {
      resolve({ alive: false });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ alive: false });
    });

    req.end();
  });
}

async function extractFacts(text) {
  // Try Anthropic first
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      log('INFO', 'Attempting Anthropic fact extraction...');
      const facts = await extractAnthropic(text, process.env.ANTHROPIC_API_KEY);
      log('INFO', `Anthropic extraction succeeded: extracted ${facts.length} facts.`);
      return { facts, tier: 'anthropic' };
    } catch (err) {
      log('WARN', `Anthropic extraction failed: ${err.message}`);
    }
  }

  // Try OpenAI second
  if (process.env.OPENAI_API_KEY) {
    try {
      log('INFO', 'Attempting OpenAI fact extraction...');
      const facts = await extractOpenAI(text, process.env.OPENAI_API_KEY);
      log('INFO', `OpenAI extraction succeeded: extracted ${facts.length} facts.`);
      return { facts, tier: 'openai' };
    } catch (err) {
      log('WARN', `OpenAI extraction failed: ${err.message}`);
    }
  }

  // Try Ollama third
  try {
    const ollamaStatus = await checkOllamaAlive();
    if (ollamaStatus.alive && ollamaStatus.models && ollamaStatus.models.length > 0) {
      const targetModel = ollamaStatus.models.find(m => m.includes('qwen') || m.includes('coder') || m.includes('llama')) || ollamaStatus.models[0];
      if (targetModel) {
        log('INFO', `Attempting Ollama extraction using model: ${targetModel}...`);
        const facts = await extractOllama(text, targetModel);
        log('INFO', `Ollama extraction succeeded: extracted ${facts.length} facts.`);
        return { facts, tier: \`ollama:\${targetModel}\` };
      }
    }
  } catch (err) {
    log('WARN', `Ollama extraction failed: ${err.message}`);
  }

  // Fallback to Heuristic
  log('INFO', 'All LLM extraction options unavailable/failed. Falling back to Heuristic extraction.');
  try {
    const { extractHeuristic } = await import('../src/extractor-heuristic.js');
    const heuristicFacts = extractHeuristic(text);
    return { facts: heuristicFacts, tier: 'heuristic' };
  } catch (err) {
    log('ERROR', `Heuristic extraction fallback failed: ${err.message}`);
    return { facts: [], tier: 'failed' };
  }
}



// ============================================================
// LOGGING
// ============================================================

function log(level, msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}\n`;
  process.stderr.write(line);
  try {
    writeFileSync(LOG_FILE, line, { flag: 'a' });
  } catch (_) { /* non-critical */ }
}

// ============================================================
// PROCESS LOCK (prevent concurrent workers)
// ============================================================

function acquireLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const lockContent = readFileSync(LOCK_FILE, 'utf8').trim();
      const lockPid = parseInt(lockContent, 10);

      // Check if the locking process is still alive
      if (lockPid && lockPid !== process.pid) {
        try {
          process.kill(lockPid, 0); // Signal 0 = check existence
          log('WARN', `Another worker is running (PID: ${lockPid}), exiting.`);
          return false;
        } catch (_) {
          // Process is dead — stale lock, claim it
          log('INFO', `Stale lock from PID ${lockPid}, claiming.`);
        }
      }
    }

    writeFileSync(LOCK_FILE, String(process.pid));
    return true;
  } catch (err) {
    log('ERROR', `Lock acquisition failed: ${err.message}`);
    return false;
  }
}

function releaseLock() {
  try {
    if (existsSync(LOCK_FILE)) {
      const content = readFileSync(LOCK_FILE, 'utf8').trim();
      if (content === String(process.pid)) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch (_) { /* best-effort */ }
}

// ============================================================
// QUEUE MANAGEMENT
// ============================================================

/**
 * Clean old queue files (older than 7 days).
 */
function cleanOldJobs() {
  const now = Date.now();
  let cleaned = 0;

  try {
    const files = readdirSync(QUEUE_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const filePath = join(QUEUE_DIR, file);
      const stat = statSync(filePath);
      if (now - stat.mtimeMs > MAX_QUEUE_AGE_MS) {
        unlinkSync(filePath);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      log('INFO', `Cleaned ${cleaned} expired queue files.`);
    }
  } catch (err) {
    log('WARN', `Queue cleanup error: ${err.message}`);
  }
}

/**
 * Read all pending job files from the queue, sorted oldest-first.
 * @returns {Array<{path: string, data: Object}>}
 */
function readJobQueue() {
  try {
    const files = readdirSync(QUEUE_DIR)
      .filter(f => f.endsWith('.json') && !f.startsWith('.'))
      .sort(); // Filenames include timestamps, so sort = oldest first

    return files.slice(0, MAX_JOBS_PER_RUN).map(file => {
      const filePath = join(QUEUE_DIR, file);
      try {
        const data = JSON.parse(readFileSync(filePath, 'utf8'));
        return { path: filePath, filename: file, data };
      } catch (_) {
        // Corrupted file — move to failed
        try { renameSync(filePath, join(FAILED_DIR, file)); } catch (__) {}
        return null;
      }
    }).filter(Boolean);
  } catch (err) {
    log('ERROR', `Failed to read queue: ${err.message}`);
    return [];
  }
}

// ============================================================
// DEDUPLICATION
// ============================================================

/**
 * Check if a fact already exists in the database.
 * Uses exact match first (fast), then semantic similarity (slower).
 * 
 * @param {string} factContent - The fact to check
 * @param {Object} db - Database module
 * @param {Function} searchFn - Hybrid search function
 * @returns {Promise<boolean>} true if duplicate
 */
async function isDuplicate(factContent, db, searchFn) {
  // 1. Exact content match (instant)
  if (db.memoryExists(factContent)) {
    return true;
  }

  // 2. Semantic similarity check (needs embedding)
  try {
    const results = await searchFn(factContent, 3);
    for (const result of results) {
      const similarity = parseFloat(result.similarity || 0);
      if (similarity >= DEDUP_SIMILARITY_THRESHOLD) {
        log('INFO', `Dedup: "${factContent.slice(0, 60)}..." similar to memory #${result.id} (sim=${similarity})`);
        return true;
      }
    }
  } catch (err) {
    log('WARN', `Dedup search failed: ${err.message}`);
    // Fail open — allow the fact through if search fails
  }

  return false;
}

/**
 * Check if an agent recently wrote a similar memory (race condition guard).
 * Looks at memories created in the last RECENT_MEMORY_WINDOW_S seconds.
 * 
 * @param {string} factContent
 * @param {Object} db
 * @returns {boolean}
 */
function hasRecentAgentMemory(factContent, db) {
  try {
    const recentMemories = db.getRecentMemories(20);
    const now = Math.floor(Date.now() / 1000);

    for (const mem of recentMemories) {
      if (now - mem.created_at > RECENT_MEMORY_WINDOW_S) continue;

      // Simple word-overlap check for race condition detection
      const factWords = new Set(factContent.toLowerCase().split(/\s+/));
      const memWords = new Set(mem.content.toLowerCase().split(/\s+/));
      let overlap = 0;
      for (const w of factWords) {
        if (memWords.has(w)) overlap++;
      }
      const overlapRatio = overlap / Math.max(factWords.size, 1);
      if (overlapRatio > 0.5) {
        log('INFO', `Race guard: "${factContent.slice(0, 50)}..." overlaps with recent memory #${mem.id}`);
        return true;
      }
    }
  } catch (err) {
    log('WARN', `Recent memory check failed: ${err.message}`);
  }
  return false;
}

// ============================================================
// MAIN WORKER
// ============================================================

async function main() {
  log('INFO', '=== PAMP Worker started ===');

  // Acquire process lock
  if (!acquireLock()) {
    process.exit(0);
  }

  try {
    // Clean expired jobs
    cleanOldJobs();

    // Read pending jobs
    const jobs = readJobQueue();
    if (jobs.length === 0) {
      log('INFO', 'No pending jobs. Exiting.');
      return;
    }

    log('INFO', `Processing ${jobs.length} job(s)...`);

    // Lazy-load heavy dependencies only if we have work to do
    const dbModule = await import('../src/database.js');
    const { searchHybrid } = await import('../src/search.js');
    const { generateEmbedding } = await import('../src/embeddings.js');

    let totalExtracted = 0;
    let totalStored = 0;
    let totalDuplicates = 0;
    let totalFailed = 0;

    for (const job of jobs) {
      const { path: jobPath, filename, data } = job;
      const retryCount = data._retries || 0;

      try {
        log('INFO', `Processing: ${filename} (retry: ${retryCount})`);

        const { facts: extractedFacts, tier } = await extractFacts(data.text);
        const facts = extractedFacts.map(f => ({ ...f, tier }));

        log('INFO', `Extracted ${facts.length} fact(s) using tier: ${tier}`);

        // Deduplicate facts within this run
        const uniqueFacts = [];
        const seenFacts = new Set();
        for (const fact of facts) {
          const key = fact.content.toLowerCase().replace(/\s+/g, ' ').trim();
          if (!seenFacts.has(key)) {
            seenFacts.add(key);
            uniqueFacts.push(fact);
          }
        }

        totalExtracted += uniqueFacts.length;

        // Process each fact
        for (const fact of uniqueFacts) {
          if (fact.confidence < MIN_CONFIDENCE) {
            log('INFO', `Skipping low-confidence fact (${fact.confidence}): "${fact.content.slice(0, 50)}..."`);
            continue;
          }

          // Dedup check 1: recent agent memory race
          if (hasRecentAgentMemory(fact.content, dbModule)) {
            totalDuplicates++;
            continue;
          }

          // Dedup check 2: existing memory search
          if (await isDuplicate(fact.content, dbModule, searchHybrid)) {
            totalDuplicates++;
            continue;
          }

          // Store the new memory
          try {
            const memoryId = dbModule.insertMemory(fact.content, fact.confidence, {
              source_type: 'agent',
              source_id: data.agent_id || 'pamp-worker',
              confidence: fact.confidence
            }, data.namespace || 'shared');

            // Generate and store embedding
            const embedding = await generateEmbedding(fact.content);
            dbModule.insertVector(memoryId, embedding);

            totalStored++;
            log('INFO', `Stored memory #${memoryId}: "${fact.content.slice(0, 60)}..." (${fact.category}, conf=${fact.confidence})`);
          } catch (storeErr) {
            log('ERROR', `Failed to store fact: ${storeErr.message}`);
          }
        }

        // Success — remove job file
        try { unlinkSync(jobPath); } catch (_) {}

      } catch (jobErr) {
        totalFailed++;
        log('ERROR', `Job ${filename} failed: ${jobErr.message}`);

        // Retry or move to failed
        if (retryCount >= MAX_RETRIES - 1) {
          log('WARN', `Job ${filename} exceeded max retries, moving to failed/`);
          try { renameSync(jobPath, join(FAILED_DIR, filename)); } catch (_) {}
        } else {
          // Increment retry count
          try {
            data._retries = retryCount + 1;
            writeFileSync(jobPath, JSON.stringify(data, null, 2));
          } catch (_) {}
        }
      }
    }

    log('INFO', `=== Worker complete: extracted=${totalExtracted} stored=${totalStored} dupes=${totalDuplicates} failed=${totalFailed} ===`);

  } finally {
    releaseLock();
  }
}

main().catch(err => {
  log('ERROR', `Worker crashed: ${err.message}`);
  releaseLock();
  process.exit(1);
});
