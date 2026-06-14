/**
 * extractor-heuristic.js — Tier 2: Zero-Cost Regex-Based Fact Extractor
 * 
 * Scans raw conversation text for explicit developer preference signals:
 *   "I prefer...", "we decided...", "always use...", "stack includes..."
 * 
 * Design decisions:
 *   - Runs synchronously — zero latency overhead on the hot path
 *   - Conservative extraction: high-precision, low-recall
 *   - Returns structured facts with confidence scores (0.0 - 1.0)
 *   - Deduplication-ready: facts are normalized before output
 * 
 * This is NOT the primary extraction tier. It's a lightweight safety net
 * that catches the most obvious signals when Tier 3 (LLM) is unavailable
 * or still processing asynchronously.
 */

// ============================================================
// PATTERN DEFINITIONS
// Ordered by specificity — most specific patterns first
// Each pattern has: regex, category, confidence, and a template
// to normalize the matched text into a clean fact statement.
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
    regex: /(?:name|call|rename)\s+(?:it|this|the\s+\w+)\s+["'`]?(\w[\w\-\.]+)["'`]?/gi,
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
    regex: /(?:set|change|update|configure)\s+(?:the\s+)?(?:port|host|env|environment|config|setting)\s+(?:to|=|:)\s*["'`]?(.+?)["'`]?(?:\.|$)/gi,
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
// FACT NORMALIZATION
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

// ============================================================
// MAIN EXTRACTION FUNCTION
// ============================================================

/**
 * Extract facts from raw conversation text using regex heuristics.
 * 
 * @param {string} text - Raw conversation text (user prompt or full turn)
 * @param {Object} [options={}]
 * @param {number} [options.minConfidence=0.65] - Minimum confidence to include a fact
 * @param {number} [options.maxFacts=10] - Maximum facts to extract per call
 * @returns {Array<{content: string, category: string, confidence: number}>}
 * 
 * @example
 *   const facts = extractHeuristic("I prefer Postgres over SQLite for our backend database.");
 *   // => [{ content: "Preference: Postgres over SQLite", category: "preference", confidence: 0.80 }]
 */
export function extractHeuristic(text, options = {}) {
  const {
    minConfidence = 0.65,
    maxFacts = 10
  } = options;

  if (!text || typeof text !== 'string' || text.length < 10) {
    return [];
  }

  const facts = [];
  const seen = new Set(); // dedup by normalized content

  // Process line-by-line to filter noise
  const lines = text.split('\n');
  const cleanLines = lines.filter(line => !isNoiseLine(line));
  const cleanText = cleanLines.join('\n');

  for (const pattern of PATTERNS) {
    // Reset regex state for global matching
    pattern.regex.lastIndex = 0;

    let match;
    while ((match = pattern.regex.exec(cleanText)) !== null) {
      // Skip matches that are too short to be meaningful
      if (match[0].length < 8) continue;

      try {
        const content = pattern.template(match);
        if (!content || content.length < 5) continue;

        // Normalize for dedup
        const key = content.toLowerCase().replace(/\s+/g, ' ').trim();
        if (seen.has(key)) continue;
        seen.add(key);

        if (pattern.confidence >= minConfidence) {
          facts.push({
            content,
            category: pattern.category,
            confidence: pattern.confidence
          });
        }

        if (facts.length >= maxFacts) break;
      } catch (_) {
        // Template execution failed — skip this match
        continue;
      }
    }

    if (facts.length >= maxFacts) break;
  }

  // Sort by confidence descending
  facts.sort((a, b) => b.confidence - a.confidence);

  return facts;
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

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) return true;
  }
  return false;
}
