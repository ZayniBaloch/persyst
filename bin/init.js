#!/usr/bin/env node

/**
 * persyst-init — Workspace rules generator and global IDE configuration builder
 * 
 * Usage:
 *   npx persyst-mcp init
 *   npx persyst-mcp init --mcp cursor,aider
 * 
 * What it does:
 *   1. Safely creates or appends system instructions to `.cursorrules` and `.windsurfrules`
 *   2. Creates a general `.persystrules.md` workspace guide
 *   3. Configures Git post-commit hook for auto-ingestion
 *   4. Generates cryptographic Ed25519 keys inside ~/.persyst
 *   5. Automatically detects and configures global settings for Cursor, Aider, Claude Code, and Continue
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { initializeKeys } from '../src/attestation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_DIR = join(homedir(), '.persyst');
const PERSYST_DB = join(CONFIG_DIR, 'persyst.db');

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
- Provide your agent name (e.g. \`cursor-agent\`, \`roo-code\`) as the \`agent_id\` parameter when searching to query your private namespace + shared project context.

## Proactive Memory Storage (CRITICAL)
- Record Milestones: When you successfully implement a feature, fix a bug, or make an architectural decision, call the \`add_memory\` tool to store a summary of the change.
- Agentic Swarms & Namespaces: If you are part of a multi-agent swarm or need private partition, pass your agent name as \`agent_id\` and set \`shared: false\` to store private memories. For general project guidelines and files, leave \`shared: true\` (default) so other agents can access them.
- Handle Contradictions: Persyst handles contradiction detection automatically. If a new fact contradicts an old memory, Persyst will flag it.
- Quality Over Quantity: Do NOT store trivial facts, temporary conversation noise, or duplicate data. "Bad data is worse than no data". Only store long-term architecture decisions, project details, and explicit user preferences.

## Explicit User Save Requests
- If the user explicitly asks you to remember, save, or keep a note of a fact (e.g., "Remember that John handles deployment", "remind me that staging is flaky"), call the \`add_memory\` tool immediately with that content.
- Bypassing Tech Filters: Explicit user requests bypass the programming keyword filters. Ensure they are captured verbatim.

## Mandatory Completion Checklist (HARD CONSTRAINT)
Before writing your final response declaring a task, feature, or bug fix complete:
1. Ask yourself: "Did I implement a feature, fix a bug, configure a tool, or discover a project rule?"
2. If YES: Call the \`add_memory\` tool to store the milestone as your final tool call *before* writing your final message to the user.
3. If NO: You may proceed to conclude without saving.
Never rely on the user to remind you to save milestones.
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
// WORKSPACE HELPERS
// ============================================================

function setupRuleFile(filePath, fileName) {
  let content = RULE_CONTENT;
  let action = 'Created';

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf8');
    if (existing.includes(INSTRUCTION_HEADER)) {
      console.log(`     [SKIP] ${fileName} already has Persyst rules configured.`);
      return;
    }
    content = existing + '\n' + RULE_CONTENT;
    action = 'Appended to';
  }

  writeFileSync(filePath, content.trim() + '\n', 'utf8');
  console.log(`     [OK] ${action} ${fileName}`);
}

// ============================================================
// GLOBAL CONFIG WRITERS
// ============================================================

function detectEditors() {
  const editors = [];
  const home = homedir();
  
  // Cursor
  const cursorDir = join(home, '.cursor');
  const winCursorDir = join(home, 'AppData', 'Roaming', 'Cursor');
  if (existsSync(cursorDir) || existsSync(winCursorDir) || existsSync('/Applications/Cursor.app') || existsSync(join(home, 'AppData', 'Local', 'Programs', 'cursor'))) {
    editors.push('cursor');
  }
  
  // Aider
  try {
    execSync('aider --version', { stdio: 'ignore' });
    editors.push('aider');
  } catch (_) {}
  
  // Claude Code
  const claudeDir = join(home, '.claude');
  if (existsSync(claudeDir) || existsSync('/Applications/Claude Code.app')) {
    editors.push('claude-code');
  }
  
  // Continue.dev
  const continueConfig = join(home, '.continue', 'config.json');
  if (existsSync(continueConfig)) {
    editors.push('continue');
  }
  
  return editors;
}

function writeCursorConfig(projectName) {
  const cursorMcp = join(homedir(), '.cursor', 'mcp.json');
  try {
    const config = existsSync(cursorMcp) ? JSON.parse(readFileSync(cursorMcp, 'utf8')) : {};
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.persyst = {
      "command": "npx",
      "args": ["-y", "persyst-mcp"],
      "env": {
        "PERSYST_DB": PERSYST_DB,
        "PERSYST_PROJECT": projectName
      }
    };
    mkdirSync(dirname(cursorMcp), { recursive: true });
    writeFileSync(cursorMcp, JSON.stringify(config, null, 2));
    console.log('     [OK] Cursor MCP config written to ~/.cursor/mcp.json');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Cursor: ${err.message}`);
  }
}

function writeAiderConfig(projectName) {
  const aiderYml = join(homedir(), '.aider.conf.yml');
  try {
    let content = '';
    if (existsSync(aiderYml)) {
      content = readFileSync(aiderYml, 'utf8');
    }
    if (!content.includes('persyst')) {
      content += `\n# Persyst MCP integration\nmcp:\n  - name: persyst\n    cmd: npx\n    args: ["-y", "persyst-mcp"]\n    env:\n      PERSYST_DB: ${PERSYST_DB}\n      PERSYST_PROJECT: ${projectName}\n`;
      writeFileSync(aiderYml, content);
      console.log('     [OK] Aider MCP config appended to ~/.aider.conf.yml');
    } else {
      console.log('     [SKIP] Aider already has Persyst configured.');
    }
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Aider: ${err.message}`);
  }
}

function writeClaudeCodeConfig(projectName) {
  const claudeJson = join(homedir(), '.claude.json');
  try {
    const config = existsSync(claudeJson) ? JSON.parse(readFileSync(claudeJson, 'utf8')) : {};
    config.mcpServers = config.mcpServers || {};
    config.mcpServers.persyst = {
      "command": "npx",
      "args": ["-y", "persyst-mcp"],
      "env": {
        "PERSYST_DB": PERSYST_DB,
        "PERSYST_PROJECT": projectName
      }
    };
    writeFileSync(claudeJson, JSON.stringify(config, null, 2));
    console.log('     [OK] Claude Code MCP config written to ~/.claude.json');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Claude Code: ${err.message}`);
  }
}

function writeContinueConfig(projectName) {
  const continueConfig = join(homedir(), '.continue', 'config.json');
  try {
    const config = existsSync(continueConfig) ? JSON.parse(readFileSync(continueConfig, 'utf8')) : {};
    config.mcpServers = config.mcpServers || [];
    // Remove existing persyst entry
    config.mcpServers = config.mcpServers.filter(s => s.name !== 'persyst');
    config.mcpServers.push({
      "name": "persyst",
      "command": "npx",
      "args": ["-y", "persyst-mcp"],
      "env": {
        "PERSYST_DB": PERSYST_DB,
        "PERSYST_PROJECT": projectName
      }
    });
    mkdirSync(dirname(continueConfig), { recursive: true });
    writeFileSync(continueConfig, JSON.stringify(config, null, 2));
    console.log('     [OK] Continue.dev MCP config written to ~/.continue/config.json');
  } catch (err) {
    console.error(`     [ERROR] Failed to configure Continue.dev: ${err.message}`);
  }
}

// ============================================================
// MAIN RUNNER
// ============================================================

function run() {
  console.log('');
  console.log('  Persyst — Workspace & Editor Setup');
  console.log('  ══════════════════════════════════════');
  console.log('');

  const cwd = process.cwd();
  console.log(`  Target workspace: ${cwd}`);

  // 1. Initialize local configuration folder and attestations
  console.log('  [1/4] Initializing keypairs & DB folders...');
  mkdirSync(CONFIG_DIR, { recursive: true });
  initializeKeys();
  console.log('     [OK] Cryptographic keypairs generated');

  // 2. Local workspace configurations
  console.log('');
  console.log('  [2/4] Initializing workspace rule files...');
  
  const cursorRulesPath = join(cwd, '.cursorrules');
  setupRuleFile(cursorRulesPath, '.cursorrules');

  const windsurfRulesPath = join(cwd, '.windsurfrules');
  setupRuleFile(windsurfRulesPath, '.windsurfrules');

  const clineRulesPath = join(cwd, '.clinerules');
  setupRuleFile(clineRulesPath, '.clinerules');

  const generalGuidePath = join(cwd, '.persystrules.md');
  writeFileSync(generalGuidePath, GENERAL_GUIDE.trim() + '\n', 'utf8');
  console.log('     [OK] Created .persystrules.md (General Guide)');

  // 3. Git post-commit hook
  const gitDir = join(cwd, '.git');
  if (existsSync(gitDir)) {
    const hooksDir = join(gitDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
    const postCommitPath = join(hooksDir, 'post-commit');
    const localPersystPath = resolve(__dirname, '..', 'index.js').replace(/\\/g, '/');

    const hookContent = `#!/bin/sh
# Persyst Git Commit Ingestion Hook
# Automatically ingests recent commits into Persyst memory on every commit.

# Local project path fallback for development
LOCAL_PERSYST="${localPersystPath}"

if [ -f "$LOCAL_PERSYST" ]; then
  node "$LOCAL_PERSYST" ingest "$PWD" 5 >/dev/null 2>&1 || true
else
  npx persyst-mcp ingest "$PWD" 5 >/dev/null 2>&1 || true
fi
`;

    writeFileSync(postCommitPath, hookContent, { mode: 0o755 });
    try {
      chmodSync(postCommitPath, 0o755);
    } catch (_) {}
    console.log('     [OK] Configured Git post-commit hook for auto-ingestion');
  }

  // 4. Global editor configurations
  console.log('');
  console.log('  [3/4] Initializing global IDE configurations...');
  
  const args = process.argv.slice(2);
  const mcpFlag = args.find(a => a.startsWith('--mcp='));
  const requestedEditors = mcpFlag ? mcpFlag.split('=')[1].split(',') : [];
  
  const editors = requestedEditors.length > 0 ? requestedEditors : detectEditors();
  console.log(`     Detected editors/environments: ${editors.join(', ') || 'none'}`);

  const projectName = basename(cwd);

  if (editors.includes('cursor')) writeCursorConfig(projectName);
  if (editors.includes('aider')) writeAiderConfig(projectName);
  if (editors.includes('claude-code')) writeClaudeCodeConfig(projectName);
  if (editors.includes('continue')) writeContinueConfig(projectName);

  // 5. Final self-test and notes
  console.log('');
  console.log('  ══════════════════════════════════════');
  console.log('  Setup complete: Persyst is successfully configured.');
  console.log('');
  console.log('  Next steps:');
  console.log('    1. Restart your editor to load the new MCP configurations.');
  console.log('    2. Test gateway connection:');
  console.log('         curl http://127.0.0.1:4321/health');
  console.log('');
}

run();
