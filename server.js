require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));
app.use(express.json());

// ── BANCO DE DADOS ────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

const JWT_SECRET = process.env.JWT_SECRET || 'easynotas-dev-secret-change-in-prod';
const ADMIN_KEY  = process.env.ADMIN_KEY  || 'admin-key-change-in-prod';

// Cria tabela de usuários se não existir
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id               SERIAL PRIMARY KEY,
      username         VARCHAR(100) UNIQUE NOT NULL,
      password_hash    TEXT NOT NULL,
      license_expires  TIMESTAMP NOT NULL,
      created_at       TIMESTAMP DEFAULT NOW()
    )
  `);
  console.log('Banco de dados inicializado.');
}
initDb().catch(err => console.error('Erro ao inicializar banco:', err.message));

// ── MIDDLEWARE DE ADMIN ───────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return res.status(401).json({ error: 'Não autorizado' });
  next();
}

// ── ROTAS DE AUTENTICAÇÃO ─────────────────────────────────────────────────────
// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });

    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Usuário ou senha inválidos' });

    const now = new Date();
    const expires = new Date(user.license_expires);
    const diasRestantes = Math.ceil((expires - now) / 86400000);

    if (diasRestantes <= 0) {
      return res.status(403).json({
        error: 'licenca_expirada',
        message: 'Sua licença expirou. Entre em contato com o suporte para renovar.',
      });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, license_expires: user.license_expires },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({ token, username: user.username, diasRestantes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// POST /api/auth/verify
app.post('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token obrigatório' });

    const decoded = jwt.verify(token, JWT_SECRET);

    // Revalida no banco (garante que licença não expirou desde o último login)
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuário não encontrado' });

    const now = new Date();
    const expires = new Date(user.license_expires);
    const diasRestantes = Math.ceil((expires - now) / 86400000);

    if (diasRestantes <= 0) {
      return res.status(403).json({
        error: 'licenca_expirada',
        message: 'Sua licença expirou. Entre em contato com o suporte para renovar.',
      });
    }

    res.json({ valid: true, username: user.username, diasRestantes });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token inválido ou expirado' });
    }
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// ── ROTAS DE ADMIN ────────────────────────────────────────────────────────────
// POST /api/admin/users — cria novo usuário
app.post('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const { username, password, dias } = req.body;
    if (!username || !password || !dias)
      return res.status(400).json({ error: 'username, password e dias são obrigatórios' });

    const hash = await bcrypt.hash(password, 10);
    const expires = new Date(Date.now() + dias * 86400000);

    const result = await pool.query(
      'INSERT INTO users (username, password_hash, license_expires) VALUES ($1, $2, $3) RETURNING id, username, license_expires',
      [username, hash, expires]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Usuário já existe' });
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// GET /api/admin/users — lista todos os usuários
app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, license_expires, created_at FROM users ORDER BY created_at DESC'
    );
    const users = result.rows.map(u => {
      const diasRestantes = Math.ceil((new Date(u.license_expires) - new Date()) / 86400000);
      return { ...u, diasRestantes };
    });
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// PATCH /api/admin/users/:id — atualiza licença ou senha
app.patch('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { dias, password } = req.body;

    if (dias) {
      const expires = new Date(Date.now() + dias * 86400000);
      await pool.query('UPDATE users SET license_expires = $1 WHERE id = $2', [expires, id]);
    }
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, id]);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// DELETE /api/admin/users/:id — remove usuário
app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Armazena estado das instâncias
const instancias = new Map();

io.on('connection', (socket) => {
  console.log('Cliente conectado ao dashboard');

  // Envia estado atual para novo cliente
  socket.emit('instancias-update', Array.from(instancias.values()));

  socket.on('disconnect', () => {
    console.log('Cliente desconectado');
  });
});

// API para instâncias registrarem logs
app.post('/api/instancia/register', (req, res) => {
  const { id, nome } = req.body;

  instancias.set(id, {
    id,
    nome,
    status: 'iniciando',
    empresas: [],
    logs: [],
    startTime: new Date().toISOString()
  });

  io.emit('instancias-update', Array.from(instancias.values()));
  res.json({ success: true });
});

app.post('/api/instancia/:id/log', (req, res) => {
  const { id } = req.params;
  const { message, level } = req.body;

  const instancia = instancias.get(id);
  if (!instancia) {
    return res.status(404).json({ error: 'Instância não encontrada' });
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    level: level || 'info'
  };

  instancia.logs.push(logEntry);

  // Mantém apenas os últimos 500 logs
  if (instancia.logs.length > 500) {
    instancia.logs = instancia.logs.slice(-500);
  }

  io.emit('log-update', { instanciaId: id, log: logEntry });
  res.json({ success: true });
});

app.post('/api/instancia/:id/empresas', (req, res) => {
  const { id } = req.params;
  const { empresas } = req.body;

  const instancia = instancias.get(id);
  if (!instancia) {
    return res.status(404).json({ error: 'Instância não encontrada' });
  }

  instancia.empresas = empresas;
  instancia.status = 'coletando';

  io.emit('instancias-update', Array.from(instancias.values()));
  res.json({ success: true });
});

app.post('/api/instancia/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  const instancia = instancias.get(id);
  if (!instancia) {
    return res.status(404).json({ error: 'Instância não encontrada' });
  }

  instancia.status = status;

  io.emit('instancias-update', Array.from(instancias.values()));
  res.json({ success: true });
});

app.post('/api/instancia/:id/empresa-progress', (req, res) => {
  const { id } = req.params;
  const { empresaIndex, empresaNome } = req.body;

  const instancia = instancias.get(id);
  if (!instancia) {
    return res.status(404).json({ error: 'Instância não encontrada' });
  }

  instancia.empresaAtual = { index: empresaIndex, nome: empresaNome };

  io.emit('instancias-update', Array.from(instancias.values()));
  res.json({ success: true });
});

app.delete('/api/instancia/:id', (req, res) => {
  const { id } = req.params;
  instancias.delete(id);

  io.emit('instancias-update', Array.from(instancias.values()));
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Dashboard rodando em http://localhost:${PORT}`);
});
