import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

const testDir = './test';
const files = readdirSync(testDir)
  .filter(f => (f.startsWith('test_') || f === 'smoke.js') && f.endsWith('.js'))
  .sort()
  .map(f => join(testDir, f));

console.log(`Running ${files.length} test files sequentially to prevent ONNX WASM memory/thread limits...`);

let failed = false;
for (const file of files) {
  console.log(`\n========================================`);
  console.log(`Running: ${file}`);
  console.log(`========================================`);

  const result = spawnSync(
    process.execPath,
    ['--test', file],
    {
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'test' },
      shell: false
    }
  );

  if (result.status !== 0) {
    console.error(`❌ Test file failed: ${file}`);
    failed = true;
  } else {
    console.log(`✅ Test file passed: ${file}`);
  }
}

if (failed) {
  process.exit(1);
} else {
  console.log('\n🎉 All test files passed successfully!');
  process.exit(0);
}
