#!/usr/bin/env node

/**
 * persyst-init — Workspace rules generator for VS Code-based IDEs (Cursor, Windsurf, Antigravity)
 * 
 * Usage:
 *   npx persyst-mcp init
 * 
 * What it does:
 *   1. Safely creates or appends system instructions to `.cursorrules`
 *   2. Safely creates or appends system instructions to `.windsurfrules`
 *   3. Creates a general `.persystrules.md` copy-pasteable guide
 *   4. Prints instructions on configuring MCP servers in Cursor/VS Code/Antigravity
 * 
 * Design:
 *   - Non-destructive: checks for existing content before appending to avoid duplication
 *   - Idempotent: safe to run multiple times
 *   - Localized: targets the current working directory (project root)
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ============================================================
// SYSTEM INSTRUCTION CONTENT
// ============================================================

const INSTRUCTION_HEADER = '# Persyst Memory Integration';

const RULE_CONTENT = `
${INSTRUCTION_HEADER}
You are integrated with Persyst, a local-first MCP memory server that stores user preferences, project guidelines, context, and decisions.

## Proactive Memory Retrieval (CRITICAL)
- Before responding to the user's prompt or executing any task, you MUST invoke the \`persyst\` MCP server's \`search_memories\` or \`get_optimized_context\` tool.
- Extract relevant search terms from the user's prompt (e.g. if the user says "update the database schema", query "database", "schema", "sqlite", "table").
- This ensures you are aware of existing codebase architecture, constraints, preferences, or past decisions before writing code.

## Proactive Memory Storage (CRITICAL)
- Record Milestones: When you successfully implement a feature, fix a bug, or make an architectural decision, call the \`add_memory\` tool to store a summary of the change.
- Handle Contradictions: Persyst handles contradiction detection automatically. If a new fact contradicts an old memory, Persyst will flag it.
- Quality Over Quantity: Do NOT store trivial facts, temporary conversation noise, or duplicate data. "Bad data is worse than no data". Only store long-term architecture decisions, project details, and explicit user preferences.
`;

const GENERAL_GUIDE = `# Persyst General Agent Integration Guide

This workspace is configured with the Persyst local-first memory server.

## How to Configure the MCP Server in VS Code / Cursor / Antigravity

Add the following configuration to your IDE's MCP Server settings:

- **Server Name:** \`persyst\`
- **Type:** \`command\`
- **Command:** \`npx\`
- **Arguments:** \`["-y", "persyst-mcp"]\`

Alternatively, if you have installed the package globally (\`npm install -g persyst-mcp\`), you can configure:
- **Command:** \`persyst-mcp\`
- **Arguments:** \`[]\`

---

## Copy-Paste System Prompt Instructions
If your agent does not read \`.cursorrules\` or \`.windsurfrules\` natively, copy and paste the following prompt into the agent's Custom Instructions, System Prompt, or System Rules:

\`\`\`markdown
${RULE_CONTENT.trim()}
\`\`\`
`;

// ============================================================
// HELPERS
// ============================================================

function setupRuleFile(filePath, fileName) {
  let content = RULE_CONTENT;
  let action = 'Created';

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (existing.includes(INSTRUCTION_HEADER)) {
      console.log(`     ℹ️  ${fileName} already has Persyst rules configured (skipped).`);
      return;
    }
    content = existing + '\n' + RULE_CONTENT;
    action = 'Appended to';
  }

  writeFileSync(filePath, content.trim() + '\n', 'utf8');
  console.log(`     ✅ ${action} ${fileName}`);
}

// ============================================================
// MAIN
// ============================================================

function run() {
  console.log('');
  console.log('  🧠 Persyst — Workspace Rules Setup');
  console.log('  ════════════════════════════════════');
  console.log('');

  const cwd = process.cwd();
  console.log(`  📁 Target workspace: ${cwd}`);
  console.log('');

  // 1. Create/Append Cursor Rules
  const cursorRulesPath = join(cwd, '.cursorrules');
  setupRuleFile(cursorRulesPath, '.cursorrules');

  // 2. Create/Append Windsurf Rules
  const windsurfRulesPath = join(cwd, '.windsurfrules');
  setupRuleFile(windsurfRulesPath, '.windsurfrules');

  // 3. Create General Guide File
  const generalGuidePath = join(cwd, '.persystrules.md');
  writeFileSync(generalGuidePath, GENERAL_GUIDE.trim() + '\n', 'utf8');
  console.log('     ✅ Created .persystrules.md (General Guide)');

  // 4. Print Success & Configuration Help
  console.log('');
  console.log('  ════════════════════════════════════');
  console.log('  ✅ Rules initialization complete!');
  console.log('');
  console.log('  To connect the memory server to Cursor, Antigravity, or VS Code:');
  console.log('    1. Open your IDE Settings -> MCP (Model Context Protocol).');
  console.log('    2. Add a new command server:');
  console.log('         • Name:      persyst');
  console.log('         • Command:   npx');
  console.log('         • Arguments: -y persyst-mcp');
  console.log('');
  console.log('  The rules we generated will guide the AI agents in this workspace to:');
  console.log('    • Proactively search memory before answering prompts.');
  console.log('    • Log milestone achievements and user preferences.');
  console.log('    • Keep the memory clean ("no bad data").');
  console.log('');
}

run();
