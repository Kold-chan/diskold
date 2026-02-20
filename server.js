/**
 * DISKOLD v4.0 — Full Discord-like app
 * MongoDB + Socket.io + WebRTC + YouTube
 * by Kold
 */
const express   = require('express');
const http      = require('http');
const { Server }= require('socket.io');
const mongoose  = require('mongoose');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const https     = require('https');
const path      = require('path');
const { nanoid }= require('nanoid');
const { User, Server: ServerModel, Channel, Message, DM } = require('./models');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 5e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '8mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'diskold_jwt_secret_kold_2024';
const PORT       = process.env.PORT || 3000;
const MONGODB_URI= process.env.MONGODB_URI || 'mongodb://localhost:27017/diskold';

// ── MongoDB ───────────────────────────────────────────────
mongoose.connect(MONGODB_URI).then(() => {
  console.log('✅ MongoDB conectado');
}).catch(err => console.error('❌ MongoDB error:', err));

// ── Helpers ───────────────────────────────────────────────
function now() { return new Date().toLocaleTimeString('es', { hour:'2-digit', minute:'2-digit' }); }
function signToken(userId) { return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '30d' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch(e) { return null; } }

// ── Auth Routes ───────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, avatar } = req.body;
    if (!username || !password) return res.json({ ok: false, error: 'Faltan datos.' });
    if (username.length < 2 || username.length > 20) return res.json({ ok: false, error: 'Nombre: 2-20 caracteres.' });
    if (password.length < 4) return res.json({ ok: false, error: 'Contraseña mínimo 4 caracteres.' });
    if (await User.findOne({ username: new RegExp(`^${username}$`, 'i') }))
      return res.json({ ok: false, error: 'Usuario ya existe.' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username, password: hash, avatar: avatar || null });
    const token = signToken(user._id);
    res.json({ ok: true, token, user: safeUser(user) });
  } catch(e) { res.json({ ok: false, error: 'Error del servidor.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: new RegExp(`^${username}$`, 'i') });
    if (!user) return res.json({ ok: false, error: 'Usuario no encontrado.' });
    if (!await bcrypt.compare(password, user.password)) return res.json({ ok: false, error: 'Contraseña incorrecta.' });
    await User.findByIdAndUpdate(user._id, { status: 'online', lastSeen: new Date() });
    const token = signToken(user._id);
    res.json({ ok: true, token, user: safeUser(user) });
  } catch(e) { res.json({ ok: false, error: 'Error del servidor.' }); }
});

app.post('/api/verify', async (req, res) => {
  const { token } = req.body;
  const decoded = verifyToken(token);
  if (!decoded) return res.json({ ok: false });
  const user = await User.findById(decoded.id);
  if (!user) return res.json({ ok: false });
  res.json({ ok: true, user: safeUser(user) });
});

app.post('/api/update-profile', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false, error: 'No autorizado.' });
  const { avatar, customStatus } = req.body;
  const update = {};
  if (avatar !== undefined) update.avatar = avatar;
  if (customStatus !== undefined) update.customStatus = customStatus;
  const user = await User.findByIdAndUpdate(decoded.id, update, { new: true });
  io.emit('user-updated', { userId: user._id, avatar: user.avatar, customStatus: user.customStatus });
  res.json({ ok: true, user: safeUser(user) });
});

// ── Server Routes ─────────────────────────────────────────
app.get('/api/servers', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const user = await User.findById(decoded.id).populate('servers');
  res.json({ ok: true, servers: user.servers });
});

app.post('/api/servers/create', async (req, res) => {
  try {
    const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
    if (!decoded) return res.json({ ok: false, error: 'No autorizado.' });
    const { name, icon, description } = req.body;
    if (!name || name.trim().length < 2) return res.json({ ok: false, error: 'Nombre mínimo 2 caracteres.' });

    const srv = await ServerModel.create({
      name: name.trim(),
      icon: icon || null,
      description: description || '',
      owner: decoded.id,
      members: [{ user: decoded.id, role: 'owner' }],
    });

    // Crear canales por defecto automáticamente
    const defaultChannels = [
      { name: 'general',    type: 'text',  position: 0 },
      { name: 'media',      type: 'text',  position: 1 },
      { name: 'general',    type: 'voice', position: 2 },
      { name: 'musica',     type: 'voice', position: 3 },
    ];
    const created = await Channel.insertMany(defaultChannels.map(c => ({ ...c, server: srv._id })));
    srv.channels = created.map(c => c._id);
    await srv.save();

    await User.findByIdAndUpdate(decoded.id, { $push: { servers: srv._id } });

    const full = await ServerModel.findById(srv._id).populate('channels');
    res.json({ ok: true, server: full });
  } catch(e) { console.error(e); res.json({ ok: false, error: 'Error creando servidor.' }); }
});

app.get('/api/servers/:id', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const srv = await ServerModel.findById(req.params.id).populate('channels').populate('members.user', 'username avatar status customStatus');
  if (!srv) return res.json({ ok: false, error: 'Servidor no encontrado.' });
  const isMember = srv.members.some(m => m.user._id.toString() === decoded.id);
  if (!isMember) return res.json({ ok: false, error: 'No eres miembro.' });
  res.json({ ok: true, server: srv });
});

app.post('/api/servers/:id/invite', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const srv = await ServerModel.findById(req.params.id);
  if (!srv) return res.json({ ok: false });
  const member = srv.members.find(m => m.user.toString() === decoded.id);
  if (!member || !['owner','admin'].includes(member.role)) return res.json({ ok: false, error: 'Sin permisos.' });
  const code = nanoid(8);
  const { maxUses = 0, expiresIn = 0 } = req.body; // expiresIn en horas, 0 = nunca
  srv.invites.push({
    code,
    createdBy: decoded.id,
    expiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 3600000) : null,
    maxUses,
  });
  await srv.save();
  res.json({ ok: true, code, url: `${req.protocol}://${req.get('host')}/invite/${code}` });
});

app.get('/api/invite/:code', async (req, res) => {
  const srv = await ServerModel.findOne({ 'invites.code': req.params.code });
  if (!srv) return res.json({ ok: false, error: 'Invitación inválida.' });
  const invite = srv.invites.find(i => i.code === req.params.code);
  if (invite.expiresAt && invite.expiresAt < new Date()) return res.json({ ok: false, error: 'Invitación expirada.' });
  if (invite.maxUses > 0 && invite.uses >= invite.maxUses) return res.json({ ok: false, error: 'Invitación agotada.' });
  res.json({ ok: true, server: { id: srv._id, name: srv.name, icon: srv.icon, memberCount: srv.members.length } });
});

app.post('/api/invite/:code/join', async (req, res) => {
  try {
    const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
    if (!decoded) return res.json({ ok: false, error: 'No autorizado.' });
    const srv = await ServerModel.findOne({ 'invites.code': req.params.code });
    if (!srv) return res.json({ ok: false, error: 'Invitación inválida.' });
    const invite = srv.invites.find(i => i.code === req.params.code);
    if (invite.expiresAt && invite.expiresAt < new Date()) return res.json({ ok: false, error: 'Invitación expirada.' });
    const already = srv.members.some(m => m.user.toString() === decoded.id);
    if (!already) {
      srv.members.push({ user: decoded.id, role: 'member' });
      invite.uses++;
      await srv.save();
      await User.findByIdAndUpdate(decoded.id, { $addToSet: { servers: srv._id } });
    }
    const full = await ServerModel.findById(srv._id).populate('channels').populate('members.user', 'username avatar status');
    res.json({ ok: true, server: full });
  } catch(e) { res.json({ ok: false, error: 'Error.' }); }
});

// ── Channel Routes ────────────────────────────────────────
app.post('/api/servers/:id/channels', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const srv = await ServerModel.findById(req.params.id);
  const member = srv?.members.find(m => m.user.toString() === decoded.id);
  if (!member || !['owner','admin'].includes(member.role)) return res.json({ ok: false, error: 'Sin permisos.' });
  const { name, type } = req.body;
  const ch = await Channel.create({ server: srv._id, name: name.trim(), type: type || 'text', position: srv.channels.length });
  srv.channels.push(ch._id);
  await srv.save();
  io.to('srv:' + srv._id).emit('channel-created', ch);
  res.json({ ok: true, channel: ch });
});

app.delete('/api/channels/:id', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const ch = await Channel.findById(req.params.id);
  if (!ch) return res.json({ ok: false });
  const srv = await ServerModel.findById(ch.server);
  const member = srv?.members.find(m => m.user.toString() === decoded.id);
  if (!member || !['owner','admin'].includes(member.role)) return res.json({ ok: false, error: 'Sin permisos.' });
  await Channel.findByIdAndDelete(req.params.id);
  await ServerModel.findByIdAndUpdate(ch.server, { $pull: { channels: ch._id } });
  io.to('srv:' + ch.server).emit('channel-deleted', { channelId: ch._id });
  res.json({ ok: true });
});

// ── Message Routes ────────────────────────────────────────
app.get('/api/channels/:id/messages', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const before = req.query.before; // para paginación
  const query = { channel: req.params.id, deleted: false };
  if (before) query.createdAt = { $lt: new Date(before) };
  const msgs = await Message.find(query).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ ok: true, messages: msgs.reverse() });
});

app.delete('/api/messages/:id', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const msg = await Message.findById(req.params.id);
  if (!msg) return res.json({ ok: false });
  // Solo el autor o admin puede borrar
  if (msg.author.toString() !== decoded.id) {
    const srv = await ServerModel.findById(msg.server);
    const member = srv?.members.find(m => m.user.toString() === decoded.id);
    if (!member || !['owner','admin'].includes(member.role)) return res.json({ ok: false });
  }
  await Message.findByIdAndUpdate(req.params.id, { deleted: true, content: 'Mensaje eliminado' });
  io.to('ch:' + msg.channel).emit('message-deleted', { messageId: msg._id });
  res.json({ ok: true });
});

app.patch('/api/messages/:id', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const msg = await Message.findById(req.params.id);
  if (!msg || msg.author.toString() !== decoded.id) return res.json({ ok: false });
  const updated = await Message.findByIdAndUpdate(req.params.id,
    { content: req.body.content, edited: true, editedAt: new Date() }, { new: true });
  io.to('ch:' + msg.channel).emit('message-edited', { messageId: msg._id, content: req.body.content });
  res.json({ ok: true, message: updated });
});

// ── DM Routes ─────────────────────────────────────────────
app.get('/api/dm/:userId', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  let dm = await DM.findOne({ participants: { $all: [decoded.id, req.params.userId] } });
  if (!dm) dm = await DM.create({ participants: [decoded.id, req.params.userId] });
  res.json({ ok: true, dm });
});

app.get('/api/dm/:userId/messages', async (req, res) => {
  const decoded = verifyToken(req.headers.authorization?.split(' ')[1]);
  if (!decoded) return res.json({ ok: false });
  const dm = await DM.findOne({ participants: { $all: [decoded.id, req.params.userId] } });
  if (!dm) return res.json({ ok: true, messages: [] });
  const msgs = dm.messages.filter(m => !m.deleted).slice(-50);
  res.json({ ok: true, messages: msgs });
});

// Página de invitación
app.get('/invite/:code', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── In-memory state ───────────────────────────────────────
// socket.id → { userId, username, avatar, serverId, channelId }
const connected  = {};
const voiceRooms = {}; // channelId → [socketId]
const watchParties = {}; // channelId → { ... }
const musicBots    = {}; // channelId → { queue, playing, current, volume, paused }
const typingTimers = {}; // `${channelId}:${userId}` → timeout

function getMb(channelId) {
  if (!musicBots[channelId]) musicBots[channelId] = { queue:[], playing:false, current:null, volume:80, paused:false };
  return musicBots[channelId];
}
function getWp(channelId) {
  if (!watchParties[channelId]) watchParties[channelId] = { active:false, videoId:null, title:null, url:null, type:'youtube', playing:false, currentTime:0, startedBy:null, lastSync:Date.now() };
  return watchParties[channelId];
}
function calcWpTime(wp) {
  if (!wp.playing) return wp.currentTime || 0;
  return (wp.currentTime || 0) + (Date.now() - wp.lastSync) / 1000;
}

// ── Socket.io ─────────────────────────────────────────────
io.on('connection', socket => {

  // ── AUTH ───────────────────────────────────────────────
  socket.on('auth', async token => {
    const decoded = verifyToken(token);
    if (!decoded) { socket.emit('auth-error', 'Sesión inválida.'); return; }
    const user = await User.findByIdAndUpdate(decoded.id, { status: 'online', lastSeen: new Date() }, { new: true });
    if (!user) { socket.emit('auth-error', 'Usuario no encontrado.'); return; }
    connected[socket.id] = { userId: user._id.toString(), username: user.username, avatar: user.avatar, serverId: null, channelId: null };
    socket.emit('auth-ok', safeUser(user));
    // Broadcast online status
    io.emit('user-status', { userId: user._id, status: 'online' });
    // Unirse a las rooms de sus servidores
    const u = await User.findById(user._id).populate('servers');
    for (const srv of u.servers) socket.join('srv:' + srv._id);
    // Cargar DMs activos
    const dms = await DM.find({ participants: user._id }).sort({ lastMessage: -1 }).limit(20);
    socket.emit('dm-list', dms.map(dm => ({
      id: dm._id,
      participants: dm.participants,
      lastMessage: dm.lastMessage,
    })));
  });

  // ── JOIN SERVER ────────────────────────────────────────
  socket.on('join-server', async ({ serverId }) => {
    const me = connected[socket.id]; if (!me) return;
    const srv = await ServerModel.findById(serverId).populate('channels').populate('members.user', 'username avatar status customStatus');
    if (!srv) return;
    const isMember = srv.members.some(m => m.user._id.toString() === me.userId);
    if (!isMember) return;
    me.serverId = serverId;
    socket.join('srv:' + serverId);
    socket.emit('server-state', {
      server: srv,
      onlineMembers: getOnlineMembers(serverId),
    });
  });

  // ── JOIN CHANNEL ───────────────────────────────────────
  socket.on('join-channel', async ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    if (me.channelId) socket.leave('ch:' + me.channelId);
    me.channelId = channelId;
    socket.join('ch:' + channelId);
    // Cargar historial
    const msgs = await Message.find({ channel: channelId, deleted: false }).sort({ createdAt: -1 }).limit(50).lean();
    socket.emit('channel-history', { channelId, messages: msgs.reverse() });
    // Estado watch party
    const wp = getWp(channelId);
    if (wp.playing) { wp.currentTime = calcWpTime(wp); wp.lastSync = Date.now(); }
    socket.emit('watch-state', { ...wp, channelId });
    // Estado música
    socket.emit('music-state', { ...getMb(channelId), channelId });
    socket.emit('channel-joined', { channelId });
  });

  // ── MESSAGES ───────────────────────────────────────────
  socket.on('send-message', async ({ channelId, content, replyToId }) => {
    const me = connected[socket.id]; if (!me || !content?.trim()) return;
    // Stop typing
    clearTyping(channelId, me.userId);
    const ch = await Channel.findById(channelId);
    if (!ch) return;
    let replyPreview = null;
    if (replyToId) {
      const original = await Message.findById(replyToId);
      replyPreview = original?.content?.slice(0, 80) || null;
    }
    if (content.trim().startsWith('/')) {
      await handleBotCommand(socket, me, ch, content.trim());
      return;
    }
    const msg = await Message.create({
      channel: channelId,
      server: ch.server,
      author: me.userId,
      authorName: me.username,
      authorAvatar: me.avatar,
      content: content.trim(),
      replyTo: replyToId || null,
      replyPreview,
    });
    io.to('ch:' + channelId).emit('new-message', { ...msg.toObject(), channelId });
  });

  // ── DM ─────────────────────────────────────────────────
  socket.on('send-dm', async ({ toUserId, content }) => {
    const me = connected[socket.id]; if (!me || !content?.trim()) return;
    let dm = await DM.findOne({ participants: { $all: [me.userId, toUserId] } });
    if (!dm) dm = await DM.create({ participants: [me.userId, toUserId] });
    const msgData = {
      author: me.userId,
      authorName: me.username,
      authorAvatar: me.avatar,
      content: content.trim(),
      createdAt: new Date(),
    };
    dm.messages.push(msgData);
    dm.lastMessage = new Date();
    await dm.save();
    const saved = dm.messages[dm.messages.length - 1];
    // Enviar al receptor si está online
    const dmRoom = 'dm:' + [me.userId, toUserId].sort().join(':');
    io.to(dmRoom).emit('dm-message', { dmId: dm._id, message: saved, participants: dm.participants });
    // Emitir al que envía también si no está en la room
    socket.emit('dm-message', { dmId: dm._id, message: saved, participants: dm.participants });
  });

  socket.on('join-dm', ({ withUserId }) => {
    const me = connected[socket.id]; if (!me) return;
    const room = 'dm:' + [me.userId, withUserId].sort().join(':');
    socket.join(room);
  });

  // ── TYPING ─────────────────────────────────────────────
  socket.on('typing-start', ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    socket.to('ch:' + channelId).emit('typing', { userId: me.userId, username: me.username, channelId });
    // Auto-stop después de 4s
    const key = `${channelId}:${me.userId}`;
    clearTimeout(typingTimers[key]);
    typingTimers[key] = setTimeout(() => {
      io.to('ch:' + channelId).emit('typing-stop', { userId: me.userId, channelId });
    }, 4000);
  });

  socket.on('typing-stop', ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    clearTyping(channelId, me.userId);
    socket.to('ch:' + channelId).emit('typing-stop', { userId: me.userId, channelId });
  });

  function clearTyping(channelId, userId) {
    const key = `${channelId}:${userId}`;
    clearTimeout(typingTimers[key]);
    delete typingTimers[key];
  }

  // ── REACTIONS ──────────────────────────────────────────
  socket.on('react', async ({ messageId, emoji, channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    const msg = await Message.findById(messageId);
    if (!msg) return;
    const existing = msg.reactions.find(r => r.emoji === emoji);
    if (existing) {
      const idx = existing.users.indexOf(me.userId);
      if (idx >= 0) existing.users.splice(idx, 1);
      else existing.users.push(me.userId);
    } else {
      msg.reactions.push({ emoji, users: [me.userId] });
    }
    await msg.save();
    io.to('ch:' + channelId).emit('reaction-update', { messageId, reactions: msg.reactions });
  });

  // ── STATUS ─────────────────────────────────────────────
  socket.on('set-status', async ({ status }) => {
    const me = connected[socket.id]; if (!me) return;
    await User.findByIdAndUpdate(me.userId, { status });
    io.emit('user-status', { userId: me.userId, status });
  });

  // ── WATCH PARTY ────────────────────────────────────────
  socket.on('watch-start', async ({ channelId, url, type }) => {
    const me = connected[socket.id]; if (!me) return;
    const wp = getWp(channelId);
    if (type === 'iframe') {
      Object.assign(wp, { active:true, type:'iframe', url, videoId:null, title:'⚽ Fútbol Libre', playing:true, currentTime:0, startedBy:me.username, lastSync:Date.now() });
    } else {
      const vid = extractVideoId(url);
      if (!vid) { socket.emit('watch-error', 'Link inválido.'); return; }
      const info = await getVideoInfo(vid);
      Object.assign(wp, { active:true, type:'youtube', videoId:vid, url:null, title:info.title, playing:false, currentTime:0, startedBy:me.username, lastSync:Date.now() });
      // Mensaje en canal
      await Message.create({ channel:channelId, authorName:'🎬 Watch Party', content:`**${me.username}** inició Watch Party: ${info.title}`, type:'bot' });
    }
    io.to('ch:' + channelId).emit('watch-state', { ...wp, channelId });
  });

  socket.on('watch-play', ({ channelId, currentTime }) => {
    const wp = getWp(channelId);
    wp.playing=true; wp.currentTime=currentTime||0; wp.lastSync=Date.now();
    io.to('ch:' + channelId).emit('watch-cmd', { action:'play', currentTime:wp.currentTime, ts:wp.lastSync, channelId });
  });
  socket.on('watch-pause', ({ channelId, currentTime }) => {
    const wp = getWp(channelId);
    wp.playing=false; wp.currentTime=currentTime||0; wp.lastSync=Date.now();
    io.to('ch:' + channelId).emit('watch-cmd', { action:'pause', currentTime:wp.currentTime, ts:wp.lastSync, channelId });
  });
  socket.on('watch-sync-request', ({ channelId }) => {
    const wp = getWp(channelId);
    if (wp.playing) { wp.currentTime=calcWpTime(wp); wp.lastSync=Date.now(); }
    io.to('ch:' + channelId).emit('watch-cmd', { action:wp.playing?'sync-play':'sync-pause', currentTime:wp.currentTime, ts:wp.lastSync, channelId });
  });
  socket.on('watch-stop', ({ channelId }) => {
    const wp = getWp(channelId);
    Object.assign(wp, { active:false, videoId:null, url:null, playing:false, currentTime:0, type:'youtube' });
    io.to('ch:' + channelId).emit('watch-state', { ...wp, channelId });
  });

  // ── VOICE (WebRTC) ─────────────────────────────────────
  socket.on('join-voice', ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    if (!voiceRooms[channelId]) voiceRooms[channelId] = [];
    voiceRooms[channelId] = voiceRooms[channelId].filter(id => id !== socket.id);
    const existing = [...voiceRooms[channelId]];
    socket.emit('existing-peers', existing);
    existing.forEach(p => io.to(p).emit('peer-joined', { peerId: socket.id, username: me.username, avatar: me.avatar }));
    voiceRooms[channelId].push(socket.id);
    socket.join('voice:' + channelId);
    socket.currentVoiceChannel = channelId;
    io.to('srv:' + me.serverId).emit('voice-users', { channelId, users: getVoiceUsers(channelId) });
    socket.emit('voice-joined', { channelId });
  });

  socket.on('leave-voice', () => leaveVoice(socket));
  socket.on('offer',         ({ to, offer })     => io.to(to).emit('offer',         { from:socket.id, offer }));
  socket.on('answer',        ({ to, answer })    => io.to(to).emit('answer',        { from:socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from:socket.id, candidate }));
  socket.on('voice-mute',    ({ muted })         => {
    const me = connected[socket.id]; if (!me) return;
    if (socket.currentVoiceChannel) io.to('voice:' + socket.currentVoiceChannel).emit('peer-mute', { peerId:socket.id, muted });
  });

  // ── DISCONNECT ─────────────────────────────────────────
  socket.on('disconnect', async () => {
    const me = connected[socket.id];
    leaveVoice(socket);
    if (me) {
      await User.findByIdAndUpdate(me.userId, { status: 'offline', lastSeen: new Date() });
      io.emit('user-status', { userId: me.userId, status: 'offline' });
    }
    delete connected[socket.id];
  });

  function leaveVoice(s) {
    const ch = s.currentVoiceChannel;
    if (!ch || !voiceRooms[ch]) return;
    voiceRooms[ch] = voiceRooms[ch].filter(id => id !== s.id);
    io.to('voice:' + ch).emit('peer-left', s.id);
    s.leave('voice:' + ch);
    s.currentVoiceChannel = null;
    const me = connected[s.id];
    if (me?.serverId) io.to('srv:' + me.serverId).emit('voice-users', { channelId: ch, users: getVoiceUsers(ch) });
  }
});

// ── Bot ───────────────────────────────────────────────────
async function handleBotCommand(socket, me, channel, text) {
  const channelId = channel._id.toString();
  const parts = text.split(' '); const cmd = parts[0].toLowerCase(); const args = parts.slice(1).join(' ');
  const mb = getMb(channelId);

  // Guardar comando como mensaje
  await Message.create({ channel:channelId, server:channel.server, author:me.userId, authorName:me.username, authorAvatar:me.avatar, content:text });
  io.to('ch:' + channelId).emit('new-message', { channel:channelId, authorName:me.username, authorAvatar:me.avatar, content:text, createdAt:new Date(), type:'text', channelId });

  const botMsg = async (t) => {
    const msg = await Message.create({ channel:channelId, server:channel.server, authorName:'🤖 KoldBot', content:t, type:'bot' });
    io.to('ch:' + channelId).emit('new-message', { ...msg.toObject(), channelId });
  };
  const emitMb = () => io.to('ch:' + channelId).emit('music-state', { ...mb, channelId });

  switch(cmd) {
    case '/play': {
      if (!args) { await botMsg('❄️ Uso: `/play nombre canción`'); return; }
      await botMsg(`🔍 Buscando **${args}**...`);
      const r = await searchYouTube(args);
      if (!r.length) { await botMsg('❌ Sin resultados.'); return; }
      const song = { ...r[0], requestedBy: me.username };
      mb.queue.push(song);
      if (!mb.playing) await playNext(mb, channelId, botMsg);
      else { await botMsg(`✅ **${song.title}** en cola (#${mb.queue.length})`); emitMb(); }
      break;
    }
    case '/watch': {
      if (!args) { await botMsg('🎬 Uso: `/watch [URL YouTube]`'); return; }
      const vid = extractVideoId(args);
      if (!vid) { await botMsg('❌ Link inválido.'); return; }
      const info = await getVideoInfo(vid);
      const wp = getWp(channelId);
      Object.assign(wp, { active:true, type:'youtube', videoId:vid, title:info.title, playing:false, currentTime:0, startedBy:me.username, lastSync:Date.now() });
      io.to('ch:' + channelId).emit('watch-state', { ...wp, channelId });
      await botMsg(`🎬 Watch Party iniciado:\n🎥 ${info.title}`);
      break;
    }
    case '/partydo': {
      const wp = getWp(channelId);
      Object.assign(wp, { active:true, type:'iframe', url:'https://librefutboltv.su/home1/', videoId:null, title:'⚽ Fútbol Libre', playing:true, currentTime:0, startedBy:me.username, lastSync:Date.now() });
      io.to('ch:' + channelId).emit('watch-state', { ...wp, channelId });
      await botMsg(`⚽ **${me.username}** abrió Fútbol Libre para todos.`);
      break;
    }
    case '/skip':   { if (!mb.current) { await botMsg('❌ Nada.'); return; } await botMsg('⏭️ Saltado.'); await playNext(mb, channelId, botMsg); break; }
    case '/stop':   { mb.queue=[]; mb.playing=false; mb.current=null; mb.paused=false; emitMb(); io.to('ch:'+channelId).emit('music-stop',{channelId}); await botMsg('⏹️ Detenido.'); break; }
    case '/pause':  { if (!mb.playing) { await botMsg('❌ Sin música.'); return; } mb.paused=true; emitMb(); io.to('ch:'+channelId).emit('music-pause',{channelId}); await botMsg('⏸️ Pausada.'); break; }
    case '/resume': { if (!mb.paused) { await botMsg('❌ No pausada.'); return; } mb.paused=false; emitMb(); io.to('ch:'+channelId).emit('music-resume',{channelId}); await botMsg('▶️ Reanudada.'); break; }
    case '/volume': { const v=parseInt(args); if(isNaN(v)||v<0||v>100){await botMsg('❌ `/volume 0-100`');return;} mb.volume=v; emitMb(); io.to('ch:'+channelId).emit('music-volume',{v,channelId}); await botMsg(`🔊 ${v}%`); break; }
    case '/queue':  { if(!mb.current&&!mb.queue.length){await botMsg('📋 Cola vacía.');return;} let msg='📋 **Cola:**\n'; if(mb.current) msg+=`▶️ ${mb.current.title}\n`; mb.queue.forEach((s,i)=>msg+=`${i+1}. ${s.title}\n`); await botMsg(msg); break; }
    case '/np':     { if(!mb.current){await botMsg('❌ Nada.');return;} await botMsg(`🎵 **${mb.current.title}** — ${mb.current.requestedBy}`); break; }
    case '/help':   { await botMsg('🤖 Comandos:\n`/play` `/watch [URL]` `/partydo` `/skip` `/stop` `/pause` `/resume` `/volume [0-100]` `/queue` `/np`'); break; }
    default:        { await botMsg('❓ Usa `/help` para ver comandos.'); }
  }
}

async function playNext(mb, channelId, botMsg) {
  if (!mb.queue.length) {
    mb.playing=false; mb.current=null;
    io.to('ch:'+channelId).emit('music-state', { ...mb, channelId });
    io.to('ch:'+channelId).emit('music-ended', { channelId });
    if (botMsg) await botMsg('✅ Cola terminada.');
    return;
  }
  mb.current=mb.queue.shift(); mb.playing=true; mb.paused=false;
  io.to('ch:'+channelId).emit('music-state', { ...mb, channelId });
  io.to('ch:'+channelId).emit('music-play', { ...mb.current, channelId });
  if (botMsg) await botMsg(`🎵 **${mb.current.title}** — ${mb.current.requestedBy}`);
}

// ── YouTube helpers ───────────────────────────────────────
function extractVideoId(url) {
  const pp = [/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/, /^([a-zA-Z0-9_-]{11})$/];
  for (const p of pp) { const m = url.match(p); if (m) return m[1]; }
  return null;
}
async function getVideoInfo(videoId) {
  return new Promise(resolve => {
    https.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{try{resolve({title:JSON.parse(d).title});}catch(e){resolve({title:'Video'});}});
    }).on('error',()=>resolve({title:'Video'}));
  });
}
async function searchYouTube(query) {
  return new Promise(resolve => {
    const q=encodeURIComponent(query);
    https.get(`https://www.youtube.com/results?search_query=${q}`,{headers:{'User-Agent':'Mozilla/5.0'}},res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{
          const ids=[...new Set((d.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g)||[]).map(m=>m.slice(11,-1)))].slice(0,5);
          const titles=(d.match(/"title":{"runs":\[{"text":"([^"]+)"/g)||[]).map(t=>{const m=t.match(/"text":"([^"]+)"/);return m?m[1]:'Sin título';}).slice(0,5);
          resolve(ids.map((id,i)=>({videoId:id,title:titles[i]||`Video ${i+1}`,thumbnail:`https://img.youtube.com/vi/${id}/mqdefault.jpg`})));
        }catch(e){resolve([]);}
      });
    }).on('error',()=>resolve([]));
  });
}

// ── Helpers ───────────────────────────────────────────────
function safeUser(u) {
  return { id:u._id, username:u.username, avatar:u.avatar, status:u.status, customStatus:u.customStatus, servers:u.servers, createdAt:u.createdAt };
}
function getOnlineMembers(serverId) {
  return Object.values(connected).filter(c => c.serverId === serverId).map(c => ({ userId:c.userId, username:c.username, avatar:c.avatar }));
}
function getVoiceUsers(channelId) {
  return (voiceRooms[channelId]||[]).map(sid => {
    const c = connected[sid];
    return c ? { socketId:sid, userId:c.userId, username:c.username, avatar:c.avatar } : null;
  }).filter(Boolean);
}

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  DISKOLD v4.0  by Kold           ║`);
  console.log(`║  http://localhost:${PORT}          ║`);
  console.log(`╚══════════════════════════════════╝\n`);
});
