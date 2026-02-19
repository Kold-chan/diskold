/**
 * DISKOLD v3.2 — Chat + Voz + Música + Watch Party + Canales
 * Creado por Kold
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const https   = require('https');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '5mb' }));

// ── Canales de texto ──────────────────────────────────────
const CHANNELS = {
  'kbros': { password: 'moscosos', description: 'Canal privado Kbros' },
  'vcby':  { password: 'akatsuki', description: 'Canal privado VCBY'  },
};

// ── Salas de voz ──────────────────────────────────────────
const VOICE_ROOMS = {
  'kbros': { password: 'moscosos', label: 'kbros' },
  'vcby':  { password: 'akatsuki', label: 'vcby'  },
};

app.post('/api/channel-join', (req, res) => {
  const { channel, password } = req.body;
  const ch = CHANNELS[channel];
  if (!ch) return res.json({ ok: false, error: 'Canal no existe.' });
  if (ch.password && ch.password !== password)
    return res.json({ ok: false, error: 'Clave incorrecta.' });
  res.json({ ok: true });
});

app.post('/api/voice-join', (req, res) => {
  const { room, password } = req.body;
  const vr = VOICE_ROOMS[room];
  if (!vr) return res.json({ ok: false, error: 'Sala no existe.' });
  if (vr.password && vr.password !== password)
    return res.json({ ok: false, error: 'Clave incorrecta.' });
  res.json({ ok: true });
});

app.get('/api/rooms-info', (req, res) => {
  res.json({
    channels: Object.entries(CHANNELS).map(([id, c]) => ({ id, label: id, locked: !!c.password })),
    voices:   Object.entries(VOICE_ROOMS).map(([id, v]) => ({ id, label: v.label, locked: !!v.password })),
  });
});

// ── Base de datos ─────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'users.json');
function readDB()   { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch(e) { return { users: [] }; } }
function writeDB(d) { fs.writeFileSync(DB_PATH, JSON.stringify(d, null, 2)); }
function hashPwd(p) { return crypto.createHash('sha256').update(p + 'diskold_salt_kold').digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

const sessions = {};

app.post('/api/register', (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.json({ ok: false, error: 'Faltan datos.' });
  if (username.length < 2 || username.length > 20) return res.json({ ok: false, error: 'Nombre: 2-20 caracteres.' });
  if (password.length < 4) return res.json({ ok: false, error: 'Contraseña muy corta.' });
  const db = readDB();
  if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.json({ ok: false, error: 'Usuario ya existe.' });
  const user = { id: crypto.randomUUID(), username, password: hashPwd(password), avatar: avatar || null, createdAt: new Date().toISOString() };
  db.users.push(user); writeDB(db);
  const token = genToken(); sessions[token] = { username, avatar: user.avatar, id: user.id };
  res.json({ ok: true, token, username, avatar: user.avatar });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.json({ ok: false, error: 'Usuario no encontrado.' });
  if (user.password !== hashPwd(password)) return res.json({ ok: false, error: 'Contraseña incorrecta.' });
  const token = genToken(); sessions[token] = { username: user.username, avatar: user.avatar, id: user.id };
  res.json({ ok: true, token, username: user.username, avatar: user.avatar });
});

app.post('/api/update-avatar', (req, res) => {
  const { token, avatar } = req.body;
  if (!token || !sessions[token]) return res.json({ ok: false, error: 'No autenticado.' });
  const s = sessions[token]; const db = readDB();
  const user = db.users.find(u => u.username === s.username);
  if (!user) return res.json({ ok: false, error: 'No encontrado.' });
  user.avatar = avatar; writeDB(db); sessions[token].avatar = avatar;
  io.emit('avatar-updated', { username: s.username, avatar });
  res.json({ ok: true });
});

app.post('/api/verify', (req, res) => {
  const { token } = req.body;
  if (token && sessions[token]) res.json({ ok: true, ...sessions[token] });
  else res.json({ ok: false });
});

// ── Watch Party por canal ─────────────────────────────────
const watchParties = {};
Object.keys(CHANNELS).forEach(ch => {
  watchParties[ch] = { active: false, videoId: null, title: null, playing: false, currentTime: 0, startedBy: null, lastSync: Date.now() };
});

function getWp(ch) { return watchParties[ch] || Object.values(watchParties)[0]; }
function calcCurrentTime(wp) {
  if (!wp.playing) return wp.currentTime || 0;
  return (wp.currentTime || 0) + (Date.now() - wp.lastSync) / 1000;
}

function extractVideoId(url) {
  const pp = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of pp) { const m = url.match(p); if (m) return m[1]; }
  return null;
}

async function getVideoInfo(videoId) {
  return new Promise(resolve => {
    https.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); resolve({ title: j.title }); } catch (e) { resolve({ title: 'Video de YouTube' }); } });
    }).on('error', () => resolve({ title: 'Video de YouTube' }));
  });
}

// ── Music Bot ─────────────────────────────────────────────
const musicBot = { queue: [], playing: false, current: null, volume: 80, paused: false };

async function searchYouTube(query) {
  return new Promise(resolve => {
    const q = encodeURIComponent(query);
    https.get(`https://www.youtube.com/results?search_query=${q}`, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const ids = [...new Set((d.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g) || []).map(m => m.slice(11, -1)))].slice(0, 5);
          const titles = (d.match(/"title":{"runs":\[{"text":"([^"]+)"/g) || []).map(t => { const m = t.match(/"text":"([^"]+)"/); return m ? m[1] : 'Sin título'; }).slice(0, 5);
          resolve(ids.map((id, i) => ({ videoId: id, title: titles[i] || `Video ${i+1}`, thumbnail: `https://img.youtube.com/vi/${id}/mqdefault.jpg` })));
        } catch (e) { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

app.get('/api/search', async (req, res) => { const r = await searchYouTube(req.query.q || ''); res.json({ results: r }); });
app.get('/api/music-state', (req, res) => res.json(musicBot));

// ── Socket.io ─────────────────────────────────────────────
const users = {};
const voiceRooms = {};

io.on('connection', socket => {

  socket.on('auth', token => {
    const s = sessions[token];
    if (!s) { socket.emit('auth-error', 'Sesión inválida.'); return; }
    // Entrar al primer canal por defecto
    const defaultChannel = Object.keys(CHANNELS)[0];
    users[socket.id] = { username: s.username, avatar: s.avatar, channel: defaultChannel };
    socket.join('ch:' + defaultChannel);
    io.emit('user-list', buildUserList());
    io.to('ch:' + defaultChannel).emit('chat-message', { system: true, text: `${s.username} entró a Diskold`, time: now() });
    socket.emit('auth-ok', s);
    socket.emit('music-state', musicBot);
    const wp = getWp(defaultChannel);
    if (wp.playing) { wp.currentTime = calcCurrentTime(wp); wp.lastSync = Date.now(); }
    socket.emit('watch-state', { ...wp, channel: defaultChannel });
    socket.emit('rooms-info', {
      channels: Object.entries(CHANNELS).map(([id, c]) => ({ id, locked: !!c.password })),
      voices:   Object.entries(VOICE_ROOMS).map(([id, v]) => ({ id, label: v.label, locked: !!v.password })),
    });
  });

  socket.on('join-channel', ({ channel }) => {
    if (!users[socket.id]) return;
    if (!CHANNELS[channel]) return;
    const prev = users[socket.id].channel;
    if (prev === channel) return;
    socket.leave('ch:' + prev);
    io.to('ch:' + prev).emit('chat-message', { system: true, text: `${users[socket.id].username} salió del canal`, time: now() });
    users[socket.id].channel = channel;
    socket.join('ch:' + channel);
    io.to('ch:' + channel).emit('chat-message', { system: true, text: `${users[socket.id].username} entró al canal`, time: now() });
    io.emit('user-list', buildUserList());
    const wp = getWp(channel);
    if (wp.playing) { wp.currentTime = calcCurrentTime(wp); wp.lastSync = Date.now(); }
    socket.emit('watch-state', { ...wp, channel });
    socket.emit('channel-joined', { channel });
  });

  socket.on('chat-message', text => {
    if (!users[socket.id]) return;
    const { username, avatar, channel } = users[socket.id];
    if (text.startsWith('/')) { handleBotCommand(socket, username, channel, text); return; }
    io.to('ch:' + channel).emit('chat-message', { user: username, avatar, text, time: now(), channel });
  });

  socket.on('bot-command', data => {
    if (!users[socket.id]) return;
    handleBotCommand(socket, users[socket.id].username, users[socket.id].channel, data.command);
  });

  // Watch Party
  socket.on('watch-start', async ({ url }) => {
    if (!users[socket.id]) return;
    const channel = users[socket.id].channel;
    const videoId = extractVideoId(url);
    if (!videoId) { socket.emit('watch-error', 'Link inválido.'); return; }
    const info = await getVideoInfo(videoId);
    const wp = getWp(channel);
    wp.active = true; wp.videoId = videoId; wp.title = info.title;
    wp.playing = false; wp.currentTime = 0;
    wp.startedBy = users[socket.id].username; wp.lastSync = Date.now();
    io.to('ch:' + channel).emit('watch-state', { ...wp, channel });
    io.to('ch:' + channel).emit('chat-message', { bot: true, user: '🎬 Watch Party', text: `**${users[socket.id].username}** inició:\n🎥 ${info.title}`, time: now(), channel });
  });

  socket.on('watch-play', ({ currentTime, channel: ch }) => {
    if (!users[socket.id]) return;
    const channel = ch || users[socket.id].channel;
    const wp = getWp(channel);
    wp.playing = true; wp.currentTime = currentTime || 0; wp.lastSync = Date.now();
    io.to('ch:' + channel).emit('watch-cmd', { action: 'play', currentTime: wp.currentTime, ts: wp.lastSync });
  });

  socket.on('watch-pause', ({ currentTime, channel: ch }) => {
    if (!users[socket.id]) return;
    const channel = ch || users[socket.id].channel;
    const wp = getWp(channel);
    wp.playing = false; wp.currentTime = currentTime || 0; wp.lastSync = Date.now();
    io.to('ch:' + channel).emit('watch-cmd', { action: 'pause', currentTime: wp.currentTime, ts: wp.lastSync });
  });

  socket.on('watch-sync-request', ({ channel: ch } = {}) => {
    const channel = (ch || users[socket.id]?.channel) || Object.keys(CHANNELS)[0];
    const wp = getWp(channel);
    if (wp.playing) { wp.currentTime = calcCurrentTime(wp); wp.lastSync = Date.now(); }
    io.to('ch:' + channel).emit('watch-cmd', {
      action: wp.playing ? 'sync-play' : 'sync-pause',
      currentTime: wp.currentTime,
      ts: wp.lastSync,
    });
  });

  socket.on('watch-stop', ({ channel: ch } = {}) => {
    if (!users[socket.id]) return;
    const channel = ch || users[socket.id].channel;
    const wp = getWp(channel);
    wp.active = false; wp.videoId = null; wp.playing = false; wp.currentTime = 0;
    io.to('ch:' + channel).emit('watch-state', { ...wp, channel });
    io.to('ch:' + channel).emit('chat-message', { bot: true, user: '🎬 Watch Party', text: `**${users[socket.id].username}** terminó el Watch Party.`, time: now(), channel });
  });

  // WebRTC — salas de voz con clave verificada en cliente
  socket.on('join-voice', roomId => {
    if (!users[socket.id] || !VOICE_ROOMS[roomId]) return;
    if (!voiceRooms[roomId]) voiceRooms[roomId] = [];
    const existing = voiceRooms[roomId].filter(id => id !== socket.id);
    socket.emit('existing-peers', existing);
    existing.forEach(p => io.to(p).emit('peer-joined', { peerId: socket.id, username: users[socket.id].username }));
    voiceRooms[roomId].push(socket.id);
    socket.join('voice:' + roomId);
    socket.currentVoiceRoom = roomId;
    emitVoiceUsers();
  });

  socket.on('leave-voice', () => leaveVoice(socket));
  socket.on('offer',         ({ to, offer })     => io.to(to).emit('offer',         { from: socket.id, offer }));
  socket.on('answer',        ({ to, answer })    => io.to(to).emit('answer',        { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    const u = users[socket.id];
    if (u) io.to('ch:' + u.channel).emit('chat-message', { system: true, text: `${u.username} salió de Diskold`, time: now() });
    leaveVoice(socket);
    delete users[socket.id];
    io.emit('user-list', buildUserList());
  });

  function leaveVoice(s) {
    const room = s.currentVoiceRoom;
    if (!room || !voiceRooms[room]) return;
    voiceRooms[room] = voiceRooms[room].filter(id => id !== s.id);
    io.to('voice:' + room).emit('peer-left', s.id);
    s.leave('voice:' + room);
    s.currentVoiceRoom = null;
    emitVoiceUsers();
  }

  function emitVoiceUsers() {
    const state = {};
    Object.keys(VOICE_ROOMS).forEach(room => {
      state[room] = (voiceRooms[room] || []).map(id => ({ id, name: users[id]?.username || 'Anónimo' }));
    });
    io.emit('voice-users', state);
  }
});

// ── Bot ───────────────────────────────────────────────────
async function handleBotCommand(socket, username, channel, text) {
  const parts = text.trim().split(' '); const cmd = parts[0].toLowerCase(); const args = parts.slice(1).join(' ');
  io.to('ch:' + channel).emit('chat-message', { user: username, avatar: users[socket.id]?.avatar, text, time: now(), channel });
  const botMsg = t => io.to('ch:' + channel).emit('chat-message', { bot: true, user: '🤖 KoldBot', text: t, time: now(), channel });
  switch (cmd) {
    case '/play': {
      if (!args) { botMsg('❄️ Uso: `/play nombre canción`'); return; }
      botMsg(`🔍 Buscando **${args}**...`);
      const r = await searchYouTube(args);
      if (!r.length) { botMsg('❌ Sin resultados.'); return; }
      const song = { ...r[0], requestedBy: username };
      musicBot.queue.push(song);
      if (!musicBot.playing) playNext(botMsg);
      else { botMsg(`✅ **${song.title}** en cola (#${musicBot.queue.length})`); io.emit('music-state', musicBot); }
      break;
    }
    case '/watch': {
      if (!args) { botMsg('🎬 Uso: `/watch [YouTube URL]`'); return; }
      const vid = extractVideoId(args); if (!vid) { botMsg('❌ Link inválido.'); return; }
      const info = await getVideoInfo(vid);
      const wp = getWp(channel);
      wp.active = true; wp.videoId = vid; wp.title = info.title;
      wp.playing = false; wp.currentTime = 0; wp.startedBy = username; wp.lastSync = Date.now();
      io.to('ch:' + channel).emit('watch-state', { ...wp, channel });
      botMsg(`🎬 Watch Party:\n🎥 ${info.title}`);
      break;
    }
    case '/skip':   { if (!musicBot.current) { botMsg('❌ Nada.'); return; } botMsg('⏭️ Saltado.'); playNext(botMsg); break; }
    case '/stop':   { musicBot.queue = []; musicBot.playing = false; musicBot.current = null; musicBot.paused = false; io.emit('music-state', musicBot); io.emit('music-stop'); botMsg('⏹️ Detenido.'); break; }
    case '/pause':  { if (!musicBot.playing) { botMsg('❌ Sin música.'); return; } musicBot.paused = true; io.emit('music-state', musicBot); io.emit('music-pause'); botMsg('⏸️ Pausada.'); break; }
    case '/resume': { if (!musicBot.paused) { botMsg('❌ No pausada.'); return; } musicBot.paused = false; io.emit('music-state', musicBot); io.emit('music-resume'); botMsg('▶️ Reanudada.'); break; }
    case '/volume': { const v = parseInt(args); if (isNaN(v) || v < 0 || v > 100) { botMsg('❌ `/volume 0-100`'); return; } musicBot.volume = v; io.emit('music-state', musicBot); io.emit('music-volume', v); botMsg(`🔊 ${v}%`); break; }
    case '/queue':  { if (!musicBot.current && !musicBot.queue.length) { botMsg('📋 Cola vacía.'); return; } let msg = '📋 **Cola:**\n'; if (musicBot.current) msg += `▶️ ${musicBot.current.title}\n`; musicBot.queue.forEach((s, i) => msg += `${i+1}. ${s.title}\n`); botMsg(msg); break; }
    case '/np':     { if (!musicBot.current) { botMsg('❌ Nada.'); return; } botMsg(`🎵 **${musicBot.current.title}** — ${musicBot.current.requestedBy}`); break; }
    case '/help':   { botMsg('🤖 `/play` `/watch [URL]` `/skip` `/stop` `/pause` `/resume` `/volume` `/queue` `/np`'); break; }
    default:        { botMsg('❓ Usa `/help`.'); }
  }
}

function playNext(botMsg) {
  if (!musicBot.queue.length) { musicBot.playing = false; musicBot.current = null; io.emit('music-state', musicBot); io.emit('music-ended'); if (botMsg) botMsg('✅ Cola terminada.'); return; }
  musicBot.current = musicBot.queue.shift(); musicBot.playing = true; musicBot.paused = false;
  io.emit('music-state', musicBot); io.emit('music-play', musicBot.current);
  if (botMsg) botMsg(`🎵 **${musicBot.current.title}** — ${musicBot.current.requestedBy}`);
}

function now() { return new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
function buildUserList() { return Object.entries(users).map(([id, u]) => ({ id, name: u.username, avatar: u.avatar, channel: u.channel })); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  DISKOLD v3.2  by Kold               ║`);
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
