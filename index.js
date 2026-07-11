const puppeteer = require('puppeteer');
const http = require('http');

const BASE_URL = 'https://online.sefaz.am.gov.br';
const LOGIN_URL = `${BASE_URL}/dte/loginSSL.asp`;
const DASHBOARD_URL = 'http://localhost:3000';

// ID único da instância (pode passar como argumento: node index.js 1)
const INSTANCIA_ID = process.argv[2] || '1';
const INSTANCIA_NOME = `Instância ${INSTANCIA_ID}`;

function apiPost(path, body) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const options = {
      hostname: 'localhost',
      port: 3000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => resolve()); // ignora erro se dashboard não estiver rodando
    req.write(data);
    req.end();
  });
}

async function log(message, level = 'info') {
  const prefix = level === 'error' ? '[ERRO]' : level === 'warning' ? '[AVISO]' : level === 'success' ? '[OK]' : '[INFO]';
  console.log(`${prefix} ${message}`);
  await apiPost(`/api/instancia/${INSTANCIA_ID}/log`, { message, level });
}

async function setStatus(status) {
  await apiPost(`/api/instancia/${INSTANCIA_ID}/status`, { status });
}

async function setEmpresas(empresas) {
  await apiPost(`/api/instancia/${INSTANCIA_ID}/empresas`, { empresas });
}

async function setEmpresaProgress(empresaIndex, empresaNome) {
  await apiPost(`/api/instancia/${INSTANCIA_ID}/empresa-progress`, { empresaIndex, empresaNome });
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fecharPopups(page) {
  let count = 0;
  while (true) {
    try {
      const btn = await page.$('#btFecharPopUpDTe');
      if (!btn) break;

      const visible = await page.evaluate(el => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }, btn);

      if (!visible) break;

      await btn.click();
      count++;
      await log(`Popup de aviso fechado (${count}).`, 'warning');
      await sleep(1000);
    } catch {
      break;
    }
  }
}

async function coletarEmpresas(page) {
  await page.waitForSelector('a', { timeout: 10000 });

  const empresas = await page.evaluate((base) => {
    const links = Array.from(document.querySelectorAll('a[href*="sel_inscricao_pj.asp"]'));
    return links.map(a => ({
      nome: a.textContent.trim(),
      url: a.href.startsWith('http') ? a.href : base + a.getAttribute('href'),
    }));
  }, BASE_URL);

  return empresas;
}

async function navegarParaNFe(page) {
  await page.waitForSelector('.menuDte_conteudoCategoria', { timeout: 10000 });

  const categoriaClicada = await page.evaluate(() => {
    const categorias = document.querySelectorAll('.menuDte_conteudoCategoria, .menuDte_conteudoCategoria2');
    for (const cat of categorias) {
      if (cat.textContent.trim() === 'NF-e') {
        cat.click();
        return true;
      }
    }
    return false;
  });

  if (!categoriaClicada) throw new Error('Categoria NF-e não encontrada no menu.');

  await log('Clicou em NF-e no menu.', 'success');
  await sleep(1000);

  const itemClicado = await page.evaluate(() => {
    const itens = document.querySelectorAll('.menuDte_itemMenu_titulo');
    for (const item of itens) {
      if (item.textContent.includes('NF-e - Download de Arquivos XML')) {
        item.click();
        return true;
      }
    }
    return false;
  });

  if (!itemClicado) throw new Error('Item de download XML não encontrado.');

  await log('Clicou em NF-e - Download de Arquivos XML.', 'success');
}

async function processarEmpresa(browser, empresa, indice, total) {
  const page = await browser.newPage();

  try {
    await setEmpresaProgress(indice, empresa.nome);
    await log(`Processando empresa [${indice + 1}/${total}]: ${empresa.nome}`);

    await page.goto(empresa.url, { waitUntil: 'networkidle2' });
    await sleep(1500);

    const urlAtual = page.url();
    await log(`URL após seleção: ${urlAtual}`);

    await fecharPopups(page);
    await navegarParaNFe(page);

    await sleep(2000);
    await log(`Empresa ${empresa.nome} processada com sucesso.`, 'success');
  } catch (err) {
    await log(`Erro ao processar ${empresa.nome}: ${err.message}`, 'error');
  } finally {
    await page.close();
  }
}

async function main() {
  // Registra instância no dashboard
  await apiPost('/api/instancia/register', { id: INSTANCIA_ID, nome: INSTANCIA_NOME });
  await log('Iniciando automação SEFAZ-AM...');
  await setStatus('iniciando');

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });

  try {
    const page = await browser.newPage();

    await log('Acessando página inicial...');
    await page.goto(`${BASE_URL}/inicioDte.asp`, { waitUntil: 'networkidle2' });
    await sleep(1000);

    await log('Acessando login SSL...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2' });
    await sleep(2000);

    await setStatus('aguardando');
    await log('Aguardando seleção do certificado digital e login...', 'warning');
    await log('Pressione Enter no terminal quando a página de empresas estiver carregada.', 'warning');

    await waitForEnter();

    await log('Coletando empresas...');
    await setStatus('coletando');

    const empresas = await coletarEmpresas(page);

    if (empresas.length === 0) {
      await log('Nenhuma empresa encontrada. Verifique o login.', 'error');
      await setStatus('erro');
      return;
    }

    await log(`${empresas.length} empresa(s) encontrada(s).`, 'success');
    await setEmpresas(empresas);

    empresas.forEach((e, i) => log(`  [${i + 1}] ${e.nome}`));

    await setStatus('processando');

    for (let i = 0; i < empresas.length; i++) {
      await processarEmpresa(browser, empresas[i], i, empresas.length);
      await sleep(1000);
    }

    await setStatus('concluido');
    await log('Automação concluída!', 'success');
  } catch (err) {
    await log(`Erro geral: ${err.message}`, 'error');
    await setStatus('erro');
  } finally {
    await browser.close();
  }
}

function waitForEnter() {
  return new Promise(resolve => {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => {
      process.stdin.pause();
      resolve();
    });
  });
}

main();
