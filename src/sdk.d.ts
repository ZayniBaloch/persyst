/**
 * TypeScript type declarations for the Persyst Developer SDK.
 * Import via: import { Persyst } from 'persyst-mcp/sdk'
 */

export interface PersystConfig {
  /**
   * Force a connection mode. If omitted, Persyst auto-detects.
   * - `'gateway'` — connect to the local HTTP gateway on port 4321
   * - `'library'` — use in-process SQLite directly (no server needed)
   * - `null` — auto-detect: probe gateway first, fall back to library
   */
  mode?: 'gateway' | 'library' | null;
  /** Gateway host (default: '127.0.0.1') */
  host?: string;
  /** Gateway port (default: 4321) */
  port?: number;
  /** Optional API key for gateway authorization */
  apiKey?: string | null;
}

export interface TrackOptions {
  /** Active session or thread identifier */
  sessionId?: string;
  /** @alias sessionId */
  session_id?: string;
  /**
   * Active workflow name (used as agent_id for namespace isolation).
   * Example: 'customer_support', 'code_review'
   */
  workflow?: string;
  /**
   * Specific event name. Used to build `content` if `content` is not provided.
   * Example: 'payment_failed', 'build_passed'
   */
  event?: string;
  /** Full text content to store as the memory. Required if `event` is not provided. */
  content?: string;
  /** Structured metadata to append to the generated content string. */
  metadata?: Record<string, unknown>;
  /** Importance score from 0.0 (low) to 1.0 (high). Default: 1.0 */
  importance?: number;
  /**
   * If true (default), the memory is visible to all agents.
   * If false, it is isolated to the `workflow` agent's namespace.
   */
  shared?: boolean;
}

export interface TrackResult {
  success: boolean;
  /** The ID of the stored (or existing) memory */
  id: number;
  /** The namespace the memory was written to */
  namespace: string;
  /** Human-readable result message */
  message?: string;
  /** Error message, present only on failure */
  error?: string;
}

export interface ProvenanceRecord {
  source_type: 'agent' | 'git' | 'api' | 'import' | 'manual';
  source_id: string | null;
  confidence: number;
}

export interface MemoryRecord {
  id: number;
  content: string;
  importance_score: number;
  created_at: number;
  last_accessed: number;
  /** Relevance score (hybrid search + reputation weight) */
  score: number;
  provenance?: ProvenanceRecord | null;
}

export interface ContextOptions {
  /** Active session or thread identifier */
  sessionId?: string;
  /** @alias sessionId */
  session_id?: string;
  /** Active workflow / agent name */
  workflow?: string;
  /**
   * Hint for the active task intent. Used to refine context selection.
   * Example: 'debugging', 'ui_styling', 'database_management', 'deployment'
   */
  intent?: string;
  /** Search query string — required */
  query: string;
  /** Hard token budget for the returned context block. Default: 2000 */
  maxTokens?: number;
  /** @alias maxTokens */
  max_tokens?: number;
}

export interface ContextResult {
  /**
   * A formatted, ready-to-inject context string for LLM system prompts.
   * Contains memory entries ranked by relevance within the token budget.
   */
  context: string;
  /** The ranked memory records included in the context */
  memories: MemoryRecord[];
  /** Cryptographic Ed25519 attestation record for audit trails */
  attestation: object | null;
  /** Detected query intent classification */
  intent: string;
  /** Detected urgency level based on query language */
  urgency: 'low' | 'medium' | 'high' | 'critical';
  /** Generated actionable suggestions derived from retrieved memories */
  suggested_actions: string[];
}

/**
 * Persyst Developer SDK Client.
 *
 * Supports two transport modes:
 * - **Gateway Mode**: communicates with the local HTTP gateway on port 4321.
 *   Best for Python/other-language agents, or when the server is already running.
 * - **Library Mode**: directly accesses the local SQLite database in-process.
 *   Best for Node.js scripts and when no server is needed.
 *
 * Auto-detects the available mode on first call (150ms probe timeout).
 *
 * @example
 * ```ts
 * import { Persyst } from 'persyst-mcp/sdk';
 *
 * const persyst = new Persyst();
 *
 * // Track an architectural decision
 * await persyst.track({
 *   content: 'We use TypeScript for all new source files',
 *   importance: 0.9,
 *   workflow: 'my-agent'
 * });
 *
 * // Retrieve compressed context for an LLM
 * const { context } = await persyst.context({
 *   query: 'coding conventions and stack choices',
 *   intent: 'general'
 * });
 * console.log(context);
 * ```
 */
export declare class Persyst {
  constructor(config?: PersystConfig);

  /**
   * Track a developer event or milestone.
   *
   * Stores it as a persistent memory in the local SQLite database via
   * the gateway (HTTP) or directly (library mode).
   *
   * If an identical memory already exists, its importance is boosted instead
   * of creating a duplicate.
   *
   * @throws {Error} If neither `content` nor `event` is provided.
   */
  track(eventData: TrackOptions): Promise<TrackResult>;

  /**
   * Retrieve compiled, optimized context tailored by query and intent.
   *
   * Runs hybrid search (keyword + semantic) + knowledge graph traversal,
   * applies temporal decay + agent reputation weighting, then compresses
   * the result to fit within `maxTokens`.
   *
   * Returns a formatted context block ready to inject into an LLM system prompt.
   */
  context(contextQuery: ContextOptions): Promise<ContextResult>;
}
