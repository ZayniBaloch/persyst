#!/usr/bin/env node

/**
 * import.js — Persyst Memory JSONL Import CLI
 *
 * Imports memories from a JSONL file created by `persyst-export`.
 * Regenerates vector embeddings for each imported memory.
 * Skips duplicates using both exact-content and semantic similarity checks.
 *
 * Usage:
 *   persyst-import memories.jsonl
 *   persyst-import memories.jsonl --dry-run          → preview without writing
 *   persyst-import memories.jsonl --namespace=shared  → force all into shared namespace
 *   persyst-import memories.jsonl --skip-embeddings   → skip re-generating embeddings (fast, no semantic search for these)
 *
 * Compatible with the JSONL format produced by `persyst-export`.
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import db, {
  insertMemory,
  insertVector,
  memoryExists,
  closeDatabase
} from '../src/database.js';
import { generateEmbedding } from '../src/embeddings.js';
import { searchHybrid } from '../src/search.js';

// ============================================================
// ARG PARSING
// ============================================================

const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));
const isDryRun = args.includes('--dry-run');
const forceNamespace = (args.find(a => a.startsWith('--namespace=')) || '').replace('--namespace=', '') || null;
const skipEmbeddings = args.includes('--skip-embeddings');

const DEDUP_THRESHOLD = 0.85;

if (!inputFile) {
  console.error('[ERROR] Usage: persyst-import <file.jsonl> [--dry-run] [--namespace=<ns>] [--skip-embeddings]');
  process.exit(1);
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log(`[IMPORT] Persyst Import${isDryRun ? ' (DRY RUN — nothing will be written)' : ''}`);
  console.log(`         Source: ${inputFile}`);
  if (forceNamespace) console.log(`         Forcing namespace: "${forceNamespace}"`);
  if (skipEmbeddings) console.log('         Skipping embedding regeneration.');
  console.log('');

  const rl = createInterface({
    input: createReadStream(inputFile, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let lineNum = 0;
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (err) {
      console.error(`  [WARN] Line ${lineNum}: Invalid JSON — skipping`);
      errors++;
      continue;
    }

    const { content, importance_score = 1.0, namespace, provenance, valid_until } = record;

    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      console.error(`  [WARN] Line ${lineNum}: Empty content — skipping`);
      errors++;
      continue;
    }

    // Skip archived memories (unless they have a parent_id, we skip them anyway)
    if (valid_until !== null && valid_until !== undefined) {
      skipped++;
      continue;
    }

    const targetNamespace = forceNamespace || namespace || 'shared';

    // --- Dedup: exact content match ---
    if (memoryExists(content, targetNamespace)) {
      console.log(`  [SKIP] Line ${lineNum}: Already exists — skipping "${content.slice(0, 60)}..."`);
      skipped++;
      continue;
    }

    // --- Dedup: semantic similarity ---
    if (!skipEmbeddings) {
      try {
        const similar = await searchHybrid(content, 1, null, null, targetNamespace);
        if (similar.length > 0 && parseFloat(similar[0].similarity) >= DEDUP_THRESHOLD) {
          console.log(`  [SKIP] Line ${lineNum}: Semantically similar to #${similar[0].id} (sim=${similar[0].similarity}) — skipping`);
          skipped++;
          continue;
        }
      } catch (_) {
        // Non-critical: proceed with import if semantic check fails
      }
    }

    if (isDryRun) {
      console.log(`  [OK] Would import: "${content.slice(0, 80)}${content.length > 80 ? '...' : ''}" → ns="${targetNamespace}"`);
      imported++;
      continue;
    }

    // --- Write to DB ---
    try {
      const prov = provenance || { source_type: 'import', source_id: 'persyst-import', confidence: 1.0 };
      const id = insertMemory(content, importance_score, prov, targetNamespace);

      if (!skipEmbeddings) {
        const embedding = await generateEmbedding(content);
        insertVector(id, embedding);
      }

      console.log(`  [OK] Imported #${id}: "${content.slice(0, 70)}${content.length > 70 ? '...' : ''}"`);
      imported++;
    } catch (err) {
      console.error(`  [ERROR] Line ${lineNum}: Failed to insert — ${err.message}`);
      errors++;
    }
  }

  console.log('');
  console.log('═'.repeat(50));
  if (isDryRun) {
    console.log(`[INFO] Dry run complete: ${imported} would import, ${skipped} skipped, ${errors} errors`);
  } else {
    console.log(`[INFO] Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`);
  }
  console.log('═'.repeat(50));
}

main()
  .catch(err => {
    console.error(`[ERROR] Import crashed: ${err.message}`);
    process.exit(1);
  })
  .finally(() => {
    closeDatabase();
  });
