#!/usr/bin/env node
/*
 * Automates the manual test of super-productivity/super-productivity#11193:
 * track a task, then leave the main window shown, hidden, minimized and fully
 * covered, and compare the tracked time and the tray title with the wall clock.
 *
 * usage: node background-throttling-check.cjs <app checkout> <output dir> <label>
 *
 * The app checkout must be built (buildFrontend:prod:es6 + electron:build). The
 * app runs in production mode from that checkout with a fresh profile.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { createRequire } = require('node:module');

const [appDirArg, outDirArg, label = 'run'] = process.argv.slice(2);
if (!appDirArg || !outDirArg) {
  console.error('usage: background-throttling-check.cjs <app checkout> <output dir> <label>');
  process.exit(2);
}
const appDir = path.resolve(appDirArg);
const outDir = path.resolve(outDirArg);
fs.mkdirSync(outDir, { recursive: true });

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const PHASE_MS = Number(process.env.PHASE_MS) || 11 * MINUTE;
const SHOWN_MS = Number(process.env.SHOWN_MS) || 2 * MINUTE;
const SETTLE_MS = 5 * SECOND;
const MAIN_URL_PART = 'angular-dist/browser/index.html';
const COVER_SCRIPT = path.join(__dirname, 'cover-window.cjs');

const appRequire = createRequire(path.join(appDir, 'package.json'));
const { _electron } = appRequire('@playwright/test');
const electronPath = appRequire('electron');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString(), ...args);

const run = (cmd, args, timeout = 20 * SECOND) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (error, stdout, stderr) =>
      resolve({ error: error ? String(error) : null, stdout: String(stdout), stderr: String(stderr) }),
    );
  });

// ---------------------------------------------------------------------------
// Main-process helpers
// ---------------------------------------------------------------------------

const mainWin = (electronApp, action) =>
  electronApp.evaluate(
    ({ BrowserWindow }, { action, urlPart }) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().includes(urlPart),
      );
      if (!win) {
        throw new Error('main window not found');
      }
      if (action) {
        win[action]();
      }
      return {
        visible: win.isVisible(),
        minimized: win.isMinimized(),
        focused: win.isFocused(),
        bounds: win.getBounds(),
        visibleWindows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
      };
    },
    { action: action || null, urlPart: MAIN_URL_PART },
  );

const appMetrics = (electronApp) =>
  electronApp.evaluate(({ app }) =>
    app.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      name: m.name || m.serviceName || '',
      percent: m.cpu.percentCPUUsage,
      cumulative: m.cpu.cumulativeCPUUsage ?? null,
      wakeups: m.cpu.idleWakeupsPerSecond,
    })),
  );

const installMainProbe = (electronApp) =>
  electronApp.evaluate(({ ipcMain, Tray, powerMonitor }) => {
    const probe = { ipc: [], tray: [], trayPatch: 'not installed' };
    globalThis.__bgCheck = probe;
    // The renderer sends this after every tracking tick; it carries the task.
    ipcMain.on('CURRENT_TASK_UPDATED', (_ev, task) => {
      probe.ipc.push([Date.now(), task ? task.timeSpent : null]);
    });
    try {
      const original = Tray.prototype.setTitle;
      Tray.prototype.setTitle = function (title, ...rest) {
        probe.tray.push([Date.now(), String(title)]);
        return original.call(this, title, ...rest);
      };
      probe.trayPatch = 'ok';
    } catch (error) {
      probe.trayPatch = String(error);
    }
    // Nobody uses the runner's keyboard or mouse. Report an active user, as if
    // they were working in another app; otherwise idle detection stops adding
    // time after 5 minutes and the comparison would be meaningless.
    powerMonitor.getSystemIdleTime = () => 0;
    return probe.trayPatch;
  });

// ---------------------------------------------------------------------------
// Covering window: a second app with a maximized window, started on demand.
// ---------------------------------------------------------------------------

const startCover = async () => {
  const coverDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bg-cover-'));
  const child = spawn(electronPath, [COVER_SCRIPT, `--user-data-dir=${coverDataDir}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[cover] ${d}`));
  const bounds = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cover window did not open')), 60 * SECOND);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += String(d);
      const m = /COVER (\{.*\})/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]));
      }
    });
    child.once('exit', (code) => reject(new Error(`cover window exited (${code})`)));
  });
  return { child, bounds };
};

const stopCover = async (cover) => {
  if (!cover || cover.child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => cover.child.once('exit', resolve));
  cover.child.kill('SIGTERM');
  await Promise.race([exited, sleep(5 * SECOND)]);
  if (cover.child.exitCode === null) {
    cover.child.kill('SIGKILL');
  }
};

const contains = (outer, inner) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.width >= inner.x + inner.width &&
  outer.y + outer.height >= inner.y + inner.height;

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const maxGap = (times, from, to) => {
  const points = [from, ...times.filter((t) => t > from && t < to), to];
  let max = 0;
  for (let i = 1; i < points.length; i++) {
    max = Math.max(max, points[i] - points[i - 1]);
  }
  return max;
};

const lastAtOrBefore = (entries, t) => {
  let found = null;
  for (const entry of entries) {
    if (entry[0] <= t) {
      found = entry;
    } else {
      break;
    }
  }
  return found;
};

const parseTrayMinutes = (title) => {
  const m = /^(?:(\d+)h\s*)?(\d+)m$/.exec(title.trim());
  return m ? Number(m[1] || 0) * 60 + Number(m[2]) : null;
};

const sumMetrics = (start, end, seconds) => {
  const startByPid = new Map(start.map((m) => [m.pid, m]));
  const byType = {};
  let percent = 0;
  for (const m of end) {
    const s = startByPid.get(m.pid);
    const p =
      s && m.cumulative !== null && s.cumulative !== null
        ? ((m.cumulative - s.cumulative) / seconds) * 100
        : m.percent;
    byType[m.type] ??= { percent: 0, wakeups: 0 };
    byType[m.type].percent += p;
    byType[m.type].wakeups += m.wakeups;
    percent += p;
  }
  return { percent, byType };
};

const analyse = (phase, data) => {
  const { ipc, tray, ticks, vis, ref } = data;
  const { tStart, tEnd } = phase;
  const drift = ([t, spent]) => spent - ref[1] - (t - ref[0]);
  const stopwatchAt = (t) => ref[1] + (t - ref[0]);

  const ipcBefore = lastAtOrBefore(ipc, tStart);
  const ipcLast = lastAtOrBefore(ipc, tEnd);
  const trackedAtEnd = ipcLast ? ipcLast[1] : null;
  const stopwatchAtEnd = stopwatchAt(tEnd);

  const trayChanges = tray
    .filter(([t]) => t > tStart && t <= tEnd)
    .map(([t, title]) => ({ t, title, minutes: parseTrayMinutes(title) }));
  // How late (or early) each tray title change came, measured from the moment
  // the stopwatch reached that full minute.
  const trayDelays = trayChanges
    .filter((c) => c.minutes !== null)
    .map((c) => c.t - (ref[0] + c.minutes * MINUTE - ref[1]));
  const trayAtStart = lastAtOrBefore(tray, tStart);
  const trayAtEnd = lastAtOrBefore(tray, tEnd);

  const visAtStart = lastAtOrBefore(vis, tStart);
  const visChanges = vis.filter(([t]) => t > tStart && t <= tEnd).map(([, s]) => s);

  const seconds = (tEnd - tStart) / SECOND;
  const cpu = sumMetrics(phase.metricsStart, phase.metricsEnd, seconds);

  const result = {
    name: phase.name,
    durationS: Math.round(seconds),
    windowAtStart: phase.stateStart,
    cover: phase.cover || null,
    visibilityState: [visAtStart ? visAtStart[1] : 'unknown', ...visChanges].join(' → '),
    trackedVsStopwatchAtEndMs: trackedAtEnd === null ? null : trackedAtEnd - stopwatchAtEnd,
    timeLostInPhaseMs: ipcBefore && ipcLast ? drift(ipcLast) - drift(ipcBefore) : null,
    maxGapBetweenTrackingUpdatesMs: maxGap(
      ipc.map(([t]) => t),
      tStart,
      tEnd,
    ),
    tray: {
      atStart: trayAtStart ? trayAtStart[1] : null,
      atEnd: trayAtEnd ? trayAtEnd[1] : null,
      expectedAtEnd: `${Math.floor(stopwatchAtEnd / MINUTE)}m`,
      changes: trayChanges.length,
      maxLateMs: trayDelays.length ? Math.max(...trayDelays) : null,
      maxEarlyMs: trayDelays.length ? -Math.min(...trayDelays) : null,
    },
    maxGapOf1sIntervalMs: maxGap(ticks, tStart, tEnd),
    cpuPercentAllProcesses: Number(cpu.percent.toFixed(2)),
    cpuByType: Object.fromEntries(
      Object.entries(cpu.byType).map(([k, v]) => [
        k,
        { percent: Number(v.percent.toFixed(2)), idleWakeupsPerS: Number(v.wakeups.toFixed(1)) },
      ]),
    ),
  };
  const expectedChanges = Math.floor(seconds / 60) - 1;
  result.ok =
    result.trackedVsStopwatchAtEndMs !== null &&
    Math.abs(result.trackedVsStopwatchAtEndMs) <= 3 * SECOND &&
    result.maxGapBetweenTrackingUpdatesMs <= 3 * SECOND &&
    result.tray.changes >= expectedChanges &&
    result.tray.maxLateMs !== null &&
    result.tray.maxLateMs <= 5 * SECOND;
  return result;
};

const fmtS = (ms) => (ms === null ? 'n/a' : `${(ms / SECOND).toFixed(1)} s`);

const toMarkdown = (summary) => {
  const lines = [
    `## ${summary.label}`,
    '',
    `${summary.system}`,
    '',
    `Tray patch: ${summary.trayPatch}. Tracking started at ${new Date(summary.ref[0]).toISOString()}.`,
    '',
    '| Phase | Duration | visibilityState | Tracked − stopwatch at end | Gained (+) / lost (−) in phase | Longest gap between tracking updates | Tray title start → end (expected) | Tray changes | Tray title latest after its minute | Longest gap, 1 s interval | CPU, all processes | GPU idle wakeups/s | OK |',
    '| --- | ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const p of summary.phases) {
    const gpu = p.cpuByType.GPU || p.cpuByType.gpu;
    lines.push(
      `| ${p.name} | ${p.durationS} s | ${p.visibilityState} | ${fmtS(p.trackedVsStopwatchAtEndMs)} | ${fmtS(p.timeLostInPhaseMs)} | ${fmtS(p.maxGapBetweenTrackingUpdatesMs)} | ${p.tray.atStart} → ${p.tray.atEnd} (${p.tray.expectedAtEnd}) | ${p.tray.changes} | ${fmtS(p.tray.maxLateMs)} | ${fmtS(p.maxGapOf1sIntervalMs)} | ${p.cpuPercentAllProcesses} % | ${gpu ? gpu.idleWakeupsPerS : 'n/a'} | ${p.ok ? 'yes' : 'NO'} |`,
    );
  }
  lines.push('');
  for (const p of summary.phases) {
    lines.push(
      `- ${p.name}: window ${JSON.stringify(p.windowAtStart)}${p.cover ? `, cover ${JSON.stringify(p.cover)}` : ''}`,
    );
  }
  lines.push('');
  return lines.join('\n');
};

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const findMainPage = async (electronApp) => {
  const deadline = Date.now() + 60 * SECOND;
  while (Date.now() < deadline) {
    const page = electronApp.windows().find((p) => p.url().includes(MAIN_URL_PART));
    if (page) {
      return page;
    }
    await sleep(250);
  }
  throw new Error(`no window with ${MAIN_URL_PART}: ${electronApp.windows().map((p) => p.url())}`);
};

const startTracking = async (page, title) => {
  const input = page.locator('add-task-bar.global .main-input').first();
  if (!(await input.isVisible())) {
    await page.locator('.tour-addBtn').waitFor({ state: 'visible', timeout: 20 * SECOND });
    await page.locator('.tour-addBtn').click();
  }
  await input.waitFor({ state: 'visible', timeout: 10 * SECOND });
  await input.fill(title);
  await input.press('Enter');
  const task = page.locator('task').filter({ hasText: title }).first();
  await task.waitFor({ state: 'visible', timeout: 20 * SECOND });
  await page.keyboard.press('Escape');
  await sleep(500);
  for (let i = 0; i < 20; i++) {
    if (await task.evaluate((el) => el.classList.contains('isCurrent'))) {
      return;
    }
    await task.hover();
    await task
      .locator('.start-task-btn')
      .click({ timeout: 2 * SECOND })
      .catch(() => undefined);
    await sleep(1000);
  }
  throw new Error('could not start tracking');
};

const main = async () => {
  const system = [
    (await run('sw_vers', [])).stdout.replace(/\s+/g, ' ').trim(),
    (await run('sysctl', ['-n', 'hw.model', 'machdep.cpu.brand_string', 'hw.ncpu'])).stdout
      .replace(/\s+/g, ' ')
      .trim(),
    `Electron ${appRequire('electron/package.json').version}`,
  ].join('; ');
  log(system);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bg-check-'));
  const electronApp = await _electron.launch({
    executablePath: electronPath,
    args: [appDir, `--user-data-dir=${userDataDir}`],
    cwd: appDir,
    env: { ...process.env, NODE_ENV: 'PROD' },
    timeout: 120 * SECOND,
  });
  electronApp.process().stdout.on('data', (d) => fs.appendFileSync(path.join(outDir, 'app.log'), d));
  electronApp.process().stderr.on('data', (d) => fs.appendFileSync(path.join(outDir, 'app.log'), d));

  const phases = [];
  let cover = null;
  let mainProbe = null;
  let rendererProbe = null;
  let trayPatch = null;
  let page = null;
  try {
    page = await findMainPage(electronApp);
    await page.waitForLoadState('domcontentloaded');
    await page.evaluate(() => {
      localStorage.setItem('SUP_ONBOARDING_PRESET_DONE', 'true');
      localStorage.setItem('SUP_ONBOARDING_HINTS_DONE', 'true');
      localStorage.setItem('SUP_IS_SHOW_TOUR', 'true');
      localStorage.setItem('SUP_EXAMPLE_TASKS_CREATED', 'true');
    });
    const dataLoaded = page.waitForEvent('console', {
      predicate: (m) => m.text().includes('[SP_ALL] All Data was loaded'),
      timeout: 60 * SECOND,
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await dataLoaded;
    await page.locator('.route-wrapper').first().waitFor({ state: 'visible' });

    trayPatch = await installMainProbe(electronApp);
    log('tray patch', trayPatch);
    await page.evaluate(() => {
      const probe = { ticks: [], vis: [[Date.now(), document.visibilityState]] };
      window.__bgCheck = probe;
      setInterval(() => probe.ticks.push(Date.now()), 1000);
      document.addEventListener('visibilitychange', () =>
        probe.vis.push([Date.now(), document.visibilityState]),
      );
    });

    await startTracking(page, 'Background throttling check');
    const deadline = Date.now() + 30 * SECOND;
    while (Date.now() < deadline) {
      const n = await electronApp.evaluate(
        () => globalThis.__bgCheck.ipc.filter(([, s]) => s > 0).length,
      );
      if (n > 0) {
        break;
      }
      await sleep(500);
    }
    log('tracking');

    const activateOtherApp = () => run('open', ['-a', 'Finder']);
    const showMain = async () => {
      await mainWin(electronApp, 'show');
      await mainWin(electronApp, 'focus');
    };
    const steps = [
      { name: 'shown', duration: SHOWN_MS, enter: showMain, exit: async () => {} },
      {
        name: 'hidden',
        duration: PHASE_MS,
        enter: async () => {
          await mainWin(electronApp, 'hide');
          await activateOtherApp();
        },
        exit: showMain,
      },
      {
        name: 'minimized',
        duration: PHASE_MS,
        enter: async () => {
          await mainWin(electronApp, 'minimize');
          await activateOtherApp();
        },
        exit: async () => {
          await mainWin(electronApp, 'restore');
          await mainWin(electronApp, 'focus');
        },
      },
      {
        name: 'covered',
        duration: PHASE_MS,
        enter: async () => {
          cover = await startCover();
        },
        exit: async () => {
          await stopCover(cover);
          await mainWin(electronApp, 'focus');
        },
      },
    ];

    for (const step of steps) {
      log('enter', step.name);
      await step.enter();
      await sleep(SETTLE_MS);
      const stateStart = await mainWin(electronApp);
      const phase = { name: step.name, stateStart };
      if (step.name === 'covered') {
        phase.cover = { bounds: cover.bounds, coversMainWindow: contains(cover.bounds, stateStart.bounds) };
      }
      await run('screencapture', ['-x', path.join(outDir, `${step.name}.png`)]);
      phase.metricsStart = await appMetrics(electronApp);
      phase.tStart = Date.now();
      await sleep(step.duration);
      phase.tEnd = Date.now();
      phase.metricsEnd = await appMetrics(electronApp);
      phase.stateEnd = await mainWin(electronApp);
      phases.push(phase);
      log('exit', step.name, JSON.stringify(phase.stateStart));
      await step.exit();
      await sleep(SETTLE_MS);
    }
  } finally {
    await stopCover(cover).catch(() => undefined);
    mainProbe = await electronApp.evaluate(() => globalThis.__bgCheck).catch(() => null);
    rendererProbe = page ? await page.evaluate(() => window.__bgCheck).catch(() => null) : null;
    fs.writeFileSync(
      path.join(outDir, 'raw.json'),
      JSON.stringify({ label, phases, mainProbe, rendererProbe }, null, 1),
    );
    const proc = electronApp.process();
    await Promise.race([electronApp.close().catch(() => undefined), sleep(10 * SECOND)]);
    if (proc.exitCode === null) {
      proc.kill('SIGKILL');
    }
  }

  const ref = mainProbe.ipc.find(([, spent]) => spent > 0);
  const data = {
    ipc: mainProbe.ipc.filter(([, spent]) => spent !== null),
    tray: mainProbe.tray,
    ticks: rendererProbe.ticks,
    vis: rendererProbe.vis,
    ref,
  };
  const summary = {
    label,
    system,
    trayPatch,
    ref,
    phases: phases.map((p) => analyse(p, data)),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const md = toMarkdown(summary);
  fs.writeFileSync(path.join(outDir, 'summary.md'), md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
  console.log(md);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
