import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

// Forbidden words are built from fragments so this file does not trip its own scan.
const FORBIDDEN = [
  ['acc', 'ount'], ['con', 'tact'], ['amo', 'unt'], ['e', 'mail'], ['pho', 'ne'], ['reve', 'nue'], ['curr', 'ency'],
].map((parts) => parts.join(''));
const FORBIDDEN_RE = new RegExp(FORBIDDEN.join('|'), 'i');

const ENGINE_DIR = join(root, 'app', 'lib', 'pipeline');
const ENGINE_FILES = ['sku-matching.js', 'pipeline-demand.js', 'burn-down.js'];

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

const engineFiles = walk(ENGINE_DIR).filter((p) => p.endsWith('.js'));
const testFiles = walk(join(root, 'test')).filter((p) => p !== self && /\.(js|mjs|cjs|json)$/.test(p));

function offenders(files) {
  const bad = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const token of code.match(/[A-Za-z_$][\w$-]*/g) ?? []) {
      if (FORBIDDEN_RE.test(token)) bad.push(`${file}: ${token}`);
    }
  }
  return bad;
}

test('all three engine files exist', () => {
  for (const f of ENGINE_FILES) assert.ok(existsSync(join(ENGINE_DIR, f)), f);
});

test('privacy: no identifiers like account/contact/amount/email/phone in engine code', () => {
  assert.deepEqual(offenders(engineFiles), []);
});

test('privacy: no such identifiers in tests or fixtures (excluding this file)', () => {
  assert.deepEqual(offenders(testFiles), []);
});

test('purity: no clock reads, randomness or network in engine code', () => {
  const rules = [
    [/Date\s*\.\s*now/, 'Date.now'],
    [/new\s+Date\s*\(\s*\)/, 'new Date()'],
    [/Math\s*\.\s*random/, 'Math.random'],
    [/\bfetch\s*\(/, 'fetch'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bprocess\s*\.\s*env\b/, 'process.env'],
    [/\brequire\s*\(/, 'require'],
    [/from\s+['"]node:(?:http|https|net|dgram|child_process|fs)/, 'node io import'],
  ];
  const bad = [];
  for (const file of engineFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const [re, label] of rules) if (re.test(code)) bad.push(`${file}: ${label}`);
  }
  assert.deepEqual(bad, []);
});

test('module layout: named exports only, no default exports', () => {
  for (const file of engineFiles) {
    const code = stripComments(readFileSync(file, 'utf8'));
    assert.equal(/export\s+default/.test(code), false, file);
  }
});

test('imports: only pipeline-demand may import, and only ./sku-matching.js', () => {
  for (const f of ENGINE_FILES) {
    const code = stripComments(readFileSync(join(ENGINE_DIR, f), 'utf8'));
    const specs = [...code.matchAll(/(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)]
      .map((m) => m[1] ?? m[2]);
    const allowed = f === 'pipeline-demand.js' ? ['./sku-matching.js'] : [];
    assert.deepEqual(specs.filter((s) => !allowed.includes(s)), [], f);
    assert.equal(/\bimport\s*['"]/.test(code), false, `${f} side-effect import`);
  }
});
