# Sample Compliance Audit Trail Output

This document contains a structured example of the JSON data returned from the `/compliance/export` endpoint. This ledger is used by security compliance officers to audit the queries, retrieved memories, and system integrity of the Persyst local-first memory layer.

---

## JSON Audit Ledger Example

```json
{
  "summary": {
    "exported_at": "2026-06-26T14:43:00.000Z",
    "start_date": "2026-06-01T00:00:00.000Z",
    "end_date": "2026-06-26T23:59:59.000Z",
    "total_attestations": 1,
    "system_integrity": "SECURE"
  },
  "agent_stats": [
    {
      "agent_id": "antigravity-worker",
      "memories_created": 15,
      "memories_confirmed": 22,
      "memories_contradicted": 0,
      "reputation_score": 23.0,
      "last_active": 1782485000
    },
    {
      "agent_id": "roo-worker",
      "memories_created": 4,
      "memories_confirmed": 6,
      "memories_contradicted": 1,
      "reputation_score": 3.5,
      "last_active": 1782484900
    }
  ],
  "attestations": [
    {
      "id": 42,
      "attestation_id": "b96870d0-fb16-4171-8bc6-52c6f114c00e",
      "query": "How is database connection configured in this project?",
      "timestamp": "2026-06-26T14:40:00.000Z",
      "agent_id": "roo-worker",
      "session_id": "session_88a91c",
      "signature": "8a32a67e81b6748b64e...86fbc86a",
      "previous_hash": "4a5c6d7e8f90a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
      "hash": "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b67a8b9c0d1e2f3a",
      "memories_retrieved": [
        {
          "id": 5,
          "content_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "score": 0.8845
        }
      ]
    }
  ]
}
```

---

## Verification of Sample Signatures

Compliance scripts can verify this trail programmatically:

```javascript
import { verifyChainIntegrity } from 'persyst/src/attestation.js';

// Verify the latest node in the audit log
const result = verifyChainIntegrity("b96870d0-fb16-4171-8bc6-52c6f114c00e");
if (result.valid) {
  console.log("✅ Audit trail verification passed. No modifications detected.");
} else {
  console.error("❌ Audit trail tampered with:", result.error);
}
```
