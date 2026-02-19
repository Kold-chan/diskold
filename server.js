/**
 * DISKOLD v2.0 — Servidor con Sistema de Cuentas
 * Creado por Kold
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');
const crypto   = require('crypto');
const https    = require('https');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' })); // Para fotos de perfil en base64

// ── Base de datos JSON ────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'users.json');

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch(e) {
    return { users: [] };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'diskold_salt_kold').digest('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Sesiones activas en memoria: token → username
const sessions = {};

// ── AUTH ENDPOINTS ────────────────────────────────────────

// Registrar cuenta
app.post('/api/register', (req, res) => {
  const { username, password, avatar } = req.body;

  if (!username || !password) return res.json({ ok: false, error: 'Faltan datos.' });
  if (username.length < 2 || username.length > 20) return res.json({ ok: false, error: 'Nombre: 2-20 caracteres.' });
  if (password.length < 4) return res.json({ ok: false, error: 'Contraseña muy corta (mín. 4 caracteres).' });

  const db = readDB();
  const exists = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.json({ ok: false, error: 'Ese nombre de usuario ya existe.' });

  const user = {
    id: crypto.randomUUID(),
    username,
    password: hashPassword(password),
    avatar: avatar || null, // base64 o null
    createdAt: new Date().toISOString()
  };

  db.users.push(user);
  writeDB(db);

  const token = generateToken();
  sessions[token] = { username: user.username, avatar: user.avatar, id: user.id };

  res.json({ ok: true, token, username: user.username, avatar: user.avatar });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Faltan datos.' });

  const db = readDB();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user) return res.json({ ok: false, error: 'Usuario no encontrado.' });
  if (user.password !== hashPassword(password)) return res.json({ ok: false, error: 'Contraseña incorrecta.' });

  const token = generateToken();
  sessions[token] = { username: user.username, avatar: user.avatar, id: user.id };

  res.json({ ok: true, token, username: user.username, avatar: user.avatar });
});

// Actualizar avatar
app.post('/api/update-avatar', (req, res) => {
  const { token, avatar } = req.body;
  if (!token || !sessions[token]) return res.json({ ok: false, error: 'No autenticado.' });

  const session = sessions[token];
  const db = readDB();
  const user = db.users.find(u => u.username === session.username);
  if (!user) return res.json({ ok: false, error: 'Usuario no encontrado.' });

  user.avatar = avatar;
  writeDB(db);
  sessions[token].avatar = avatar;

  // Notificar a todos del nuevo avatar
  io.emit('avatar-updated', { username: session.username, avatar });

  res.json({ ok: true });
});

// Verificar token (para mantener sesión)
app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  if (token && sessions[token]) {
    res.json({ ok: true, ...sessions[token] });
  } else {
    res.json({ ok: false });
  }
});

// ── Estado del bot de música ──────────────────────────────
const musicBot = {
  queue: [], playing: false, current: null, volume: 80, paused: false,
};

async function searchYouTube(query) {
  return new Promise((resolve) => {
    const q = encodeURIComponent(query);
    https.get(`https://www.youtube.com/results?search_query=${q}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const ids = [...new Set((data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g)||[]).map(m=>m.slice(11,-1)))].slice(0,5);
          const titles = (data.match(/"title":{"runs":\[{"text":"([^"]+)"/g)||[]).map(t=>{const m=t.match(/"text":"([^"]+)"/);return m?m[1]:'Sin título';}).slice(0,5);
          resolve(ids.map((id,i)=>({ videoId:id, title:titles[i]||`Video ${i+1}`, thumbnail:`https://img.youtube.com/vi/${id}/mqdefault.jpg` })));
        } catch(e) { resolve([]); }
      });
    }).on('error', ()=>resolve([]));
  });
}

app.get('/api/search', async (req, res) => {
  const results = await searchYouTube(req.query.q || '');
  res.json({ results });
});

app.get('/api/music-state', (req, res) => res.json(musicBot));

// ── Socket.io ─────────────────────────────────────────────
const users  = {}; // socketId → { username, avatar }
const rooms  = {};

io.on('connection', (socket) => {

  // Login con token
  socket.on('auth', (token) => {
    const session = sessions[token];
    if (!session) { socket.emit('auth-error', 'Sesión inválida.'); return; }

    users[socket.id] = { username: session.username, avatar: session.avatar };
    io.emit('user-list', buildUserList());
    broadcast_system(`${session.username} entró a Diskold`);
    socket.emit('auth-ok', session);
    socket.emit('music-state', musicBot);
  });

  socket.on('chat-message', (text) => {
    if (!users[socket.id]) return;
    const { username, avatar } = users[socket.id];

    if (text.startsWith('/')) {
      handleBotCommand(socket, username, text);
      return;
    }

    io.emit('chat-message', {
      user: username,
      avatar,
      text,
      time: now()
    });
  });

  socket.on('bot-command', (data) => {
    if (!users[socket.id]) return;
    handleBotCommand(socket, users[socket.id].username, data.command);
  });

  // WebRTC
  socket.on('join-voice', (roomId) => {
    if (!users[socket.id]) return;
    if (!rooms[roomId]) rooms[roomId] = [];
    const peers = rooms[roomId].filter(id => id !== socket.id);
    socket.emit('existing-peers', peers);
    peers.forEach(p => io.to(p).emit('peer-joined', { peerId: socket.id, username: users[socket.id].username }));
    rooms[roomId].push(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    emitVoiceUsers(roomId);
  });

  socket.on('leave-voice', () => leaveVoice(socket));
  socket.on('offer',         ({to,offer})     => io.to(to).emit('offer',         {from:socket.id,offer}));
  socket.on('answer',        ({to,answer})    => io.to(to).emit('answer',        {from:socket.id,answer}));
  socket.on('ice-candidate', ({to,candidate}) => io.to(to).emit('ice-candidate', {from:socket.id,candidate}));

  socket.on('disconnect', () => {
    const u = users[socket.id];
    if (u) broadcast_system(`${u.username} salió de Diskold`);
    leaveVoice(socket);
    delete users[socket.id];
    io.emit('user-list', buildUserList());
  });

  function leaveVoice(s) {
    if (!s.currentRoom || !rooms[s.currentRoom]) return;
    rooms[s.currentRoom] = rooms[s.currentRoom].filter(id => id !== s.id);
    io.to(s.currentRoom).emit('peer-left', s.id);
    emitVoiceUsers(s.currentRoom);
    s.leave(s.currentRoom);
    s.currentRoom = null;
  }

  function emitVoiceUsers(roomId) {
    io.emit('voice-users', {
      roomId,
      users: (rooms[roomId]||[]).map(id => ({ id, name: users[id]?.username || 'Anónimo' }))
    });
  }
});

// ── Bot de música ─────────────────────────────────────────
async function handleBotCommand(socket, username, text) {
  const parts = text.trim().split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  io.emit('chat-message', { user: username, avatar: users[socket.id]?.avatar, text, time: now() });

  switch(cmd) {
    case '/play': {
      if (!args) { botMsg('❄️ Uso: `/play nombre de la canción`'); return; }
      botMsg(`🔍 Buscando **${args}**...`);
      const results = await searchYouTube(args);
      if (!results.length) { botMsg('❌ No encontré resultados.'); return; }
      const song = { ...results[0], requestedBy: username };
      musicBot.queue.push(song);
      if (!musicBot.playing) playNext();
      else { botMsg(`✅ **${song.title}** en cola (#${musicBot.queue.length})`); io.emit('music-state', musicBot); }
      break;
    }
    case '/skip':  { if(!musicBot.current){botMsg('❌ No hay nada reproduciéndose.');return;} botMsg(`⏭️ **${username}** saltó la canción.`); playNext(); break; }
    case '/stop':  { musicBot.queue=[];musicBot.playing=false;musicBot.current=null;musicBot.paused=false; io.emit('music-state',musicBot); io.emit('music-stop'); botMsg('⏹️ Música detenida.'); break; }
    case '/pause': { if(!musicBot.playing){botMsg('❌ No hay música.');return;} musicBot.paused=true; io.emit('music-state',musicBot); io.emit('music-pause'); botMsg('⏸️ Pausada.'); break; }
    case '/resume':{ if(!musicBot.paused){botMsg('❌ No está pausada.');return;} musicBot.paused=false; io.emit('music-state',musicBot); io.emit('music-resume'); botMsg('▶️ Reanudada.'); break; }
    case '/volume':{ const v=parseInt(args); if(isNaN(v)||v<0||v>100){botMsg('❌ Uso: `/volume 0-100`');return;} musicBot.volume=v; io.emit('music-state',musicBot); io.emit('music-volume',v); botMsg(`🔊 Volumen: **${v}%**`); break; }
    case '/queue': { if(!musicBot.current&&!musicBot.queue.length){botMsg('📋 Cola vacía.');return;} let msg='📋 **Cola:**\n'; if(musicBot.current)msg+=`▶️ ${musicBot.current.title} (${musicBot.current.requestedBy})\n`; musicBot.queue.forEach((s,i)=>msg+=`${i+1}. ${s.title}\n`); botMsg(msg); break; }
    case '/np':    { if(!musicBot.current){botMsg('❌ Nada sonando.');return;} botMsg(`🎵 **${musicBot.current.title}** — por ${musicBot.current.requestedBy}`); break; }
    case '/help':  { botMsg('🤖 **KoldBot:**\n`/play [canción]` `/skip` `/stop` `/pause` `/resume` `/volume [0-100]` `/queue` `/np`'); break; }
    default:       { botMsg(`❓ Comando desconocido. Usa \`/help\`.`); }
  }
}

function playNext() {
  if (!musicBot.queue.length) { musicBot.playing=false; musicBot.current=null; io.emit('music-state',musicBot); io.emit('music-ended'); botMsg('✅ Cola terminada.'); return; }
  musicBot.current=musicBot.queue.shift(); musicBot.playing=true; musicBot.paused=false;
  io.emit('music-state',musicBot); io.emit('music-play',musicBot.current);
  botMsg(`🎵 **${musicBot.current.title}** — por ${musicBot.current.requestedBy}`);
}

function botMsg(text) { io.emit('chat-message',{bot:true,user:'🤖 KoldBot',text,time:now()}); }
function now() { return new Date().toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'}); }
function buildUserList() { return Object.entries(users).map(([id,u])=>({id,name:u.username,avatar:u.avatar})); }
function broadcast_system(text) { io.emit('chat-message',{system:true,text,time:now()}); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  DISKOLD v2.0  —  by Kold         ║`);
  console.log(`║  http://localhost:${PORT}            ║`);
  console.log(`╚══════════════════════════════════╝\n`);
});
