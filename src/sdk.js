import http from 'http';
import net from 'net';

/**
 * Persyst Developer SDK Client
 * Supports both Gateway Mode (local HTTP server) and Library Mode (direct in-process SQLite).
 */
export class Persyst {
  /**
   * @param {Object} [config={}]
   * @param {string} [config.mode=null] - 'gateway' | 'library' | null (auto-detect)
   * @param {string} [config.host='127.0.0.1'] - Gateway host
   * @param {number} [config.port=4321] - Gateway port
   * @param {string} [config.apiKey=null] - Gateway authorization key
   */
  constructor(config = {}) {
    this.mode = config.mode || null;
    this.host = config.host || '127.0.0.1';
    this.port = config.port || 4321;
    this.apiKey = config.apiKey || null;
    this._detectedMode = null;
  }

  /**
   * Auto-detect reachable Gateway on port 4321, falling back to direct library mode.
   * @private
   */
  async _resolveMode() {
    if (this.mode) {
      return this.mode;
    }
    if (this._detectedMode) {
      return this._detectedMode;
    }

    try {
      const isReachable = await new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(150); // 150ms probe timeout
        socket.on('connect', () => {
          socket.destroy();
          resolve(true);
        });
        socket.on('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.on('timeout', () => {
          socket.destroy();
          resolve(false);
        });
        socket.connect(this.port, this.host);
      });
      this._detectedMode = isReachable ? 'gateway' : 'library';
    } catch (_) {
      this._detectedMode = 'library';
    }
    return this._detectedMode;
  }

  /**
   * Track a developer event or milestone.
   * @param {Object} eventData
   * @param {string} [eventData.sessionId] - Active session / thread identifier
   * @param {string} [eventData.workflow] - Active workflow name (e.g. 'customer_support')
   * @param {string} [eventData.event] - Specific event name (e.g. 'payment_failed')
   * @param {string} [eventData.content] - Full text detail of the event
   * @param {Object} [eventData.metadata] - Structured metadata facts
   * @param {number} [eventData.importance=1.0] - Importance score (0.0 - 1.0)
   * @param {boolean} [eventData.shared=true] - Whether the memory is shared across namespaces
   */
  async track(eventData = {}) {
    const mode = await this._resolveMode();
    const sessionId = eventData.sessionId || eventData.session_id || null;
    const workflow = eventData.workflow || null;
    const event = eventData.event || null;
    const metadata = eventData.metadata || null;
    const importance = eventData.importance !== undefined ? eventData.importance : 1.0;
    const shared = eventData.shared !== undefined ? eventData.shared : true;

    let content = eventData.content || '';
    if (!content) {
      if (event) {
        content = `Event: ${event}`;
        if (workflow) content += ` in workflow: ${workflow}`;
        if (metadata) content += `. Metadata: ${JSON.stringify(metadata)}`;
      } else {
        throw new Error('Either content or event must be provided to track()');
      }
    }

    if (mode === 'gateway') {
      return this._trackGateway({ content, importance, agent_id: workflow || 'sdk', session_id: sessionId, shared });
    } else {
      return this._trackLibrary({ content, importance, agent_id: workflow || 'sdk', session_id: sessionId, shared });
    }
  }

  /**
   * Internal direct SQLite write.
   * @private
   */
  async _trackLibrary({ content, importance, agent_id, session_id, shared }) {
    const { insertMemory, insertVector, redactSecrets } = await import('./database.js');
    const { generateEmbedding } = await import('./embeddings.js');

    const namespace = shared ? 'shared' : agent_id;
    const redactedContent = redactSecrets ? redactSecrets(content) : content;
    const id = insertMemory(redactedContent, importance, {
      source_type: 'api',
      source_id: agent_id,
      confidence: 1.0
    }, namespace);

    const embedding = await generateEmbedding(redactedContent);
    insertVector(id, embedding);
    return { success: true, id };
  }

  /**
   * Internal HTTP POST write to Gateway.
   * @private
   */
  _trackGateway(payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/add',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let responseBody = '';
        res.on('data', chunk => { responseBody += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseBody));
          } catch (e) {
            reject(new Error(`Failed to parse gateway response: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /**
   * Retrieve compiled, optimized context tailored by intent and workflow.
   * @param {Object} contextQuery
   * @param {string} [contextQuery.sessionId] - Active session / thread identifier
   * @param {string} [contextQuery.workflow] - Active workflow name (e.g. 'customer_support')
   * @param {string} [contextQuery.intent] - Active reasoning intent (e.g. 'debugging')
   * @param {string} contextQuery.query - Prompt query string to find similar context for
   * @param {number} [contextQuery.maxTokens=2000] - Hard budget limit of tokens
   */
  async context(contextQuery = {}) {
    const mode = await this._resolveMode();
    const sessionId = contextQuery.sessionId || contextQuery.session_id || null;
    const workflow = contextQuery.workflow || null;
    const intent = contextQuery.intent || null;
    const query = contextQuery.query || '';
    const maxTokens = contextQuery.maxTokens || contextQuery.max_tokens || 2000;

    if (mode === 'gateway') {
      return this._contextGateway({ query, max_tokens: maxTokens, agent_id: workflow, session_id: sessionId, intent });
    } else {
      return this._contextLibrary({ query, max_tokens: maxTokens, agent_id: workflow, session_id: sessionId, intent });
    }
  }

  /**
   * Internal direct SQLite read.
   * @private
   */
  async _contextLibrary({ query, max_tokens, agent_id, session_id, intent }) {
    const { getOptimizedContext } = await import('./search.js');
    return getOptimizedContext(query, max_tokens, agent_id, session_id, agent_id || null, intent);
  }

  /**
   * Internal HTTP POST read from Gateway.
   * @private
   */
  _contextGateway(payload) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(payload);
      const req = http.request({
        hostname: this.host,
        port: this.port,
        path: '/context',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let responseBody = '';
        res.on('data', chunk => { responseBody += chunk; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseBody));
          } catch (e) {
            reject(new Error(`Failed to parse gateway response: ${e.message}`));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
