// Bundles the UI into dist/ (served to WebView2 from <exe>\web).
//   node build.mjs              production build
//   node build.mjs --watch      rebuild on change (dev)
//   node build.mjs --no-spine   a build to share with others: without the Spine model player
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
// The Spine Runtimes may be passed on only by a Spine Editor licensee, or to people who each have a Spine Editor
// license, so builds meant for others leave the player out (.skel files are plain files there).
const spine = !process.argv.includes('--no-spine');
const outdir = process.env.MARKNOTES_WEB_OUT || 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });
cpSync('src/index.html', `${outdir}/index.html`);
cpSync('src/assets', `${outdir}/assets`, { recursive: true });
if (spine) {
  // The Spine Runtimes' license and copyright notice go with any copy of them.
  mkdirSync(`${outdir}/licenses`, { recursive: true });
  cpSync('node_modules/@esotericsoftware/spine-player/LICENSE', `${outdir}/licenses/spine-runtimes-LICENSE.txt`);
}

/** Without Spine, the Spine packages resolve to an empty module, so none of their code can reach the bundle. */
const noSpine = {
  name: 'no-spine',
  setup(b) {
    b.onResolve({ filter: /^@esotericsoftware\// }, (a) => ({ path: a.path, namespace: 'no-spine' }));
    b.onLoad({ filter: /.*/, namespace: 'no-spine' }, () => ({ contents: 'export {};', loader: 'js' }));
  },
};

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
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"', __SPINE__: String(spine) },
  plugins: spine ? [] : [noSpine],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
