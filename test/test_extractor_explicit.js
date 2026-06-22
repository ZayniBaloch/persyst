import { extractHeuristic } from '../src/extractor-heuristic.js';

const tests = [
  { input: 'Remember: the staging server is flaky on Mondays', expectSave: true },
  { input: 'Note that John handles DB migrations, dont touch those files', expectSave: true },
  { input: "Don't forget the SSL cert expires March 15", expectSave: true },
  { input: 'FYI the client doesnt want emojis in any responses', expectSave: true },
  { input: 'Keep in mind that auth.js is legacy code, do not refactor it', expectSave: true },
  { input: 'Heads up: the API rate limit is 100 requests per minute', expectSave: true },
  { input: 'Remind me to check the deployment pipeline before releasing', expectSave: true },
  { input: 'Important: always run tests before merging to main', expectSave: true },
  // These should NOT be saved by explicit triggers:
  { input: 'how do I use typescript', expectSave: false },
  { input: 'what is the weather today', expectSave: false },
  // These should still be saved by implicit patterns:
  { input: 'we are using Postgres for our database', expectSave: true },
  { input: 'I prefer camelCase over snake_case for variable naming', expectSave: true },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const facts = extractHeuristic(t.input);
  const saved = facts.length > 0;
  const ok = saved === t.expectSave;
  
  const icon = ok ? '✅' : '❌';
  const status = ok ? 'OK' : `FAIL (expected ${t.expectSave ? 'save' : 'skip'}, got ${saved ? 'save' : 'skip'})`;
  
  console.log(`${icon} [${status}] "${t.input.slice(0, 60)}"`);
  if (facts.length > 0) {
    facts.forEach(f => console.log(`     -> ${f.content} ${f.explicit ? '[EXPLICIT]' : '[implicit]'} conf:${f.confidence}`));
  }
  console.log();
  
  if (ok) passed++; else failed++;
}

console.log(`Results: ${passed} passed, ${failed} failed`);
