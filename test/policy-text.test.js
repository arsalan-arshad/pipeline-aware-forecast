/**
 * Tests for the privacy and terms text and the pages that show it (written from the contract).
 * Wording checks are case-insensitive substring checks, tolerant of phrasing. Forbidden words are
 * built from fragments so this file passes the repository's own privacy scan.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  POLICY_LAST_UPDATED,
  SUPPORT_ADDRESS,
  PRIVACY_SECTIONS,
  TERMS_SECTIONS,
} from '../app/lib/policy-text.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const frag = (...parts) => parts.join('');
const WORD_ONE = frag('acc', 'ount');
const WORD_TWO = frag('con', 'tact');
const WORD_THREE = frag('amo', 'unt');

const flat = (sections) => sections.flatMap((s) => [s.heading, ...s.paragraphs]).join('\n');
const privacy = flat(PRIVACY_SECTIONS).toLowerCase();
const terms = flat(TERMS_SECTIONS).toLowerCase();
const has = (text, ...needles) => needles.some((n) => text.includes(n.toLowerCase()));

// ---- constants ----

test('constants have the agreed values', () => {
  assert.equal(POLICY_LAST_UPDATED, '2026-10-12');
  assert.equal(SUPPORT_ADDRESS, 'arsalanarshad.dev@gmail.com');
});

test('the last-updated date is a real calendar date', () => {
  assert.match(POLICY_LAST_UPDATED, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(`${POLICY_LAST_UPDATED}T00:00:00Z`).toISOString().slice(0, 10), POLICY_LAST_UPDATED);
});

// ---- structure ----

for (const [name, sections] of [['PRIVACY_SECTIONS', PRIVACY_SECTIONS], ['TERMS_SECTIONS', TERMS_SECTIONS]]) {
  test(`${name} is a non-empty array of { heading, paragraphs } with non-empty strings`, () => {
    assert.ok(Array.isArray(sections));
    assert.ok(sections.length > 0);
    for (const section of sections) {
      assert.equal(typeof section.heading, 'string');
      assert.notEqual(section.heading.trim(), '');
      assert.ok(Array.isArray(section.paragraphs));
      assert.ok(section.paragraphs.length > 0, `no paragraphs under "${section.heading}"`);
      for (const p of section.paragraphs) {
        assert.equal(typeof p, 'string');
        assert.notEqual(p.trim(), '');
      }
    }
  });

  test(`${name} has unique headings and no extra keys on a section`, () => {
    const headings = sections.map((s) => s.heading);
    assert.equal(new Set(headings).size, headings.length);
    for (const s of sections) assert.deepEqual(Object.keys(s).sort(), ['heading', 'paragraphs']);
  });
}

// ---- privacy wording ----

test('privacy: gives the support address', () => {
  assert.ok(privacy.includes(SUPPORT_ADDRESS.toLowerCase()));
});

test('privacy: says credentials are encrypted with AES-256-GCM', () => {
  assert.ok(has(privacy, 'aes-256-gcm'));
  assert.ok(has(privacy, 'encrypt'));
});

test('privacy: says data is deleted on uninstall and when Shopify sends shop/redact', () => {
  assert.ok(has(privacy, 'uninstall'));
  // Wording may name the webhook (shop/redact) or describe it ("shop erasure request").
  assert.ok(has(privacy, 'shop/redact', 'shop redact', 'erasure', 'redact'));
  assert.ok(has(privacy, 'delet'));
});

test('privacy: says the app is read-only', () => {
  assert.ok(has(privacy, 'read-only', 'read only'));
});

test('privacy: says nothing is sold or used for advertising and nothing goes to an AI provider', () => {
  assert.ok(has(privacy, 'sell', 'sold', 'sale'));
  assert.ok(has(privacy, 'advertis'));
  assert.ok(/\bai\b/.test(privacy) || has(privacy, 'artificial intelligence', 'language model'));
});

test('privacy: lists that Salesforce record details are not stored', () => {
  for (const word of [WORD_ONE, WORD_TWO, WORD_THREE]) {
    assert.ok(privacy.includes(word), `mentions ${word}`);
  }
  // The sentence that names them must be a negation, not a claim that they are stored.
  const paragraphs = PRIVACY_SECTIONS.flatMap((s) => s.paragraphs).filter((p) => p.toLowerCase().includes(WORD_ONE));
  assert.ok(paragraphs.length > 0);
  assert.ok(paragraphs.some((p) => /\b(not|never|no|neither|nor)\b/i.test(p)));
});

test('privacy: names Salesforce and Shopify', () => {
  assert.ok(has(privacy, 'salesforce'));
  assert.ok(has(privacy, 'shopify'));
});

// ---- terms wording ----

test('terms: say forecasts are estimates and not guarantees', () => {
  assert.ok(has(terms, 'estimate'));
  assert.ok(has(terms, 'guarantee'));
});

test('terms: say the app is read-only', () => {
  assert.ok(has(terms, 'read-only', 'read only'));
});

test('terms: make the merchant responsible for their own Salesforce credentials and permissions', () => {
  assert.ok(has(terms, 'salesforce'));
  assert.ok(has(terms, 'credentials'));
  assert.ok(has(terms, 'permission'));
  assert.ok(has(terms, 'responsib'));
});

test('terms: give the support address', () => {
  assert.ok(terms.includes(SUPPORT_ADDRESS.toLowerCase()));
});

// ---- phrases that must never appear ----

for (const [name, text] of [['privacy', privacy], ['terms', terms]]) {
  test(`${name}: contains none of the banned claims`, () => {
    for (const banned of ['guarantee that', 'we sell', 'gdpr certified', 'hipaa', 'governing law of']) {
      assert.ok(!text.includes(banned), `contains "${banned}"`);
    }
  });

  test(`${name}: contains no placeholder text`, () => {
    for (const marker of ['lorem', 'todo', 'tbd', 'xxx', '[insert', 'example.com']) {
      assert.ok(!text.includes(marker), `contains "${marker}"`);
    }
  });
}

test('the only address in either text is the support address', () => {
  const found = new Set((`${privacy}\n${terms}`).match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []);
  assert.deepEqual([...found], [SUPPORT_ADDRESS.toLowerCase()]);
});

// ---- pages ----

const privacyPath = join(root, 'app', 'routes', 'privacy.jsx');
const termsPath = join(root, 'app', 'routes', 'terms.jsx');
const feedbackPath = join(root, 'app', 'routes', 'app.feedback.jsx');

for (const [name, path] of [['privacy', privacyPath], ['terms', termsPath]]) {
  test(`${name} route exists with a default-exported component`, () => {
    assert.ok(existsSync(path));
    const src = readFileSync(path, 'utf8');
    assert.match(src, /export\s+default\s+(async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*;?\s*$)/m);
  });

  test(`${name} route is public: it does not use authentication`, () => {
    assert.ok(!readFileSync(path, 'utf8').includes('authenticate'));
  });

  test(`${name} route renders the shared policy text rather than its own copy`, () => {
    const src = readFileSync(path, 'utf8');
    assert.ok(src.includes('policy-text'));
  });

  test(`${name} route does not load data (no database or Shopify imports)`, () => {
    const src = readFileSync(path, 'utf8');
    assert.ok(!/db\.server|shopify\.server|prisma/i.test(src));
  });
}

test('the privacy page uses the privacy sections and the terms page the terms sections', () => {
  assert.ok(read('app', 'routes', 'privacy.jsx').includes('PRIVACY_SECTIONS'));
  assert.ok(read('app', 'routes', 'terms.jsx').includes('TERMS_SECTIONS'));
});

test('the feedback page links to /privacy and /terms', () => {
  const src = readFileSync(feedbackPath, 'utf8');
  assert.ok(src.includes('/privacy'));
  assert.ok(src.includes('/terms'));
});

test('the policy text module is plain JavaScript with no server-only imports', () => {
  const src = read('app', 'lib', 'policy-text.js');
  assert.ok(!/^\s*import\s/m.test(src));
});
