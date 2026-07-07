import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const decoder = new TextDecoder('utf-8', { fatal: true });

const sourceRoots = ['src', 'server', 'scripts', 'test'];
const rootFiles = ['server.ts', 'vite.config.ts', 'index.html', 'package.json', 'README.md'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.html', '.css']);
const skipDirs = new Set(['node_modules', 'dist', '.git', '.apex-data', '.venv-litellm', '.python', '.codebase-memory']);

function collectSourceFiles(dir: string, files: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, files);
      continue;
    }
    if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function describeCharacter(char: string) {
  const codePoint = char.codePointAt(0) || 0;
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ${JSON.stringify(char)}`;
}

test('source files stay strict UTF-8 and ASCII-only', () => {
  const files = [
    ...sourceRoots.flatMap(root => collectSourceFiles(path.join(repoRoot, root))),
    ...rootFiles.map(file => path.join(repoRoot, file))
  ];
  const failures: string[] = [];

  for (const file of files) {
    const relativePath = path.relative(repoRoot, file).replace(/\\/g, '/');
    const bytes = fs.readFileSync(file);
    let text = '';

    try {
      text = decoder.decode(bytes);
    } catch (error: any) {
      failures.push(`${relativePath}: invalid UTF-8 (${error.message})`);
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (const [lineIndex, line] of lines.entries()) {
      for (const char of line) {
        const codePoint = char.codePointAt(0) || 0;
        if (codePoint > 127) {
          failures.push(`${relativePath}:${lineIndex + 1}: non-ASCII ${describeCharacter(char)}`);
          break;
        }
      }
      if (failures.length >= 20) break;
    }
    if (failures.length >= 20) break;
  }

  assert.deepEqual(failures, []);
});
