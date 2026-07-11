const path = require('path');
const os = require('os');
const fs = require('fs');

// Fila única de leitura de stdin — evita múltiplas interfaces readline no mesmo stream
const stdinQueue = [];
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  const lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (stdinQueue.length > 0) {
      const resolve = stdinQueue.shift();
      resolve(trimmed);
    }
  }
});

function waitStdin() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = stdinQueue.indexOf(resolve);
      if (idx !== -1) stdinQueue.splice(idx, 1);
      reject(new Error('stdin timeout após 10 minutos'));
    }, 10 * 60 * 1000);
    stdinQueue.push((line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

delete process.env.ELECTRON_RUN_AS_NODE;

const BASE_URL = 'https://online.sefaz.am.gov.br';
const LOGIN_URL = `${BASE_URL}/dte/loginSSL.asp`;
const INSTANCIA_ID = parseInt(process.argv[2] || '1', 10);
const DEBUG_PORT = 9220 + INSTANCIA_ID;
const USER_DATA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'EasyNotas', `perfil-${INSTANCIA_ID}`);
const DOWNLOAD_DIR = process.env.EASYNOTAS_DOWNLOAD_DIR
  || path.join(__dirname, '..', 'downloads', `instancia-${INSTANCIA_ID}`);
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function send(type, data) {
  process.stdout.write(JSON.stringify({ type, data }) + '\n');
}

function log(message, level = 'info') {
  send('log', { message, level, timestamp: new Date().toISOString() });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForContinue() {
  const line = await waitStdin();
  if (line !== 'continue') log(`waitForContinue recebeu inesperado: ${line}`, 'warning');
}

async function fecharPopups(page) {
  let count = 0;
  while (true) {
    try {
      const btn = await page.$('#btFecharPopUpDTe');
      if (!btn) break;
      const visible = await page.evaluate(el => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      }, btn);
      if (!visible) break;
      await btn.click();
      count++;
      log(`Popup de aviso fechado (${count}).`, 'warning');
      await sleep(1000);
    } catch { break; }
  }
}

async function coletarEmpresas(page) {
  await page.waitForSelector('a[href*="sel_inscricao_pj.asp"]', { timeout: 10000 });
  return page.evaluate((base) => {
    const rows = Array.from(document.querySelectorAll('tr'));
    const empresas = [];

    for (const row of rows) {
      const link = row.querySelector('a[href*="sel_inscricao_pj.asp"]');
      if (!link) continue;

      const cells = row.querySelectorAll('td');
      let nome = '', inscricao = '', cnpj = '';

      // Tenta pegar pelos índices das colunas
      if (cells.length >= 3) {
        nome = cells[0].textContent.trim() || link.textContent.trim();
        inscricao = cells[1].textContent.trim();
        cnpj = cells[2].textContent.trim();
      } else {
        nome = link.textContent.trim();
      }

      // Fallback: pega o nome do link se célula vazia
      if (!nome) nome = link.textContent.trim();

      const url = link.href.startsWith('http') ? link.href : base + link.getAttribute('href');
      empresas.push({ nome, inscricao, cnpj, url });
    }

    return empresas;
  }, BASE_URL);
}

async function waitForEmpresaSelecionada() {
  const line = await waitStdin();
  try {
    const data = JSON.parse(line);
    if (data.type === 'empresa-selecionada') return { url: data.url, filtros: data.filtros || {} };
  } catch {}
  return null;
}

async function navegarParaNFe(page) {
  await page.waitForSelector('.menuDte_conteudoCategoria', { timeout: 10000 });
  const ok1 = await page.evaluate(() => {
    const cats = document.querySelectorAll('.menuDte_conteudoCategoria, .menuDte_conteudoCategoria2');
    for (const c of cats) { if (c.textContent.trim() === 'NF-e') { c.click(); return true; } }
    return false;
  });
  if (!ok1) throw new Error('Categoria NF-e nao encontrada.');
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  await sleep(1500);
  log('Clicou em NF-e no menu.', 'success');

  const ok2 = await page.evaluate(() => {
    const itens = document.querySelectorAll('.menuDte_itemMenu_titulo');
    for (const item of itens) {
      if (item.textContent.includes('NF-e - Download de Arquivos XML')) { item.click(); return true; }
    }
    return false;
  });
  if (!ok2) throw new Error('Item de download XML nao encontrado.');
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  await sleep(1500);
  log('Clicou em NF-e - Download de Arquivos XML.', 'success');
}

async function preencherFormulario(page) {
  log('Formulario carregado. Preencha os filtros no app e clique em Continuar.', 'warning');
  send('status', 'aguardando-formulario');

  // Aguarda continuar com filtros enviados pelo dashboard
  const filtros = await waitStdin().then(line => {
    try {
      const data = JSON.parse(line);
      if (data.type === 'continuar-formulario') return data.filtros || {};
    } catch {}
    return {};
  });

  log(`Preenchendo: modelo=${filtros.modelo} de=${filtros.de} ate=${filtros.ate} sit=${filtros.situacao}`);

  // Localiza o frame que contém o formulário
  let frame = page.mainFrame();
  for (const f of page.frames()) {
    const found = await f.$('input[name="emitidasPeriodoDe"]').catch(() => null);
    if (found) { frame = f; break; }
  }

  await frame.waitForSelector('input[name="emitidasPeriodoDe"]', { timeout: 10000 });

  // Modelo
  await frame.evaluate((modelo) => {
    const radio = document.querySelector(`input[name="modelo"][value="${modelo}"]`);
    if (radio) { radio.checked = true; radio.click(); }
  }, filtros.modelo || '55');

  // Data De
  await frame.evaluate((v) => {
    const el = document.querySelector('input[name="emitidasPeriodoDe"]');
    if (!el) return;
    el.value = v;
    ['input','change','blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
  }, filtros.de || '');
  log(`Campo De: "${await frame.$eval('input[name="emitidasPeriodoDe"]', el => el.value)}"`);

  // Data Ate
  await frame.evaluate((v) => {
    const el = document.querySelector('input[name="emitidasPeriodoAte"]');
    if (!el) return;
    el.value = v;
    ['input','change','blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
  }, filtros.ate || '');
  log(`Campo Ate: "${await frame.$eval('input[name="emitidasPeriodoAte"]', el => el.value)}"`);

  // Situacao
  await frame.evaluate((sit) => {
    const el = document.querySelector('select[name="situacaoNFe"]');
    if (el) { el.value = sit; el.dispatchEvent(new Event('change', { bubbles: true })); }
  }, filtros.situacao || 'TODAS');

  await sleep(500);
  log('Clicando em Solicitar...', 'info');
  await frame.evaluate(() => {
    const btn = document.querySelector('input[type="submit"][value*="Solicitar"]');
    if (btn) btn.click();
  });
  await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
  await sleep(1000);
  log('Solicitacao enviada.', 'success');
}

async function baixarPaginas(page) {
  const client = await page.createCDPSession();
  await client.send('Browser.setDownloadBehavior', {
    behavior: 'allowAndName',
    downloadPath: DOWNLOAD_DIR,
    eventsEnabled: true,
  });

  send('status', 'aguardando-download');
  log('Lista de XMLs carregada. Clique em Continuar para iniciar o download.', 'warning');
  await waitForContinue();

  const progressoFile = path.join(DOWNLOAD_DIR, 'progresso.json');
  let progresso = { paginasbaixadas: [] };
  if (fs.existsSync(progressoFile)) {
    try { progresso = JSON.parse(fs.readFileSync(progressoFile, 'utf8')); } catch {}
    if (progresso.paginasbaixadas.length > 0)
      log(`Progresso anterior: ${progresso.paginasbaixadas.length} pagina(s) ja baixada(s).`, 'warning');
  }

  // Mapa guid -> pagina para renomear corretamente
  const downloadMap = new Map(); // guid -> { pagina, filename }
  let paginaAtual = 1;

  client.on('Browser.downloadWillBegin', ({ guid, suggestedFilename }) => {
    downloadMap.set(guid, { pagina: paginaAtual, filename: suggestedFilename });
  });

  client.on('Browser.downloadProgress', ({ guid, state, receivedBytes, totalBytes }) => {
    if (state === 'completed') {
      const info = downloadMap.get(guid);
      if (!info) return;
      downloadMap.delete(guid);
      const src = path.join(DOWNLOAD_DIR, guid);
      const ext = path.extname(info.filename) || '.zip';
      const dest = path.join(DOWNLOAD_DIR, `PAG-${info.pagina}${ext}`);
      try {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        if (fs.existsSync(src)) {
          fs.renameSync(src, dest);
          log(`Salvo: PAG-${info.pagina}${ext}`, 'success');
        }
      } catch (e) {
        log(`Erro ao renomear pagina ${info.pagina}: ${e.message}`, 'warning');
      }
      // Atualiza progresso
      if (!progresso.paginasbaixadas.includes(info.pagina)) {
        progresso.paginasbaixadas.push(info.pagina);
        fs.writeFile(progressoFile, JSON.stringify(progresso, null, 2), () => {});
      }
    } else if (state === 'canceled') {
      const info = downloadMap.get(guid);
      downloadMap.delete(guid);
      if (info) log(`Download cancelado — pagina ${info.pagina}.`, 'warning');
    }
  });

  let pagina = 1;
  while (true) {
    await page.waitForSelector('#selectAll', { timeout: 15000 });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});

    if (progresso.paginasbaixadas.includes(pagina)) {
      log(`Pagina ${pagina} ja baixada, pulando...`, 'warning');
    } else {
      paginaAtual = pagina;

      await page.evaluate(() => {
        const cb = document.getElementById('selectAll');
        if (cb) cb.click();
      });
      await sleep(200);

      await page.evaluate(() => {
        const btn = document.querySelector('input[type="button"][value*="Download"]');
        if (btn) btn.click();
      });
      log(`Download disparado — pagina ${pagina}.`, 'success');
      await sleep(300);
    }

    const temProximo = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.some(a => a.textContent.trim() === 'Próximo' && a.href && !a.href.endsWith('#'));
    });

    if (!temProximo) {
      log(`Ultima pagina: ${pagina}. Aguardando downloads finalizarem...`, 'success');
      break;
    }

    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const prox = links.find(a => a.textContent.trim() === 'Próximo' && a.href && !a.href.endsWith('#'));
      if (prox) prox.click();
    });
    await page.waitForNetworkIdle({ idleTime: 300, timeout: 8000 }).catch(() => {});
    pagina++;
  }

  // Aguarda downloads pendentes (max 2 min)
  for (let t = 0; t < 120 && downloadMap.size > 0; t++) await sleep(1000);

  log(`Downloads concluidos! Pasta: ${DOWNLOAD_DIR}`, 'success');
}

async function processarEmpresa(browser, empresa, indice, total) {
  const page = await browser.newPage();
  try {
    send('empresa-progress', { index: indice, nome: empresa.nome });
    log(`Processando empresa [${indice + 1}/${total}]: ${empresa.nome}`);
    await page.goto(empresa.url, { waitUntil: 'networkidle2' });
    await sleep(1500);
    log(`URL apos selecao: ${page.url()}`);
    await fecharPopups(page);
    await navegarParaNFe(page);
    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
    await sleep(1000);
    await preencherFormulario(page);

    // Verifica progresso anterior
    const progressoFile = path.join(DOWNLOAD_DIR, 'progresso.json');
    if (fs.existsSync(progressoFile)) {
      try {
        const prog = JSON.parse(fs.readFileSync(progressoFile, 'utf8'));
        const qtd = prog.paginasbaixadas ? prog.paginasbaixadas.length : 0;
        if (qtd > 0) {
          log(`Progresso anterior encontrado: ${qtd} pagina(s) ja baixada(s). Continuando de onde parou...`, 'warning');
        }
      } catch {}
    } else {
      fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    }

    await baixarPaginas(page);
    log(`Empresa ${empresa.nome} concluida.`, 'success');
  } catch (err) {
    log(`Erro em ${empresa.nome}: ${err.message}`, 'error');
  } finally {
    await page.close();
  }
}

async function main() {
  // Importa puppeteer dinamicamente (ESM)
  const { default: puppeteer } = await import('puppeteer');

  // Remove lock file do perfil se existir (Chrome travado)
  const lockFile = path.join(USER_DATA_DIR, 'SingletonLock');
  try { require('fs').unlinkSync(lockFile); } catch {}

  log('Iniciando automacao SEFAZ-AM...');
  send('status', 'iniciando');

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: await puppeteer.executablePath(),
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    args: [
      '--start-maximized',
      `--remote-debugging-port=${DEBUG_PORT}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--auto-select-client-certificate',
      '--disable-client-certificate-popup',
      '--no-restore-last-session',
      '--restore-last-session=false',
      '--disable-session-crashed-bubble',
      '--disable-infobars',
    ],
  });

  // Garante que a pasta de download existe
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  try {
    // Fecha abas extras que possam ter sido restauradas
    const pages = await browser.pages();
    for (let i = 1; i < pages.length; i++) await pages[i].close();

    const page = pages[0] || await browser.newPage();
    log('Acessando pagina inicial...');
    await page.goto(`${BASE_URL}/inicioDte.asp`, { waitUntil: 'networkidle2' });
    await sleep(1000);

    log('Acessando login SSL...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await sleep(2000);

    send('status', 'aguardando');
    log('Selecione o certificado digital no Chrome e clique em Continuar no dashboard.', 'warning');

    await waitForContinue();

    log('Coletando empresas...');
    send('status', 'coletando');

    const empresas = await coletarEmpresas(page);

    if (empresas.length === 0) {
      log('Nenhuma empresa encontrada. Verifique o login.', 'error');
      send('status', 'erro');
      await browser.close();
      return;
    }

    log(`${empresas.length} empresa(s) encontrada(s).`, 'success');
    send('empresas', empresas);

    // Aguarda o usuario selecionar a empresa no dashboard
    send('status', 'selecionando');
    log('Selecione a empresa no dashboard e clique em Confirmar.', 'warning');

    const resultado = await waitForEmpresaSelecionada();
    if (!resultado) {
      log('Nenhuma empresa selecionada.', 'error');
      send('status', 'erro');
      await browser.close();
      return;
    }

    const { url: urlSelecionada, filtros } = resultado;
    const empresaSelecionada = empresas.find(e => e.url === urlSelecionada);
    log(`Empresa selecionada: ${empresaSelecionada ? empresaSelecionada.nome : urlSelecionada}`, 'success');

    send('status', 'processando');
    await processarEmpresa(browser, empresaSelecionada || { nome: 'Selecionada', url: urlSelecionada }, 0, 1);

    send('status', 'concluido');
    log('Automacao concluida!', 'success');
  } catch (err) {
    log(`Erro geral: ${err.message}`, 'error');
    send('status', 'erro');
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  process.stderr.write(err.stack + '\n');
  process.exit(1);
});
