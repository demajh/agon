// Copies the built-in persona library into dist so the published package is self-contained.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../personas');
const target = resolve(here, '../dist/builtin-personas');
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, {
  recursive: true,
  filter: (src) => !src.endsWith('.md') || src === source,
});
