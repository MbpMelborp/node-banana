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

    for (const size of sizes) {
      console.log(`Opening the ${size} dataset…`);
      await page.evaluate(`location.href = '/gpu-spike?size=${size}&overlay=off'`);
      await delay(1000);
      await page.waitFor(() => window.__spike?.ready || window.__spike?.error, null, { timeout: 300000, message: `the ${size} scene` });
      const error = await page.evaluate(() => window.__spike.error || null);
      if (error) throw new Error(`The spike page failed: ${error}`);
      await page.evaluate(PAGE_PROBE);
      await page.evaluate(() => {
        window.__perfErrors = [];
        addEventListener('error', event => window.__perfErrors.push(event.message));
        addEventListener('unhandledrejection', event => window.__perfErrors.push(String(event.reason?.message || event.reason)));
        window.__spikeInput = {};
        addEventListener('pointerup', event => { window.__spikeInput.up = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
        addEventListener('pointermove', event => { window.__spikeInput.move = { x: event.clientX, y: event.clientY }; }, { capture: true, passive: true });
      });
      const dataset = await page.evaluate(() => window.__spike.dataset);
      const htmlInCanvas = await page.evaluate(() => window.__spike.htmlInCanvas);
      console.log(`  ${dataset.nodes} nodes, ${dataset.edges} edges, loaded in ${dataset.loadMs} ms`);
      const devicePixelRatio = await page.evaluate(() => devicePixelRatio);
      const pageToScreen = process.platform === 'win32' ? devicePixelRatio : devicePixelRatio / geometry.scaleFactor;

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

      const traced = [], results = [];
      for (let round = 0; round < rounds; round++) {
        for (const name of gestureNames) {
          const spec = GESTURES[name];
          // Every node on screen, as question 1 asks, before each gesture.
          await page.evaluate(() => window.__spike.scene.fit());
          await delay(300);
          const origin = await target(spec.target);
          assert.ok(origin, `No ${spec.target} to start ${name} on`);
          const events = schedule(spec, origin, { hz, seconds });
          const viewBefore = await page.evaluate(() => window.__spike.scene.view());
          await app.run(({ contentTracing }, categories) => contentTracing.startRecording({ included_categories: categories, excluded_categories: ['*'] }), PERF_TRACE_CATEGORIES);
          await page.evaluate(name => { performance.mark(`banana:gesture ${name}`); window.__spikeInput = {}; window.__spike.frames.start(); }, name);
          const sent = await play(events, { synthetic: spec.synthetic });
          const last = events.at(-1);
          await page.waitFor(({ type, x, y }) => { const seen = type === 'up' ? window.__spikeInput.up : window.__spikeInput.move;
            return seen && Math.abs(seen.x - x) <= 1.5 && Math.abs(seen.y - y) <= 1.5; }, last, { message: `${name} to reach the page` });
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const frames = await page.evaluate(() => window.__spike.frames.stop());
          const traceFile = await app.run(({ contentTracing }, file) => contentTracing.stopRecording(file), path.join(traceDir, `${size}-${name}-${round + 1}.json`));
          for (const event of readTrace(traceFile)) if (keepAnalyzed(event)) traced.push(event);
          if (!flag('--keep-traces')) await fs.rm(traceFile, { force: true });
          const viewAfter = await page.evaluate(() => window.__spike.scene.view());
          if (spec.target === 'node') {
            const after = await page.evaluate(i => window.__spike.scene.nodeRect(i), origin.index);
            assert.ok(after.x !== origin.before.x || after.y !== origin.before.y, `${name} did not move the node`);
          } else assert.notDeepEqual(viewAfter, viewBefore, `${name} did not move the view`);
          const result = { name, round: round + 1, inputEvents: sent, input: spec.synthetic || !osInput ? 'synthetic' : 'os', pageFrames: frames };
          results.push(result);
          console.log(`  ${name}: ${frames.fps} frames/s in the page, js p95 ${frames.jsMs.p95} ms`);
          await delay(300);
        }
      }
      const trace = analyzeTrace(traced);
      console.log(`\n${formatReport(trace)}\n`);
      const memory = await page.evaluate(() => window.__spike.memory());
      const processes = await app.run(({ app }) => app.getAppMetrics().map(m => ({ type: m.type, workingSetMB: Math.round(m.memory.workingSetSize / 1024), privateMB: m.memory.privateBytes == null ? null : Math.round(m.memory.privateBytes / 1024) })));
      const sceneInfo = await page.evaluate(() => window.__spike.scene.info());
      const verdicts = Object.fromEntries(Object.entries(trace.summary).map(([label, summary]) => [label, judge(size, summary, report.displayHz || trace.refreshHz)]));
      const errors = await page.evaluate(() => window.__perfErrors);
      assert.deepEqual(errors, [], 'Page errors during the run');
      await fs.writeFile(output.replace(/\.json$/, '') + `-${size}.png`, await page.screenshot());
      report.sizes[size] = { dataset, htmlInCanvas, scene: sceneInfo, memory, processes, trace, verdicts, results };
    }
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
