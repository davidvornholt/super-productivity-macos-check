// A second app whose maximized, opaque window covers the screen: the
// "fully cover it with another maximized window" step of the manual test.
'use strict';

const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, backgroundColor: '#777777', title: 'Cover' });
  win.loadURL('data:text/html,<title>Cover</title><body style="margin:0;background:%23777777"></body>');
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
    app.focus({ steal: true });
    setTimeout(() => process.stdout.write(`COVER ${JSON.stringify(win.getBounds())}\n`), 2000);
  });
});
