# 🔌 Persyst Swarm Connection Specification

This specification documents the connection models, HTTP endpoints, and namespace isolation patterns for running local-first or cloud-based **Agent Swarms** integrated with the Persyst Memory Gateway.

---

## 🏗️ Architecture Overview

When running an agent swarm, agents typically need both **shared context** (project requirements, design specs, global variables) and **private context** (agent-specific task history, specialized scratchpads). 

By exposing a lightweight HTTP Gateway on `127.0.0.1:4321`, Persyst permits any swarm framework (e.g., CrewAI, Autogen, LangGraph, custom scripts) to query and store memory without subprocess overhead.

```mermaid
graph TD
    subgraph Swarm Framework (Python/JS)
      AgentA[Agent A: Planner]
      AgentB[Agent B: Coder]
      AgentC[Agent C: Reviewer]
    end

    subgraph Persyst HTTP Gateway (Port 4321)
      Router{HTTP Router}
      DB[(SQLite Memory Store)]
      Vec[(HNSW Vector Index)]
    end

    AgentA -->|POST /add {agent_id: planner}| Router
    AgentB -->|POST /search {agent_id: coder}| Router
    AgentC -->|POST /context| Router

    Router --> DB
    Router --> Vec
```

---

## 📡 HTTP API Reference

All requests must use `POST` and include the header `'Content-Type: application/json'`.

### 1. Store Memory (`POST /add`)
Saves a new fact in the memory store, generates its vector embedding, and validates it against current memories for contradictions.

* **Endpoint**: `/add`
* **Request Payload**:
```json
{
  "content": "Database migrations must always use the knex migration library.",
  "importance": 0.9,
  "agent_id": "architect-agent",
  "session_id": "session_8f90a",
  "shared": true
}
```
* **Parameters**:
  * `content` (string, required): The fact content to store.
  * `importance` (float, optional, default: `1.0`): Priority score (0.0 to 1.0).
  * `agent_id` (string, optional): The ID of the agent writing the memory. Sets the namespace.
  * `session_id` (string, optional): Session tracking identifier.
  * `shared` (boolean, optional, default: `true`): If `true`, this memory is queryable by all agents. If `false`, it is isolated to the writing agent's namespace.

* **Response (200 OK)**:
```json
{
  "success": true,
  "id": 142,
  "content": "Database migrations must always use the knex migration library.",
  "category": "rule",
  "confidence": 0.85
}
```

---

### 2. Search Memories (`POST /search`)
Queries the memory vector index and runs full-text FTS5 search to return attested, relevant facts.

* **Endpoint**: `/search`
* **Request Payload**:
```json
{
  "query": "Which database migration tool are we using?",
  "limit": 5,
  "agent_id": "coder-agent",
  "session_id": "session_8f90a"
}
```
* **Parameters**:
  * `query` (string, required): Search query.
  * `limit` (int, optional, default: `5`): Maximum results to return.
  * `agent_id` (string, optional): Restricts private search scopes to this agent's private namespace + all `shared` memories.

* **Response (200 OK)**:
```json
{
  "success": true,
  "count": 1,
  "namespace": "coder-agent",
  "results": [
    {
      "id": 142,
      "content": "Database migrations must always use the knex migration library.",
      "category": "rule",
      "similarity": 0.88,
      "created_at": 1781646206
    }
  ]
}
```

---

### 3. Retrieve Context (`POST /context`)
Retrieves a compressed, ranked context block suitable for direct insertion into an LLM's system prompt.

* **Endpoint**: `/context`
* **Request Payload**:
```json
{
  "query": "Current database tech stack and conventions",
  "max_tokens": 2000,
  "agent_id": "coder-agent"
}
```

* **Response (200 OK)**:
```json
{
  "context": "=== PERSYST MEMORY ===\n• [Memory #142] Database migrations must always use the knex migration library.\n=== END MEMORY ==="
}
```

---

## 🔒 Namespace Isolation & Sharing Models

Persyst supports multi-agent setups via two isolation modes:

1. **Shared Workspace Memory (`shared: true`)**:
   - Stored in the global namespace.
   - Any agent in the swarm can query and leverage these memories.
   - Perfect for project-level conventions (e.g. "We use vanilla CSS").

2. **Agent-Isolated Memory (`shared: false`)**:
   - Tagged specifically with `agent_id`.
   - Invisible to other agents in the swarm.
   - Ideal for agent-specific workflows (e.g. Coder agent's private debugging stack).

---

## 💻 Swarm Code Integration Example (Python)

Below is a ready-to-use utility class for integrating Persyst Memory into a Python-based swarm agent.

```python
import requests
from typing import List, Dict, Any

class PersystClient:
    def __init__(self, host: str = "127.0.0.1", port: int = 4321):
        self.base_url = f"http://{host}:{port}"

    def add_memory(self, content: str, agent_id: str, shared: bool = True) -> Dict[str, Any]:
        """Store a fact in Persyst Memory Gateway."""
        try:
          response = requests.post(
              f"{self.base_url}/add",
              json={"content": content, "agent_id": agent_id, "shared": shared},
              timeout=1.0
          )
          return response.json()
        except requests.exceptions.RequestException as e:
          return {"success": False, "error": str(e)}

    def search_memories(self, query: str, agent_id: str, limit: int = 5) -> List[Dict[str, Any]]:
        """Search memories visible to this agent."""
        try:
          response = requests.post(
              f"{self.base_url}/search",
              json={"query": query, "agent_id": agent_id, "limit": limit},
              timeout=1.0
          )
          return response.json().get("results", [])
        except requests.exceptions.RequestException:
          return []

    def get_prompt_context(self, query: str, agent_id: str, max_tokens: int = 1500) -> str:
        """Get pre-formatted prompt context block."""
        try:
          response = requests.post(
              f"{self.base_url}/context",
              json={"query": query, "agent_id": agent_id, "max_tokens": max_tokens},
              timeout=1.0
          )
          return response.json().get("context", "")
        except requests.exceptions.RequestException:
          return ""

# Usage in Agent Prompting:
# client = PersystClient()
# context = client.get_prompt_context("CSS styling rules", agent_id="frontend-agent")
# system_prompt = f"You are a CSS wizard. Use the following context:\n{context}"
```
