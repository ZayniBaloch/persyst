# Aider Integration Guide for Persyst

Persyst gives Aider long-term persistent memory across sessions. By running Persyst as an MCP server, Aider can store, retrieve, and search memories about your project's architecture, past decisions, and coding conventions.

## 1. Setup

Start the Persyst MCP server in the background before running Aider, or run them in separate terminals.

```bash
# Terminal 1: Start the memory server
npx persyst-mcp

# Terminal 2: Run Aider
aider
```

*Note: Aider is adding native MCP support soon. For now, if Aider doesn't auto-detect the local stdio server, you may need to use a wrapper script or wait for the official MCP integration release.*

## 2. Ingesting Git History (The Magic Feature)

One of the most powerful ways to use Persyst with Aider is to ingest your project's git history. This turns every past commit into a searchable memory. Aider can then understand *why* certain code was written or what bugs were fixed in the past.

In your Aider chat, just say:
> "Use the ingest_git_commits tool to import the last 100 commits from this repository."

Aider will call `ingest_git_commits(repo_path=".", count=100)`. Persyst will:
1. Parse the git log.
2. Store each commit as a memory.
3. Automatically generate a semantic search embedding.
4. Extract the author as a named entity and link it to the commit memory.

This process is idempotent (safe to run multiple times). It will skip commits it has already seen.

## 3. Example Workflows with Aider

### Asking Architectural Questions
> **You:** "Why did we choose Postgres over MySQL for this project?"
> 
> **Aider:** *(Calls `search_memories(query="Postgres vs MySQL", limit=5)`)*
> "According to a memory stored last month, the decision was made because of Postgres's superior JSONB support for the analytics pipeline."

### Storing Conventions
> **You:** "Please remember that all our React components should use functional syntax with hooks, never class components."
> 
> **Aider:** *(Calls `add_memory(content="All React components must use functional syntax with hooks, not class components.", importance=0.9)`)*
> "Got it. I've stored that convention in memory."

### Entity Mapping
> **You:** "Create an entity for the 'AuthService' and link it to the memory about how JWTs are signed."
> 
> **Aider:** *(Calls `add_entity(name="AuthService", type="concept")` then `link_entity_memory(...)`)*

### Onboarding a New Context
When you start a new Aider session, you don't need to re-explain the project. Just ask Aider to search its memory for key terms related to what you're working on, and it will fetch the relevant context.
