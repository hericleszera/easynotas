delete process.env.ELECTRON_RUN_AS_NODE;

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// ── AUDIT LOG ─────────────────────────────────────────────────────────────────
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const _createdDirs = new Set();

function appendAuditLog(id, log) {
  try {
    if (!_createdDirs.has(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
      _createdDirs.add(LOGS_DIR);
    }
    const date = new Date(log.timestamp);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = date.toTimeString().slice(0, 8);  // HH:MM:SS
    const level = (log.level || 'info').toUpperCase();
    const line = `[${timeStr}] [${level}] ${log.message}\n`;
    const filePath = path.join(LOGS_DIR, `instancia-${id}-${dateStr}.txt`);
    fs.appendFile(filePath, line, 'utf8', () => {});
  } catch (e) { /* silently ignore audit log failures */ }
}

// Localiza o Node.js do sistema (não o do Electron)
const { execSync } = require('child_process');

function findNodeExe() {
  try {
    const cmd = process.platform === 'win32' ? 'where node' : 'which node';
    const result = execSync(cmd, { encoding: 'utf8', timeout: 3000 }).trim().split('\n');
    // filtra o executável do Electron (contém 'electron' no caminho)
    const node = result.find(p => !p.toLowerCase().includes('electron'));
    if (node) return node.trim();
  } catch {}
  // fallbacks
  return process.platform === 'win32'
    ? 'C:\\Program Files\\nodejs\\node.exe'
    : '/usr/local/bin/node';
}
const NODE_EXE = findNodeExe();

let mainWindow;
const instancias = new Map();

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 860,
    minHeight: 560,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#07070f',
    title: 'EasyNotas',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
  });

  // Abre tela de login primeiro
  mainWindow.loadFile(path.join(__dirname, 'login.html'));

  mainWindow.on('closed', () => {
    for (const [, inst] of instancias) {
      if (inst.process) inst.process.kill();
    }
    instancias.clear();
  });
}

// ── IPC: LOGIN ────────────────────────────────────────────────────────────────
const https = require('https');
const http2 = require('http');

function apiPost(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http2;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const API_BASE = process.env.EASYNOTAS_API || 'https://easynotas-production.up.railway.app';

ipcMain.handle('auth-login', async (event, { username, password }) => {
  try {
    const res = await apiPost(`${API_BASE}/api/auth/login`, { username, password });
    return res;
  } catch (err) {
    return { status: 0, body: { error: 'Sem conexão com o servidor. Verifique sua internet.' } };
  }
});

ipcMain.handle('auth-verify', async (event, token) => {
  try {
    const res = await apiPost(`${API_BASE}/api/auth/verify`, { token });
    return res;
  } catch (err) {
    return { status: 0, body: { error: 'Sem conexão com o servidor.' } };
  }
});

ipcMain.handle('auth-ir-dashboard', async (event, { token, username, diasRestantes, role }) => {
  // Persiste sessão localmente (arquivo criptografado simples)
  const sessionFile = path.join(os.homedir(), 'AppData', 'Local', 'EasyNotas', 'session.json');
  try {
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ token, username, diasRestantes, role, savedAt: Date.now() }), 'utf8');
  } catch {}
  mainWindow.loadFile(path.join(__dirname, 'dashboard.html'));
});

ipcMain.handle('auth-get-session', async () => {
  const sessionFile = path.join(os.homedir(), 'AppData', 'Local', 'EasyNotas', 'session.json');
  try {
    const raw = fs.readFileSync(sessionFile, 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
});

ipcMain.handle('auth-logout', async () => {
  const sessionFile = path.join(os.homedir(), 'AppData', 'Local', 'EasyNotas', 'session.json');
  try { fs.unlinkSync(sessionFile); } catch {}
  mainWindow.loadFile(path.join(__dirname, 'login.html'));
});

// ── CONTROLE DA JANELA ────────────────────────────────────────────────────────
ipcMain.on('win-minimize',  () => mainWindow && mainWindow.minimize());
ipcMain.on('win-maximize',  () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('win-close',     () => mainWindow && mainWindow.close());

// ── JANELA ADMIN ──────────────────────────────────────────────────────────────
let adminWindow = null;
ipcMain.handle('abrir-janela-admin', () => {
  if (adminWindow && !adminWindow.isDestroyed()) {
    adminWindow.focus();
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 800,
    minHeight: 500,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    backgroundColor: '#07070f',
    title: 'EasyNotas — Admin',
    autoHideMenuBar: true,
    parent: mainWindow,
  });
  adminWindow.loadFile(path.join(__dirname, 'admin.html'));
  adminWindow.on('closed', () => { adminWindow = null; });
});

function broadcast(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function broadcastEstado() {
  const lista = Array.from(instancias.entries()).map(([id, inst]) => ({
    id,
    status: inst.status,
    empresas: inst.empresas,
    empresaAtual: inst.empresaAtual,
  }));
  broadcast('estado', lista);
}

ipcMain.handle('iniciar-instancia', async (event, id) => {
  if (instancias.has(id)) return { success: false, error: 'Já existe' };
  if (instancias.size >= 4) return { success: false, error: 'Máximo de 4 instâncias' };

  instancias.set(id, { status: 'iniciando', empresas: [], empresaAtual: null, logs: [] });
  broadcastEstado();

  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '' };
  const customDir = customDownloadDirs.get(id);
  if (customDir) env.EASYNOTAS_DOWNLOAD_DIR = customDir;

  const worker = spawn(NODE_EXE, [path.join(__dirname, 'bot-worker.js'), String(id)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });

  // Log de diagnóstico
  worker.on('error', (err) => {
    const inst = instancias.get(id);
    if (!inst) return;
    const logEntry = { message: `Falha ao iniciar worker: ${err.message}`, level: 'error', timestamp: new Date().toISOString() };
    inst.logs.push(logEntry);
    inst.status = 'erro';
    broadcast('log', { id, log: logEntry });
    broadcastEstado();
  });

  instancias.get(id).process = worker;

  // Recebe mensagens JSON do worker via stdout
  let buffer = '';
  worker.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const inst = instancias.get(id);
        if (!inst) continue;
        if (msg.type === 'log') {
          inst.logs.push(msg.data);
          if (inst.logs.length > 550) inst.logs = inst.logs.slice(-550);
          broadcast('log', { id, log: msg.data });
          appendAuditLog(id, msg.data);
        } else if (msg.type === 'status') {
          inst.status = msg.data;
          broadcastEstado();
        } else if (msg.type === 'empresas') {
          inst.empresas = msg.data;
          broadcastEstado();
        } else if (msg.type === 'empresa-progress') {
          inst.empresaAtual = msg.data;
          broadcast('empresa-progress', { id, empresaAtual: msg.data });
        }
      } catch {}
    }
  });

  // Captura stderr
  worker.stderr.on('data', (data) => {
    const inst = instancias.get(id);
    if (!inst) return;
    const msg = data.toString().trim();
    if (!msg) return;
    const logEntry = { message: msg, level: 'error', timestamp: new Date().toISOString() };
    inst.logs.push(logEntry);
    broadcast('log', { id, log: logEntry });
    appendAuditLog(id, logEntry);
  });

  worker.on('exit', (code) => {
    const inst = instancias.get(id);
    if (inst) {
      inst.status = code === 0 ? 'concluido' : 'erro';
      broadcastEstado();
    }
  });

  return { success: true };
});

ipcMain.handle('parar-instancia', (event, id) => {
  const inst = instancias.get(id);
  if (!inst) return { success: false };
  if (inst.process) inst.process.kill();
  instancias.delete(id);
  broadcastEstado();
  return { success: true };
});

ipcMain.on('continuar-instancia', (event, { id, filtros }) => {
  const inst = instancias.get(id);
  if (inst && inst.process && inst.process.stdin) {
    if (filtros) {
      inst.process.stdin.write(JSON.stringify({ type: 'continuar-formulario', filtros }) + '\n');
    } else {
      inst.process.stdin.write('continue\n');
    }
  }
});

ipcMain.on('selecionar-empresa', (event, { id, url, filtros }) => {
  const inst = instancias.get(id);
  if (inst && inst.process && inst.process.stdin) {
    inst.process.stdin.write(JSON.stringify({ type: 'empresa-selecionada', url, filtros }) + '\n');
  }
});

ipcMain.handle('get-estado', () => {
  return Array.from(instancias.entries()).map(([id, inst]) => ({
    id, status: inst.status, empresas: inst.empresas,
    empresaAtual: inst.empresaAtual,
  }));
});

ipcMain.on('abrir-pasta-download', (event, id) => {
  const customDir = customDownloadDirs.get(id);
  const dir = customDir || path.join(__dirname, '..', 'downloads', 'instancia-' + id);
  shell.openPath(dir);
});

// Mapa de diretórios customizados por instância
const customDownloadDirs = new Map();

ipcMain.handle('selecionar-pasta-download', async (event, id) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: `Pasta de destino — Instância ${id}`,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const dir = result.filePaths[0];
  customDownloadDirs.set(id, dir);
  return dir;
});

ipcMain.handle('get-pasta-download', (event, id) => {
  return customDownloadDirs.get(id) || null;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // nova instância tentou abrir — foca a janela existente
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(createMainWindow);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
