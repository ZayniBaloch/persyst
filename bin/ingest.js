#!/usr/bin/env node

/**
 * persyst-ingest — Direct Git Commit Ingester
 * 
 * Usage:
 *   npx persyst-mcp ingest [repo_path] [count]
 * 
 * This script runs directly without starting the MCP server, allowing
 * git hooks or direct CLI commands to populate the memory database.
 */

import { getRecentCommits } from '../src/git.js';
import {
  insertMemory,
  insertVector,
  insertEntity,
  insertEdge,
  memoryExistsByHashPrefix
} from '../src/database.js';
import { generateEmbedding } from '../src/embeddings.js';
import { searchCache } from '../src/cache.js';

const repoPath = process.argv[2] || process.cwd();
const count = parseInt(process.argv[3], 10) || 10;

async function run() {
  console.log(`[persyst] Ingesting git commits for: ${repoPath}`);
  try {
    const commits = await getRecentCommits(repoPath, count);
    let added = 0;
    let skipped = 0;

    for (const commit of commits) {
      const hashPrefix = commit.hash.slice(0, 7);
      // Check if commit already exists in memories
      if (memoryExistsByHashPrefix(`[${hashPrefix}]%`)) {
        skipped++;
        continue;
      }

      // Insert memory with git provenance
      const id = insertMemory(commit.fullText, commit.importance, {
        source_type: 'git',
        source_id: commit.hash,
        confidence: 0.8
      });

      // Generate embedding vector and store
      const embedding = await generateEmbedding(commit.fullText);
      insertVector(id, embedding);

      // Link Author entity
      const authorId = insertEntity(commit.author, 'person');
      if (authorId) {
        insertEdge(authorId, id, 'authored', 'entity', 'memory');
      }

      // Link Files Touched
      for (const file of commit.files) {
        const fileId = insertEntity(file, 'file');
        if (fileId) {
          insertEdge(fileId, id, 'touches', 'entity', 'memory');
        }
      }

      added++;
    }

    if (added > 0) {
      searchCache.invalidate();
    }

    console.log(`[persyst] Success: Ingested ${added} commits (${skipped} already existed)`);
    process.exit(0);
  } catch (err) {
    console.error(`[persyst] Ingestion failed: ${err.message}`);
    process.exit(1);
  }
}

run();
