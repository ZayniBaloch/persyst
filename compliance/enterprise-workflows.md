# Persyst Enterprise Integration & Developer Workflows

This document outlines the target user profiles, core deployment patterns, and operational workflows for enterprise teams running Persyst in regulated environments (HIPAA, SOC 2, EU AI Act).

---

## 1. Target User Profiles & Personas

### A. The Regulated Software Engineer
* **Profile**: Developers writing software in healthcare (PHI), finance (PCI), defense, or government sectors.
* **Problem**: They want to use AI coding assistants (Cursor, Claude Code, Aider, Continue.dev) to boost productivity, but corporate security policies strictly forbid sending workspace context or developer interaction logs to cloud-based memory services.
* **Persyst Solution**: Persyst runs completely offline. The vector database (SQLite) and embedding model (ONNX Runtime) execute locally within the workstation boundary, ensuring zero data egress.

### B. The Security & Compliance Officer
* **Profile**: Compliance managers responsible for verifying that AI usage aligns with SOC 2 CC8.1 (Auditing) or HIPAA § 164.312 (Audit Controls).
* **Problem**: AI code generation is a black box. Compliance teams need proof of what information was retrieved, when it was injected, and whether the data boundary was breached.
* **Persyst Solution**: Cryptographic signature chaining. Every context injection and memory retrieval is signed using local Ed25519 keys, producing a tamper-evident audit ledger that can be verified and exported.

### C. The Swarm & Multi-Agent Architect
* **Profile**: Architects building autonomous developer agents or multi-agent swarms.
* **Problem**: Swarms need a way to share common project specifications (coding rules, API styles) while isolating private, temporary agent states to avoid context pollution.
* **Persyst Solution**: Namespace separation. Agents share global memories (`namespace = 'shared'`) but maintain private memory buffers using unique `agent_id` parameters.

---

## 2. Core Workflows & Integration Patterns

### Workflow A: Single-Developer Local IDE Integration
This is the default configuration for individual developer workstations.

```
+-------------------------------------------------------------+
| Developer Workstation                                       |
|                                                             |
|  [Cursor / Claude Code / Aider]                             |
|              |                                              |
|         (STDIO MCP)                                         |
|              v                                              |
|      [persyst-mcp daemon]                                   |
|              |                                              |
|       (Local SQLite)                                        |
|              v                                              |
|      ~/.persyst/persyst.db                                  |
|                                                             |
+-------------------------------------------------------------+
```

* **Command**: Run `npx persyst-mcp init` to generate `.cursorrules` or `.persystrules.md`.
* **Execution**: The IDE agent calls the MCP server on stdio.
* **Effect**: Facts are recorded automatically as the developer writes code, maintaining context across projects and branches.

---

### Workflow B: Automated CI/CD Audit Trail Export
This workflow is used by security teams to verify development integrity before merging to production.

```
[Developer Workstation] ---> (Git Commit) ---> [CI/CD Pipeline]
                                                      |
                                                      v
                                        (Run Audit Script)
                                                      |
                                                      v
                                      [Get /compliance/export]
                                                      |
                                                      v
                                    (Generate Compliance Artifact)
```

1. **Continuous Retrieval Logging**: As developers work, Persyst writes signed attestations to the local database.
2. **Commit Verification**: Before pushing code, a pre-commit or CI/CD script runs the verification check:
   ```bash
   # Verify the integrity of the attestation ledger
   npx persyst-mcp verify_attestation --id <latest-id>
   ```
3. **Audit Export**: At the end of a sprint or release cycle, the team exports the cryptographic log via HTTP or the CLI:
   ```bash
   curl "http://127.0.0.1:4321/compliance/export?format=markdown" > sprint-audit-trail.md
   ```
   This file is committed to the team's compliance repository as cryptographically signed proof of clean context custody.

---

### Workflow C: Multi-Agent Swarm Isolation
For teams using orchestrators (e.g. CrewAI, AutoGen) or multi-agent CLI workspaces.

1. **Global Base Configuration**: The lead developer initializes the shared project database containing coding standards and architecture rules:
   ```javascript
   await sdk.addMemory({
     content: "Rule: Use CamelCase for all database models.",
     shared: true // accessible by all agents
   });
   ```
2. **Private Workspace Isolation**: Each worker agent in the swarm initializes with a unique `agent_id`:
   ```javascript
   // Worker Agent A queries its own namespace + shared global namespace
   const context = await sdk.getContext({
     query: "database models",
     agentId: "database-worker",
     maxTokens: 1000
   });
   ```
   This ensures that the database worker doesn't get polluted by memories from the frontend styling worker.

---

## 3. Best Practices for Compliance Management

* **Attestation Key Rotation**: Keys are stored at `~/.persyst/keys/`. Regulated teams should back up these keys securely. To rotate keys, simply backup and remove the keys folder; Persyst will automatically generate a new Ed25519 pair on the next run.
* **Secret Redaction Audits**: While Persyst automatically redacts known API keys and credentials, developers should periodically check `/stats` to verify that no plain-text credentials have been stored.
* **Periodic Consolidation**: Configure your agents to call `consolidate_memories` weekly to merge redundant memories, keeping retrieval speeds sub-5ms.
