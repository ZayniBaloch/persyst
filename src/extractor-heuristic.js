/**
 * extractor-heuristic.js — Tier 2: Zero-Cost Regex-Based Fact Extractor
 * 
 * Scans raw conversation text for extractable knowledge signals.
 * 
 * Operates in TWO modes:
 * 
 * 1. EXPLICIT SAVE MODE (highest priority, bypasses all filters)
 *    Triggered when user says: "remember", "save this", "note:", "important:",
 *    "don't forget", "fyi", "keep in mind", "remind me", "make a note"
 *    These always get stored — confidence 0.95. No tech filter applied.
 *    Examples:
 *      "Remember: the staging server is flaky on Mondays"
 *      "Note: John handles DB migrations, don't touch those files"
 *      "Don't forget the SSL cert expires March 15"
 *      "FYI the client doesn't want emojis in any responses"
 * 
 * 2. IMPLICIT PATTERN MODE (normal extraction, requires tech context)
 *    Regex patterns for common developer signal phrases:
 *      "I prefer...", "we decided...", "always use...", "stack includes..."
 *    Conservative: high-precision, low-recall
 *    Filters non-technical content (noise filter)
 * 
 * Design decisions:
 *   - Runs synchronously — zero latency overhead on the hot path
 *   - Returns structured facts with confidence scores (0.0 - 1.0)
 *   - Explicit saves always win — no filter can suppress them
 */

// ============================================================
// EXPLICIT SAVE TRIGGERS
// These phrases indicate the user intentionally wants something saved.
// Order matters — more specific patterns come first.
// ============================================================

const EXPLICIT_SAVE_PATTERNS = [
  // "remember: ..." / "remember that ..." / "remember to ..."
  {
    regex: /\bremember(?:\s*[:–—])?\s+(?:that\s+|to\s+)?(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.95
  },
  // "note: ..." / "note that ..."
  {
    regex: /\bnote(?:\s*[:–—])\s*(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.95
  },
  {
    regex: /\bnote\s+that\s+(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.95
  },
  // "important: ..."
  {
    regex: /\bimportant(?:\s*[:–—])\s*(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.95
  },
  // "fyi: ..." / "fyi, ..."
  {
    regex: /\bfyi(?:\s*[:–—,])?\s*(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.90
  },
  // "don't forget ..."
  {
    regex: /\bdon['']t\s+forget\s+(?:that\s+|to\s+)?(.+?)(?:\.|$)/gi,
    category: 'reminder',
    confidence: 0.90
  },
  // "keep in mind ..."
  {
    regex: /\bkeep\s+in\s+mind\s+(?:that\s+)?(.+?)(?:\.\s*$|$)/gi,
    category: 'note',
    confidence: 0.90
  },
  // "save this: ..." / "save that ..."
  {
    regex: /\bsave\s+(?:this|that|the following)(?:\s*[:–—])?\s*(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.95
  },
  // "remind me ..." / "set a reminder ..."
  {
    regex: /\bremind\s+(?:me\s+)?(?:to\s+|that\s+|about\s+)?(.+?)(?:\.|$)/gi,
    category: 'reminder',
    confidence: 0.90
  },
  // "make a note ..." / "take a note ..."
  {
    regex: /\b(?:make|take)\s+a\s+note(?:\s*[:–—]|s?\s+that\s+|s?\s+about\s+|:?\s+)?(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.90
  },
  // "heads up: ..." / "heads up, ..."
  {
    regex: /\bheads?\s+up(?:\s*[:–—,])?\s*(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.90
  },
  // "warning: ..." (project context, not log output)
  {
    regex: /\bwarning(?:\s*[:–—])\s*(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.85
  },
  // "caution: ..."
  {
    regex: /\bcaution(?:\s*[:–—])\s*(.+?)(?:\.|$)/gi,
    category: 'note',
    confidence: 0.85
  },
  // "the rule is ..." / "our rule is ..."
  {
    regex: /\b(?:the|our)\s+rule\s+is\s+(?:that\s+)?(.+?)(?:\.|$)/gi,
    category: 'rule',
    confidence: 0.90
  }
];

// ============================================================
// IMPLICIT PATTERN DEFINITIONS
// Ordered by specificity — most specific patterns first
// Each pattern: regex, category, confidence, template
// ============================================================

const PATTERNS = [
  // --- Decision patterns (highest confidence) ---
  {
    regex: /(?:we|i|the team)\s+(?:have\s+)?decided\s+(?:to\s+)?(?:use|go\s+with|adopt|switch\s+to|move\s+to)\s+(.+?)(?:\.|$)/gi,
    category: 'decision',
    confidence: 0.85,
    template: (match) => `Decision: ${cleanFact(match[1])}`
  },
  {
    regex: /(?:we(?:'re|\s+are)?\s+)?(?:going|moving)\s+(?:to\s+)?(?:use|adopt|switch\s+to|migrate\s+to)\s+(.+?)(?:\s+(?:for|because|since|as)\b|\.|$)/gi,
    category: 'decision',
    confidence: 0.80,
    template: (match) => `Decision: Moving to ${cleanFact(match[1])}`
  },

  // --- Explicit preference patterns ---
  {
    regex: /i\s+(?:always\s+)?prefer\s+(.+?)(?:\s+(?:over|instead\s+of|rather\s+than)\s+(.+?))?(?:\.|$)/gi,
    category: 'preference',
    confidence: 0.80,
    template: (match) => {
      const pref = cleanFact(match[1]);
      const alt = match[2] ? ` over ${cleanFact(match[2])}` : '';
      return `Preference: ${pref}${alt}`;
    }
  },
  {
    regex: /(?:we|i)\s+(?:should\s+)?(?:always|never)\s+(?:use|avoid|include|add|write|create)\s+(.+?)(?:\.|$)/gi,
    category: 'preference',
    confidence: 0.75,
    template: (match) => `Rule: ${cleanFact(match[0])}`
  },

  // --- Stack / technology patterns ---
  {
    regex: /(?:our|the|my)\s+(?:tech\s+)?stack\s+(?:includes?|uses?|is|has)\s+(.+?)(?:\.\s|\.$|$)/gim,
    category: 'stack',
    confidence: 0.85,
    template: (match) => `Stack: ${cleanFact(match[1])}`
  },
  {
    regex: /(?:we(?:'re|\s+are)?\s+)?using\s+(.+?)\s+(?:for|as)\s+(?:our|the)\s+(.+?)(?:\.|$)/gi,
    category: 'stack',
    confidence: 0.80,
    template: (match) => `Stack: Using ${cleanFact(match[1])} for ${cleanFact(match[2])}`
  },
  {
    regex: /(?:our|the)\s+(?:backend|frontend|database|api|server|client|infra(?:structure)?)\s+(?:is|uses?|runs?\s+on)\s+(.+?)(?:\.|$)/gi,
    category: 'stack',
    confidence: 0.80,
    template: (match) => `Stack: ${cleanFact(match[0])}`
  },

  // --- Naming / convention patterns ---
  {
    regex: /(?:name|call|rename)\s+(?:it|this|the\s+\w+)\s+[\"'`]?(\w[\w\-\.]+)[\"'`]?/gi,
    category: 'naming',
    confidence: 0.70,
    template: (match) => `Naming: ${cleanFact(match[0])}`
  },

  // --- Architecture patterns ---
  {
    regex: /(?:the\s+)?(?:project|app|application|system|architecture)\s+(?:follows?|uses?|is\s+based\s+on|implements?)\s+(.+?)(?:\s+pattern|\s+architecture)?(?:\.|$)/gi,
    category: 'architecture',
    confidence: 0.80,
    template: (match) => `Architecture: ${cleanFact(match[1])}`
  },

  // --- Coding rule / style patterns ---
  {
    regex: /(?:always|never|must|should|don't|do\s+not)\s+(?:use|write|create|add|include|put|place|keep)\s+(.+?)(?:\.|$)/gi,
    category: 'rule',
    confidence: 0.70,
    template: (match) => `Rule: ${cleanFact(match[0])}`
  },

  // --- Config / env patterns ---
  {
    regex: /(?:set|change|update|configure)\s+(?:the\s+)?(?:port|host|env|environment|config|setting)\s+(?:to|=|:)\s*[\"'`]?(.+?)[\"'`]?(?:\.|$)/gi,
    category: 'config',
    confidence: 0.75,
    template: (match) => `Config: ${cleanFact(match[0])}`
  }
];

// ============================================================
// NOISE FILTERS
// Skip lines that look like code, errors, or system output
// ============================================================

const NOISE_PATTERNS = [
  /^[\s]*(?:import|export|const|let|var|function|class|if|else|for|while|return|throw|try|catch)\s/,
  /^[\s]*[{}\[\]();]/,
  /^[\s]*\/\//,
  /^[\s]*\*/,
  /^[\s]*```/,
  /^\s*$/,
  /^(?:error|warning|info|debug|trace):/i,
  /^\s*at\s+\w+/,           // stack trace lines
  /^[A-Z_]{2,}=/,           // ENV variable assignments
  /^\d{4}-\d{2}-\d{2}/,     // timestamp lines
];

/**
 * Check if a line looks like noise (code, logs, etc.)
 * @param {string} line
 * @returns {boolean}
 */
function isNoiseLine(line) {
  return NOISE_PATTERNS.some(p => p.test(line));
}

// ============================================================
// FACT NORMALIZATION & COGNITIVE FILTER
// ============================================================

/**
 * Clean and normalize an extracted fact string.
 * Removes trailing punctuation, excess whitespace, and truncates.
 * @param {string} raw
 * @returns {string}
 */
function cleanFact(raw) {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/[\s]+/g, ' ')        // collapse whitespace
    .replace(/[,;:]+$/, '')        // strip trailing punctuation
    .replace(/^["'`]+|["'`]+$/g, '') // strip quotes
    .slice(0, 200);                // hard max fact length
}

// List of programming/tech concepts to distinguish tech context from conversational filler
const TECH_CONCEPTS = [
  'mode', 'theme', 'config', 'stack', 'style', 'code', 'file', 'folder', 'path',
  'api', 'endpoint', 'json', 'data', 'db', 'database', 'table', 'migration',
  'schema', 'sql', 'query', 'url', 'port', 'host', 'env', 'environment',
  'node', 'npm', 'git', 'react', 'vue', 'angular', 'svelte', 'next', 'express',
  'postgres', 'sqlite', 'mongo', 'mysql', 'docker', 'ubuntu', 'linux', 'server',
  'pipeline', 'ci', 'cd', 'github', 'actions', 'oauth', 'auth', 'security',
  'token', 'key', 'credential', 'package', 'dependency', 'library', 'script',
  'test', 'jest', 'vitest', 'eslint', 'prettier', 'tailwind', 'css', 'html',
  'js', 'ts', 'typescript', 'javascript', 'eval', 'function', 'class', 'component',
  'import', 'export', 'require', 'const', 'let', 'var', 'compiler', 'build',
  'cli', 'command', 'terminal', 'mcp', 'server', 'client', 'persyst', 'memory'
];

/**
 * Filter out conversational filler and keep only valid technical statements/preferences.
 * NOTE: This filter is ONLY applied to implicit pattern matches, NOT to explicit saves.
 * @param {string} content - The extracted fact text
 * @returns {boolean} - true if it is a valid, high-value fact
 */
function cognitiveNoiseFilter(content) {
  const normalized = content.toLowerCase().trim();

  // 1. Filter out interrogatives (questions)
  const questionWords = ['how', 'why', 'what', 'where', 'when', 'who', 'can', 'could', 'would', 'is', 'are', 'should'];
  if (normalized.endsWith('?')) return false;
  for (const q of questionWords) {
    if (normalized.startsWith(q + ' ') || normalized.includes(` ${q} `) || normalized.includes(`:${q} `)) {
      if (normalized.includes(' ?') || normalized.endsWith('?')) return false;
      if (/preference:\s+(?:can|could|would|is|are|how|why|what|where)\s/i.test(content)) return false;
      if (/rule:\s+(?:can|could|would|is|are|how|why|what|where)\s/i.test(content)) return false;
      if (/decision:\s+(?:can|could|would|is|are|how|why|what|where)\s/i.test(content)) return false;
    }
  }

  // 2. Filter out transient pronouns/vague statements without enough context
  if (/preference:\s+(?:this|that|it|these|those|us|me|them|him|her)\b/i.test(content)) return false;
  if (/decision:\s+(?:this|that|it|these|those|us|me|them|him|her)\b/i.test(content)) return false;

  // 3. Filter out transient time references indicating very short-term state
  const transientTerms = ['today', 'tomorrow', 'yesterday', 'now', 'just', 'temporary', 'currently', 'for now', 'briefly', 'at the moment'];
  for (const term of transientTerms) {
    if (normalized.includes(` ${term} `) || normalized.endsWith(` ${term}`)) {
      return false;
    }
  }

  // 4. Filter out trace logs, build outputs, compile errors
  if (normalized.includes('at ') && normalized.includes('.js:')) return false;
  if (normalized.includes('error:') || normalized.includes('exception:')) return false;
  if (normalized.includes('exit code') || normalized.includes('npm error')) return false;

  // 5. Require at least one programming/project-related concept
  const words = normalized.split(/[^a-zA-Z0-9\-\.\/]+/);
  const hasTechTerm = words.some(w => {
    return TECH_CONCEPTS.some(concept => {
      if (concept.length <= 2) {
        return w === concept;
      }
      return w.includes(concept);
    }) ||
    w.endsWith('.js') || w.endsWith('.json') || w.endsWith('.css') || w.endsWith('.md') ||
    w.includes('/') || w.includes('\\');
  });
  
  if (!hasTechTerm) {
    return false;
  }

  return true;
}

// ============================================================
// EXPLICIT SAVE EXTRACTION
// Runs first. Bypasses all noise filters. 
// The user said "remember this" — we save it, period.
// ============================================================

/**
 * Extract explicitly-commanded saves from text.
 * User phrases like "remember:", "note:", "don't forget" always get stored.
 * No tech concept filter. No question filter. Confidence: 0.90–0.95.
 * 
 * @param {string} text
 * @returns {Array<{content: string, category: string, confidence: number, explicit: true}>}
 */
function extractExplicitSaves(text) {
  const results = [];
  const seen = new Set();

  for (const pattern of EXPLICIT_SAVE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match;
    while ((match = pattern.regex.exec(text)) !== null) {
      const raw = match[1] || match[0];
      const cleaned = cleanFact(raw);

      // Minimum useful length
      if (!cleaned || cleaned.length < 8) continue;

      // Skip pure questions
      if (cleaned.endsWith('?')) continue;

      // Skip if this is just a meta-instruction to the system itself ("remember to search memories")
      const metaWords = ['search_memories', 'add_memory', 'get_optimized_context', 'persyst tool'];
      if (metaWords.some(w => cleaned.toLowerCase().includes(w))) continue;

      const key = cleaned.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);

      // Format the content with a Note:/Reminder: prefix if not already prefixed
      let content = cleaned;
      if (!/^(?:Note|Reminder|Rule|Important|Warning|Caution|FYI):/i.test(cleaned)) {
        const prefix = pattern.category === 'reminder' ? 'Reminder' : 'Note';
        content = `${prefix}: ${cleaned}`;
      }

      results.push({
        content,
        category: pattern.category,
        confidence: pattern.confidence,
        explicit: true  // Mark as user-commanded — bypasses any downstream filters
      });
    }
  }

  return results;
}

// ============================================================
// MAIN EXTRACTION FUNCTION
// ============================================================

/**
 * Extract facts from raw conversation text using regex heuristics.
 * 
 * Runs in priority order:
 *   1. Explicit saves ("remember:", "note:", "don't forget") — always stored
 *   2. Implicit patterns (tech decisions, preferences, rules) — filtered
 * 
 * @param {string} text - Raw conversation text (user prompt or full turn)
 * @param {Object} [options={}]
 * @param {number} [options.minConfidence=0.65] - Minimum confidence to include a fact
 * @param {number} [options.maxFacts=15] - Maximum facts to extract per call
 * @returns {Array<{content: string, category: string, confidence: number, explicit?: boolean}>}
 * 
 * @example
 *   // Explicit save — bypasses all filters
 *   extractHeuristic("Remember: the staging server is flaky on Mondays")
 *   // => [{ content: "Note: the staging server is flaky on Mondays", category: "note", confidence: 0.95, explicit: true }]
 * 
 *   // Implicit pattern — goes through noise filter
 *   extractHeuristic("I prefer Postgres over SQLite for our backend database.")
 *   // => [{ content: "Preference: Postgres over SQLite", category: "preference", confidence: 0.80 }]
 */
export function extractHeuristic(text, options = {}) {
  const {
    minConfidence = 0.65,
    maxFacts = 15
  } = options;

  if (!text || typeof text !== 'string' || text.length < 10) {
    return [];
  }

  // Strip all markdown fenced code blocks to prevent extracting facts from example code/logs
  const cleanSourceText = text.replace(/```[\s\S]*?```/g, '');

  // --- Step 1: Explicit saves (highest priority, no filter) ---
  const explicitFacts = extractExplicitSaves(cleanSourceText);

  // --- Step 2: Implicit pattern matching (filtered, tech-required) ---
  const implicitFacts = [];
  const seen = new Set(explicitFacts.map(f => f.content.toLowerCase().replace(/\s+/g, ' ').trim()));

  // Process line-by-line to filter code/noise
  const lines = cleanSourceText.split('\n');
  const cleanLines = lines.filter(line => !isNoiseLine(line));
  const cleanText = cleanLines.join('\n');

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;

    let match;
    while ((match = pattern.regex.exec(cleanText)) !== null) {
      if (match[0].length < 8) continue;

      try {
        const content = pattern.template(match);
        if (!content || content.length < 5) continue;

        if (!cognitiveNoiseFilter(content)) continue;

        const key = content.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(key)) continue;
        seen.add(key);

        if (pattern.confidence >= minConfidence) {
          implicitFacts.push({
            content,
            category: pattern.category,
            confidence: pattern.confidence
          });
        }

        if (explicitFacts.length + implicitFacts.length >= maxFacts) break;
      } catch (_) {
        continue;
      }
    }

    if (explicitFacts.length + implicitFacts.length >= maxFacts) break;
  }

  // Explicit facts first (user-commanded), then implicit sorted by confidence
  implicitFacts.sort((a, b) => b.confidence - a.confidence);
  return [...explicitFacts, ...implicitFacts];
}

/**
 * Quick check: does this text contain any extractable signals?
 * Cheaper than running full extraction — use as a gate.
 * 
 * @param {string} text
 * @returns {boolean}
 */
export function hasExtractableSignals(text) {
  if (!text || text.length < 10) return false;

  // Check explicit save triggers first (very cheap)
  for (const pattern of EXPLICIT_SAVE_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }

  // Then implicit patterns
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }

  return false;
}
