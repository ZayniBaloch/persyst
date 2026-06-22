import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/database.js';

test('Secret Redaction on Write', async (t) => {
  await t.test('1. OpenAI standalone key redaction', () => {
    const raw = 'The OpenAI API key is sk-123456789012345678901234567890123456789012345678.';
    const expected = 'The OpenAI API key is [REDACTED].';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('2. OpenAI Project standalone key redaction', () => {
    const raw = 'The key is sk-proj-123456789012345678901234567890123456789012345678.';
    const expected = 'The key is [REDACTED].';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('3. GitHub PAT standalone redaction', () => {
    const raw = 'My github token is ghp_123456789012345678901234567890123456';
    const expected = 'My github token is [REDACTED]';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('4. Google API Key standalone redaction', () => {
    const raw = 'Use Google API key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q';
    const expected = 'Use Google API key [REDACTED]';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('5. Key-value style credential redaction (quoted and unquoted)', () => {
    assert.equal(redactSecrets('password = "mypassword123"'), 'password = "[REDACTED]"');
    assert.equal(redactSecrets('api_key: \'mysecretkey123\''), 'api_key: \'[REDACTED]\'');
    assert.equal(redactSecrets('pwd: abcdef123'), 'pwd: [REDACTED]');
    assert.equal(redactSecrets('secret is topsecret1'), 'secret is [REDACTED]');
    assert.equal(redactSecrets('the password (SuperSecret!2026)'), 'the password ([REDACTED])');
    assert.equal(redactSecrets('AWS access key is AKIAFAKEKEY9988776655'), 'AWS access key is [REDACTED]');
    assert.equal(
      redactSecrets('The AWS-key-shaped string (AKIAFAKEKEY9988776655) and the password (SuperSecret!2026)'),
      'The AWS-key-shaped string ([REDACTED]) and the password ([REDACTED])'
    );
    assert.equal(
      redactSecrets('the password uses Tr0ub4dor&3'),
      'the password uses [REDACTED]'
    );
    assert.equal(
      redactSecrets('our AWS key for X is AKIAQWERTYUIOP123456'),
      'our AWS key for X is [REDACTED]'
    );
  });

  await t.test('6. npm token standalone redaction', () => {
    const raw = 'The npm token npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij is available.';
    const expected = 'The npm token [REDACTED] is available.';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('7. JWT token standalone redaction', () => {
    const raw = 'JWT token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQs';
    const expected = 'JWT token: [REDACTED]';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('8. PEM Private key redaction', () => {
    const raw = `Here is the private key:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0y...
-----END RSA PRIVATE KEY-----
Keep it safe.`;
    const expected = `Here is the private key:
[REDACTED]
Keep it safe.`;
    assert.equal(redactSecrets(raw), expected);

    assert.equal(redactSecrets(`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEINT3Z1g=
-----END PRIVATE KEY-----`), '[REDACTED]');

    assert.equal(redactSecrets(`-----BEGIN PGP PRIVATE KEY BLOCK-----
Version: GnuPG v2
mQENBF2...
-----END PGP PRIVATE KEY BLOCK-----`), '[REDACTED]');
  });

  await t.test('9. Non-sensitive strings should NOT be redacted', () => {
    const texts = [
      'The password reset flow was fixed.',
      'Always secure your api_key in dotenv files.',
      'Authentication token verification was added to endpoints.',
      'The server is running on port 3000.'
    ];
    for (const text of texts) {
      assert.equal(redactSecrets(text), text);
    }
  });
});

