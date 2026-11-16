#!/usr/bin/env node
/**
 * Right-clicking a document tab near the window's right edge must never
 * run into React's "Maximum update depth exceeded" (minified error #185),
 * whatever the layout scale (Playwright against the Vite dev server, no
 * backend - the dev build names the component).
 *
 * The tab menu used to be kept in view by a layout effect that measured
 * the rendered menu and set its position as state, moving it by the
 * measured overflow until none was left. Chromium lays out at the display
 * scale times the page zoom and snaps to 1/64 of a device pixel; the
 * desktop app's default zoom is 90%, so on a 100% display the layout
 * scale is 0.9 - a scale at which the corrected position, converted back,
 * still measures a hair over the limit, and every pass set another new
 * position: a setState loop that took the page down. At 133% (1.2 with
 * the zoom) and on a Retina display (1.8) the numbers happen to settle.
 * The menus now go through the shared placement, which writes styles and
 * holds no position state (src/hooks/usePopupPosition.js).
 *
 * The matrix: real device scale factors (--force-device-scale-factor, the
 * same layout zoom a display scale and the app's zoom give) 0.9 - the
 * failing case - then 1, 1.1, 1.2, 1.25, 1.333, 1.5, 1.75 and 2; many
 * tabs in a scrolled strip; right-clicks along the strip up to the
 * window's right edge. Each time: the app stays rendered, no page error,
 * no React error, the menu inside the window and still. And statically:
 * no component nudges a menu by a measured overflow through state.
 *
 * Needs playwright-core with Chromium. Port TAB_MENU_LOOP_TEST_PORT (5246).
 * Run: node tests/tab-menu-update-loop-live.test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reapOnExit } from './helpers/reap.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(REPO, 'package.json'));
const PORT = Number(process.env.TAB_MENU_LOOP_TEST_PORT || 5246);
let failed = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${!ok && detail ? ' | ' + String(detail).slice(0, 1200) : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.env.SKIP_BROWSER_TESTS) { console.log('SKIP: SKIP_BROWSER_TESTS is set'); process.exit(0); }
let pw;
try { pw = req('playwright-core'); } catch { console.log('SKIP: playwright-core is not installed'); process.exit(0); }
const portFree = (port) => new Promise((resolve) => { const s = createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });
if (!(await portFree(PORT))) { console.log(`SKIP: port ${PORT} is busy (TAB_MENU_LOOP_TEST_PORT)`); process.exit(0); }
const launch = (scale, w, h) => pw.chromium.launch({ args: [`--force-device-scale-factor=${scale}`, `--window-size=${w},${h}`] });
let browser;
try { browser = await launch(1, 1200, 800); } catch (e) { console.log(`SKIP: Chromium could not start (${String(e.message).split('\n')[0]})`); process.exit(0); }
const vite = reapOnExit(spawn(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', String(PORT), '--strictPort'], { cwd: REPO, stdio: 'ignore' }));
const URL_ = `http://localhost:${PORT}/`;
let ready = false;
for (let i = 0; i < 240 && !ready; i++) { try { ready = (await fetch(URL_)).ok; } catch { await sleep(250); } }
const stop = async () => { try { await browser.close(); } catch { /* gone */ } try { vite.kill('SIGTERM'); } catch { /* gone */ } };
if (!ready) { console.log('SKIP: the Vite dev server did not come up'); await stop(); process.exit(0); }

const N = 16;
async function open() {
  const context = await browser.newContext({ viewport: null, reducedMotion: 'reduce', colorScheme: 'dark' });
  await context.addInitScript(() => { try { localStorage.setItem('whatsNewLastSeen', '99.0.0'); localStorage.setItem('app-theme', 'dark'); localStorage.setItem('expandedDocumentCategories', JSON.stringify(['General'])); } catch { /* no storage */ } });
  await context.route('**/api/**', (r) => r.fulfill({ status: 404, json: { error: 'no backend in this test' } }));
  await context.route('**/socket.io/**', (r) => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(`${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`); });
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to fetch|\/api\/|404|ERR_|WebSocket|socket\.io/.test(t)) errors.push(t.slice(0, 500)); } });
  await page.goto(URL_, { waitUntil: 'load' }); await sleep(1500);
  await page.evaluate(async (n) => {
    const { db } = await import('/src/db/database.js');
    await db.documents.clear();
    const tabs = [];
    for (let i = 1; i <= n; i++) { const id = await db.documents.add({ title: `Sample note ${i} with a long title`, content: `# Sample ${i}\n\nText ${i}.`, category: 'General', stableId: `sid-${i}`, createdAt: new Date(), updatedAt: new Date() }); tabs.push({ id, title: `Sample note ${i} with a long title` }); }
    localStorage.setItem('documentOpenTabs', JSON.stringify(tabs));
    localStorage.setItem('currentDocumentId', JSON.stringify(tabs[tabs.length - 1].id));
    localStorage.setItem('innerSidebarVisible', 'false');
  }, N);
  await page.reload({ waitUntil: 'load' }); await sleep(1800);
  for (let i = 0; i < 6; i++) { const b = page.getByRole('button', { name: /^Got it!$/ }); if (await b.count()) { await b.first().click().catch(() => {}); break; } await sleep(300); }
  return { context, page, errors };
}
const alive = (page) => page.evaluate(() => { const root = document.getElementById('root'); return { children: root ? root.children.length : -1, text: root ? root.innerText.length : -1, rail: !!document.querySelector('nav.w-16') }; });
const menuBox = (page) => page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((el) => /^Close This Tab$/.test(el.textContent.trim()) && el.closest('.fixed'));
  if (!b) return null;
  const r = b.closest('.fixed').getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, inViewport: r.left >= -0.5 && r.top >= -0.5 && r.right <= window.innerWidth + 0.5 && r.bottom <= window.innerHeight + 0.5 };
});
const strip = (page) => page.evaluate(() => { const s = document.querySelector('.sc-tab-strip'); const r = s.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, scrollLeft: s.scrollLeft, scrollWidth: s.scrollWidth, clientWidth: s.clientWidth }; });

// one right-click at (x, y); returns whether everything held (a dead page stops the scenario: the caller reopens)
async function rightClick(tag, page, errors, x, y) {
  errors.length = 0;
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: 'right' }); await sleep(350);
  const a = await alive(page);
  const menu = await menuBox(page);
  await sleep(120);
  const again = await menuBox(page);
  const loop = errors.find((e) => /Maximum update depth|#185/.test(e));
  const ok = a.children > 0 && a.text > 50 && a.rail && errors.length === 0 && !!menu && menu.inViewport && !!again && Math.abs(again.left - menu.left) < 0.01 && Math.abs(again.top - menu.top) < 0.01;
  check(`${tag}: right-click at (${x}, ${y}) - the app stays rendered, no update loop, the menu inside the window and still`, ok, JSON.stringify({ loop: loop || null, alive: a, menu, again, errors: errors.slice(0, 2) }));
  await page.keyboard.press('Escape').catch(() => {}); await sleep(120);
  // after an update loop the page's error boundary shows its fallback (the rail stays): the caller starts afresh
  return a.children > 0 && a.text > 50 && !loop && !!menu;
}

async function matrix(scale, width, height) {
  const tag = `scale ${scale}, window ${width}x${height}`;
  await browser.close().catch(() => {});
  browser = await launch(scale, width, height);
  let { context, page, errors } = await open();
  const s = await strip(page);
  const inner = await page.evaluate(() => ({ w: window.innerWidth, dpr: window.devicePixelRatio }));
  check(`${tag}: the page runs at that scale (devicePixelRatio ${inner.dpr}), many tabs, the strip scrolled (scrollWidth ${s.scrollWidth} > clientWidth ${s.clientWidth})`, Math.abs(inner.dpr - scale) < 0.01 && s.scrollWidth > s.clientWidth + 50 && s.scrollLeft > 0, JSON.stringify({ inner, s }));
  const midY = (s.top + s.bottom) / 2;
  // along the strip, from where a menu just fits to the window's right edge
  let held = 0; let tried = 0; let dead = 0;
  for (let x = Math.max(s.left + 20, inner.w - 300); x <= Math.min(s.right, inner.w) - 3; x += 11) {
    tried++;
    const stillThere = await rightClick(tag, page, errors, Math.round(x), Math.round(midY));
    if (stillThere) held++; else { dead++; await context.close(); ({ context, page, errors } = await open()); }
  }
  check(`${tag}: ${tried} right-clicks along the strip's right end, no update loop, the page never went down (${dead} time(s))`, tried >= 10 && dead === 0, JSON.stringify({ tried, held, dead }));
  await context.close();
}

// statically: a menu is never nudged by a measured overflow through state (the loop's shape)
{
  const offenders = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (/\.(jsx?|mjs)$/.test(e.name)) { const src = fs.readFileSync(f, 'utf8'); if (/-\s*\(\s*\w+\.(right|bottom)\s*-\s*window\.inner(Width|Height)/.test(src)) offenders.push(path.relative(REPO, f)); } } };
  walk(path.join(REPO, 'src'));
  check('no component moves a menu by its measured overflow (x - (rect.right - window.innerWidth ...)) - the shared placement does it', offenders.length === 0, offenders.join(', '));
  const docs = fs.readFileSync(path.join(REPO, 'src', 'components', 'DocumentsPage.jsx'), 'utf8');
  check('the Documents tab menu and template menu are placed by usePopupPosition, with no layout effect of their own', /usePopupPosition\(tabContextMenuRef,/.test(docs) && /usePopupPosition\(templateContextMenuRef,/.test(docs) && !/useLayoutEffect\(/.test(docs));
}

try {
  for (const scale of [0.9, 1, 1.1, 1.2, 1.25, 1.333, 1.5, 1.75, 2]) await matrix(scale, 1000, 700);
  await matrix(0.9, 1280, 820);
  await matrix(0.9, 1113, 640);
} catch (e) {
  check('the run completed', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' ') : String(e));
} finally {
  await stop();
}
console.log(`\n${failed ? failed + ' check(s) failed' : 'All checks passed'}`);
process.exit(failed ? 1 : 0);
