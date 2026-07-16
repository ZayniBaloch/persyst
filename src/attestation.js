/**
 * attestation.js — Cryptographic Attestation Engine
 * 
 * Implements Ed25519 signature generation and verification for search queries.
 * Chains each attestation by linking to the hash of the previous one.
 */

import crypto from 'crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import db, { stmts, getLastAttestation, insertAttestation, getAttestationById } from './database.js';

const KEYS_DIR = join(homedir(), '.persyst', 'keys');

/**
 * Initialize keypair if it doesn't already exist.
 */
export function initializeKeys() {
  mkdirSync(KEYS_DIR, { recursive: true });
  const pubPath = join(KEYS_DIR, 'public.pem');
  const privPath = join(KEYS_DIR, 'private.pem');

  if (!existsSync(pubPath) || !existsSync(privPath)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    writeFileSync(pubPath, publicKey);
    writeFileSync(privPath, privateKey);
    console.error('[persyst] Generated new Ed25519 keypair for attestation');
  }
}

/**
 * Read private key.
 */
function getPrivateKey() {
  const privPath = join(KEYS_DIR, 'private.pem');
  return readFileSync(privPath, 'utf8');
}

/**
 * Read public key.
 */
export function getPublicKey() {
  const pubPath = join(KEYS_DIR, 'public.pem');
  return readFileSync(pubPath, 'utf8');
}

/**
 * Generate a new attestation for search results.
 */
export function createAttestation(query, memories, agentId = null, sessionId = null) {
  initializeKeys();

  const attestationId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  // Map memories to {id, content_hash, score}
  const memoriesRetrieved = memories.map(m => {
    const contentHash = crypto.createHash('sha256').update(m.content).digest('hex');
    let scoreVal = 0;
    if (m.hybrid_score !== undefined && m.hybrid_score !== null) {
      scoreVal = m.hybrid_score;
    } else if (m.score !== undefined && m.score !== null) {
      scoreVal = m.score;
    }
    return {
      id: m.id,
      content_hash: contentHash,
      score: Math.round(parseFloat(scoreVal) * 10000)
    };
  });

  // Fetch previous attestation hash for the hash chain
  const lastAtt = getLastAttestation();
  const previousHash = lastAtt ? lastAtt.hash : null;

  // Construct document to sign (ordered keys to ensure canonical serialization)
  const doc = {
    attestation_id: attestationId,
    query,
    timestamp,
    memories_retrieved: memoriesRetrieved,
    agent_id: agentId || null,
    session_id: sessionId || null,
    previous_hash: previousHash
  };

  const dataToSign = JSON.stringify(doc);

  // Sign document using Ed25519
  const privateKey = getPrivateKey();
  const signature = crypto.sign(null, Buffer.from(dataToSign), {
    key: privateKey,
    type: 'pkcs8',
    format: 'pem'
  }).toString('hex');

  // Construct full record and compute its hash
  const fullAttestation = {
    ...doc,
    signature
  };

  const hash = crypto.createHash('sha256').update(JSON.stringify(fullAttestation)).digest('hex');

  const record = {
    ...fullAttestation,
    hash
  };

  // Persist to DB
  insertAttestation(record);

  return record;
}

/**
 * Verify a single attestation record's signature and hash.
 */
export function verifyAttestationRecord(attestation) {
  try {
    const doc = {
      attestation_id: attestation.attestation_id,
      query: attestation.query,
      timestamp: attestation.timestamp,
      memories_retrieved: typeof attestation.memories_retrieved === 'string'
        ? JSON.parse(attestation.memories_retrieved)
        : attestation.memories_retrieved,
      agent_id: attestation.agent_id || null,
      session_id: attestation.session_id || null,
      previous_hash: attestation.previous_hash || null
    };

    const dataToSign = JSON.stringify(doc);
    const fullRecord = {
      ...doc,
      signature: attestation.signature
    };
    const computedHash = crypto.createHash('sha256').update(JSON.stringify(fullRecord)).digest('hex');

    // Check hash first — if it matches, doc reconstruction is correct
    const hashMatch = computedHash === attestation.hash;
    if (!hashMatch) {
      console.error('[persyst-attest] HASH MISMATCH for', attestation.attestation_id);
      console.error('[persyst-attest] stored hash:', attestation.hash);
      console.error('[persyst-attest] computed hash:', computedHash);
      console.error('[persyst-attest] doc:', JSON.stringify(doc));
      return { valid: false, error: 'Attestation hash mismatch' };
    }

    const publicKey = getPublicKey();

    // Verify signature
    const isSignatureValid = crypto.verify(
      null,
      Buffer.from(dataToSign),
      {
        key: publicKey,
        type: 'spki',
        format: 'pem'
      },
      Buffer.from(attestation.signature, 'hex')
    );

    if (!isSignatureValid) {
      console.error('[persyst-attest] SIG VERIFY FAIL for', attestation.attestation_id);
      console.error('[persyst-attest] Hash matches but signature invalid');
      console.error('[persyst-attest] dataToSign:', dataToSign);
      console.error('[persyst-attest] signature:', attestation.signature);
      console.error('[persyst-attest] public key:', publicKey);
      return { valid: false, error: 'Signature verification failed' };
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * Iteratively verifies signature and chain integrity.
 * Walks backwards from the target attestation to the genesis link,
 * confirming each previous_hash matches the predecessor's actual hash
 * and that sequence order strictly increases.
 */
export function verifyChainIntegrity(attestationId) {
  const att = getAttestationById(attestationId);
  if (!att) {
    return { valid: false, error: `Attestation not found: ${attestationId}` };
  }

  const selfVerify = verifyAttestationRecord(att);
  if (!selfVerify.valid) {
    return selfVerify;
  }

  // Iterative chain walk — no recursion, no stack overflow risk
  const MAX_CHAIN_DEPTH = 10000;
  let current = att;
  let depth = 0;

  while (current.previous_hash) {
    if (depth >= MAX_CHAIN_DEPTH) {
      return { valid: false, error: 'Broken chain: chain length exceeds maximum' };
    }

    const prevAtt = stmts.getAttestationByHash.get(current.previous_hash);
    if (!prevAtt) {
      return { valid: false, error: `Broken chain: Previous attestation with hash ${current.previous_hash} not found` };
    }

    if (prevAtt.hash !== current.previous_hash) {
      return { valid: false, error: 'Broken chain: previous_hash does not match predecessor hash' };
    }

    if (prevAtt.id >= current.id) {
      return { valid: false, error: 'Broken chain: Invalid sequence order' };
    }

    const prevVerify = verifyAttestationRecord(prevAtt);
    if (!prevVerify.valid) {
      return { valid: false, error: `Broken chain: Previous link is invalid: ${prevVerify.error}` };
    }

    current = prevAtt;
    depth++;
  }

  return { valid: true, attestation: current };
}
