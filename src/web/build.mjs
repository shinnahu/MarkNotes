// Bundles the UI into dist/ (served to WebView2 from <exe>\web).
//   node build.mjs           production build
//   node build.mjs --watch   rebuild on change (dev)
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = process.env.MARKNOTES_WEB_OUT || 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('src/index.html', `${outdir}/index.html`);
cpSync('src/assets', `${outdir}/assets`, { recursive: true });
// The Spine Runtimes' license and copyright notice go with any copy of them.
mkdirSync(`${outdir}/licenses`, { recursive: true });
cpSync('node_modules/@esotericsoftware/spine-player/LICENSE', `${outdir}/licenses/spine-runtimes-LICENSE.txt`);

const options = {
  entryPoints: { app: 'src/main.jsx' },
  bundle: true,
  splitting: true,
  format: 'esm',
  outdir,
  target: ['chrome110'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  legalComments: 'none',
  chunkNames: 'chunks/[name]-[hash]',
  loader: { '.svg': 'text' },
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
