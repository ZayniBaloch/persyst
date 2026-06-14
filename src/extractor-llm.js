/**
 * extractor-llm.js — Tier 3: Asynchronous LLM-Based Fact Extraction
 * 
 * Parses conversation turns through a local LLM (Ollama) or cheap cloud
 * fallback (Gemini Flash, GPT-4o-mini, Claude Haiku) to extract structured
 * developer facts, preferences, and architectural decisions.
 * 
 * Design decisions:
 *   - Default model: llama3.2:3b (fast on CPU, excellent at JSON)
 *   - Ollama-first: no cloud egress unless explicitly configured
 *   - Cloud fallback is opt-in via env vars (OPENAI_API_KEY, etc.)
 *   - Returns structured JSON array of facts with confidence scores
 *   - Hard timeout per extraction call (30s default)
 *   - Never throws — always returns { facts: [], error?: string }
 */

import { homedir } from 'os';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';

// ============================================================
// CONFIGURATION
// ============================================================

const DEFAULT_MODEL = 'llama3.2:3b';
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const EXTRACTION_TIMEOUT_MS = 30_000; // 30 seconds hard limit per call
const MAX_INPUT_CHARS = 8000;         // Truncate input to prevent OOM

/**
 * Load Persyst config from ~/.persyst/config.json if it exists.
 * @returns {Object}
 */
function loadConfig() {
  const configPath = join(homedir(), '.persyst', 'config.json');
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf8'));
    }
  } catch (_) { /* fallback to defaults */ }
  return {};
}

// ============================================================
// EXTRACTION PROMPT
// ============================================================

const SYSTEM_PROMPT = `You are a fact extraction engine for a developer memory system called Persyst.

Your job: Extract ONLY concrete, actionable developer facts from conversation text.

EXTRACT these categories:
- "preference": Tool, library, pattern, or style preferences (e.g., "prefers TypeScript over JavaScript")
- "decision": Architectural or technical decisions made (e.g., "decided to use PostgreSQL for the database")
- "stack": Technology stack components (e.g., "backend uses Express.js with TypeScript")
- "rule": Coding rules, conventions, or constraints (e.g., "always use camelCase for variable names")
- "config": Configuration choices (e.g., "API runs on port 3001")
- "architecture": System design patterns (e.g., "follows microservices architecture")

DO NOT EXTRACT:
- Conversational filler ("okay", "sounds good", "thanks")
- Questions or requests (these are not facts)
- Code snippets or error messages
- Temporary debugging steps
- Anything uncertain or speculative

Return a JSON array. Each item must have:
- "content": A clear, concise fact statement (max 200 chars)
- "category": One of the categories above
- "confidence": 0.0-1.0 (how certain this is a real, lasting fact)

If no facts are found, return an empty array: []

IMPORTANT: Return ONLY valid JSON. No markdown, no code fences, no explanation.`;

/**
 * Build the user prompt from conversation text.
 * @param {string} text - Raw conversation text
 * @returns {string}
 */
function buildUserPrompt(text) {
  // Truncate to prevent token overflow
  const truncated = text.length > MAX_INPUT_CHARS
    ? text.slice(0, MAX_INPUT_CHARS) + '\n[...truncated]'
    : text;

  return `Extract developer facts from this conversation:\n\n${truncated}`;
}

// ============================================================
// OLLAMA PROVIDER (local-first)
// ============================================================

/**
 * Call Ollama's /api/generate endpoint for fact extraction.
 * @param {string} text - Conversation text to extract from
 * @param {Object} [opts={}]
 * @returns {Promise<{facts: Array, error?: string}>}
 */
async function extractWithOllama(text, opts = {}) {
  const config = loadConfig();
  const ollamaUrl = opts.ollamaUrl || config.ollama_url || process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;
  const model = opts.model || config.extraction_model || process.env.PERSYST_MODEL || DEFAULT_MODEL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  try {
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(text),
        stream: false,
        options: {
          temperature: 0.1,   // Low temp for structured output
          num_predict: 1024,  // Max tokens for response
        },
        format: 'json'       // Request JSON format
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      return { facts: [], error: `Ollama HTTP ${response.status}: ${errText.slice(0, 200)}` };
    }

    const data = await response.json();
    const rawOutput = data.response || '';

    return parseExtraction(rawOutput);
  } catch (err) {
    if (err.name === 'AbortError') {
      return { facts: [], error: `Ollama timed out after ${EXTRACTION_TIMEOUT_MS}ms` };
    }
    return { facts: [], error: `Ollama error: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// OPENAI-COMPATIBLE PROVIDER (GPT-4o-mini, etc.)
// ============================================================

/**
 * Call an OpenAI-compatible API for extraction.
 * @param {string} text
 * @param {Object} [opts={}]
 * @returns {Promise<{facts: Array, error?: string}>}
 */
async function extractWithOpenAI(text, opts = {}) {
  const apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) return { facts: [], error: 'No OPENAI_API_KEY set' };

  const baseUrl = opts.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const model = opts.model || 'gpt-4o-mini';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(text) }
        ],
        temperature: 0.1,
        max_tokens: 1024,
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      return { facts: [], error: `OpenAI HTTP ${response.status}: ${errText.slice(0, 200)}` };
    }

    const data = await response.json();
    const rawOutput = data.choices?.[0]?.message?.content || '';

    return parseExtraction(rawOutput);
  } catch (err) {
    if (err.name === 'AbortError') {
      return { facts: [], error: `OpenAI timed out after ${EXTRACTION_TIMEOUT_MS}ms` };
    }
    return { facts: [], error: `OpenAI error: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// GOOGLE GEMINI PROVIDER
// ============================================================

/**
 * Call Google Gemini API for extraction.
 * @param {string} text
 * @param {Object} [opts={}]
 * @returns {Promise<{facts: Array, error?: string}>}
 */
async function extractWithGemini(text, opts = {}) {
  const apiKey = opts.apiKey || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) return { facts: [], error: 'No GOOGLE_API_KEY or GEMINI_API_KEY set' };

  const model = opts.model || 'gemini-2.0-flash';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: buildUserPrompt(text) }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json'
          }
        }),
        signal: controller.signal
      }
    );

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      return { facts: [], error: `Gemini HTTP ${response.status}: ${errText.slice(0, 200)}` };
    }

    const data = await response.json();
    const rawOutput = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return parseExtraction(rawOutput);
  } catch (err) {
    if (err.name === 'AbortError') {
      return { facts: [], error: `Gemini timed out after ${EXTRACTION_TIMEOUT_MS}ms` };
    }
    return { facts: [], error: `Gemini error: ${err.message}` };
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// RESPONSE PARSER
// ============================================================

const VALID_CATEGORIES = new Set([
  'preference', 'decision', 'stack', 'rule', 'config', 'architecture'
]);

/**
 * Parse and validate LLM extraction output into structured facts.
 * Handles common LLM quirks: markdown fences, wrapper objects, invalid JSON.
 * 
 * @param {string} raw - Raw LLM output
 * @returns {{facts: Array<{content: string, category: string, confidence: number}>, error?: string}}
 */
function parseExtraction(raw) {
  if (!raw || typeof raw !== 'string') {
    return { facts: [], error: 'Empty LLM response' };
  }

  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  try {
    let parsed = JSON.parse(cleaned);

    // Handle wrapper objects like { "facts": [...] } or { "results": [...] }
    if (!Array.isArray(parsed)) {
      if (parsed.facts && Array.isArray(parsed.facts)) {
        parsed = parsed.facts;
      } else if (parsed.results && Array.isArray(parsed.results)) {
        parsed = parsed.results;
      } else if (parsed.extractions && Array.isArray(parsed.extractions)) {
        parsed = parsed.extractions;
      } else {
        return { facts: [], error: 'LLM returned non-array JSON' };
      }
    }

    // Validate and normalize each fact
    const validFacts = parsed
      .filter(f => {
        if (!f || typeof f !== 'object') return false;
        if (!f.content || typeof f.content !== 'string') return false;
        if (f.content.length < 5 || f.content.length > 500) return false;
        return true;
      })
      .map(f => ({
        content: f.content.trim().slice(0, 200),
        category: VALID_CATEGORIES.has(f.category) ? f.category : 'preference',
        confidence: typeof f.confidence === 'number'
          ? Math.max(0, Math.min(1, f.confidence))
          : 0.7
      }))
      // Only keep facts above confidence threshold
      .filter(f => f.confidence >= 0.5);

    return { facts: validFacts };
  } catch (e) {
    return { facts: [], error: `JSON parse failed: ${e.message}` };
  }
}

// ============================================================
// MAIN EXTRACTION FUNCTION (with cascading fallback)
// ============================================================

/**
 * Extract facts from conversation text using LLM.
 * Tries providers in order: Ollama → Gemini → OpenAI
 * 
 * @param {string} text - Raw conversation text
 * @param {Object} [options={}]
 * @param {string} [options.provider] - Force a specific provider: 'ollama', 'openai', 'gemini'
 * @param {string} [options.model] - Override model name
 * @param {string} [options.ollamaUrl] - Override Ollama URL
 * @returns {Promise<{facts: Array, provider: string, error?: string}>}
 */
export async function extractWithLLM(text, options = {}) {
  if (!text || typeof text !== 'string' || text.length < 20) {
    return { facts: [], provider: 'none', error: 'Text too short for extraction' };
  }

  const providers = [];

  if (options.provider) {
    // Force specific provider
    providers.push(options.provider);
  } else {
    // Default cascade: Ollama (local) → Gemini (cheap) → OpenAI (fallback)
    providers.push('ollama', 'gemini', 'openai');
  }

  const errors = [];

  for (const provider of providers) {
    let result;

    switch (provider) {
      case 'ollama':
        result = await extractWithOllama(text, options);
        break;
      case 'gemini':
        result = await extractWithGemini(text, options);
        break;
      case 'openai':
        result = await extractWithOpenAI(text, options);
        break;
      default:
        continue;
    }

    if (result.facts.length > 0) {
      return { facts: result.facts, provider };
    }

    if (result.error) {
      errors.push(`[${provider}] ${result.error}`);
    }

    // If Ollama returned empty facts without error, it genuinely found nothing
    if (!result.error && provider === 'ollama') {
      return { facts: [], provider: 'ollama' };
    }
  }

  return {
    facts: [],
    provider: 'none',
    error: errors.length > 0 ? errors.join('; ') : 'All providers returned empty'
  };
}

// Re-export for testing
export { parseExtraction, SYSTEM_PROMPT };
