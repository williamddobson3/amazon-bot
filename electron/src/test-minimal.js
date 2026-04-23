const { app } = require('electron');
console.log('app type:', typeof app);
if (app && app.whenReady) {
  app.whenReady().then(() => {
    console.log('App ready! Electron v' + process.versions.electron);
    app.quit();
  });
} else {
  console.log('app is:', app);
  console.log('require electron returned:', typeof require('electron'), require('electron'));
}
