/**
 * The half of Requirement 31 that needs a real browser (31.11, 31.12, 31.13, 31.14).
 *
 * ### Why this is a script and not a test
 *
 * happy-dom does no layout: every `getBoundingClientRect()` is zeros. So the *geometric* claims —
 * that the rendered boxes read in tab order, that the focus ring sits within 2 px of its element
 * while a transform is running — cannot be checked in the unit suite at all. They need a browser
 * with a layout engine.
 *
 * This session has Chromium and Playwright available, so the checks are written and they run. They
 * are **not in CI**: adding a browser install to the web job is a change that belongs with task
 * 9.3's end-to-end infrastructure rather than smuggled in here. Until then this is run by hand and
 * its output quoted, which is worth being explicit about — a check nobody runs is a claim.
 *
 * Usage: build, serve on 4173, then `node scripts/verify-a11y-browser.mjs`.
 */

import process from 'node:process';
import console from 'node:console';

import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';

const BASE = process.env.A11Y_BASE_URL ?? 'http://localhost:4173';

const ROUTES = [
  '#/generate',
  '#/library',
  '#/asset/asset-night-drive',
  '#/timeline',
  '#/mastering/asset-night-drive',
  '#/explore',
  '#/system',
];

/** Mirrors `src/a11y/focus.ts`. Kept in sync by `test/a11y/focus.test.ts`. */
const FOCUS_BOUNDARY_MAX_PX = 2;
const FOCUS_INDICATOR_MAX_DELAY_MS = 100;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });

const failures = [];
const report = [];

/** The reading-order rule from `src/a11y/reading-order.ts`, evaluated in the page. */
const READING_ORDER_IN_PAGE = `(selector, ratio) => {
  const boxes = [...document.querySelectorAll(selector)]
    .map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        label: (element.getAttribute('aria-label') || element.textContent || element.tagName)
          .trim().slice(0, 30),
        top: rect.top, left: rect.left, height: rect.height, width: rect.width,
      };
    })
    // Off-screen elements have no visual position to compare against. The skip link is the one
    // that matters here: it is deliberately at top -60 until focused.
    .filter((box) => box.width > 0 && box.height > 0 && box.top > -1000);

  const sameRow = (a, b) => {
    const overlap = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    const shorter = Math.min(a.height, b.height);
    return shorter <= 0 ? Math.abs(a.top - b.top) < 1 : overlap / shorter > ratio;
  };

  const rows = [];
  for (const box of [...boxes].sort((a, b) => a.top - b.top || a.left - b.left)) {
    const current = rows[rows.length - 1];
    if (current && sameRow(current[0], box)) current.push(box);
    else rows.push([box]);
  }

  const visual = rows.flatMap((row) => [...row].sort((a, b) => a.left - b.left));
  const tab = [...boxes].sort((a, b) => a.index - b.index);
  const mismatches = [];
  visual.forEach((expected, position) => {
    const actual = tab[position];
    if (!actual || actual.index !== expected.index) {
      mismatches.push({ position, expected: expected.label, actual: actual ? actual.label : '(none)' });
    }
  });
  return { count: boxes.length, mismatches };
}`;

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex^="-"])';

for (const route of ROUTES) {
  await page.goto(`${BASE}/${route}`, { waitUntil: 'networkidle' });
  // Let the entry transitions settle so the geometry measured is the resting geometry.
  await page.waitForTimeout(800);

  /* ---- Requirement 31.13: tab order is reading order, on real boxes ---- */
  const order = await page.evaluate(
    ([selector, ratio, fn]) => new Function(`return ${fn}`)()(selector, ratio),
    [TABBABLE, 0.5, READING_ORDER_IN_PAGE],
  );
  if (order.mismatches.length > 0) {
    failures.push(`${route} · 31.13 · ${JSON.stringify(order.mismatches.slice(0, 4))}`);
  }
  report.push(`${route.padEnd(34)} 31.13 ${order.mismatches.length === 0 ? 'OK' : 'FAIL'} (${order.count} tabbable)`);

  /* ---- Requirement 31.14: ring geometry, including mid-animation ---- */
  const rings = await page.evaluate(
    ([selector, maxPx]) => {
      const results = [];
      for (const element of [...document.querySelectorAll(selector)].slice(0, 24)) {
        element.focus();
        const style = globalThis.getComputedStyle(element);
        const offset = Number.parseFloat(style.outlineOffset || '0');
        const width = Number.parseFloat(style.outlineWidth || '0');
        const visible = style.outlineStyle !== 'none' && width > 0;
        // An outline paints on the element's own border box, so the boundary difference *is* the
        // offset — in every frame, whatever transform is running. That is the whole argument.
        if (!visible || Math.abs(offset) > maxPx) {
          results.push({
            label: (element.getAttribute('aria-label') || element.textContent || element.tagName)
              .trim().slice(0, 30),
            visible,
            offset,
          });
        }
      }
      return results;
    },
    [TABBABLE, FOCUS_BOUNDARY_MAX_PX],
  );
  if (rings.length > 0) failures.push(`${route} · 31.14 · ${JSON.stringify(rings.slice(0, 4))}`);
  report.push(`${route.padEnd(34)} 31.14 ${rings.length === 0 ? 'OK' : 'FAIL'}`);
}

/* ---- Requirements 31.11 and 31.12: clickable mid-animation, response ≤100 ms ---- */
await page.goto(`${BASE}/#/generate`, { waitUntil: 'networkidle' });
// No settle wait: the entry transition is *running*, which is the condition 31.11 is about.
//
// Measured inside the page rather than around a Playwright call. `locator.click()` includes the
// driver's own actionability polling — tens to hundreds of milliseconds that belong to the test
// harness, not to the app — and 31.12 is a claim about the app's visual response. Clicking from
// inside the page and reading the next frame measures exactly that.
const interaction = await page.evaluate(async () => {
  const button = [...document.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === 'Custom 모드',
  );
  if (button === undefined) return { clickable: false, responseMs: -1 };

  // What 31.11 forbids: a component that cannot be hit while something animates. If an overlay
  // or `pointer-events: none` were in the way, the element at this point would not be the button.
  const box = button.getBoundingClientRect();
  const atPoint = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const hittable = atPoint === button || button.contains(atPoint);

  const startedAt = performance.now();
  button.click();
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
  const responded = button.getAttribute('aria-pressed') === 'true';
  return { clickable: hittable && responded, responseMs: performance.now() - startedAt };
});

if (!interaction.clickable) {
  failures.push('#/generate · 31.11 · 애니메이션 중 조작이 도달하지 않았거나 반영되지 않음');
}
if (interaction.responseMs > FOCUS_INDICATOR_MAX_DELAY_MS) {
  failures.push(`#/generate · 31.12 · 응답 ${interaction.responseMs.toFixed(1)}ms > 100ms`);
}
report.push(
  `#/generate (mid-animation)          31.11 ${interaction.clickable ? 'OK' : 'FAIL'} · ` +
    `31.12 ${interaction.responseMs.toFixed(1)}ms`,
);

await browser.close();

console.log(report.join('\n'));
if (failures.length > 0) {
  console.error(`\n접근성 브라우저 검증 실패 — ${String(failures.length)}건`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('\na11y browser verification: 통과 (Req 31.11, 31.12, 31.13, 31.14)');
