/**
 * events.js — Persyst In-Process Memory Event Bus
 *
 * A shared EventEmitter used by the HTTP gateway (SSE broadcasting),
 * the log watcher, and the MCP tool handlers to signal memory changes
 * in real-time without tight coupling.
 *
 * Events emitted:
 *   memory_added       { id, content, namespace, source }
 *   memory_deleted     { id }
 *   memories_consolidated { consolidated_groups, details }
 */

import { EventEmitter } from 'events';

export const memoryEventBus = new EventEmitter();

// Support large swarms with many simultaneous SSE subscribers
memoryEventBus.setMaxListeners(500);
