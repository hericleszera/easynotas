console.log('=== DIAGNÓSTICO ===');
console.log('process.versions.electron:', process.versions.electron);
console.log('process.type:', process.type);

const electron = require('electron');
console.log('typeof electron:', typeof electron);
console.log('electron is string?', typeof electron === 'string');

if (typeof electron === 'object') {
  console.log('electron keys:', Object.keys(electron).slice(0, 10));
  console.log('electron.app:', typeof electron.app);
  console.log('electron.ipcMain:', typeof electron.ipcMain);
} else {
  console.log('electron value:', electron);
}

console.log('\n=== TESTE DESESTRUTURAÇÃO ===');
try {
  const { app, ipcMain } = require('electron');
  console.log('app:', typeof app);
  console.log('ipcMain:', typeof ipcMain);
} catch(e) {
  console.log('ERRO:', e.message);
}

setTimeout(() => process.exit(0), 1000);
