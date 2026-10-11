import { build } from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import octicons from '@primer/octicons';

const root = new URL('./', import.meta.url);
const dist = new URL('dist/', root);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL('src/main.js', root))],
  bundle: true,
  minify: true,
  outdir: fileURLToPath(dist),
  entryNames: 'assets/site',
  target: ['es2020'],
});
const template = await readFile(new URL('index.html', root), 'utf8');
const html = template.replace(/\{\{icon:([\w-]+)\}\}/g, (_, name) =>
  octicons[name].toSVG({ width: 18, height: 18, 'aria-hidden': 'true' }));
await writeFile(new URL('index.html', dist), html);
await cp(new URL('public/', root), dist, { recursive: true });
