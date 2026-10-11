#!/usr/bin/env node
/**
 * End-to-end scan quality harness.
 *
 *   npm run e2e                       # all cases, OCR on, UI smoke on 3 cases
 *   npm run e2e -- --only invoice,receipt --no-ui
 *   npm run e2e -- --no-ocr           # skip OCR (much faster)
 *
 * Options:
 *   --only a,b       run only these case ids (see tests/e2e/scene.ts CASES)
 *   --no-ocr         no text layer / OCR metrics
 *   --no-clean-ocr   skip the OCR baseline on the clean printed page
 *   --no-ui          skip driving the real UI (camera screen import -> PDF button)
 *   --ui-cases a,b   cases to drive through the UI (default letter_a4,invoice,german)
 *   --live           also feed one case to the live camera via a fake video device
 *   --out DIR        artifacts (default /tmp/claude-0/e2e-out)
 *   --server URL     use a running dev server instead of starting one
 *   --report-only    rewrite report.md from an existing results.json
 *   --merge          keep the other cases' results already in OUT/results.json (with --only)
 *   --baseline DIR   add a before/after table against DIR/results.json (an earlier run)
 *
 * Needs: playwright-core (resolved from the repo or E2E_TOOLS, default
 * /tmp/claude-0/e2e-tools, installed there on first use), a Chromium
 * (PW_CHROMIUM, default /opt/pw-browsers/chromium), poppler-utils
 * (pdfinfo, pdftotext, pdfimages) and, for --live, python3 with Pillow.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReport } from './report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

/* ---------------------------------------------------------------- args ---- */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const OUT = resolve(value('--out', '/tmp/claude-0/e2e-out'));
const ONLY = value('--only', '').split(',').filter(Boolean);
const OCR = !flag('--no-ocr');
const CLEAN_OCR = OCR && !flag('--no-clean-ocr');
const UI = !flag('--no-ui');
const UI_CASES = value('--ui-cases', 'letter_a4,invoice,german').split(',').filter(Boolean);
const LIVE = flag('--live');
const BASELINE = value('--baseline', '');
const loadBaseline = () =>
  BASELINE ? JSON.parse(readFileSync(join(BASELINE, 'results.json'), 'utf8')) : null;
const PORT = Number(value('--port', '5199'));
let SERVER = value('--server', '');

/* --------------------------------------------------------- dependencies ---- */

async function loadPlaywright() {
  const tools = process.env.E2E_TOOLS ?? '/tmp/claude-0/e2e-tools';
  for (const base of [join(root, 'package.json'), join(tools, 'package.json')]) {
    try {
      return createRequire(base)('playwright-core');
    } catch {
      // try the next location
    }
  }
  console.log(`Installing playwright-core into ${tools} (not into the repo)…`);
  mkdirSync(tools, { recursive: true });
  if (!existsSync(join(tools, 'package.json')))
    writeFileSync(join(tools, 'package.json'), '{"private":true}');
  execFileSync('npm', ['install', '--no-audit', '--no-fund', 'playwright-core@1.64.0'], {
    cwd: tools,
    stdio: 'inherit',
  });
  return createRequire(join(tools, 'package.json'))('playwright-core');
}

function chromiumPath() {
  const p = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';
  return existsSync(p) ? p : undefined;
}

/* -------------------------------------------------------------- server ---- */

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server did not come up: ${url}`);
}

let server = null;
async function startServer() {
  if (SERVER) return;
  SERVER = `http://localhost:${PORT}/doc-scanner/`;
  try {
    const r = await fetch(`${SERVER}tests/e2e/harness.html`);
    if (r.ok) {
      console.log(`Using the dev server already on ${SERVER}`);
      return;
    }
  } catch {
    // start one
  }
  server = spawn(
    'npx',
    ['vite', '--config', 'tests/e2e/vite.config.e2e.ts', '--port', String(PORT), '--strictPort'],
    {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  server.stdout.on('data', () => {});
  server.stderr.on('data', (d) => process.stderr.write(d));
  await waitFor(`${SERVER}tests/e2e/harness.html`, 90_000);
}

function stopServer() {
  if (server) {
    try {
      process.kill(-server.pid);
    } catch {
      // already gone
    }
  }
}

/* ----------------------------------------------------------------- pdf ---- */

function run(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stdout, stderr: '' };
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? String(e),
    };
  }
}

function inspectPdf(path) {
  const info = run('pdfinfo', [path]);
  const pages = Number(/Pages:\s+(\d+)/.exec(info.stdout)?.[1] ?? 0);
  const size = /Page size:\s+([\d.]+) x ([\d.]+) pts/.exec(info.stdout);
  const text = run('pdftotext', ['-enc', 'UTF-8', path, '-']);
  const raw = run('pdftotext', ['-raw', '-enc', 'UTF-8', path, '-']);
  const images = run('pdfimages', ['-list', path]);
  const render = run('pdftoppm', [
    '-r',
    '10',
    '-singlefile',
    '-png',
    path,
    path.replace(/\.pdf$/, '_render'),
  ]);
  return {
    valid: info.ok && pages > 0 && render.ok && !/error/i.test(info.stderr + render.stderr),
    errors: (info.stderr + text.stderr + render.stderr).trim().slice(0, 500),
    pages,
    pageMm: size ? [(+size[1] / 72) * 25.4, (+size[2] / 72) * 25.4] : null,
    text: text.stdout.replace(/\f/g, '\n'),
    rawText: raw.stdout.replace(/\f/g, '\n'),
    images: images.stdout
      .split('\n')
      .slice(2)
      .filter(Boolean)
      .map((l) => l.trim().split(/\s+/).slice(3, 9).join(' ')),
  };
}

/* --------------------------------------------------------------- cases ---- */

function save(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, b64] of Object.entries(files))
    writeFileSync(join(dir, name), Buffer.from(b64, 'base64'));
}

async function openHarness(browser) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`  [pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`  [console] ${m.text()}`);
  });
  await page.goto(`${SERVER}tests/e2e/harness.html`);
  await page.waitForFunction(
    () => document.getElementById('status')?.textContent === 'ready',
    null,
    {
      timeout: 120_000,
    },
  );
  return page;
}

async function runPipelineCase(browser, id) {
  const page = await openHarness(browser);
  try {
    const result = await page.evaluate(
      ({ id, ocr, cleanOcr }) =>
        window.e2e.runCase(id, { ocr, cleanOcr, filters: window.e2e.FILTERS }),
      { id, ocr: OCR, cleanOcr: CLEAN_OCR },
    );
    const dir = join(OUT, id);
    rmSync(dir, { recursive: true, force: true });
    save(dir, result.files);
    delete result.files;
    const pdf = inspectPdf(join(dir, 'scan.pdf'));
    writeFileSync(join(dir, 'pdftotext.txt'), pdf.text);
    writeFileSync(join(dir, 'truth.txt'), result.truth.text);
    if (result.ocrClean) writeFileSync(join(dir, 'ocr_clean.txt'), result.ocrClean.text);
    result.pdfCheck = { ...pdf, text: undefined, rawText: undefined };
    if (OCR) {
      result.text = await page.evaluate(
        ({ truth, got, special, zone }) => window.e2e.textMetrics(truth, got, special, zone),
        {
          truth: result.truth.text,
          got: pdf.text,
          special: result.truth.special,
          zone: result.truth.zoneText || undefined,
        },
      );
      const sets = [
        ['', result.filters],
        ['truecrop_', result.trueCropFilters ?? {}],
      ];
      for (const [prefix, set] of sets)
        for (const [name, f] of Object.entries(set)) {
          if (f.ocrText === undefined) continue;
          writeFileSync(join(dir, `ocr_${prefix}${name}.txt`), f.ocrText);
          f.text = await page.evaluate(
            ({ truth, got, zone }) => window.e2e.textMetrics(truth, got, undefined, zone),
            { truth: result.truth.text, got: f.ocrText, zone: result.truth.zoneText || undefined },
          );
          delete f.ocrText;
        }
      result.textRaw = await page.evaluate(({ truth, got }) => window.e2e.textMetrics(truth, got), {
        truth: result.truth.text,
        got: pdf.rawText,
      });
    }
    if (result.ocrClean) delete result.ocrClean.text;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await page.close();
  }
}

/** Drive the real app: camera screen -> "Choose photos" import -> PDF button -> download. */
async function runUiCase(browser, id, photoPath, { live = false } = {}) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 412, height: 915 },
  });
  await context.grantPermissions(['camera']);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const started = Date.now();
  const t = {};
  try {
    await page.goto(SERVER);
    const input = page.locator('input[type=file]');
    await input.waitFor({ state: 'attached', timeout: 60_000 });
    t.cameraScreen = Date.now() - started;
    if (live) {
      // Record the hints the camera shows while it looks at the page.
      t.hints = [];
      const poll = setInterval(async () => {
        const text = await page
          .locator('.status')
          .innerText()
          .catch(() => '');
        if (text && t.hints.at(-1) !== text.trim()) t.hints.push(text.trim());
      }, 200);
      page.once('close', () => clearInterval(poll));
      // Auto-capture should fire after ~1 s of steady detection on the fake camera feed.
      const done = Date.now();
      await page.getByText(/Page 1 added/).waitFor({ timeout: 90_000 });
      t.autoCapture = Date.now() - done;
      clearInterval(poll);
      await page.getByRole('button', { name: 'Close camera' }).click();
    } else {
      await input.setInputFiles(photoPath);
    }
    // The Download button (next to Share where the share sheet is offered).
    const pdfButton = page.getByRole('button', { name: 'Download PDF' });
    await pdfButton.waitFor({ timeout: 120_000 });
    t.imported = Date.now() - started;
    const toasts = await page
      .locator('[role=status], .toast')
      .allInnerTexts()
      .catch(() => []);
    // Give the background prefetch a moment, as a user reviewing the page would.
    const downloadPromise = page.waitForEvent('download', { timeout: 600_000 });
    const clickAt = Date.now();
    await pdfButton.click();
    const file = await downloadPromise;
    t.save = Date.now() - clickAt;
    const dir = join(OUT, `ui_${live ? 'live_' : ''}${id}`);
    mkdirSync(dir, { recursive: true });
    const pdfPath = join(dir, 'ui.pdf');
    await file.saveAs(pdfPath);
    await page.screenshot({ path: join(dir, 'screen.png') });
    const pdf = inspectPdf(pdfPath);
    writeFileSync(join(dir, 'pdftotext.txt'), pdf.text);
    const result = {
      id,
      live,
      filename: file.suggestedFilename(),
      timings: t,
      errors,
      toasts,
      pdf: { ...pdf, text: undefined, rawText: undefined },
    };
    result.bytes = readFileSync(pdfPath).length;
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 2));
    result.text = pdf.text;
    return result;
  } catch (error) {
    const dir = join(OUT, `ui_${live ? 'live_' : ''}${id}`);
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, 'failure.png') }).catch(() => {});
    return { id, live, error: String(error?.message ?? error), errors, timings: t };
  } finally {
    await context.close();
  }
}

/* ---------------------------------------------------------------- main ---- */

async function main() {
  mkdirSync(OUT, { recursive: true });
  if (flag('--report-only')) {
    const { meta, results, ui } = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8'));
    writeReport(OUT, results, ui, meta, loadBaseline());
    console.log(`Report: ${join(OUT, 'report.md')}`);
    return;
  }
  const { chromium } = await loadPlaywright();
  await startServer();
  const launch = (extra = []) =>
    chromium.launch({
      executablePath: chromiumPath(),
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--js-flags=--max-old-space-size=8192',
        ...extra,
      ],
    });
  const browser = await launch();
  let results = [];
  let ui = [];
  try {
    const page = await openHarness(browser);
    const cases = await page.evaluate(() => window.e2e.listCases());
    await page.close();
    const ids = cases.map((c) => c.id).filter((id) => !ONLY.length || ONLY.includes(id));
    for (const id of ids) {
      const t0 = Date.now();
      process.stdout.write(`${id.padEnd(16)} `);
      try {
        let r;
        try {
          r = await runPipelineCase(browser, id);
        } catch (error) {
          // A page reload (e.g. source edited during the run) loses the case; retry once.
          if (!/context was destroyed|navigation/i.test(String(error?.message))) throw error;
          r = await runPipelineCase(browser, id);
        }
        results.push(r);
        const d = r.detection;
        console.log(
          `corner ${Math.max(...d.cornerErr).toFixed(1)}px  ink ${(r.truthCrop.inkRecall * 100).toFixed(1)}%  white ${(r.truthCrop.white * 100).toFixed(1)}%` +
            (r.text ? `  CER ${(r.text.cer * 100).toFixed(1)}%` : '') +
            `  ${((Date.now() - t0) / 1000).toFixed(0)}s`,
        );
      } catch (error) {
        console.log(`FAILED: ${error?.message ?? error}`);
        results.push({ id, error: String(error?.message ?? error) });
      }
    }
    if (UI) {
      for (const id of UI_CASES) {
        const photo = join(OUT, id, 'photo.jpg');
        if (!existsSync(photo)) continue;
        process.stdout.write(`ui:${id.padEnd(13)} `);
        const r = await runUiCase(browser, id, photo);
        const pipeline = results.find((p) => p.id === id);
        if (r.text !== undefined && pipeline?.truth) {
          const p = await openHarness(browser);
          r.textMetrics = await p.evaluate(
            ({ truth, got, special }) => window.e2e.textMetrics(truth, got, special),
            { truth: pipeline.truth.text, got: r.text, special: pipeline.truth.special },
          );
          await p.close();
        }
        delete r.text;
        ui.push(r);
        console.log(
          r.error
            ? `FAILED: ${r.error}`
            : `ok  ${(r.bytes / 1024).toFixed(0)} KB  CER ${r.textMetrics ? (r.textMetrics.cer * 100).toFixed(1) + '%' : '-'}  save ${(r.timings.save / 1000).toFixed(1)}s`,
        );
      }
    }
  } finally {
    await browser.close();
  }
  if (LIVE) {
    const id = UI_CASES[0];
    const photo = join(OUT, id, 'photo.jpg');
    const y4m = join(OUT, `ui_live_${id}`, 'camera.y4m');
    mkdirSync(dirname(y4m), { recursive: true });
    execFileSync('python3', [join(here, 'y4m.py'), photo, y4m], { stdio: 'inherit' });
    const liveBrowser = await launch([`--use-file-for-fake-video-capture=${y4m}`]);
    try {
      process.stdout.write(`live:${id.padEnd(11)} `);
      const r = await runUiCase(liveBrowser, id, photo, { live: true });
      delete r.text;
      ui.push(r);
      console.log(
        r.error
          ? `FAILED: ${r.error}`
          : `ok  auto-capture after ${(r.timings.autoCapture / 1000).toFixed(1)}s`,
      );
    } finally {
      await liveBrowser.close();
    }
  }
  const meta = {
    commit: run('git', ['-C', root, 'rev-parse', '--short', 'HEAD']).stdout.trim(),
    dirty: run('git', ['-C', root, 'status', '--porcelain', '--', 'src']).stdout.trim() !== '',
    date: new Date().toISOString(),
  };
  if (flag('--merge') && existsSync(join(OUT, 'results.json'))) {
    const old = JSON.parse(readFileSync(join(OUT, 'results.json'), 'utf8'));
    const fresh = new Set(results.map((r) => r.id));
    const order = old.results.map((r) => r.id);
    results = [...old.results.filter((r) => !fresh.has(r.id)), ...results].sort(
      (a, b) => (order.indexOf(a.id) + 1 || 1e9) - (order.indexOf(b.id) + 1 || 1e9),
    );
    if (!ui.length) ui = old.ui ?? [];
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ meta, results, ui }, null, 2));
  writeReport(OUT, results, ui, meta, loadBaseline());
  console.log(`\nReport: ${join(OUT, 'report.md')}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(stopServer);
