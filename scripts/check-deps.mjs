#!/usr/bin/env node
// Enforces the package dependency direction described in CLAUDE.md.
// Each workspace package may only depend on the internal packages listed here.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ALLOW = {
  '@agon/spec': [],
  '@agon/db': ['@agon/spec'],
  '@agon/llm': ['@agon/spec'],
  '@agon/adapters': ['@agon/spec'],
  '@agon/exporters': ['@agon/spec'],
  '@agon/engine': ['@agon/spec', '@agon/llm', '@agon/adapters'],
  '@agon/sdk': [],
  '@agon/server': [
    '@agon/spec',
    '@agon/db',
    '@agon/llm',
    '@agon/adapters',
    '@agon/engine',
    '@agon/exporters',
    '@agon/integrations',
  ],
  '@agon/integrations': ['@agon/spec'],
  '@agon/cli': ['@agon/spec', '@agon/llm', '@agon/adapters', '@agon/engine', '@agon/exporters', '@agon/sdk'],
  '@agon/ui': ['@agon/sdk'],
  '@agon/demo-app': [],
};

const roots = ['packages', 'examples'];
const problems = [];
let checked = 0;

for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const dir of readdirSync(root)) {
    const pkgPath = join(root, dir, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const allowed = ALLOW[pkg.name];
    if (!allowed) {
      problems.push(`${pkgPath}: package "${pkg.name}" is not registered in scripts/check-deps.mjs`);
      continue;
    }
    checked++;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies });
    for (const dep of deps) {
      if (dep.startsWith('@agon/') && !allowed.includes(dep)) {
        problems.push(`${pkgPath}: "${pkg.name}" may not depend on "${dep}" (allowed: ${allowed.join(', ') || 'none'})`);
      }
    }
  }
}

if (problems.length) {
  console.error('Dependency direction violations:\n' + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log(`check-deps: ${checked} packages OK`);
