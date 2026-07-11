const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Auth
  login:        (username, password) => ipcRenderer.invoke('auth-login', { username, password }),
  verificarToken: (token)            => ipcRenderer.invoke('auth-verify', token),
  irDashboard:  (data)               => ipcRenderer.invoke('auth-ir-dashboard', data),
  getSession:   ()                   => ipcRenderer.invoke('auth-get-session'),
  logout:       ()                   => ipcRenderer.invoke('auth-logout'),

  // Bot
  iniciarInstancia:  (id)              => ipcRenderer.invoke('iniciar-instancia', id),
  pararInstancia:    (id)              => ipcRenderer.invoke('parar-instancia', id),
  continuarInstancia:(id, filtros)     => ipcRenderer.send('continuar-instancia', { id, filtros }),
  selecionarEmpresa: (id, url, filtros)=> ipcRenderer.send('selecionar-empresa', { id, url, filtros }),
  getEstado:         ()                => ipcRenderer.invoke('get-estado'),
  abrirPastaDownload:(id)              => ipcRenderer.send('abrir-pasta-download', id),

  onEstado:         (cb) => ipcRenderer.on('estado',          (_, data) => cb(data)),
  onLog:            (cb) => ipcRenderer.on('log',             (_, data) => cb(data)),
  onEmpresaProgress:(cb) => ipcRenderer.on('empresa-progress',(_, data) => cb(data)),
});
