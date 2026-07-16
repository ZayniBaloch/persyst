#!/usr/bin/env node

/**
 * persyst-monitor — Real-Time Terminal Activity Monitor
 *
 * Connects to the Persyst HTTP gateway (default: http://127.0.0.1:4321) and
 * streams all memory events live to your terminal. Also polls /health and
 * /stats every 10 seconds to show a running context snapshot.
 *
 * Usage:
 *   npx persyst-mcp monitor
 *   node bin/monitor.js
 *   node bin/monitor.js --port 4321
 *   node bin/monitor.js --context          (snapshot only, no event stream)
 *
 * Requirements:
 *   - Persyst server must be running (npx persyst-mcp OR node index.js)
 *   - Server gateway port 4321 must be accessible (http://127.0.0.1:4321)
 */

import http from 'http';

// ============================================================
// CONFIG
// ============================================================

const args = process.argv.slice(2);
const PORT_ARG = args.find(a => a.startsWith('--port='))?.split('=')[1]
  || (args.indexOf('--port') !== -1 ? args[args.indexOf('--port') + 1] : null);
const PORT     = parseInt(PORT_ARG || process.env.PORT || '4321', 10);
const HOST     = process.env.PERSYST_HOST || '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;
const CONTEXT_ONLY = args.includes('--context');

// ============================================================
// TERMINAL UTILITIES (No external deps — raw ANSI)
// ============================================================

const ANSI = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
};

function c(ansi, text) { return `${ansi}${text}${ANSI.reset}`; }
function bold(t)    { return c(ANSI.bold, t); }
function dim(t)     { return c(ANSI.dim, t); }
function green(t)   { return c(ANSI.green, t); }
function yellow(t)  { return c(ANSI.yellow, t); }
function cyan(t)    { return c(ANSI.cyan, t); }
function red(t)     { return c(ANSI.red, t); }
function magenta(t) { return c(ANSI.magenta, t); }
function blue(t)    { return c(ANSI.blue, t); }
function white(t)   { return c(ANSI.white, t); }

function hr(char = '-', width = 72) {
  return dim(char.repeat(width));
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', {
    hour12:  false,
    hour:    '2-digit',
    minute:  '2-digit',
    second:  '2-digit'
  });
}

function isoNow() {
  return new Date().toLocaleString('en-US', { hour12: false }).replace(',', '');
}

function truncate(str, maxLen = 80) {
  if (!str) return '';
  const clean = str.replace(/\n/g, ' ').trim();
  return clean.length > maxLen ? clean.slice(0, maxLen - 3) + '...' : clean;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ============================================================
// HTTP HELPERS
// ============================================================

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${BASE_URL}${path}`, { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Invalid JSON from ${path}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.on('error', reject);
  });
}

// ============================================================
// SESSION COUNTERS
// ============================================================

const session = {
  saved:        0,
  retrieved:    0,
  deleted:      0,
  updated:      0,
  consolidated: 0,
  watcher:      0,
  startTime:    Date.now(),
  connected:    false,
};

// ============================================================
// BANNER
// ============================================================

function printBanner(health) {
  const version  = health?.version || '2.x';
  const memories = health?.memories ?? '?';

  console.log('');
  console.log(bold(cyan('  ======================================================================')));
  console.log(bold(cyan('    PERSYST LIVE ACTIVITY MONITOR')));
  console.log(dim(`    v${version}  |  ${BASE_URL}  |  ${isoNow()}`));
  console.log(bold(cyan('  ======================================================================')));
  console.log('');
  console.log(`  ${bold('Gateway:')}   ${cyan(BASE_URL)}`);
  console.log(`  ${bold('Memories:')} ${bold(green(String(memories)))} active records in database`);
  console.log('');
  console.log(hr('='));
  console.log('');
}

// ============================================================
// STATS PANEL
// ============================================================

function printStatsPanel(health, stats) {
  const uptime   = health?.uptime_seconds ?? 0;
  const memories = health?.memories ?? 0;
  const sseConns = health?.sse_clients ?? 0;
  const elapsed  = Math.floor((Date.now() - session.startTime) / 1000);

  // Use exact stats from /stats endpoint if available
  const content    = stats?.content;
  const totalChars = content?.total_chars ?? null;
  const rawTokens  = content?.raw_tokens_exact ?? null;   // chars / 4 — exact, not estimated
  const avgChars   = content?.avg_chars ?? null;

  const namespaces = stats?.namespaces || [];
  const agents     = stats?.agents     || [];

  console.log('');
  console.log(hr('='));
  console.log(`  ${bold(cyan('LIVE STATS'))}  ${dim('[' + timestamp() + ']')}`);
  console.log(hr('='));

  // Context metrics — exact where available
  console.log(`  ${bold('Active Memories:')}      ${bold(green(String(memories)))}`);

  if (rawTokens !== null) {
    console.log(`  ${bold('Total Content Size:')}   ${totalChars.toLocaleString()} chars`);
    console.log(`  ${bold('Raw Tokens (exact):')}   ${bold(rawTokens.toLocaleString())}  ${dim('(SUM(LENGTH(content)) / 4)')}`);
    if (avgChars !== null) {
      console.log(`  ${bold('Avg Memory Length:')}    ${avgChars} chars  ${dim('(~' + Math.ceil(avgChars / 4) + ' tokens)')}`);
    }
  } else {
    console.log(`  ${bold('Token Stats:')}          ${dim('(server not exposing content stats yet)')}`);
  }

  console.log(`  ${bold('Server Uptime:')}         ${formatUptime(uptime)}`);
  console.log(`  ${bold('SSE Subscribers:')}       ${sseConns}`);

  // Namespace breakdown — with exact chars
  if (namespaces.length > 0) {
    console.log('');
    console.log(`  ${bold('Namespace Breakdown:')}`);
    const totalNsChars = namespaces.reduce((sum, ns) => sum + (ns.total_chars || 0), 0) || 1;
    for (const ns of namespaces) {
      const nsChars  = ns.total_chars ?? 0;
      const nsToks   = ns.raw_tokens_exact ?? Math.ceil(nsChars / 4);
      const nsCount  = ns.count ?? 0;
      const pct      = Math.max(1, Math.round((nsChars / totalNsChars) * 20));
      const bar      = '#'.repeat(pct);
      const name     = (ns.namespace || 'shared').padEnd(30);
      console.log(
        `    ${cyan(name)}  ${green(bar.padEnd(20))}  ${bold(String(nsCount))} memories` +
        `  |  ${nsToks.toLocaleString()} tokens`
      );
    }
  }

  // Agent reputation ledger
  if (agents.length > 0) {
    console.log('');
    console.log(`  ${bold('Agent Reputation Ledger:')}`);
    console.log(`    ${'Agent ID'.padEnd(32)} ${'Created'.padEnd(10)} ${'Confirmed'.padEnd(12)} ${'Contradicted'.padEnd(14)} Trust`);
    console.log(`    ${dim('-'.repeat(72))}`);
    for (const a of agents.slice(0, 6)) {
      const score    = parseFloat(a.reputation_score).toFixed(2);
      const scoreCol = parseFloat(score) >= 0.9 ? green : parseFloat(score) >= 0.7 ? yellow : red;
      console.log(
        `    ${(a.agent_id || 'unknown').padEnd(32)}` +
        ` ${String(a.memories_created).padEnd(10)}` +
        ` ${String(a.memories_confirmed).padEnd(12)}` +
        ` ${String(a.memories_contradicted).padEnd(14)}` +
        ` ${scoreCol(score)}`
      );
    }
  }

  // Session summary
  console.log('');
  console.log(`  ${bold('Session Activity:')}   ${dim('(' + formatUptime(elapsed) + ' monitoring)')}`);
  console.log(
    `    ${green('[SAVED]')}    ${bold(String(session.saved).padEnd(6))}` +
    `  ${cyan('[RETRIEVED]')} ${bold(String(session.retrieved).padEnd(6))}` +
    `  ${yellow('[UPDATED]')} ${bold(String(session.updated).padEnd(6))}` +
    `  ${red('[DELETED]')}  ${bold(String(session.deleted).padEnd(6))}` +
    `  ${magenta('[WATCHER]')} ${bold(String(session.watcher))}` +
    `  ${blue('[MERGED]')} ${bold(String(session.consolidated))}`
  );

  console.log(hr('='));
  console.log('');
}


// ============================================================
// EVENT PRINTERS
// ============================================================

function printMemorySaved(data) {
  session.saved++;
  const isWatcher = (data.source || '').startsWith('watcher');
  if (isWatcher) session.watcher++;

  const tag     = isWatcher
    ? bold(magenta('[WATCHER AUTO-SAVE]'))
    : bold(green('[MEMORY SAVED]     '));
  const ns      = data.namespace || 'shared';
  const source  = data.source || 'unknown';
  const estTok  = data.content ? Math.ceil(data.content.length / 4) : 0;

  console.log(`  ${tag}  ${dim(timestamp())}`);
  console.log(`    ${bold('Memory ID:')}    #${data.id}`);
  console.log(`    ${bold('Source:')}       ${cyan(source)}`);
  console.log(`    ${bold('Namespace:')}    ${ns}`);
  if (data.content) {
    console.log(`    ${bold('Content:')}      ${dim(truncate(data.content, 90))}`);
    console.log(`    ${bold('Est. Tokens:')} ~${estTok}`);
  }
  console.log(hr('-', 60));
}

function printMemoryDeleted(data) {
  session.deleted++;
  console.log(`  ${bold(red('[MEMORY DELETED]   '))}  ${dim(timestamp())}`);
  console.log(`    ${bold('Memory ID:')}    #${data.id}`);
  console.log(`    ${bold('Namespace:')}    ${data.namespace || 'shared'}`);
  console.log(hr('-', 60));
}

function printMemoryRetrieved(data) {
  session.retrieved++;
  const tool      = data.tool || 'unknown';
  const agent     = data.agent_id || 'unknown';
  const count     = data.count ?? 0;
  const query     = data.query || '';
  const ns        = data.namespace || 'shared';
  const ids       = Array.isArray(data.memory_ids) ? data.memory_ids.join(', #') : '';
  const hasBudget = data.token_budget !== undefined;

  console.log(`  ${bold(cyan('[MEMORY RETRIEVED]  '))}  ${dim(timestamp())}`);
  console.log(`    ${bold('Tool:')}         ${cyan(tool)}`);
  console.log(`    ${bold('Agent:')}        ${agent}`);
  console.log(`    ${bold('Query:')}        ${dim(truncate(query, 70))}`);
  console.log(`    ${bold('Results:')}      ${bold(green(String(count)))} memories injected`);
  if (ids) {
    console.log(`    ${bold('Memory IDs:')}   #${ids}`);
  }
  console.log(`    ${bold('Namespace:')}    ${ns}`);
  if (hasBudget) {
    console.log(`    ${bold('Token Budget:')} ${data.token_budget.toLocaleString()}`);
  }
  console.log(hr('-', 60));
}

function printMemoryUpdated(data) {
  session.updated++;
  console.log(`  ${bold(yellow('[MEMORY UPDATED]   '))}  ${dim(timestamp())}`);
  console.log(`    ${bold('Old ID:')}       #${data.old_id}  ->  New ID: #${data.new_id}`);
  console.log(`    ${bold('Namespace:')}    ${data.namespace || 'shared'}`);
  console.log(hr('-', 60));
}

function printConsolidated(data) {
  session.consolidated++;
  console.log(`  ${bold(blue('[CONSOLIDATION]    '))}  ${dim(timestamp())}`);
  console.log(`    ${bold('Groups merged:')}  ${data.consolidated_groups ?? '?'}`);
  if (data.details) {
    console.log(`    ${bold('Details:')}        ${dim(truncate(JSON.stringify(data.details), 80))}`);
  }
  console.log(hr('-', 60));
}

// ============================================================
// SSE PARSER (raw http — no third-party dependency needed)
// ============================================================

function connectSSE(onEvent, onError, onConnected) {
  const req = http.get({
    hostname: HOST,
    port:     PORT,
    path:     '/events',
    headers:  { 'Accept': 'text/event-stream', 'Cache-Control': 'no-cache' }
  }, (res) => {
    if (res.statusCode !== 200) {
      onError(new Error(`SSE returned HTTP ${res.statusCode}`));
      return;
    }

    onConnected();

    let buffer = '';
    let curEvent = '';
    let curData  = '';

    res.setEncoding('utf8');
    res.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const t = line.trimEnd();
        if (t === '') {
          // dispatch
          if (curData) onEvent(curEvent || 'message', curData);
          curEvent = '';
          curData  = '';
        } else if (t.startsWith('event:')) {
          curEvent = t.slice(6).trim();
        } else if (t.startsWith('data:')) {
          curData = t.slice(5).trim();
        }
      }
    });

    res.on('end', () => onError(new Error('SSE stream closed by server')));
    res.on('error', onError);
  });

  req.on('error', onError);
  req.setTimeout(0); // no timeout — persistent connection
  return req;
}

// ============================================================
// STATS POLLER
// ============================================================

async function pollStats() {
  try {
    const [health, stats] = await Promise.all([get('/health'), get('/stats')]);
    printStatsPanel(health, stats);
  } catch (err) {
    console.log(`  ${bold(yellow('[WARN]'))} Stats poll failed: ${dim(err.message)}`);
  }
}

// ============================================================
// CONTEXT SNAPSHOT MODE (--context flag)
// ============================================================

async function runContextSnapshot() {
  console.log('');
  console.log(bold(cyan('  PERSYST CONTEXT SNAPSHOT')));
  console.log(hr('='));
  try {
    const [health, stats] = await Promise.all([get('/health'), get('/stats')]);
    printStatsPanel(health, stats);
  } catch (err) {
    console.log(`  ${red('[ERROR]')} Cannot reach Persyst server at ${BASE_URL}`);
    console.log(`  ${dim('Make sure persyst-mcp is running: npx persyst-mcp')}`);
    console.log(`  ${dim('Error: ' + err.message)}`);
    process.exit(1);
  }
  process.exit(0);
}

// ============================================================
// RECONNECT LOGIC
// ============================================================

let reconnectDelay = 2000;
let statsInterval  = null;

function reconnect() {
  session.connected = false;
  if (statsInterval) { clearInterval(statsInterval); statsInterval = null; }
  reconnectDelay = Math.min(reconnectDelay * 1.5, 30000);
  const delaySec = Math.round(reconnectDelay / 1000);
  console.log(`  ${yellow('[RECONNECT]')} Retrying in ${delaySec}s...`);
  setTimeout(startMonitor, reconnectDelay);
}

function startMonitor() {
  connectSSE(
    // onEvent
    (eventName, rawData) => {
      let data = {};
      try { data = JSON.parse(rawData); } catch (_) {}

      switch (eventName) {
        case 'connected':       break; // handled in onConnected
        case 'memory_added':    printMemorySaved(data);      break;
        case 'memory_retrieved': printMemoryRetrieved(data); break;
        case 'memory_deleted':  printMemoryDeleted(data);    break;
        case 'memory_updated':  printMemoryUpdated(data);    break;
        case 'memories_consolidated': printConsolidated(data); break;
        default:
          if (eventName !== 'message') {
            console.log(`  ${dim('[EVENT]')} ${eventName}: ${dim(truncate(rawData, 60))}`);
          }
      }
    },

    // onError
    (err) => {
      console.log('');
      console.log(`  ${red('[DISCONNECTED]')} ${err.message}`);
      reconnect();
    },

    // onConnected
    async () => {
      reconnectDelay = 2000;
      session.connected = true;

      let health = null;
      try { health = await get('/health'); } catch (_) {}
      printBanner(health);

      await pollStats();

      if (statsInterval) clearInterval(statsInterval);
      statsInterval = setInterval(pollStats, 10000);

      console.log(`  ${dim('Listening for real-time events... Press Ctrl+C to stop')}`);
      console.log('');
    }
  );
}

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

process.on('SIGINT', () => {
  const elapsed = Math.floor((Date.now() - session.startTime) / 1000);
  console.log('');
  console.log(hr('='));
  console.log(`  ${bold(cyan('MONITOR SESSION SUMMARY'))}`);
  console.log(`  Session duration:    ${formatUptime(elapsed)}`);
  console.log(`  Memories saved:      ${bold(String(session.saved))}`);
  console.log(`  Memories retrieved:  ${bold(String(session.retrieved))}`);
  console.log(`  Memories updated:    ${bold(String(session.updated))}`);
  console.log(`  Memories deleted:    ${bold(String(session.deleted))}`);
  console.log(`  Watcher captures:    ${bold(String(session.watcher))}`);
  console.log(`  Consolidations:      ${bold(String(session.consolidated))}`);
  console.log(hr('='));
  console.log('');
  if (statsInterval) clearInterval(statsInterval);
  process.exit(0);
});

// ============================================================
// ENTRY POINT
// ============================================================

async function main() {
  console.log('');
  console.log(`  ${bold('Persyst Monitor')} — connecting to ${cyan(BASE_URL)}...`);

  if (CONTEXT_ONLY) {
    await runContextSnapshot();
    return;
  }

  // Verify server is reachable before entering SSE loop
  try {
    await get('/health');
  } catch (err) {
    console.log('');
    console.log(`  ${red('[ERROR]')} Cannot reach Persyst server at ${cyan(BASE_URL)}`);
    console.log('');
    console.log(`  ${bold('Start the server first:')}`);
    console.log(`    npx persyst-mcp`);
    console.log(`    node index.js`);
    console.log('');
    console.log(`  ${dim('Error: ' + err.message)}`);
    console.log('');
    process.exit(1);
  }

  startMonitor();
}

main();
