// GPU canvas spike runner (throwaway, never merged). Opens /gpu-spike in the
// production Electron app with HTML-in-Canvas switched on, drives pans, drags
// and zooms over the tiled stress workflow, and writes a JSON report judged
// against the spike's targets. Runs unchanged on Windows and the Mac.
//
//   npm run build
//   node scripts/gpu-spike.cjs --input os --sizes 5k,10k --output gpu-spike-windows.json
//
// --input os (the default on Windows and the Mac) moves the real cursor at
// --hz (1000) in a maximised window: do not touch the mouse while it runs.
// Zooms are always sent through Electron with Ctrl held, since the OS players
// cannot hold a key. --input synthetic sends everything through Electron.
// --chromium-flags adds switches, e.g. "--use-angle=swiftshader" on a machine
// with no GPU. --keep-traces keeps the Chromium traces next to the report.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchElectron } = require('./lib/electron-driver.cjs');
const { PERF_TRACE_CATEGORIES, PAGE_PROBE } = require('../electron/lib/perf-trace.cjs');
const { readTrace, analyzeTrace, keepAnalyzed, formatReport } = require('./lib/trace-analysis.cjs');
const { createOsInput } = require('./lib/os-input.cjs');
const { strayElectron } = require('./lib/processes.cjs');

const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const flag = name => process.argv.includes(name);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const started = Date.now();
const stage = name => { if (flag('--verbose')) console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`); };
const root = path.resolve(__dirname, '..');
const HTML_IN_CANVAS = '--enable-blink-features=CanvasDrawElement';

// Gestures in page (css) pixels; o carries the start point and the room around it.
const GESTURES = {
  'pan-sweep': { target: 'pane', path: (o, u) => ({ x: o.x + o.ax * Math.sin(u * Math.PI * 6) + 30 * u, y: o.y + o.ay * Math.sin(u * Math.PI * 4) }) },
  'pan-wheel': { target: 'pane', wheel: i => ({ dx: Math.floor(i / 50) % 2 ? -23 : 24, dy: 0 }) },
  'drag-sweep': { target: 'node', path: (o, u) => ({ x: o.x + o.ax * Math.sin(u * Math.PI * 6) + 30 * u, y: o.y + o.ay * Math.sin(u * Math.PI * 4) }) },
  // In and out about 4× each way, as a pinch or Ctrl+wheel does.
  'zoom-wheel': { target: 'pane', synthetic: true, modifiers: ['control'], wheel: i => ({ dx: 0, dy: Math.floor(i / 60) % 2 ? -8 : 8 }) },
};

function schedule(gesture, origin, { hz, seconds }) {
  const n = Math.round(hz * seconds), interval = 1000 / hz, events = [];
  if (gesture.wheel) {
    events.push({ t: 0, type: 'move', x: origin.x, y: origin.y });
    for (let i = 0; i < n; i++) events.push({ t: 40 + i * interval, type: 'wheel', x: origin.x, y: origin.y, ...gesture.wheel(i), modifiers: gesture.modifiers });
    // The end marker: a lone tiny event the page records.
    // The end marker is a small move: Chromium coalesces wheel events, so a
    // distinct last wheel event could merge into the ones before it.
    events.push({ t: 60 + n * interval, type: 'move', x: origin.x + 3, y: origin.y + 3 });
    return events;
  }
  events.push({ t: 0, type: 'move', x: origin.x, y: origin.y }, { t: 40, type: 'down', x: origin.x, y: origin.y });
  let point = origin;
  for (let i = 0; i < n; i++) {
    point = gesture.path(origin, (i + 1) / n, i);
    events.push({ t: 80 + i * interval, type: 'move', x: point.x, y: point.y });
  }
  events.push({ t: 80 + n * interval + 20, type: 'up', x: point.x, y: point.y });
  return events;
}

// The spike's pass lines (the brief, question 1).
// refreshHz is the display's own rate, not the trace's estimate.
function judge(size, summary, refreshHz) {
  const vsyncMs = 1000 / refreshHz;
  if (size === '5k') {
    const checks = {
      presentedAtRefresh: summary.presentedFps >= 0.95 * refreshHz,
      p95WithinOneAndAHalfVsyncs: summary.frameMs.p95 != null && summary.frameMs.p95 <= 1.5 * vsyncMs,
      mainThreadAtMost30Pct: (summary.threads.rendererMain?.busyPct ?? 100) <= 30,
    };
    return { pass: Object.values(checks).every(Boolean), checks };
  }
  const checks = { atLeast90PctOfRefresh: summary.presentedFps >= 0.9 * refreshHz };
  return { pass: Object.values(checks).every(Boolean), checks };
}

async function main() {
  const sizes = option('--sizes', '5k,10k').split(',');
  // scene: question 1; paint: questions 2 and 5 (needs HTML-in-Canvas).
  const checks = option('--checks', 'scene,paint').split(',');
  const rounds = Number(option('--rounds', 2));
  const osInput = option('--input', ['win32', 'darwin'].includes(process.platform) ? 'os' : 'synthetic') === 'os' ? createOsInput() : undefined;
  assert.ok(!osInput || osInput.available, '--input os needs Windows or macOS');
  const hz = Number(option('--hz', osInput ? 1000 : 125));
  const seconds = Number(option('--seconds', 4));
  const gestureNames = option('--gestures', ['pan-sweep', 'drag-sweep', 'zoom-wheel', ...(process.platform === 'darwin' ? ['pan-wheel'] : [])].join(',')).split(',');
  for (const name of gestureNames) assert.ok(GESTURES[name], `Unknown gesture ${name}; one of ${Object.keys(GESTURES).join(', ')}`);
  for (const size of sizes) assert.ok(['5k', '10k'].includes(size), '--sizes takes 5k and 10k');
  const flags = [HTML_IN_CANVAS, ...option('--chromium-flags', '').split(' ').filter(Boolean)];
  const output = path.resolve(option('--output', path.join(os.tmpdir(), 'gpu-spike.json')));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.access(path.join(root, '.next/BUILD_ID')).catch(() => { throw new Error('Run npm run build first: the runner uses the production build.'); });
  const strays = strayElectron();
  if (strays.length && !flag('--allow-others')) throw new Error(`Electron is still running from a Node Banana checkout:\n${strays.map(p => `  ${p.pid} ${p.path}`).join('\n')}\nClose it (or pass --allow-others).`);

  const traceDir = flag('--keep-traces') ? output.replace(/\.json$/, '') + '-traces' : await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-spike-traces-'));
  await fs.mkdir(traceDir, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-spike-profile-'));
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  let app;
  const report = { date: new Date().toISOString(), platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model, input: osInput ? 'os' : 'synthetic', inputHz: hz,
    gestureMs: seconds * 1000, rounds, chromiumFlags: flags, sizes: {} };
  try {
    stage('launching');
    app = await launchElectron({ executable: require('electron'), args: [...flags, root], cwd: root,
      env: { ...process.env, NODE_BANANA_ELECTRON_USER_DATA: profile, NODE_BANANA_ELECTRON_PORT: String(port) } });
    const { page } = app;
    await app.run(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
    await app.window();
    const windowOption = option('--window', osInput ? 'maximized' : '1440x900');
    const [width, height] = windowOption === 'maximized' ? [] : windowOption.split('x').map(Number);
    await app.run(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (width) { window.unmaximize(); window.setContentSize(width, height); window.center(); } else window.maximize();
      // Chromium stops producing frames for a covered window.
      window.setAlwaysOnTop(true);
      window.focus();
    }, { width, height });
    const environment = await app.run(({ app, screen, BrowserWindow }) => {
      const display = screen.getPrimaryDisplay(), window = BrowserWindow.getAllWindows()[0];
      return { gpu: app.getGPUFeatureStatus(), displayHz: display.displayFrequency, scaleFactor: display.scaleFactor, displaySize: display.size,
        windowContentSize: window.getContentSize(), versions: { electron: process.versions.electron, chrome: process.versions.chrome } };
    });
    Object.assign(report, environment);
    const gpuInfo = await app.run(({ app }) => app.getGPUInfo('basic')).catch(() => null);
    report.gpuDevice = gpuInfo?.gpuDevice?.find(device => device.active) ?? gpuInfo?.gpuDevice?.[0] ?? null;

    const geometry = await app.run(({ BrowserWindow, screen }) => {
      const bounds = BrowserWindow.getAllWindows()[0].getContentBounds();
      const display = screen.getDisplayMatching(bounds);
      return { origin: process.platform === 'win32' ? screen.dipToScreenPoint({ x: bounds.x, y: bounds.y }) : { x: bounds.x, y: bounds.y }, scaleFactor: display.scaleFactor };
    });

    // Opens the spike page and installs the input and error watchers.
    async function open(query, label) {
      console.log(`Opening ${label}…`);
      await page.evaluate(`location.href = '/gpu-spike?${query}&overlay=off'`);
      await delay(1000);
      await page.waitFor(() => window.__spike?.ready || window.__spike?.error, null, { timeout: 300000, message: label });
      const error = await page.evaluate(() => window.__spike.error || null);
      if (error) throw new Error(`The spike page failed: ${error}`);
      await page.evaluate(PAGE_PROBE);
      await page.evaluate(() => {
        window.__perfErrors = [];
        addEventListener('error', event => { if (!/^ResizeObserver loop/.test(event.message)) window.__perfErrors.push(event.message); });
        addEventListener('unhandledrejection', event => window.__perfErrors.push(String(event.reason?.message || event.reason)));
        window.__spikeInput = {};
        addEventListener('pointerup', event => { window.__spikeInput.up = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
        addEventListener('pointermove', event => { window.__spikeInput.move = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
      });
      const dataset = await page.evaluate(() => window.__spike.dataset);
      console.log(`  ${dataset.nodes} nodes, ${dataset.edges} edges, loaded in ${dataset.loadMs} ms`);
      return dataset;
    }
    const devicePixelRatio = await page.evaluate(() => devicePixelRatio);
    const pageToScreen = process.platform === 'win32' ? devicePixelRatio : devicePixelRatio / geometry.scaleFactor;
    report.devicePixelRatio = devicePixelRatio;

    async function play(events, { synthetic } = {}) {
      if (osInput && !synthetic) {
        const result = await osInput.play(events.map(e => ({ ...e, x: geometry.origin.x + e.x * pageToScreen, y: geometry.origin.y + e.y * pageToScreen })));
        return result.sent;
      }
      return app.run(async ({ BrowserWindow }, events) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const start = performance.now();
        let sent = 0, down = false;
        await new Promise(resolve => {
          const timer = setInterval(() => {
            while (sent < events.length && events[sent].t <= performance.now() - start) {
              const { type, x, y, dx, dy, modifiers = [] } = events[sent++];
              const at = { x: Math.round(x), y: Math.round(y) };
              if (type === 'wheel') contents.sendInputEvent({ type: 'mouseWheel', ...at, deltaX: dx, deltaY: dy, canScroll: true, modifiers });
              else if (type === 'down') { down = true; contents.sendInputEvent({ type: 'mouseDown', button: 'left', ...at, clickCount: 1 }); }
              else if (type === 'up') { down = false; contents.sendInputEvent({ type: 'mouseUp', button: 'left', ...at, clickCount: 1 }); }
              else contents.sendInputEvent({ type: 'mouseMove', ...(down ? { button: 'left', modifiers: ['leftButtonDown'] } : {}), ...at });
            }
            if (sent === events.length) { clearInterval(timer); resolve(); }
          }, 4);
        });
        return sent;
      }, events);
    }

    const target = kind => page.evaluate(kind => {
      const scene = window.__spike.scene, cx = innerWidth / 2, cy = innerHeight / 2;
      const room = (x, y) => ({ ax: Math.max(40, Math.min(innerWidth * .3, x - 60, innerWidth - x - 60)), ay: Math.max(20, Math.min(innerHeight * .2, y - 60, innerHeight - y - 60)) });
      if (kind === 'node') {
        let best;
        for (let i = 0; i < window.__spike.dataset.nodes; i++) {
          const rect = scene.nodeRect(i);
          const x = rect.x + rect.width / 2, y = rect.y + Math.min(rect.height / 2, 20);
          if (scene.nodeAt(x, y) !== i) continue;
          const distance = Math.hypot(x - cx, y - cy);
          if (!best || distance < best.distance) best = { x, y, distance, index: i };
        }
        return best && { ...best, ...room(best.x, best.y), before: scene.nodeRect(best.index) };
      }
      for (let radius = 0; radius < Math.min(cx, cy) - 60; radius += 4) {
        for (let angle = 0; angle < Math.PI * 2; angle += Math.max(.05, 4 / Math.max(radius, 1))) {
          const x = Math.round(cx + radius * Math.cos(angle)), y = Math.round(cy + radius * Math.sin(angle));
          if (scene.nodeAt(x, y) < 0) return { x, y, ...room(x, y) };
        }
      }
    }, kind);

    // One traced gesture; its trace events go into `traced`.
    async function measure(name, label, traced) {
      const spec = GESTURES[name];
      const origin = await target(spec.target);
      assert.ok(origin, `No ${spec.target} to start ${name} on`);
      const events = schedule(spec, origin, { hz, seconds });
      const viewBefore = await page.evaluate(() => window.__spike.scene.view());
      await app.run(({ contentTracing }, categories) => contentTracing.startRecording({ included_categories: categories, excluded_categories: ['*'] }), PERF_TRACE_CATEGORIES);
      await page.evaluate(label => { performance.mark(`banana:gesture ${label}`); window.__spikeInput = {}; window.__spike.frames.start(); }, label);
      const sent = await play(events, { synthetic: spec.synthetic });
      const last = events.at(-1);
      await page.waitFor(({ type, x, y }) => { const seen = type === 'up' ? window.__spikeInput.up : window.__spikeInput.move;
        return seen && Math.abs(seen.x - x) <= 1.5 && Math.abs(seen.y - y) <= 1.5; }, last, { message: `${name} to reach the page` });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const frames = await page.evaluate(() => window.__spike.frames.stop());
      const traceFile = await app.run(({ contentTracing }, file) => contentTracing.stopRecording(file), path.join(traceDir, `${label}-${Date.now()}.json`));
      for (const event of readTrace(traceFile)) if (keepAnalyzed(event)) traced.push(event);
      if (!flag('--keep-traces')) await fs.rm(traceFile, { force: true });
      const viewAfter = await page.evaluate(() => window.__spike.scene.view());
      if (spec.target === 'node') {
        const after = await page.evaluate(i => window.__spike.scene.nodeRect(i), origin.index);
        assert.ok(after.x !== origin.before.x || after.y !== origin.before.y, `${name} did not move the node`);
      } else assert.notDeepEqual(viewAfter, viewBefore, `${name} did not move the view`);
      console.log(`  ${label}: ${frames.fps} frames/s in the page, js p95 ${frames.jsMs.p95} ms`);
      return { name, label, inputEvents: sent, input: spec.synthetic || !osInput ? 'synthetic' : 'os', pageFrames: frames };
    }
    const processMemory = () => app.run(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, workingSetMB: Math.round(m.memory.workingSetSize / 1024), privateMB: m.memory.privateBytes == null ? null : Math.round(m.memory.privateBytes / 1024) })));
    const checkErrors = async () => assert.deepEqual(await page.evaluate(() => window.__perfErrors), [], 'Page errors during the run');

    // Compares the screen's pixels in `rect` (css px) between two states; saves both and their difference.
    async function grab(rect) {
      return app.run(async ({ BrowserWindow }, rect) => {
        const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rect);
        globalThis.__grabs = globalThis.__grabs || [];
        globalThis.__grabs.push(image);
        return globalThis.__grabs.length - 1;
      }, rect);
    }
    async function compare(a, b, file) {
      return app.run(({ nativeImage }, { a, b, file }, require) => {
        const fs = require('node:fs');
        const A = globalThis.__grabs[a], B = globalThis.__grabs[b];
        const size = A.getSize(), pa = A.toBitmap(), pb = B.toBitmap();
        if (pa.length !== pb.length) return { error: `sizes differ: ${JSON.stringify(size)} vs ${JSON.stringify(B.getSize())}` };
        const diff = Buffer.alloc(pa.length);
        let within = 0, maxDiff = 0;
        const pixels = pa.length / 4;
        for (let p = 0; p < pa.length; p += 4) {
          const d = Math.max(Math.abs(pa[p] - pb[p]), Math.abs(pa[p + 1] - pb[p + 1]), Math.abs(pa[p + 2] - pb[p + 2]));
          if (d <= 2) within++;
          maxDiff = Math.max(maxDiff, d);
          // The difference, amplified, on black.
          const v = Math.min(255, d * 8);
          diff[p] = v; diff[p + 1] = v; diff[p + 2] = v; diff[p + 3] = 255;
        }
        fs.writeFileSync(`${file}-painted.png`, A.toPNG());
        fs.writeFileSync(`${file}-live.png`, B.toPNG());
        fs.writeFileSync(`${file}-diff.png`, nativeImage.createFromBitmap(diff, size).toPNG());
        return { size, pixels, withinTwoLevelsPct: Math.round(within / pixels * 10000) / 100, maxDiff };
      }, { a, b, file });
    }

    async function paintChecks() {
      const result = {};
      // --paint-copies N paints a smaller tiling, for trying the checks on a slow machine.
      const copies = option('--paint-copies');
      await open(`${copies ? `copies=${copies}` : 'size=5k'}&paint=manual`, 'the dataset for painter A');
      assert.ok(await page.evaluate(() => !!window.__spike.painter), 'Painter A needs HTML-in-Canvas (--enable-blink-features=CanvasDrawElement)');
      await page.mouseMove(2, 2);
      // A screenful at 100%, at the top-left of the first copy.
      await page.evaluate(() => window.__spike.scene.setView({ zoom: 1, x: 40, y: 80 }));
      await delay(500);
      console.log('Painting the 5k dataset (screenful first, then every node at 1/8)…');
      const started = Date.now();
      await page.evaluate(() => window.__spike.painter.start());
      // A pan while painting goes on in the background, traced.
      await delay(1500);
      const traced = [];
      const pan = await measure('pan-sweep', 'pan-while-painting', traced);
      const panTrace = analyzeTrace(traced);
      await page.waitFor(() => { const s = window.__spike.painter.status(); return s.allMs != null || s.atlasFull; }, null, { timeout: Number(option('--paint-timeout', 180000)), interval: 250, message: 'every node painted' });
      result.status = await page.evaluate(() => window.__spike.painter.status());
      result.wallMs = Date.now() - started;
      result.panWhilePainting = { pageFrames: pan.pageFrames, trace: panTrace, verdict: judge('5k', Object.values(panTrace.summary)[0], report.displayHz || panTrace.refreshHz) };
      console.log(`  screenful ${result.status.screenfulMs} ms, all ${result.status.allMs} ms, ${result.status.batches} batches`);

      // A change to a node that is not being edited: five prompt nodes in view.
      await page.evaluate(() => window.__spike.scene.setView({ zoom: 1, x: 40, y: 80 }));
      await delay(300);
      const prompts = await page.evaluate(() => {
        const ids = [];
        for (let i = 0; i < window.__spike.dataset.nodes && ids.length < 5; i++) {
          const r = window.__spike.scene.nodeRect(i);
          if (r.type === 'prompt' && r.x > 0 && r.y > 0 && r.x + r.width < innerWidth && r.y + r.height < innerHeight) ids.push(r.id);
        }
        return ids;
      });
      await page.evaluate(() => { window.__spike.timings['painter.changeToShownMs'] = []; });
      for (const [k, id] of prompts.entries()) {
        await page.evaluate(({ id, k }) => window.__spike.painter.change(id, { prompt: `Changed while not being edited, take ${k + 1}: a lighthouse at dusk` }), { id, k });
        await delay(600);
      }
      result.changeToShownMs = await page.evaluate(() => window.__spike.timings['painter.changeToShownMs']);
      result.timings = await page.evaluate(() => window.__spike.timings);
      result.memory = await page.evaluate(() => window.__spike.memory());
      result.processes = await processMemory();

      // Painted against live, one node of each type, at 100% on whole pixels.
      const sample = await page.evaluate(() => {
        const seen = new Map();
        for (let i = 0; i < window.__spike.dataset.nodes; i++) { const r = window.__spike.scene.nodeRect(i); if (!seen.has(r.type)) seen.set(r.type, r.id); }
        return [...seen.values()];
      });
      const shots = output.replace(/\.json$/, '') + '-fidelity';
      await fs.mkdir(shots, { recursive: true });
      result.fidelity = [];
      for (const id of sample) {
        await page.evaluate(id => { const s = window.__spike.scene, r = s.nodeRect(id), v = s.view(); s.setView({ zoom: 1, x: Math.round(v.x + 240 - r.x), y: Math.round(v.y + 160 - r.y) }); }, id);
        await page.evaluate(() => window.__spike.live.set([]));
        await page.evaluate(id => window.__spike.painter.paintNow(id), id);
        await delay(250);
        const rect = await page.evaluate(id => window.__spike.scene.paintRect(id), id);
        const box = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
        const painted = await grab(box);
        const swapStarted = Date.now();
        await page.evaluate(id => window.__spike.live.set([id]), id);
        const swapMs = Date.now() - swapStarted;
        await delay(250);
        const live = await grab(box);
        const type = await page.evaluate(id => window.__spike.scene.nodeRect(id).type, id);
        const compared = await compare(painted, live, path.join(shots, type));
        result.fidelity.push({ id, type, swapMs, ...compared, pass: compared.withinTwoLevelsPct >= 99.5 });
        console.log(`  ${type}: ${compared.withinTwoLevelsPct ?? compared.error}% of pixels within 2 levels`);
      }
      await page.evaluate(() => window.__spike.live.set([]));
      result.liveSwapMs = await page.evaluate(() => window.__spike.timings['live.swapMs']);
      await checkErrors();
      return result;
    }

    // Question 1: the scene alone, stand-in images, no painter or live layer.
    if (checks.includes('scene')) for (const size of sizes) {
      const dataset = await open(`size=${size}&painter=off&live=off`, `the ${size} scene`);
      const htmlInCanvas = await page.evaluate(() => window.__spike.htmlInCanvas);
      const traced = [], results = [];
      for (let round = 0; round < rounds; round++) {
        for (const name of gestureNames) {
          // Every node on screen, as question 1 asks, before each gesture.
          await page.evaluate(() => window.__spike.scene.fit());
          await delay(300);
          results.push({ round: round + 1, ...await measure(name, name, traced) });
          await delay(300);
        }
      }
      const trace = analyzeTrace(traced);
      console.log(`\n${formatReport(trace)}\n`);
      const verdicts = Object.fromEntries(Object.entries(trace.summary).map(([label, summary]) => [label, judge(size, summary, report.displayHz || trace.refreshHz)]));
      await checkErrors();
      await fs.writeFile(output.replace(/\.json$/, '') + `-${size}.png`, await page.screenshot());
      report.sizes[size] = { dataset, htmlInCanvas, scene: await page.evaluate(() => window.__spike.scene.info()), memory: await page.evaluate(() => window.__spike.memory()),
        processes: await processMemory(), trace, verdicts, results };
    }

    // Questions 2 and 5: painter A on the 5k dataset, then painted against live nodes.
    if (checks.includes('paint')) report.paint = await paintChecks();
    await fs.writeFile(output, JSON.stringify(report, null, 2));
    console.log(`Saved ${output}`);
  } finally {
    if (app) {
      await app.close();
      for (let wait = 0; wait < 20 && strayElectron().length > strays.length; wait++) await delay(250);
    }
    const remove = dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(error => console.warn(`Could not remove ${dir}: ${error.message}`));
    await remove(profile);
    if (!flag('--keep-traces')) await remove(traceDir);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
