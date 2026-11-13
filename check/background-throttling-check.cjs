#!/usr/bin/env node
/*
 * Automates the manual test of super-productivity/super-productivity#11193:
 * track a task, then leave the main window shown, hidden, minimized and fully
 * covered, and compare the tracked time and the tray title with the wall clock.
 *
 * usage: node background-throttling-check.cjs <app checkout> <output dir> <label>
 *
 * The app checkout must be built (buildFrontend:prod:es6 + electron:build). The
 * app runs in production mode from that checkout with a fresh profile, and
 * driver.cjs, loaded into its main process, runs the phases.
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
const COVER_SCRIPT = path.join(__dirname, 'cover-window.cjs');

const DRIVER = path.join(__dirname, 'driver.cjs');

const appRequire = createRequire(path.join(appDir, 'package.json'));
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
  const { ipc, tray, ticks, mainTicks, vis, ref } = data;
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
    maxGapOfMain1sIntervalMs: mainTicks ? maxGap(mainTicks, tStart, tEnd) : null,
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
    (result.tray.maxLateMs === null ? expectedChanges <= 0 : result.tray.maxLateMs <= 5 * SECOND);
  return result;
};

const fmtS = (ms) => (ms === null ? 'n/a' : `${(ms / SECOND).toFixed(1)} s`);

const toMarkdown = (summary) => {
  const lines = [
    `## ${summary.label}`,
    '',
    `${summary.system}`,
    '',
    `Tray patch: ${summary.trayPatch}. Switches: ${JSON.stringify(summary.switches)}. Tracking started at ${new Date(summary.ref[0]).toISOString()}.`,
    '',
    '| Phase | Duration | visibilityState | Tracked − stopwatch at end | Gained (+) / lost (−) in phase | Longest gap between tracking updates | Tray title start → end (expected) | Tray changes | Tray title latest after its minute | Longest gap, 1 s interval | Same, main process | CPU, all processes | GPU idle wakeups/s | OK |',
    '| --- | ---: | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const p of summary.phases) {
    const gpu = p.cpuByType.GPU || p.cpuByType.gpu;
    lines.push(
      `| ${p.name} | ${p.durationS} s | ${p.visibilityState} | ${fmtS(p.trackedVsStopwatchAtEndMs)} | ${fmtS(p.timeLostInPhaseMs)} | ${fmtS(p.maxGapBetweenTrackingUpdatesMs)} | ${p.tray.atStart} → ${p.tray.atEnd} (${p.tray.expectedAtEnd}) | ${p.tray.changes} | ${fmtS(p.tray.maxLateMs)} | ${fmtS(p.maxGapOf1sIntervalMs)} | ${fmtS(p.maxGapOfMain1sIntervalMs)} | ${p.cpuPercentAllProcesses} % | ${gpu ? gpu.idleWakeupsPerS : 'n/a'} | ${p.ok ? 'yes' : 'NO'} |`,
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

// LAUNCH=open starts the app through LaunchServices, as Finder or the Dock
// would. Spawned directly, it runs as a child of the runner's daemon, which
// macOS doesn't treat as an app, so App Nap could never apply to it.
const LAUNCH_WITH_OPEN = process.env.LAUNCH === 'open';

const runApp = (userDataDir) =>
  new Promise((resolve) => {
    const env = {
      NODE_ENV: 'PROD',
      NODE_OPTIONS: `--require ${DRIVER}`,
      BG_CHECK_OUT: outDir,
      BG_CHECK_PHASE_MS: String(PHASE_MS),
      BG_CHECK_SHOWN_MS: String(SHOWN_MS),
      BG_CHECK_COVER: COVER_SCRIPT,
      BG_CHECK_ELECTRON: electronPath,
      // A LaunchServices-launched app has no screen recording permission.
      BG_CHECK_SCREENSHOTS: LAUNCH_WITH_OPEN ? '0' : '1',
    };
    const appArgs = [appDir, `--user-data-dir=${userDataDir}`];
    const appLogPath = path.join(outDir, 'app.log');
    let child;
    let driverLoaded = false;
    let logTimer = null;
    if (LAUNCH_WITH_OPEN) {
      const bundle = path.resolve(electronPath, '../../..');
      const errLogPath = path.join(outDir, 'app.stderr.log');
      fs.writeFileSync(appLogPath, '');
      fs.writeFileSync(errLogPath, '');
      child = spawn(
        'open',
        [
          '-n',
          '-W',
          '--stdout',
          appLogPath,
          '--stderr',
          errLogPath,
          ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
          '-a',
          bundle,
          '--args',
          ...appArgs,
        ],
        { stdio: 'inherit' },
      );
      let printed = 0;
      logTimer = setInterval(() => {
        const lines = fs.readFileSync(appLogPath, 'utf8').split('\n');
        for (const line of lines.slice(printed, -1)) {
          if (line.includes('[bg-check]')) {
            driverLoaded = true;
            console.log(line);
          }
        }
        printed = Math.max(printed, lines.length - 1);
      }, 5 * SECOND);
    } else {
      const appLog = fs.createWriteStream(appLogPath);
      child = spawn(electronPath, appArgs, {
        cwd: appDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
      });
      const onData = (d) => {
        appLog.write(d);
        for (const line of String(d).split('\n')) {
          if (line.includes('[bg-check]')) {
            driverLoaded = true;
            console.log(line);
          }
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.once('exit', () => appLog.end());
    }
    const kill = () => {
      child.kill('SIGKILL');
      if (LAUNCH_WITH_OPEN) {
        execFile('pkill', ['-9', '-f', userDataDir], () => undefined);
      }
    };
    const budget = SHOWN_MS + 3 * PHASE_MS + 10 * MINUTE;
    const killTimer = setTimeout(() => {
      log('the app ran out of time, killing it');
      kill();
    }, budget);
    const loadTimer = setTimeout(() => {
      if (!driverLoaded) {
        log('the driver did not load, killing the app');
        kill();
      }
    }, 2 * MINUTE);
    child.once('exit', (code, signal) => {
      clearTimeout(killTimer);
      clearTimeout(loadTimer);
      if (logTimer) {
        clearInterval(logTimer);
      }
      resolve({ code, signal });
    });
  });

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
  const exit = await runApp(userDataDir);
  log('app exited', JSON.stringify(exit));
  const rawPath = path.join(outDir, 'raw.json');
  if (!fs.existsSync(rawPath)) {
    throw new Error('the driver wrote no raw.json; see app.log');
  }
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  if (raw.error) {
    throw new Error(`the driver failed: ${raw.error}`);
  }
  const { phases, mainProbe, rendererProbe } = raw;

  const ref = mainProbe.ipc.find(([, spent]) => spent > 0);
  const data = {
    ipc: mainProbe.ipc.filter(([, spent]) => spent !== null),
    tray: mainProbe.tray,
    ticks: rendererProbe.ticks,
    mainTicks: mainProbe.mainTicks,
    vis: rendererProbe.vis,
    ref,
  };
  const summary = {
    label,
    system,
    trayPatch: mainProbe.trayPatch,
    switches: mainProbe.switches,
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
