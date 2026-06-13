# Persyst

**Local-first MCP memory server for coding agents.**

Persyst gives AI coding agents (Claude Code, Cursor, Aider, Windsurf) persistent memory across sessions. It stores memories in a local SQLite database with hybrid keyword + semantic search — no cloud, no API keys, works offline.

## How It Works

```
Your AI Agent ←→ MCP (stdio) ←→ Persyst ←→ SQLite (local)
```

1. **Agent stores a memory** → Persyst saves it + generates a search embedding
2. **Agent searches memories** → Persyst finds matches by both keywords AND meaning
3. **"dark mode" ↔ "night theme"** → Semantic search understands synonyms

## Quick Start

### 1. Install

```bash
npm install -g persyst-mcp
```

### 2. Add to Claude Code

Edit your Claude Code MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "persyst": {
      "command": "persyst-mcp"
    }
  }
}
```

### 3. Use It

In Claude Code, the agent can now call tools like:
- `add_memory` — Store a fact
- `search_memories` — Find relevant memories
- `get_memory` — Get a specific memory
- `update_memory` — Update a memory
- `delete_memory` — Remove a memory
- `get_recent_memories` — Latest memories
- `get_important_memories` — Most important memories

## Setup for Other Agents

### Cursor

Add to your Cursor MCP settings:

```json
{
  "persyst": {
    "command": "persyst-mcp"
  }
}
```

### Aider

```bash
# Start the MCP server alongside Aider
persyst-mcp &
```

## Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `add_memory` | Store a new memory | `content` (string), `importance` (0-1, optional) |
| `search_memories` | Hybrid keyword + semantic search | `query` (string), `limit` (number) |
| `get_memory` | Get memory by ID | `id` (number) |
| `update_memory` | Update memory content | `id` (number), `content` (string) |
| `delete_memory` | Delete a memory | `id` (number) |
| `get_recent_memories` | Get latest memories | `limit` (number) |
| `get_important_memories` | Get by importance score | `limit` (number) |

## How Search Works

Persyst uses **hybrid search** — combining two strategies:

1. **Keyword Search (FTS5)** — Exact word matches using BM25 ranking
2. **Semantic Search (sqlite-vec)** — Meaning-based using local embeddings

Results from both are merged. Keyword matches get a score boost so exact matches rank higher, but semantic matches still surface related memories.

## Architecture

```
persyst/
├── index.js              ← Entry point (starts MCP server)
├── src/
│   ├── server.js         ← MCP server (stdio transport)
│   ├── database.js       ← SQLite + schema + CRUD
│   ├── search.js         ← Hybrid search engine
│   ├── embeddings.js     ← Local embedding generation
│   └── tools.js          ← 7 MCP tool definitions
├── test/
│   └── smoke.js          ← End-to-end test
└── db/                   ← Database files (gitignored)
```

## Data Storage

- Database location: `~/.persyst/persyst.db`
- All data stays on your machine
- No telemetry, no cloud calls, no API keys
- Works offline (airplane mode ✓)

## Tech Stack

- **Runtime:** Node.js 18+
- **Database:** SQLite via better-sqlite3
- **Vector Search:** sqlite-vec (local, no cloud)
- **Full-Text Search:** SQLite FTS5
- **Embeddings:** @huggingface/transformers + all-MiniLM-L6-v2 (384-dim, ~50MB)
- **Protocol:** MCP over stdio

## Development

```bash
# Clone and install
git clone <repo-url>
cd persyst
npm install

# Run smoke test
npm test

# Start server directly
node index.js
```

## License

MIT
