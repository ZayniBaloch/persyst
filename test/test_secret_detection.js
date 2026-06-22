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
  });

  await t.test('6. Non-sensitive strings should NOT be redacted', () => {
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
