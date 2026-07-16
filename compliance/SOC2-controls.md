# Persyst Compliance Control Mapping: SOC 2 Type II

This document maps Persyst's architectural and functional safeguards to SOC 2 Type II Trust Services Criteria (TSC) for **Security, Confidentiality, and Privacy**. 

Persyst is a local-first, decentralized memory layer for AI agents, designed specifically to operate completely within the enterprise security perimeter.

---

## CC6.1: Logical Access Controls
> *The entity restricts logical access to security assets, infrastructure, and information assets to authorized users...*

* **Local-First Isolation**: Persyst does not transmit database records, credentials, or context packets to any external cloud service. All DB instances are loaded in-process or accessed via a local loopback HTTP interface (`127.0.0.1`).
* **Namespace Boundary Enforcement**: AI agents are isolated by namespaces (`namespace` column in the SQLite schema). A coding agent bound to a specific repository or namespace cannot access, query, or search facts belonging to another agent's namespace, unless explicitly configured to write to the `shared` namespace.

---

## CC6.3: Transmission and Encryption Controls
> *The entity prevents unauthorized access to data during transmission...*

* **Zero-Egress Execution**: All vector similarity calculations, full-text searches, and heuristic extractions are executed inside the developer's workstation or target environment using local SQLite and ONNX Runtime (`@huggingface/transformers`).
* **No Network Egress**: Persyst implements zero cloud synchronization by default. Any multi-host swarm configurations run over TLS-encrypted peer-to-peer or gateway routes with mandatory API key authentication.

---

## CC6.5: Secret and Credential Protection
> *The entity protects credentials and transmission secrets from exposure...*

* **Automatic Secret Redaction**: Persyst employs a heuristic scanner on all incoming log files and text writes. 
* **Redaction Coverage**: High-entropy strings matching pattern signatures for API keys (e.g., OpenAI, Google, AWS, GitHub PATs), Private Keys, Database connection URLs, and JSON Web Tokens (JWT) are automatically replaced with `[REDACTED_SECRET]` before they are persisted to the database.

---

## CC8.1: Auditing & Cryptographic Chain of Custody
> *The entity implements logs and audit trails to monitor system activity...*

* **Ed25519 Cryptographic Attestation**: For every search, retrieval, or context injection query, Persyst generates an Ed25519 cryptographic signature. This signature seals:
  1. The search query.
  2. The hash of every retrieved memory block.
  3. The identifier of the requesting agent.
  4. The timestamp.
* **Hash-Chaining (Ledger)**: Each attestation record contains the SHA-256 hash of the *previous* attestation record, creating a tamper-evident audit ledger.
* **Tamper Verification**: Auditors can verify the integrity of the entire memory ledger programmatically using `verifyChainIntegrity()` to guarantee that no memory injection or manipulation has occurred.
