#!/usr/bin/env node

/**
 * extract.js — Manual Extraction CLI
 * 
 * Allows developers to test and run extraction on demand.
 * 
 * Usage:
 *   npx persyst-mcp extract "I prefer TypeScript over JavaScript"
 *   npx persyst-mcp extract --file conversation.txt
 *   npx persyst-mcp extract --tier heuristic "we decided to use PostgreSQL"
 *   npx persyst-mcp extract --provider gemini "our stack uses Next.js"
 *   npx persyst-mcp extract --dry-run "always use camelCase"
 */

import { argv, stdin, stdout } from 'process';
import { readFileSync, existsSync } from 'fs';

// ============================================================
// ARGUMENT PARSING
// ============================================================

const args = argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const flag = args[i].slice(2);
    // Check if next arg is the value (not another flag)
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      flags[flag] = args[i + 1];
      i++;
    } else {
      flags[flag] = true;
    }
  } else {
    positional.push(args[i]);
  }
}

// ============================================================
// HELP
// ============================================================

if (flags.help || args.length === 0) {
  console.log(`
  Persyst Extract — Manual Fact Extraction CLI

  USAGE:
    npx persyst-mcp extract <text>           Extract from text
    npx persyst-mcp extract --file <path>    Extract from file
    echo "text" | npx persyst-mcp extract -  Extract from stdin

  OPTIONS:
    --dry-run              Show extracted facts without storing to database
    --json                 Output results as JSON
    --file <path>          Read text from a file
    --help                 Show this help message

  EXAMPLES:
    npx persyst-mcp extract "I prefer Postgres over SQLite"
    npx persyst-mcp extract --dry-run --file ./conversation.log
  `);
  process.exit(0);
}

// ============================================================
// INPUT RESOLUTION
// ============================================================

let inputText = '';

if (flags.file) {
  // Read from file
  const filePath = flags.file;
  if (!existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
  inputText = readFileSync(filePath, 'utf8');
} else if (positional[0] === '-') {
  // Read from stdin
  inputText = readFileSync(0, 'utf8');
} else if (positional.length > 0) {
  // Read from positional args
  inputText = positional.join(' ');
} else {
  console.error('Error: No text provided. Use --help for usage.');
  process.exit(1);
}

if (!inputText.trim()) {
  console.error('Error: Empty input text.');
  process.exit(1);
}

// ============================================================
// EXTRACTION
// ============================================================

async function run() {
  const dryRun = flags['dry-run'] === true;
  const jsonOutput = flags.json === true;

  const allFacts = [];

  // --- Tier 2: Heuristic ---
  const { extractHeuristic } = await import('../src/extractor-heuristic.js');
  const heuristicFacts = extractHeuristic(inputText);

  for (const f of heuristicFacts) {
    allFacts.push({ ...f, tier: 'heuristic' });
  }

  if (!jsonOutput) {
    console.log(`\n📋 Heuristic fact(s) extracted: ${heuristicFacts.length}`);
    for (const f of heuristicFacts) {
      console.log(`  ✓ [${f.category}] (conf: ${f.confidence}) ${f.content}`);
    }
  }

  // --- Summary ---
  if (!jsonOutput) {
    console.log(`\n━━━ Total: ${allFacts.length} fact(s) ━━━`);
  }

  // --- Store to database (unless dry-run) ---
  if (!dryRun && allFacts.length > 0) {
    if (!jsonOutput) {
      console.log(`\n💾 Storing to database...`);
    }

    const { insertMemory, insertVector, memoryExists } = await import('../src/database.js');
    const { generateEmbedding } = await import('../src/embeddings.js');

    let stored = 0;
    let dupes = 0;

    for (const fact of allFacts) {
      // Exact dedup
      if (memoryExists(fact.content)) {
        dupes++;
        if (!jsonOutput) {
          console.log(`  ⏭ Duplicate: "${fact.content.slice(0, 50)}..."`);
        }
        continue;
      }

      const id = insertMemory(fact.content, fact.confidence, {
        source_type: 'agent',
        source_id: `pamp-${fact.tier}`,
        confidence: fact.confidence
      });

      const embedding = await generateEmbedding(fact.content);
      insertVector(id, embedding);

      stored++;
      if (!jsonOutput) {
        console.log(`  ✅ Stored memory #${id}: "${fact.content.slice(0, 60)}..."`);
      }
    }

    if (!jsonOutput) {
      console.log(`\n📊 Result: ${stored} stored, ${dupes} duplicates skipped`);
    }
  } else if (dryRun && !jsonOutput) {
    console.log(`\n🔍 Dry run — no facts stored.`);
  }

  // --- JSON output ---
  if (jsonOutput) {
    console.log(JSON.stringify({
      input_length: inputText.length,
      facts: allFacts,
      dry_run: dryRun
    }, null, 2));
  }
}

run().catch(err => {
  console.error(`\n❌ Extraction failed: ${err.message}`);
  process.exit(1);
});
