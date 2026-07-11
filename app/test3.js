// Intercepta o require antes de tudo
const Module = require('module');
const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'electron') {
    console.log('require("electron") chamado de:', parent && parent.filename);
    console.trace();
  }
  return origLoad.apply(this, arguments);
};

const { app, ipcMain } = require('electron');
console.log('app:', typeof app);
console.log('ipcMain:', typeof ipcMain);
