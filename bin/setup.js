#!/usr/bin/env node

/**
 * persyst-setup — One-command installer for Persyst Claude Code hooks
 * 
 * Usage:
 *   npx persyst-mcp setup
 * 
 * What it does:
 *   1. Copies persyst-hook.js to ~/.persyst/hooks/
 *   2. Creates or merges ~/.claude/settings.json with hook registrations
 *   3. Prints success message with instructions
 * 
 * Design:
 *   - Non-destructive: merges with existing settings, never overwrites
 *   - Cross-platform: works on Windows, macOS, and Linux
 *   - Idempotent: safe to run multiple times
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// PATHS
// ============================================================

const HOME = homedir();
const PERSYST_DIR = join(HOME, '.persyst');
const PERSYST_HOOKS_DIR = join(PERSYST_DIR, 'hooks');
const HOOK_DEST = join(PERSYST_HOOKS_DIR, 'persyst-hook.js');

const CLAUDE_DIR = join(HOME, '.claude');
const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json');

// Source hook file — shipped with the npm package
const HOOK_SOURCE = resolve(__dirname, '..', 'hooks', 'persyst-hook.js');

// ============================================================
// HOOK CONFIGURATION
// ============================================================

const HOOK_ENTRY = {
  type: 'command',
  command: `node "${HOOK_DEST}"`
};

const HOOK_CONFIG = {
  SessionStart: [
    {
      matcher: '',
      hooks: [{ ...HOOK_ENTRY }]
    }
  ],
  UserPromptSubmit: [
    {
      matcher: '',
      hooks: [{ ...HOOK_ENTRY, timeout: 10 }]
    }
  ]
};

// ============================================================
// HELPERS
// ============================================================

function ensureDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readJsonFile(filePath) {
  try {
    const raw = readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Merge Persyst hook entries into existing settings.
 * Does NOT overwrite existing hooks — appends Persyst entries if not already present.
 */
function mergeHookSettings(existing) {
  const settings = { ...existing };
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [eventName, hookGroups] of Object.entries(HOOK_CONFIG)) {
    if (!settings.hooks[eventName]) {
      settings.hooks[eventName] = [];
    }

    // Check if a Persyst hook is already registered
    const alreadyRegistered = settings.hooks[eventName].some(group =>
      group.hooks && group.hooks.some(h =>
        h.command && h.command.includes('persyst-hook')
      )
    );

    if (!alreadyRegistered) {
      settings.hooks[eventName].push(...hookGroups);
    }
  }

  return settings;
}

// ============================================================
// MAIN
// ============================================================

function run() {
  console.log('');
  console.log('  🧠 Persyst — Claude Code Hook Setup');
  console.log('  ════════════════════════════════════');
  console.log('');

  // Step 1: Verify hook source exists
  if (!existsSync(HOOK_SOURCE)) {
    console.error(`  ❌ Hook source not found at: ${HOOK_SOURCE}`);
    console.error('     Make sure you are running this from the persyst-mcp package.');
    process.exit(1);
  }

  // Step 2: Copy and template hook file to ~/.persyst/hooks/
  console.log('  📁 Installing and templating hook script...');
  ensureDir(PERSYST_HOOKS_DIR);
  const INDEX_PATH = resolve(__dirname, '..', 'index.js');
  const WORKER_PATH = resolve(__dirname, '..', 'bin', 'extract-worker.js');
  let hookContent = readFileSync(HOOK_SOURCE, 'utf8');
  hookContent = hookContent.replace('{{PERSYST_INDEX_PATH}}', INDEX_PATH.replace(/\\/g, '/'));
  hookContent = hookContent.replace('{{PERSYST_WORKER_PATH}}', WORKER_PATH.replace(/\\/g, '/'));
  writeFileSync(HOOK_DEST, hookContent, 'utf8');
  console.log(`     ✅ Copied & templated to ${HOOK_DEST}`);

  // Step 3: Merge into ~/.claude/settings.json
  console.log('');
  console.log('  ⚙️  Configuring Claude Code...');
  ensureDir(CLAUDE_DIR);

  const existingSettings = readJsonFile(CLAUDE_SETTINGS);
  const mergedSettings = mergeHookSettings(existingSettings);

  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(mergedSettings, null, 2) + '\n', 'utf8');
  console.log(`     ✅ Updated ${CLAUDE_SETTINGS}`);

  // Step 4: Print success
  console.log('');
  console.log('  ════════════════════════════════════');
  console.log('  ✅ Setup complete!');
  console.log('');
  console.log('  Persyst will now automatically:');
  console.log('    • Load your stored memories when Claude Code starts');
  console.log('    • Search for relevant context on every prompt');
  console.log('    • Index your git commits into the memory database');
  console.log('');
  console.log('  ⚡ Restart Claude Code to activate the hooks.');
  console.log('');
  console.log('  Memory database: ~/.persyst/persyst.db');
  console.log('  Hook script:     ~/.persyst/hooks/persyst-hook.js');
  console.log('  Claude settings:  ~/.claude/settings.json');
  console.log('');
}

run();
