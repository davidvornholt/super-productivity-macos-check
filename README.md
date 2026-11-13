# Super Productivity macOS background throttling check

A temporary repository that runs the manual test of
[super-productivity/super-productivity#11193](https://github.com/super-productivity/super-productivity/pull/11193)
on GitHub-hosted macOS runners. It builds the app before and after the change,
tracks time on a task, and checks the tracked time, the IPC updates and the tray
title while the main window is shown, hidden, minimized and covered by another
window. A control build without the two timer switches showed that the check
notices throttled timers (run 43437566302).

GitHub's macOS images turn App Nap off for every app, and an app the runner
spawns directly counts as part of a daemon, so App Nap can't apply to it. The
workflow turns App Nap back on and starts the app through LaunchServices
(`LAUNCH=open`). Results:
[super-productivity/super-productivity#11193 (comment)](https://github.com/super-productivity/super-productivity/pull/11193#issuecomment-6858186194).

- [Workflow](.github/workflows/macos-background-throttling-check.yml)
- [Check script](check/background-throttling-check.cjs)
