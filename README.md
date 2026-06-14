# Persyst

**Local-first MCP memory server for coding agents.**

Persyst gives AI coding agents (Claude Code, Cursor, VS Code, Aider, Windsurf, Antigravity) persistent memory across sessions. It stores memories in a local SQLite database with hybrid keyword + semantic search — no cloud, no API keys, works offline.

## How It Works

```
Your AI Agent ←→ MCP (stdio) ←→ Persyst ←→ SQLite (local)
```

1. **Agent stores a memory** → Persyst saves it + generates a search embedding
2. **Agent searches memories** → Persyst finds matches by both keywords AND meaning
3. **"dark mode" ↔ "night theme"** → Semantic search understands synonyms

> 🚨 **First-Run Note**: On the first start, Persyst will automatically download the local embedding model (`all-MiniLM-L6-v2` ~50MB). This can take 30-60 seconds depending on your connection. The server will log `Loading embedding model...` and then proceed normally.

---

## Quick Start

You don't need to install anything globally. You can run it instantly using `npx`:

### 1. Add to Claude Code or Claude Desktop

#### Claude Code (CLI)
Add this to your global configuration file located at `~/.claude.json`:
```json
{
  "mcpServers": {
    "persyst": {
      "command": "npx",
      "args": ["-y", "persyst-mcp"]
    }
  }
}
```

#### Claude Desktop
Add this to your Claude Desktop configuration file:
* **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
* **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
* **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "persyst": {
      "command": "npx",
      "args": ["-y", "persyst-mcp"]
    }
  }
}
```

---

## Setup for Other Agents

### VS Code (Cline / Roo Code)
Add this configuration to your user settings under the MCP settings file (`cline_mcp_settings.json`):
```json
{
  "mcpServers": {
    "persyst": {
      "command": "npx",
      "args": ["-y", "persyst-mcp"]
    }
  }
}
```

### Cursor
Add Persyst in Cursor under **Settings → Features → MCP**:
1. Click **+ Add New MCP Server**
2. Name: `persyst`
3. Type: `stdio`
4. Command: `npx -y persyst-mcp`

### Aider
Start Aider from the command line passing the server command:
```bash
aider --mcp-server persyst:npx -y persyst-mcp
```
Or append this to your `.aider.conf.yml` project file:
```yaml
mcp-server:
  - name: persyst
    command: npx -y persyst-mcp
```

### Antigravity
Add Persyst to your Antigravity agent configuration file at `~/.gemini/antigravity/mcp_config.json`:
```json
{
  "mcpServers": {
    "persyst": {
      "command": "npx",
      "args": ["-y", "persyst-mcp"]
    }
  }
}
```

---

## Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `add_memory` | Store a new memory | `content` (string), `importance` (0-1, optional) |
| `search_memories` | Hybrid keyword + semantic search | `query` (string), `limit` (number) |
| `get_memory` | Get memory by ID | `id` (number) |
| `update_memory` | Update memory content | `id` (number), `content` (string) |
| `delete_memory` | Delete a memory and clean up edges | `id` (number) |
| `get_recent_memories` | Get latest memories | `limit` (number) |
| `get_important_memories` | Get by importance score | `limit` (number) |

---

## How Search Works

Persyst uses **hybrid search** — combining two strategies:

1. **Keyword Search (FTS5)** — Exact word matches using BM25 ranking
2. **Semantic Search (sqlite-vec)** — Meaning-based using local embeddings

Results from both are merged. Keyword matches get a score boost so exact matches rank higher, but semantic matches still surface related memories.

---

## Tech Stack

- **Runtime:** Node.js 18+
- **Database:** SQLite via better-sqlite3
- **Vector Search:** sqlite-vec (local, no cloud)
- **Full-Text Search:** SQLite FTS5
- **Embeddings:** @huggingface/transformers + all-MiniLM-L6-v2 (384-dim, ~50MB)
- **Protocol:** MCP over stdio

---

## Troubleshooting

#### `better-sqlite3` installation fails
`better-sqlite3` compiles native C++ code on installation. Make sure you have python and C++ build tools installed on your system:
* **Windows:** Run `npm install --global windows-build-tools` or install Visual Studio Build Tools.
* **macOS/Linux:** Run `xcode-select --install` or install `build-essential`.

#### The agent is stuck or loading forever on startup
This is normal on the **very first run** because Persyst is downloading the ~50MB embedding model. Wait 30-60 seconds for it to complete. The next runs will be instant.

#### Command not found: `persyst-mcp`
Instead of running it globally, prefer using the `npx -y persyst-mcp` command in your agent configurations. It automatically installs and updates the server non-interactively.

#### Permission Denied
Do not run `npx` with `sudo`. If you run into permission issues, ensure your npm global prefix is owned by your user account.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
