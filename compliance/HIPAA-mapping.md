# Persyst Compliance Control Mapping: HIPAA Security & Privacy

This document describes how Persyst enables healthcare developers to leverage AI agents (such as Cursor, Claude Code, Aider, and Roo Code) without compromising HIPAA (Health Insurance Portability and Accountability Act) compliance or requiring complex Business Associate Agreements (BAAs) for the local memory layer.

---

## 1. No Protected Health Information (PHI) Egress
Under HIPAA, transmitting Protected Health Information (PHI) to third-party APIs requires a Business Associate Agreement (BAA). 

* **Persyst Boundary**: Persyst runs **100% offline and locally**. All data storage (SQLite), vector embeddings (ONNX Runtime), and semantic matches are processed locally on the client machine or inside the enterprise private cloud.
* **No BAA Required**: Because Persyst does not store, transmit, or process data on its own servers (as there are none), Persyst does not act as a Business Associate. Healthcare organizations retain complete physical and logical custody of all files, logs, and database records.

---

## 2. Access Control and Technical Safeguards (§ 164.312)

### A. Access Control (§ 164.312(a))
* **Local OS Authentication**: Persyst inherits the underlying operating system's access controls. Files stored under the user's home directory (`~/.persyst/`) are protected by user-level directory permissions.
* **Namespace Isolation**: Multiprocess or swarm-based setups can partition data using namespace parameters, ensuring distinct sub-agents only query data specifically approved for their context scope.

### B. Audit Controls (§ 164.312(b))
* **Cryptographic Ledger**: Persyst automatically records a tamper-evident audit trail of all memories retrieved during AI developer sessions.
* **Tamper-Evident Chain**: Every retrieval event creates an Ed25519 signature linked to the previous block's hash. A list of all historical retrievals can be exported at any time via the `/compliance/export` endpoint to prove no unauthorized context leaks or manual data modifications occurred.

### C. Transmission Security (§ 164.312(e))
* **No Cloud Transmission**: Data is never sent across public networks.
* **Local Loopback Encryption**: If the HTTP gateway is enabled, it binds strictly to `127.0.0.1` by default to prevent external listening. For multi-node swarms, TLS/HTTPS configuration is required.
