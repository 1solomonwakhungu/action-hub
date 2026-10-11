import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access, cp, mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const dist = new URL('../dist/', import.meta.url);
const html = await readFile(new URL('index.html', dist), 'utf8');

test('every local asset and anchor resolves under the Pages project path', async () => {
  for (const [, url] of html.matchAll(/(?:src|href|content)="(\/[^"]+)"/g)) {
    assert.ok(url.startsWith('/action-hub/'), url);
    await access(new URL(url.slice('/action-hub/'.length), dist));
  }
  for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(html.includes(`id="${id}"`), `Missing anchor ${id}`);
  }
  assert.ok(!html.includes('{{icon:'));
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
});

test('source-backed limitations and evaluation distinctions stay visible', () => {
  for (const phrase of [
    'Illustrative project figures', 'not universal MCP guarantees',
    'single-use and expire after five minutes', 'canonical argument hash',
    'not yet', 'argument hash or upstream version', '30 goal-only queries',
    'list_servers', 'Pinned bundles', 'not the shipped default',
    'metric to track, not an existing measured result',
    'current fixture has 121 rows',
    'Cold catalog indexing and refresh contact configured downstream servers',
    'call <code>listTools</code> before execution',
    'After indexing, runtime connections stay inactive',
    'hutsonlabs', 'QuanTradin', 'BC_MARO',
  ]) assert.ok(html.includes(phrase), phrase);
  assert.ok(!html.includes('not spawned or authenticated until'));
  assert.ok(!html.includes('\u2014'), 'No em dashes in site prose');
  assert.ok(html.includes('old.reddit.com/r/mcp/comments/1x2u6sb/'));
});

test('accessible interactions have static fallbacks and reduced-motion support', async () => {
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('aria-label="Copy Homebrew install commands"'));
  assert.equal((html.match(/data-step=/g) || []).length, 3);
  assert.ok(html.includes('id="step-detail"'));
  assert.ok(html.includes('class="skip-link"'));
  assert.ok((html.match(/role="img"/g) || []).length >= 2);
  const js = await readFile(new URL('assets/site.js', dist), 'utf8');
  assert.ok(js.includes('prefers-reduced-motion'));
  const css = await readFile(new URL('assets/site.css', dist), 'utf8');
  assert.ok(css.includes('prefers-reduced-motion'));
});

test('site builds from a filesystem path containing spaces', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'action hub site '));
  try {
    const site = new URL('../', import.meta.url);
    for (const path of ['build.mjs', 'package.json', 'index.html', 'src', 'public']) {
      await cp(new URL(path, site), join(temporary, path), { recursive: true });
    }
    const manifest = JSON.parse(await readFile(new URL('package.json', site), 'utf8'));
    assert.ok(manifest.devDependencies.esbuild, 'Site must declare its build dependency');
    const require = createRequire(import.meta.url);
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      const target = join(temporary, 'node_modules', name);
      await mkdir(dirname(target), { recursive: true });
      const modules = require.resolve.paths(name).find(path =>
        existsSync(join(path, name, 'package.json')));
      await symlink(join(modules, name), target,
        process.platform === 'win32' ? 'junction' : 'dir');
    }
    await promisify(execFile)(process.execPath, [join(temporary, 'build.mjs')]);
    await access(join(temporary, 'dist', 'assets', 'site.js'));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
