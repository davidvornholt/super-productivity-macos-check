/*
 * Loaded into the app's main process with NODE_OPTIONS=--require. It drives
 * the check from inside the app instead of over a debugging protocol, because
 * Playwright's Electron launcher appends --disable-background-timer-throttling,
 * --disable-renderer-backgrounding and --disable-backgrounding-occluded-windows
 * and keeps attached pages visible, which would hide exactly what this checks.
 *
 * It writes <BG_CHECK_OUT>/raw.json and quits the app.
 */
'use strict';

if (process.type !== 'browser') {
  return;
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { app, BrowserWindow, ipcMain, Tray } = require('electron');

const SECOND = 1000;
const OUT = process.env.BG_CHECK_OUT;
const PHASE_MS = Number(process.env.BG_CHECK_PHASE_MS);
const SHOWN_MS = Number(process.env.BG_CHECK_SHOWN_MS);
const COVER_SCRIPT = process.env.BG_CHECK_COVER;
const ELECTRON = process.env.BG_CHECK_ELECTRON;
const SETTLE_MS = 5 * SECOND;
const MAIN_URL_PART = 'angular-dist/browser/index.html';
const TASK_TITLE = 'Background throttling check';

// Child processes (Finder, screencapture, the cover window) must not load this.
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (key === 'NODE_OPTIONS' || key.startsWith('BG_CHECK_')) {
    delete childEnv[key];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[bg-check]', new Date().toISOString(), ...args);
const run = (cmd, args, timeout = 20 * SECOND) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, env: childEnv }, (error, stdout) =>
      resolve({ error: error ? String(error) : null, stdout: String(stdout) }),
    );
  });

log('driver loaded', `electron ${process.versions.electron}`, `pid ${process.pid}`);

// ---------------------------------------------------------------------------
// Probes, installed before the app's own code runs
// ---------------------------------------------------------------------------

const probe = { ipc: [], tray: [], trayPatch: 'not installed', switches: {} };

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

app.once('ready', () => {
  // Nobody uses the runner's keyboard or mouse. Report an active user, as if
  // they were working in another app; otherwise idle detection stops adding
  // time after 5 minutes and the comparison would be meaningless.
  const { powerMonitor } = require('electron');
  powerMonitor.getSystemIdleTime = () => 0;
  for (const name of [
    'disable-background-timer-throttling',
    'disable-renderer-backgrounding',
    'disable-backgrounding-occluded-windows',
  ]) {
    probe.switches[name] = app.commandLine.hasSwitch(name);
  }
  log('switches', JSON.stringify(probe.switches));
  drive().then(
    () => finish(0),
    (error) => {
      log('error', error && error.stack ? error.stack : String(error));
      finish(1, error);
    },
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mainWin = null;
let cover = null;
const phases = [];

const waitFor = async (what, fn, timeout = 30 * SECOND, interval = 250) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) {
      return value;
    }
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const js = (code) => mainWin.webContents.executeJavaScript(code, true);

const winState = () => ({
  visible: mainWin.isVisible(),
  minimized: mainWin.isMinimized(),
  focused: mainWin.isFocused(),
  bounds: mainWin.getBounds(),
  visibleWindows: BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length,
});

const appMetrics = () =>
  app.getAppMetrics().map((m) => ({
    pid: m.pid,
    type: m.type,
    name: m.name || m.serviceName || '',
    percent: m.cpu.percentCPUUsage,
    cumulative: m.cpu.cumulativeCPUUsage ?? null,
    wakeups: m.cpu.idleWakeupsPerSecond,
  }));

const key = (keyCode) => {
  mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode });
};

const startCover = async () => {
  const coverDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-bg-cover-'));
  const child = spawn(ELECTRON, [COVER_SCRIPT, `--user-data-dir=${coverDataDir}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv,
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

const stopCover = async () => {
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
// Setup: skip onboarding, add a task and start tracking it
// ---------------------------------------------------------------------------

const waitForDataLoaded = () =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('app data did not load')), 90 * SECOND);
    const onMessage = (...args) => {
      const message =
        args[0] && typeof args[0].message === 'string' ? args[0].message : String(args[2] ?? '');
      if (message.includes('[SP_ALL] All Data was loaded')) {
        clearTimeout(timer);
        mainWin.webContents.off('console-message', onMessage);
        resolve();
      }
    };
    mainWin.webContents.on('console-message', onMessage);
  });

const setUp = async () => {
  mainWin = await waitFor(
    'the main window',
    () => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes(MAIN_URL_PART)),
    120 * SECOND,
  );
  await waitFor('the first load', () => !mainWin.webContents.isLoading(), 120 * SECOND);
  await js(`
    localStorage.setItem('SUP_ONBOARDING_PRESET_DONE', 'true');
    localStorage.setItem('SUP_ONBOARDING_HINTS_DONE', 'true');
    localStorage.setItem('SUP_IS_SHOW_TOUR', 'true');
    localStorage.setItem('SUP_EXAMPLE_TASKS_CREATED', 'true');
    true;
  `);
  const loaded = waitForDataLoaded();
  mainWin.webContents.reload();
  await loaded;
  await waitFor('the app shell', () => js(`!!document.querySelector('.route-wrapper')`));
  mainWin.show();
  mainWin.focus();
  await sleep(2 * SECOND);

  await js(`
    window.__bgCheck = { ticks: [], vis: [[Date.now(), document.visibilityState]] };
    setInterval(() => window.__bgCheck.ticks.push(Date.now()), 1000);
    document.addEventListener('visibilitychange', () =>
      window.__bgCheck.vis.push([Date.now(), document.visibilityState]),
    );
    true;
  `);

  // Add the task.
  const inputSelector = 'add-task-bar.global .main-input';
  if (!(await js(`!!document.querySelector(${JSON.stringify(inputSelector)})`))) {
    await waitFor('the add button', () => js(`!!document.querySelector('.tour-addBtn')`), 20 * SECOND);
    await js(`document.querySelector('.tour-addBtn').click(); true`);
  }
  await waitFor('the add task input', () =>
    js(`!!document.querySelector(${JSON.stringify(inputSelector)})`),
  );
  await js(`document.querySelector(${JSON.stringify(inputSelector)}).focus(); true`);
  await sleep(300);
  mainWin.webContents.insertText(TASK_TITLE);
  await sleep(300);
  key('Enter');
  const findTask = `[...document.querySelectorAll('task')].find((el) => el.textContent.includes(${JSON.stringify(TASK_TITLE)}))`;
  await waitFor('the new task', () => js(`!!(${findTask})`), 20 * SECOND);
  key('Escape');
  await sleep(500);

  // Hover the task so its play button renders, then click it.
  for (let i = 0; i < 20; i++) {
    if (await js(`!!(${findTask})?.classList.contains('isCurrent')`)) {
      return;
    }
    const rect = await js(`(() => {
      const r = (${findTask}).getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    mainWin.webContents.sendInputEvent({ type: 'mouseEnter', x: rect.x, y: rect.y });
    mainWin.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y });
    await sleep(500);
    await js(`(() => {
      const button = (${findTask}).querySelector('.start-task-btn');
      if (button) { button.click(); }
      return !!button;
    })()`);
    await sleep(1000);
  }
  throw new Error('could not start tracking');
};

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const drive = async () => {
  await setUp();
  await waitFor('a tracking update', () => probe.ipc.some(([, spent]) => spent > 0));
  log('tracking');

  const activateOtherApp = () => run('open', ['-a', 'Finder']);
  const showMain = async () => {
    mainWin.show();
    mainWin.focus();
  };
  const steps = [
    { name: 'shown', duration: SHOWN_MS, enter: showMain, exit: async () => {} },
    {
      name: 'hidden',
      duration: PHASE_MS,
      enter: async () => {
        mainWin.hide();
        await activateOtherApp();
      },
      exit: showMain,
    },
    {
      name: 'minimized',
      duration: PHASE_MS,
      enter: async () => {
        mainWin.minimize();
        await activateOtherApp();
      },
      exit: async () => {
        mainWin.restore();
        mainWin.focus();
      },
    },
    {
      name: 'covered',
      duration: PHASE_MS,
      enter: async () => {
        cover = await startCover();
      },
      exit: async () => {
        await stopCover();
        mainWin.focus();
      },
    },
  ];

  for (const step of steps) {
    log('enter', step.name);
    await step.enter();
    await sleep(SETTLE_MS);
    const stateStart = winState();
    const phase = { name: step.name, stateStart };
    if (step.name === 'covered') {
      phase.cover = { bounds: cover.bounds, coversMainWindow: contains(cover.bounds, stateStart.bounds) };
    }
    await run('screencapture', ['-x', path.join(OUT, `${step.name}.png`)]);
    phase.metricsStart = appMetrics();
    phase.tStart = Date.now();
    await sleep(step.duration);
    phase.tEnd = Date.now();
    phase.metricsEnd = appMetrics();
    phase.stateEnd = winState();
    phases.push(phase);
    log('exit', step.name, JSON.stringify(stateStart));
    await step.exit();
    await sleep(SETTLE_MS);
  }
};

let finished = false;
const finish = async (code, error) => {
  if (finished) {
    return;
  }
  finished = true;
  await stopCover().catch(() => undefined);
  let rendererProbe = null;
  if (mainWin && !mainWin.isDestroyed()) {
    rendererProbe = await Promise.race([
      js(`JSON.stringify(window.__bgCheck || null)`).then((s) => JSON.parse(s)),
      sleep(10 * SECOND).then(() => null),
    ]).catch(() => null);
  }
  fs.writeFileSync(
    path.join(OUT, 'raw.json'),
    JSON.stringify(
      { phases, mainProbe: probe, rendererProbe, error: error ? String(error.stack || error) : null },
      null,
      1,
    ),
  );
  log('raw.json written, exiting', code);
  app.exit(code);
};
