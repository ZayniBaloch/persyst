#!/usr/bin/env node

/**
 * export.js — Persyst Memory JSONL Export CLI
 *
 * Exports all active memories to a portable JSONL file for backup or migration.
 * Each line is a JSON object representing one memory with its full metadata.
 *
 * Usage:
 *   persyst-export                          → exports to persyst-export-<timestamp>.jsonl
 *   persyst-export memories.jsonl           → exports to memories.jsonl
 *   persyst-export --namespace=shared       → exports only the shared namespace
 *   persyst-export --all                    → includes archived (valid_until IS NOT NULL) memories
 *
 * The output format is designed to be imported back via `persyst-import`.
 */

import { createWriteStream } from 'fs';
import db, { closeDatabase } from '../src/database.js';

// ============================================================
// ARG PARSING
// ============================================================

const args = process.argv.slice(2);
const outputFile = args.find(a => !a.startsWith('--')) || `persyst-export-${Date.now()}.jsonl`;
const namespace = (args.find(a => a.startsWith('--namespace=')) || '').replace('--namespace=', '') || null;
const includeArchived = args.includes('--all');

// ============================================================
// EXPORT
// ============================================================

try {
  const conditions = [];
  const params = [];

  if (!includeArchived) {
    conditions.push('m.valid_until IS NULL');
  }
  if (namespace) {
    conditions.push("(m.namespace = ? OR m.namespace = 'shared')");
    params.push(namespace);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const query = `
    SELECT
      m.id,
      m.content,
      m.importance_score,
      m.namespace,
      m.created_at,
      m.last_accessed,
      m.access_count,
      m.parent_id,
      m.valid_until,
      p.source_type,
      p.source_id,
      p.confidence
    FROM memories m
    LEFT JOIN provenance p ON p.memory_id = m.id
    ${whereClause}
    ORDER BY m.id ASC
  `;

  const rows = params.length > 0 ? db.prepare(query).all(...params) : db.prepare(query).all();

  const out = createWriteStream(outputFile, { encoding: 'utf8' });

  let count = 0;
  for (const row of rows) {
    const record = {
      id: row.id,
      content: row.content,
      importance_score: row.importance_score,
      namespace: row.namespace || 'shared',
      created_at: row.created_at,
      last_accessed: row.last_accessed,
      access_count: row.access_count,
      parent_id: row.parent_id ?? null,
      valid_until: row.valid_until ?? null,
      provenance: row.source_type
        ? {
            source_type: row.source_type,
            source_id: row.source_id ?? null,
            confidence: row.confidence ?? 1.0
          }
        : null
    };
    out.write(JSON.stringify(record) + '\n');
    count++;
  }

  await new Promise((resolve, reject) => {
    out.end((err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  console.log(`✅ Exported ${count} memories to: ${outputFile}`);
  if (namespace) {
    console.log(`   Namespace filter: "${namespace}" + shared`);
  }
  if (includeArchived) {
    console.log('   Includes archived (superseded) memories.');
  }

} catch (err) {
  console.error(`❌ Export failed: ${err.message}`);
  process.exit(1);
} finally {
  closeDatabase();
}
