# Persyst

**Local-first, compliance-grade MCP memory layer for regulated enterprise coding teams using AI assistants.**

Persyst gives AI coding agents (Claude Code, Cursor, VS Code, Aider, Windsurf, Antigravity) persistent memory across sessions. It stores memories in a local SQLite database with hybrid keyword + semantic search — operating 100% offline with zero cloud egress.

---

## Compliance-Grade Security Features

Persyst is built from the ground up for highly regulated enterprise environments (finance, healthcare, defense) subject to **SOC 2**, **HIPAA**, and the **EU AI Act**:

* **100% Data Residency (Zero-Egress)**: All vector calculations, full-text searches, and model inferences run locally on the developer's workstation. No database records or context data ever leave the local machine. Bypasses Business Associate Agreement (BAA) complexity for HIPAA.
* **Cryptographic Chain of Custody**: Every context retrieval generates an Ed25519 cryptographic signature sealing the query and retrieved memory hashes. Each attestation is chained to the previous one via SHA-256 hash chains, creating a tamper-evident audit ledger verifiable by security teams.
* **Automatic Secret Redaction**: Scans incoming log files and text writes to redact high-entropy secrets (API keys, JWTs, database strings, private keys) before they reach the persistent database.
* **Event-Driven File Watching**: Integrates `chokidar` for instant scanning of agent transcript folders, guaranteeing that your memories are synchronized immediately after each agent interaction.
* **Workspace Project Isolation**: Supports `PERSYST_PROJECT` environment partitioning, preventing cross-project context leaks while allowing shared enterprise compliance rules.

*Read more in our compliance mapping guides:*
- [SOC 2 Type II Controls](compliance/SOC2-controls.md)
- [HIPAA Mapping & PHI Boundaries](compliance/HIPAA-mapping.md)
- [EU AI Act Article 13 Transparency](compliance/EU-AI-Act-Article13.md)
- [Compliance Audit Trail Sample](compliance/audit-trail-sample.md)

---

## Quick Start & Automatic IDE Setup

You don't need to configure MCP files manually. Persyst includes an automated setup CLI that detects installed editors and configures rule wrappers and global settings in seconds.

### Automatic One-Command Setup

Run the setup wizard in your target project directory:

```bash
npx persyst-mcp init
```

This command automatically:
1. Generates local cryptographic Ed25519 keypairs in `~/.persyst`.
2. Creates workspace rule files (`.cursorrules`, `.windsurfrules`, `.clinerules`, `.persystrules.md`) to instruct agents on memory retrieval.
3. Automatically writes global MCP server configurations for **Cursor**, **Claude Code**, **Aider**, and **Continue.dev** with project-scoped environment parameters (`PERSYST_PROJECT`).

---

## Manual MCP Configuration

If you prefer to configure your agent manually, add the MCP server definition to your editor:

### Claude Code (`~/.claude.json`) & Claude Desktop
```json
{
  "mcpServers": {
    "persyst": {
      "command": "npx",
      "args": ["-y", "persyst-mcp"],
      "env": {
        "PERSYST_PROJECT": "my-project"
      }
    }
  }
}
```

### VS Code (Cline / Roo Code)
Add to your user settings under `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "persyst": {
      "command": "npx",
      "args": ["-y", "persyst-mcp"],
      "env": {
        "PERSYST_PROJECT": "my-project"
      }
    }
  }
}
```

### Cursor
Under **Settings → Features → MCP**:
1. Click **+ Add New MCP Server**
2. Name: `persyst`
3. Type: `stdio`
4. Command: `npx -y persyst-mcp`

### Aider
Append to your `.aider.conf.yml` project file:
```yaml
mcp-server:
  - name: persyst
    command: npx -y persyst-mcp
    env:
      PERSYST_PROJECT: my-project
```

---

## Passive Recording vs. Active Retrieval

> **Note on Agent Integration**: Persyst operates in two complementary modes:
> 1. **Passive Recording**: The file watcher automatically extracts and saves memories from your agent conversation transcripts in the background.
> 2. **Active Retrieval**: The AI agent calls `search_memories` or `get_optimized_context` to fetch relevant context.
>
> The IDE itself does not automatically inject retrieved memories into prompt inputs unless configured to do so via workspace rules (e.g. `.cursorrules`, `.windsurfrules`, `.clinerules`) or custom system prompt builders.

---

## Available Tools (19 MCP Endpoints)

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `add_memory` | Store a new memory with secret redaction & contradiction check | `content`, `importance` (0-1), `agent_id`, `shared` |
| `search_memories` | Hybrid keyword + semantic search with attestation | `query`, `limit`, `agent_id` |
| `get_memory` | Retrieve a specific memory by ID (boosts importance) | `id`, `agent_id` |
| `update_memory` | Update content & archive previous version | `id`, `content`, `agent_id` |
| `delete_memory` | Permanently delete a memory & clean knowledge graph edges | `id` |
| `get_recent_memories` | Fetch latest memories ordered by creation date | `limit`, `agent_id` |
| `get_important_memories` | Fetch memories ranked by importance score | `limit`, `agent_id` |
| `get_optimized_context` | Graph-hopped context prompt compiled within token budget | `query`, `max_tokens`, `agent_id`, `intent` |
| `ingest_git_commits` | Parse & import recent git commits as structured memories | `repo_path`, `count` |
| `watch_git_repo` | Poll repository for changes and auto-ingest new commits | `repo_path` |
| `consolidate_memories` | Semantic deduplication sweep merging similar memories | — |
| `get_memory_history` | Retrieve complete version history and semantic diffs | `query` |
| `get_agent_stats` | View agent reputation scores & contradiction metrics | — |
| `export_audit_log` | Export cryptographic attestation audit log (JSON/Markdown) | `start_date`, `end_date` |
| `verify_attestation` | Verify Ed25519 signature & SHA-256 chain integrity | `attestation_id` |
| `add_entity` | Add named entity to knowledge graph | `name`, `type` |
| `link_entity_memory` | Create edge between knowledge graph entity and memory | `entity_id`, `memory_id`, `relation` |
| `search_by_entity` | Query linked memories via knowledge graph traversal | `entity_name` |

---

## Local HTTP Gateway & Swarm Integration

In addition to STDIO transport, Persyst automatically launches a high-throughput local HTTP Gateway on port `4321` (`http://127.0.0.1:4321`).

- **`/health`**: Health check and database status
- **`/stats`**: Global memory & agent reputation statistics
- **`/system-prompt`**: Formatted prompt context injection
- **`/compliance/export`**: Cryptographic compliance audit report export (supports `format=markdown`)
- **`/events`**: Real-time Server-Sent Events (SSE) stream for agent swarms

---

## How Hybrid Search Works

Persyst combines two complementary search strategies:

1. **Keyword Search (SQLite FTS5)** — Fast, exact string matching using BM25 ranking.
2. **Semantic Search (sqlite-vec)** — Deep meaning-based matching using local `all-MiniLM-L6-v2` embeddings.

Results are merged dynamically. Keyword matches receive a score boost so exact matches rank at the top, while semantic similarity surfaces conceptually relevant memories even when different phrasing is used.

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Database:** SQLite via `better-sqlite3` (synchronous, WAL mode)
- **Vector Search:** `sqlite-vec` (in-process, zero cloud egress)
- **Full-Text Search:** SQLite FTS5
- **Embeddings:** `@huggingface/transformers` + `all-MiniLM-L6-v2` (384-dim, local ONNX)
- **Watcher:** `chokidar` event-driven file monitoring
- **Protocol:** MCP over stdio + HTTP Gateway

---

## Backup & Migration

Persyst includes built-in JSONL export/import commands for portable memory backup and cross-machine migration:

```bash
# Export all memories to a JSONL file
npx persyst-mcp export

# Export to a specific file
npx persyst-mcp export my-backup.jsonl

# Preview import (dry run)
npx persyst-mcp import my-backup.jsonl --dry-run

# Import memories (deduplicates automatically)
npx persyst-mcp import my-backup.jsonl
```

---

## License

MIT License. See [LICENSE](LICENSE) for details.
