import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const files = [
  'src/index.cjs',
  'src/index.js',
  'test/collect.test.js',
  'scripts/lint.mjs',
  'examples/mcp-tools.mjs',
];
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
if (packageJson.license !== 'MIT') throw new Error('package license must be MIT');
if (Object.keys(packageJson.dependencies || {}).length > 0) throw new Error('runtime dependencies are not allowed');
