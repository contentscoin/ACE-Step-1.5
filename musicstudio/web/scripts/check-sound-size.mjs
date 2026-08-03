/**
 * Requirement 32.17 — the sound runtime, gzipped, must stay at or under 20 KB.
 *
 * ### What is measured, and why it is measured this way
 *
 * The clause says "오디오 자산을 제외한 사운드 재생 런타임 코드의 압축 후 전송 크기". Two words
 * decide the method:
 *
 * - **런타임 코드**: the modules under `src/sound/` and the sound components, and nothing else.
 *   Measuring the whole bundle would pass today and keep passing after the sound layer tripled,
 *   because React dwarfs it.
 * - **압축 후 전송**: gzip of the *bundled and minified* output, not of the sources. Source bytes
 *   are three or four times the shipped bytes and would fail a budget the product actually meets;
 *   raw bundled bytes would pass one it does not.
 *
 * So this builds exactly those modules with esbuild — the bundler Vite already ships — minified,
 * and gzips the result. `SEMANTIC_CUES` is 78 entries of Korean text and is by far the largest
 * part, which is the point: the budget is what stops the table growing without anyone noticing.
 *
 * Run by `npm run build` before `vite build`, so a violation produces no artefact.
 */

import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';

import * as esbuild from 'esbuild';

/** Requirement 32.17. */
const BUDGET_BYTES = 20 * 1024;

/**
 * Everything a page pays for by using the sound layer, as **one** entry.
 *
 * One synthetic module rather than four entry points, because four bundles would each carry a
 * copy of `cues.ts` and the measurement would report roughly four times the shipped size — a
 * budget that fails for a reason the product does not have.
 */
const ENTRY_MODULES = [
  './src/sound/layer.ts',
  './src/sound/context.tsx',
  './src/components/sound/CueAnnouncer.tsx',
  './src/components/sound/SoundSettingsPanel.tsx',
];

const root = fileURLToPath(new URL('..', import.meta.url));

const result = await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: ENTRY_MODULES.map((module) => `export * from '${module}';`).join('\n'),
    resolveDir: root,
    sourcefile: 'sound-runtime.ts',
    loader: 'ts',
  },
  bundle: true,
  minify: true,
  format: 'esm',
  write: false,
  // React and the shared style module are paid for by the rest of the app; the clause is about
  // the *sound playback runtime*, and bundling React into this measurement would make the budget
  // unmeetable for reasons that have nothing to do with sound.
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  logLevel: 'silent',
});

const bundled = Buffer.concat(result.outputFiles.map((file) => Buffer.from(file.contents)));
const gzipped = gzipSync(bundled, { level: 9 });

const kb = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;

if (gzipped.byteLength > BUDGET_BYTES) {
  console.error(
    `사운드 런타임 크기 초과 (Req 32.17): ${kb(gzipped.byteLength)} > ${kb(BUDGET_BYTES)}`,
  );
  console.error(`  번들: ${kb(bundled.byteLength)} · gzip: ${kb(gzipped.byteLength)}`);
  console.error('  줄이려면: 큐 문구를 짧게, 또는 표를 지연 로드로 분리하세요.');
  process.exit(1);
}

console.log(
  `sound size check: 통과 — gzip ${kb(gzipped.byteLength)} / ${kb(BUDGET_BYTES)} ` +
    `(번들 ${kb(bundled.byteLength)})`,
);
