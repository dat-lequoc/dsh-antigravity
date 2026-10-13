// The token block is the only UI the plugin renders from locally counted data,
// so the rendering rules are pinned here: it stays hidden until something has
// been counted, the compact figure is what users read, and the exact count stays
// available in the title attribute.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function extractUsageHelpers() {
  const start = source.indexOf('    function formatTokenCount(');
  const end = source.indexOf('    function QuotaPanel(');
  assert.ok(start > 0 && end > start, 'usage helpers not found in client.js');

  const context = {
    // Minimal element stub: enough to walk the tree the component builds.
    React: {
      createElement: (type, props, ...children) => ({
        type,
        props: props || {},
        children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
      }),
    },
    Number, String, Math, Array, Boolean, isFinite,
  };

  return vm.runInNewContext(
    source.slice(start, end) + '\n({ UsageStats, formatTokenCount, exactTokenCount })',
    context,
  );
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return textOf(node.children);
}

function titlesOf(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((child) => titlesOf(child, out)); return out; }
  if (typeof node.props?.title === 'string') out.push(node.props.title);
  titlesOf(node.children, out);
  return out;
}

// Echoes the key and interpolates {count}, like the real locale helper does.
const t = (key, params) =>
  params && typeof params === 'object'
    ? `${key}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(',')})`
    : key;

const sample = {
  requests: 7,
  inputTokens: 1010,
  outputTokens: 355,
  cacheReadTokens: 120,
  totalTokens: 1365,
  todayTokens: 420,
  scope: 'local',
};

test('the token block stays hidden until something has been counted', () => {
  const { UsageStats } = extractUsageHelpers();
  assert.equal(UsageStats({ usage: undefined, t }), null);
  assert.equal(UsageStats({ usage: { requests: 0, totalTokens: 0 }, t }), null);
});

test('the block shows a compact total and keeps exact counts in titles', () => {
  const { UsageStats } = extractUsageHelpers();
  const tree = UsageStats({ usage: sample, t });
  const text = textOf(tree);

  assert.match(text, /tokensTitle/);
  assert.match(text, /1\.4K/, 'total renders in compact form');
  assert.match(text, /tokensInput/);
  assert.match(text, /tokensOutput/);
  assert.match(text, /tokensToday/);
  // Label/value pairs are separate nodes, so match the compact values directly.
  assert.match(text, /\b1\.0K\b/, 'input renders compactly');
  assert.match(text, /\b355\b/, 'small output counts stay exact');
  assert.match(text, /tokensRequests\(count=7\)/);
  // The caveat is short and visible; the full explanation hangs off the title.
  assert.match(text, /tokensScopeShort/);
  assert.doesNotMatch(text, /tokensScope\(/, 'the long caveat must not be inline text');

  const titles = titlesOf(tree);
  assert.ok(titles.includes('tokensScope'), 'the full caveat should be available on hover');
  assert.ok(titles.some((title) => /1\D?365/.test(title)), `total exact count missing: ${titles.join('|')}`);
  assert.ok(titles.some((title) => /1\D?010/.test(title)), `input exact count missing: ${titles.join('|')}`);
  assert.ok(titles.some((title) => title === '355'), `output exact count missing: ${titles.join('|')}`);
  assert.ok(titles.some((title) => title === '420'), `today exact count missing: ${titles.join('|')}`);
});

test('the cached-input row appears only when the service reported cached tokens', () => {
  const { UsageStats } = extractUsageHelpers();
  const withCache = textOf(UsageStats({ usage: sample, t }));
  assert.match(withCache, /tokensCache/);

  const withoutCache = textOf(UsageStats({ usage: { ...sample, cacheReadTokens: 0 }, t }));
  assert.doesNotMatch(withoutCache, /tokensCache/);
});

test('token counts format compactly across the whole range', () => {
  const { formatTokenCount } = extractUsageHelpers();
  assert.equal(formatTokenCount(0), '0');
  assert.equal(formatTokenCount(999), '999');
  assert.equal(formatTokenCount(1000), '1.0K');
  assert.equal(formatTokenCount(12345), '12K');
  assert.equal(formatTokenCount(1234567), '1.23M');
  assert.equal(formatTokenCount(12345678), '12.3M');
  assert.equal(formatTokenCount(1.5e9), '1.50B');
  // Defensive: the store can hand back nothing at all.
  assert.equal(formatTokenCount(undefined), '0');
  assert.equal(formatTokenCount(Number.NaN), '0');
});

// The token block first shipped as unstyled text: the client module reloaded
// while the injected <style> survived in the DOM, and installStyle() returned
// early because a tag with that id already existed, so the new markup was paired
// with the old stylesheet. These two tests pin the fix and the class contract.
function extractStyleInstaller() {
  const start = source.indexOf('    function installStyle() {');
  const marker = source.indexOf('document.head.append(style);', start);
  assert.ok(start > 0 && marker > start, 'installStyle not found in client.js');
  const end = source.indexOf('\n    }', marker);
  const styleId = /const STYLE_ID = "([^"]+)"/.exec(source)?.[1];
  assert.ok(styleId, 'STYLE_ID not found in client.js');
  return { body: source.slice(start, end + '\n    }'.length), styleId };
}

function runInstallStyle(existing) {
  const { body, styleId } = extractStyleInstaller();
  const appended = [];
  const created = [];
  const document = {
    getElementById: (id) => (existing && existing.id === id ? existing : null),
    createElement: () => {
      const element = { id: '', textContent: '' };
      created.push(element);
      return element;
    },
    head: { append: (element) => appended.push(element) },
  };
  vm.runInNewContext(`const STYLE_ID = ${JSON.stringify(styleId)};\n${body}\ninstallStyle();`, { document, console });
  return { appended, created, existing };
}

test('a client reload refreshes the stylesheet instead of keeping the old one', () => {
  const stale = { id: 'dsh-antigravity-settings-style', textContent: '.dsha-usage{color:red}' };
  const { appended, existing } = runInstallStyle(stale);

  assert.equal(appended.length, 0, 'must not append a duplicate style tag');
  assert.notEqual(existing.textContent, '.dsha-usage{color:red}', 'stale stylesheet was not replaced');
  assert.match(existing.textContent, /\.dsha-usage\{/, 'refreshed stylesheet is missing the token block');
  assert.match(existing.textContent, /\.dsha-quota-group\{/, 'refreshed stylesheet dropped earlier rules');
});

test('the first install still creates and appends the style tag', () => {
  const { appended, created } = runInstallStyle(null);
  assert.equal(appended.length, 1);
  assert.equal(created.length, 1);
  assert.equal(appended[0].id, 'dsh-antigravity-settings-style');
  assert.match(appended[0].textContent, /\.dsha-usage\{/);
});

test('every class the token block renders has a matching style rule', () => {
  const start = source.indexOf('    function UsageStats(');
  const end = source.indexOf('    function QuotaPanel(');
  const slice = source.slice(start, end);
  const classes = [...new Set([...slice.matchAll(/className: "([^"]+)"/g)].map((match) => match[1]))];
  assert.ok(classes.length >= 8, `expected the token block classes, found ${classes.join(', ')}`);

  const styleStart = source.indexOf('style.textContent = `');
  const stylesheet = source.slice(styleStart, source.indexOf('`;', styleStart));
  for (const className of classes) {
    assert.match(stylesheet, new RegExp(`\\.${className}[{:]`), `${className} has no style rule`);
  }
});
