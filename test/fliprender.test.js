// ============================================================
//  web/dispatch.js — flipRender, the row-reorder glide.
//
//  This is animation, so the *look* can only be judged in a browser
//  (HANDOFF.md carries the manual before/after steps). What is testable
//  is the contract around it, and that is where the bugs live:
//   - it must render exactly once, on every path;
//   - it must resolve only AFTER the re-render, because applyReorder
//     flashes the newly-rendered rows and they do not exist before then;
//   - rows must be uniquely named during the transition and unnamed
//     after, or the next transition animates rows that did not move;
//   - no View Transitions support, or prefers-reduced-motion, must fall
//     back to a plain synchronous render rather than doing nothing.
// ============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWeb } = require('./webharness');

/** A <tr data-tid> stand-in that records what gets written to its style. */
function row(tid) {
  return { dataset: { tid: String(tid) }, style: {} };
}

/**
 * Loads dispatch.js with a document exposing `rows`, and a configurable
 * View Transitions implementation.
 *
 * @param {Object} opts
 *   rows           the rows querySelectorAll should return
 *   supported      whether document.startViewTransition exists
 *   reducedMotion  what prefers-reduced-motion reports
 */
function loadFlip({ rows = [row(1), row(2)], supported = true, reducedMotion = false } = {}) {
  const log = [];
  let finishTransition;

  const doc = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: (sel) => {
      log.push({ query: sel });
      return rows;
    },
    addEventListener() {},
    createElement: () => ({ style: {}, addEventListener() {}, appendChild() {} }),
    head: { appendChild() {} },
  };

  if (supported) {
    doc.startViewTransition = (cb) => {
      log.push({ started: true });
      // The real API defers the callback; that deferral is the whole point.
      const updateCallbackDone = Promise.resolve().then(() => {
        log.push({ updated: true });
        cb();
      });
      const finished = new Promise((res, rej) => {
        finishTransition = (err) => (err ? rej(err) : res());
      });
      return { updateCallbackDone, finished };
    };
  }

  const { sandbox } = loadWeb(['core.js', 'dispatch.js'], {
    document: doc,
    window: {
      addEventListener() {},
      matchMedia: (q) => ({ matches: /reduced-motion/.test(q) && reducedMotion }),
    },
  });

  return { ui: sandbox, log, rows, finish: () => finishTransition && finishTransition() };
}

test('the re-render is deferred, and flipRender resolves only after it', async () => {
  const { ui, log } = loadFlip();
  let rendered = 0;

  const done = ui.flipRender(() => { rendered++; });

  // Deferred: the callback has not run yet when flipRender returns.
  assert.equal(rendered, 0, 're-render must not run synchronously');

  await done;
  assert.equal(rendered, 1, 're-render must have run by the time it resolves');
  assert.ok(log.some((e) => e.started), 'a view transition should have started');
});

test('rows are named during the transition and cleared once it finishes', async () => {
  const { ui, rows, finish } = loadFlip();

  await ui.flipRender(() => {});

  // Named, uniquely, and as valid custom idents (not bare numbers).
  const names = rows.map((r) => r.style.viewTransitionName);
  assert.deepEqual(names, ['trip-1', 'trip-2']);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) assert.match(n, /^[A-Za-z][\w-]*$/);

  finish();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(rows.map((r) => r.style.viewTransitionName), ['', '']);
});

test('a skipped transition still clears the names, without an unhandled rejection', async () => {
  // Starting a second transition while one is running skips the first, and a
  // skipped transition REJECTS `finished`. That is routine (drag twice
  // quickly), so it must clean up quietly rather than surface as an error.
  const { ui, rows, finish } = loadFlip();
  const rejections = [];
  process.on('unhandledRejection', (r) => rejections.push(r));

  await ui.flipRender(() => {});
  assert.deepEqual(rows.map((r) => r.style.viewTransitionName), ['trip-1', 'trip-2']);

  finish(new Error('AbortError: transition skipped'));
  await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(rows.map((r) => r.style.viewTransitionName), ['', '']);
  assert.deepEqual(rejections, []);
  process.removeAllListeners('unhandledRejection');
});

test('without View Transitions it renders once, synchronously', async () => {
  const { ui, rows } = loadFlip({ supported: false });
  let rendered = 0;

  const done = ui.flipRender(() => { rendered++; });

  assert.equal(rendered, 1, 'fallback must render immediately');
  await done; // still a promise, so callers need no special case
  assert.equal(rendered, 1, 'and must not render a second time');
  // Nothing to clean up, so no names should have been set either.
  assert.deepEqual(rows.map((r) => r.style.viewTransitionName), [undefined, undefined]);
});

test('prefers-reduced-motion skips the animation but still renders', async () => {
  const { ui, log } = loadFlip({ reducedMotion: true });
  let rendered = 0;

  await ui.flipRender(() => { rendered++; });

  assert.equal(rendered, 1);
  assert.equal(log.some((e) => e.started), false, 'no transition when motion is reduced');
});

test('the rows are re-named after the re-render, not only before it', async () => {
  // renderDispatch replaces the tbody's innerHTML, so the elements named
  // before the transition are gone by the time it runs — the new ones must be
  // named inside the update callback or the browser has nothing to pair.
  const before = [row(1)];
  const after = [row(1)];
  let current = before;
  const { ui } = loadFlip({ rows: [] });

  // swap the row set at re-render time, the way a real re-render does
  ui.document.querySelectorAll = () => current;
  await ui.flipRender(() => { current = after; });

  assert.equal(after[0].style.viewTransitionName, 'trip-1');
});
