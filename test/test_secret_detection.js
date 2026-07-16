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

  await t.test('9. AWS Secret Key with slashes/plus/equals', () => {
    const raw = 'aws_secret=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    const expected = 'aws_secret=[REDACTED]';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('10. Database Connection Strings', () => {
    assert.equal(
      redactSecrets('mongodb://admin:password123@cluster0.example.net/db'),
      'mongodb://admin:[REDACTED]@cluster0.example.net/db'
    );
    assert.equal(
      redactSecrets('mongodb+srv://user:my+secret-pass@cluster.mongodb.net/test?retryWrites=true'),
      'mongodb+srv://user:[REDACTED]@cluster.mongodb.net/test?retryWrites=true'
    );
    assert.equal(
      redactSecrets('postgresql://postgres:secret_pass@localhost:5432/mydb'),
      'postgresql://postgres:[REDACTED]@localhost:5432/mydb'
    );
    assert.equal(
      redactSecrets('redis://:myredispassword@redis-server:6379'),
      'redis://:[REDACTED]@redis-server:6379'
    );
  });

  await t.test('11. SSH passphrase', () => {
    const raw = 'ssh_passphrase=MySSHKeyPassphrase123';
    const expected = 'ssh_passphrase=[REDACTED]';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('12. Password with all printable special characters', () => {
    const raw = 'password=Test!@#$%^&*()_+-=[]{}|;\':",./<>?`~';
    const expected = 'password=[REDACTED]';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('13. Quoted multiline secrets', () => {
    const raw = `password="line1
line2
line3"`;
    const expected = 'password="[REDACTED]"';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('14. URL with credentials preserves subdomain and path structure', () => {
    const raw = 'https://user:password123@api.example.com/endpoint';
    const expected = 'https://user:[REDACTED]@api.example.com/endpoint';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('15. Technical terms (Base64, SHA256, IPv4) should not be redacted', () => {
    const raw = 'Base64-like string: password=SGVsbG8gV29ybGQ= with SHA256 and IPv4 address 127.0.0.1';
    const expected = 'Base64-like string: password=[REDACTED] with SHA256 and IPv4 address 127.0.0.1';
    assert.equal(redactSecrets(raw), expected);
  });

  await t.test('16. Unquoted multiline secrets with continuation lines', () => {
    // Test 141
    assert.equal(
      redactSecrets('password=line1\nline2\nline3'),
      'password=[REDACTED]'
    );
    // Test 142
    assert.equal(
      redactSecrets('api_key=sk-test-abc123\ndef456\nghi789'),
      'api_key=[REDACTED]'
    );
    // Test 143
    assert.equal(
      redactSecrets('secret=firstpart\nsecondpart\nthirdpart'),
      'secret=[REDACTED]'
    );
    // Verify that it doesn't match the next key-value line
    assert.equal(
      redactSecrets('password=SimplePassword\nusername=admin'),
      'password=[REDACTED]\nusername=admin'
    );
    // Verify that it doesn't match normal prose lines with spaces
    assert.equal(
      redactSecrets('password=MyPassword\nThis is a normal sentence.'),
      'password=[REDACTED]\nThis is a normal sentence.'
    );
  });

  await t.test('17. JSON credentials with quotes around keyword and trailing special characters', () => {
    // Test 145
    assert.equal(
      redactSecrets('{"password": "SuperSecret123!"}'),
      '{"password": "[REDACTED]"}'
    );
    assert.equal(
      redactSecrets('{"api_key": "sk-live-abc123!!!"}'),
      '{"api_key": "[REDACTED]"}'
    );
  });

  await t.test('18. Non-sensitive strings should NOT be redacted', () => {
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

