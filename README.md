# Super Productivity macOS background throttling check

A temporary repository that runs the manual test of
[super-productivity/super-productivity#11193](https://github.com/super-productivity/super-productivity/pull/11193)
on GitHub-hosted macOS runners. It builds the app before and after the change,
tracks time on a task, and checks the tracked time, the IPC updates and the tray
title while the main window is shown, hidden, minimized and covered by another
window. A control build without the two timer switches shows that the check
notices throttled timers.

- [Workflow](.github/workflows/macos-background-throttling-check.yml)
- [Check script](check/background-throttling-check.cjs)
