/**
 * DISKOLD v4.2
 * MongoDB + Socket.io + WebRTC + YouTube + Files-in-RAM
 * by Kold
 */
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const mongoose   = require('mongoose');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const https      = require('https');
const path       = require('path');
const { nanoid } = require('nanoid');
const { User, Server: SrvModel, Channel, Message, DM } = require('./models');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{ origin:'*' }, maxHttpBufferSize: 12e6 });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '12mb' }));

const JWT_SECRET  = process.env.JWT_SECRET  || 'diskold_secret_kold';
const PORT        = process.env.PORT        || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/diskold';

// ── File limbo (RAM only — se borran al reiniciar) ────────
// fileId → { data: Buffer|string(base64), filename, mimetype, size, uploadedAt }
const fileStore = new Map();
// Auto-limpiar archivos > 6h
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600000;
  for (const [id, f] of fileStore) {
    if (f.uploadedAt < cutoff) fileStore.delete(id);
  }
}, 3600000);


// ── Poll store ────────────────────────────────────────────
// pollId → { question, options:[{text,votes:[userId]}], createdBy, channelId }
const polls = new Map();

// ── Pin store ─────────────────────────────────────────────
// channelId → [{ msgId, content, authorName, pinnedBy, pinnedAt }]
const pins = new Map();

// ── Alarm store ───────────────────────────────────────────
const alarms = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [id, a] of alarms) {
    if (a.triggerAt <= now) {
      io.to('ch:'+a.channelId).emit('alarm-ring', { label:a.label, createdBy:a.createdBy });
      alarms.delete(id);
    }
  }
}, 5000);

// ── Vibe meter ────────────────────────────────────────────
const vibes = new Map();
function getVibe(cid) {
  if (!vibes.has(cid)) vibes.set(cid, { vibe:0, lastActivity:Date.now() });
  const v = vibes.get(cid);
  const decaySecs = (Date.now() - v.lastActivity) / 1000;
  v.vibe = Math.max(0, v.vibe - Math.floor(decaySecs/30));
  v.lastActivity = Date.now();
  return v;
}
function bumpVibe(cid) {
  const v = getVibe(cid);
  v.vibe = Math.min(100, v.vibe + 3);
  io.to('ch:'+cid).emit('vibe-update', { channelId:cid, vibe:v.vibe });
}

// ── Canvas/Draw store ─────────────────────────────────────
const canvases = new Map();
function getCanvas(cid) {
  if (!canvases.has(cid)) canvases.set(cid, { strokes:[] });
  return canvases.get(cid);
}

// ── Focus/Pomodoro ────────────────────────────────────────
const focusSessions = new Map();

// ── Partydo host ──────────────────────────────────────────
// channelId → socketId of host
const partydoHosts = {};

// ── osu!mania Leaderboard ─────────────────────────────────
// serverId → { scores: [{ userId, username, score, accuracy, maxCombo, rank, ts }] }
const maniaLeaderboards = new Map();
function getManiaLB(serverId) {
  if (!maniaLeaderboards.has(serverId)) maniaLeaderboards.set(serverId, { scores: [] });
  return maniaLeaderboards.get(serverId);
}

// ── MongoDB ───────────────────────────────────────────────
mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB OK'))
  .catch(e  => console.error('❌ MongoDB:', e));

// ── JWT ───────────────────────────────────────────────────
const signToken  = id  => jwt.sign({ id }, JWT_SECRET, { expiresIn: '30d' });
const verifyTok  = tok => { try { return jwt.verify(tok, JWT_SECRET); } catch { return null; } };
const authHeader = req => verifyTok(req.headers.authorization?.split(' ')[1]);

// ── safeUser ──────────────────────────────────────────────
const safeUser = u => ({
  id: u._id, username: u.username, avatar: u.avatar,
  status: u.status, customStatus: u.customStatus,
  servers: u.servers, createdAt: u.createdAt,
  friendRequestCount: u.friendRequests?.length || 0,
});

// ═══════════════════════════════════════════════════════════
// HTTP ROUTES
// ═══════════════════════════════════════════════════════════

// ── Auth ──────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username?.trim() || !password) return res.json({ ok:false, error:'Faltan datos.' });
    if (username.length < 2 || username.length > 20) return res.json({ ok:false, error:'Nombre: 2-20 caracteres.' });
    if (password.length < 4) return res.json({ ok:false, error:'Contraseña mínimo 4 caracteres.' });
    if (await User.findOne({ username: new RegExp(`^${username.trim()}$`,'i') }))
      return res.json({ ok:false, error:'Ese usuario ya existe.' });
    const hash = await bcrypt.hash(password, 10);
    const user = await User.create({ username: username.trim(), password: hash });
    res.json({ ok:true, token: signToken(user._id), user: safeUser(user) });
  } catch(e) { res.json({ ok:false, error:'Error del servidor.' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: new RegExp(`^${username}$`,'i') });
    if (!user)                              return res.json({ ok:false, error:'Usuario no encontrado.' });
    if (!await bcrypt.compare(password, user.password)) return res.json({ ok:false, error:'Contraseña incorrecta.' });
    await User.findByIdAndUpdate(user._id, { status:'online', lastSeen: new Date() });
    res.json({ ok:true, token: signToken(user._id), user: safeUser(user) });
  } catch(e) { res.json({ ok:false, error:'Error del servidor.' }); }
});

app.post('/api/verify', async (req, res) => {
  const d = verifyTok(req.body.token);
  if (!d) return res.json({ ok:false });
  const user = await User.findById(d.id);
  if (!user) return res.json({ ok:false });
  res.json({ ok:true, user: safeUser(user) });
});

app.post('/api/update-profile', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const { avatar, customStatus } = req.body;
  const upd = {};
  if (avatar       !== undefined) upd.avatar       = avatar;
  if (customStatus !== undefined) upd.customStatus = customStatus;
  const user = await User.findByIdAndUpdate(d.id, upd, { new:true });
  io.emit('user-updated', { userId: user._id, avatar: user.avatar, customStatus: user.customStatus });
  res.json({ ok:true, user: safeUser(user) });
});

// ── Users search ──────────────────────────────────────────
app.get('/api/users/search', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const q = req.query.q?.trim();
  if (!q || q.length < 2) return res.json({ ok:true, users:[] });
  const users = await User.find({ username: new RegExp(q,'i'), _id: { $ne: d.id } }).limit(10).select('username avatar status customStatus');
  res.json({ ok:true, users });
});

// ── Friend Requests ───────────────────────────────────────
app.post('/api/friends/request/:targetId', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  if (d.id === req.params.targetId) return res.json({ ok:false, error:'No puedes agregarte a ti mismo.' });
  const me = await User.findById(d.id);
  const target = await User.findById(req.params.targetId);
  if (!target) return res.json({ ok:false, error:'Usuario no encontrado.' });
  if (me.friends.includes(target._id)) return res.json({ ok:false, error:'Ya son amigos.' });
  if (me.sentRequests.includes(target._id)) return res.json({ ok:false, error:'Solicitud ya enviada.' });
  // Comprobar si el target ya me mandó solicitud → aceptar directamente
  const existing = target.sentRequests.includes(me._id);
  if (existing) {
    await User.findByIdAndUpdate(d.id,          { $addToSet:{ friends: target._id }, $pull:{ friendRequests:{ from: target._id } } });
    await User.findByIdAndUpdate(target._id,    { $addToSet:{ friends: me._id },     $pull:{ sentRequests: me._id } });
    io.to('user:'+d.id).emit('friend-added', { userId: target._id, username: target.username, avatar: target.avatar });
    io.to('user:'+target._id.toString()).emit('friend-added', { userId: me._id, username: me.username, avatar: me.avatar });
    return res.json({ ok:true, accepted:true });
  }
  await User.findByIdAndUpdate(d.id,        { $addToSet:{ sentRequests: target._id } });
  await User.findByIdAndUpdate(target._id,  { $push:{ friendRequests:{ from: me._id, username: me.username, avatar: me.avatar } } });
  io.to('user:'+target._id.toString()).emit('friend-request', { from: me._id, username: me.username, avatar: me.avatar });
  res.json({ ok:true, accepted:false });
});

app.post('/api/friends/accept/:fromId', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const from = await User.findById(req.params.fromId);
  if (!from) return res.json({ ok:false });
  const me = await User.findById(d.id);
  await User.findByIdAndUpdate(d.id,       { $addToSet:{ friends: from._id }, $pull:{ friendRequests:{ from: from._id } } });
  await User.findByIdAndUpdate(from._id,   { $addToSet:{ friends: me._id  }, $pull:{ sentRequests: me._id } });
  io.to('user:'+d.id).emit('friend-added', { userId: from._id, username: from.username, avatar: from.avatar });
  io.to('user:'+from._id.toString()).emit('friend-added', { userId: me._id, username: me.username, avatar: me.avatar });
  res.json({ ok:true });
});

app.post('/api/friends/decline/:fromId', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  await User.findByIdAndUpdate(d.id,                { $pull:{ friendRequests:{ from: req.params.fromId } } });
  await User.findByIdAndUpdate(req.params.fromId,   { $pull:{ sentRequests: d.id } });
  res.json({ ok:true });
});

app.delete('/api/friends/:userId', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  await User.findByIdAndUpdate(d.id,             { $pull:{ friends: req.params.userId } });
  await User.findByIdAndUpdate(req.params.userId, { $pull:{ friends: d.id } });
  res.json({ ok:true });
});

app.get('/api/friends', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const me = await User.findById(d.id)
    .populate('friends', 'username avatar status customStatus')
    .populate('friendRequests.from', 'username avatar');
  res.json({ ok:true, friends: me.friends, requests: me.friendRequests });
});

// ── Servers ───────────────────────────────────────────────
app.get('/api/servers', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const user = await User.findById(d.id).populate('servers','name icon description');
  res.json({ ok:true, servers: user.servers });
});

app.post('/api/servers/create', async (req, res) => {
  try {
    const d = authHeader(req); if (!d) return res.json({ ok:false });
    const { name, description } = req.body;
    if (!name?.trim() || name.trim().length < 2) return res.json({ ok:false, error:'Nombre mínimo 2 caracteres.' });
    const srv = await SrvModel.create({
      name: name.trim(), description: description||'',
      owner: d.id,
      members: [{ user: d.id, role:'owner' }],
    });
    const defaults = [
      { name:'general', type:'text',  position:0 },
      { name:'media',   type:'text',  position:1 },
      { name:'general', type:'voice', position:2 },
      { name:'musica',  type:'voice', position:3 },
    ];
    const chs = await Channel.insertMany(defaults.map(c => ({ ...c, server: srv._id })));
    srv.channels = chs.map(c => c._id);
    await srv.save();
    await User.findByIdAndUpdate(d.id, { $push:{ servers: srv._id } });
    const full = await SrvModel.findById(srv._id).populate('channels');
    res.json({ ok:true, server: full });
  } catch(e) { console.error(e); res.json({ ok:false, error:'Error.' }); }
});

app.get('/api/servers/:id', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const srv = await SrvModel.findById(req.params.id)
    .populate('channels')
    .populate('members.user','username avatar status customStatus');
  if (!srv) return res.json({ ok:false, error:'No encontrado.' });
  if (!srv.members.some(m => m.user._id.toString() === d.id))
    return res.json({ ok:false, error:'No eres miembro.' });
  res.json({ ok:true, server: srv });
});

app.post('/api/servers/:id/invite', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const srv = await SrvModel.findById(req.params.id);
  if (!srv) return res.json({ ok:false });
  const mb = srv.members.find(m => m.user.toString() === d.id);
  if (!mb || !['owner','admin'].includes(mb.role)) return res.json({ ok:false, error:'Sin permisos.' });
  const code = nanoid(8);
  srv.invites.push({ code, createdBy: d.id, maxUses: req.body.maxUses||0 });
  await srv.save();
  res.json({ ok:true, code, url:`${req.protocol}://${req.get('host')}/invite/${code}` });
});

app.get('/api/invite/:code', async (req, res) => {
  const srv = await SrvModel.findOne({ 'invites.code': req.params.code });
  if (!srv) return res.json({ ok:false, error:'Inválido.' });
  const inv = srv.invites.find(i => i.code === req.params.code);
  if (inv.expiresAt && inv.expiresAt < new Date()) return res.json({ ok:false, error:'Expirado.' });
  res.json({ ok:true, server:{ id:srv._id, name:srv.name, icon:srv.icon, memberCount:srv.members.length } });
});

app.post('/api/invite/:code/join', async (req, res) => {
  try {
    const d = authHeader(req); if (!d) return res.json({ ok:false });
    const srv = await SrvModel.findOne({ 'invites.code': req.params.code });
    if (!srv) return res.json({ ok:false, error:'Inválido.' });
    if (!srv.members.some(m => m.user.toString() === d.id)) {
      srv.members.push({ user: d.id, role:'member' });
      srv.invites.find(i => i.code === req.params.code).uses++;
      await srv.save();
      await User.findByIdAndUpdate(d.id, { $addToSet:{ servers: srv._id } });
    }
    const full = await SrvModel.findById(srv._id)
      .populate('channels')
      .populate('members.user','username avatar status');
    res.json({ ok:true, server: full });
  } catch(e) { res.json({ ok:false, error:'Error.' }); }
});

// ── Channels ──────────────────────────────────────────────
app.post('/api/servers/:id/channels', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const srv = await SrvModel.findById(req.params.id);
  const mb = srv?.members.find(m => m.user.toString() === d.id);
  if (!mb || !['owner','admin'].includes(mb.role)) return res.json({ ok:false });
  const ch = await Channel.create({ server:srv._id, name:req.body.name.trim(), type:req.body.type||'text', position:srv.channels.length });
  srv.channels.push(ch._id); await srv.save();
  io.to('srv:'+srv._id).emit('channel-created', ch);
  res.json({ ok:true, channel: ch });
});

app.delete('/api/channels/:id', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const ch = await Channel.findById(req.params.id);
  if (!ch) return res.json({ ok:false });
  const srv = await SrvModel.findById(ch.server);
  const mb  = srv?.members.find(m => m.user.toString() === d.id);
  if (!mb || !['owner','admin'].includes(mb.role)) return res.json({ ok:false });
  await Channel.findByIdAndDelete(req.params.id);
  await SrvModel.findByIdAndUpdate(ch.server, { $pull:{ channels: ch._id } });
  io.to('srv:'+ch.server).emit('channel-deleted', { channelId: ch._id });
  res.json({ ok:true });
});

// ── Messages ──────────────────────────────────────────────
app.get('/api/channels/:id/messages', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const q = { channel: req.params.id, deleted:false };
  if (req.query.before) q.createdAt = { $lt: new Date(req.query.before) };
  const msgs = await Message.find(q).sort({ createdAt:-1 }).limit(50).lean();
  res.json({ ok:true, messages: msgs.reverse() });
});

app.delete('/api/messages/:id', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const msg = await Message.findById(req.params.id);
  if (!msg) return res.json({ ok:false });
  if (msg.author?.toString() !== d.id) {
    const srv = await SrvModel.findById(msg.server);
    const mb  = srv?.members.find(m => m.user.toString() === d.id);
    if (!mb || !['owner','admin'].includes(mb.role)) return res.json({ ok:false });
  }
  await Message.findByIdAndUpdate(req.params.id, { deleted:true, content:'Mensaje eliminado' });
  io.to('ch:'+msg.channel).emit('message-deleted', { messageId: msg._id });
  res.json({ ok:true });
});

app.patch('/api/messages/:id', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const msg = await Message.findById(req.params.id);
  if (!msg || msg.author?.toString() !== d.id) return res.json({ ok:false });
  await Message.findByIdAndUpdate(req.params.id, { content: req.body.content, edited:true, editedAt: new Date() });
  io.to('ch:'+msg.channel).emit('message-edited', { messageId: msg._id, content: req.body.content });
  res.json({ ok:true });
});

// ── Files (RAM limbo) ─────────────────────────────────────
app.post('/api/upload', async (req, res) => {
  try {
    const d = authHeader(req); if (!d) return res.json({ ok:false });
    const { filename, mimetype, data } = req.body; // data = base64
    if (!data || !filename) return res.json({ ok:false, error:'Sin archivo.' });
    const sizeBytes = Math.round(data.length * 0.75);
    if (sizeBytes > 10 * 1024 * 1024) return res.json({ ok:false, error:'Máximo 10 MB.' });
    const fileId = nanoid(16);
    fileStore.set(fileId, { data, filename, mimetype: mimetype||'application/octet-stream', size: sizeBytes, uploadedAt: Date.now() });
    res.json({ ok:true, fileId, filename, mimetype, size: sizeBytes });
  } catch(e) { res.json({ ok:false, error:'Error.' }); }
});

app.get('/api/files/:id', (req, res) => {
  const f = fileStore.get(req.params.id);
  if (!f) return res.status(404).json({ ok:false });
  const buf = Buffer.from(f.data.replace(/^data:[^;]+;base64,/,''), 'base64');
  res.set('Content-Type', f.mimetype);
  res.set('Content-Disposition', `attachment; filename="${encodeURIComponent(f.filename)}"`);
  res.send(buf);
});

// ── DM ────────────────────────────────────────────────────
app.get('/api/dm/:userId/messages', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const dm = await DM.findOne({ participants: { $all:[d.id, req.params.userId] } });
  if (!dm) return res.json({ ok:true, messages:[] });
  res.json({ ok:true, messages: dm.messages.filter(m=>!m.deleted).slice(-50) });
});

app.get('/api/dms', async (req, res) => {
  const d = authHeader(req); if (!d) return res.json({ ok:false });
  const dms = await DM.find({ participants: d.id }).sort({ lastMessage:-1 }).limit(20);
  res.json({ ok:true, dms });
});

// ── Invite landing page ───────────────────────────────────
app.get('/invite/:code', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

// ── Channel snapshot (export chat as HTML) ────────────────
app.get('/api/channels/:id/snapshot', async (req, res) => {
  const msgs = await Message.find({ channel: req.params.id, deleted: false }).sort({ createdAt: 1 }).limit(200).lean();
  const rows = msgs.map(m => `<div style="padding:6px 0;border-bottom:1px solid #222;"><span style="color:#a8d8ff;font-weight:700;">${m.authorName||'?'}</span> <span style="color:#555;font-size:.75em;">${new Date(m.createdAt).toLocaleString('es')}</span><br><span style="color:#e8eaf0;">${(m.content||'').replace(/</g,'&lt;')}</span></div>`).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Diskold Snapshot</title><style>body{background:#0a0a0c;color:#e8eaf0;font-family:sans-serif;max-width:700px;margin:0 auto;padding:20px;}h1{color:#a8d8ff;font-family:monospace;}</style></head><body><h1>📸 Diskold Snapshot</h1><p style="color:#555;">Exportado: ${new Date().toLocaleString('es')}</p>${rows}</body></html>`;
  res.set('Content-Type','text/html');
  res.set('Content-Disposition',`attachment; filename="snapshot-${req.params.id}.html"`);
  res.send(html);
});

// ── Partydo view (iframe with adblock CSS injected) ───────
app.get('/partydo-view', (req, res) => {
  const adblockSelectors = [
    '[class*="banner"],[id*="banner"]',
    '[class*="popup"],[id*="popup"]',
    '[class*="overlay"]:not(.video-overlay)',
    '[class*="advertisement"],[class*="adsense"]',
    '[class*="ad-container"],[class*="ad-wrap"]',
    '[class*="sticky-ad"],[class*="floating-ad"]',
    'ins.adsbygoogle',
    'iframe[src*="doubleclick"]',
    'iframe[src*="googlesyndication"]',
    '[class*="cookie"],[id*="cookie"]',
    '[class*="gdpr"],[class*="consent"]',
    '[class*="subscribe-modal"],[id*="subscribe"]'
  ].join(',');

  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<style>' +
    '* { box-sizing:border-box; margin:0; padding:0; }' +
    'html,body { width:100%; height:100%; background:#000; overflow:hidden; }' +
    'iframe#tv { width:100%; height:100%; border:none; display:block; }' +
    '[class*="banner"],[id*="banner"],[class*="popup"],[id*="popup"],' +
    '[class*="advertisement"],[class*="adsense"],[class*="ad-wrap"],' +
    'ins.adsbygoogle,[class*="cookie-banner"],[class*="gdpr"]' +
    '{ display:none!important; }' +
    '</style></head><body>' +
    '<iframe id="tv" src="https://librefutboltv.su/home1/"' +
    ' allow="autoplay;fullscreen;encrypted-media"' +
    ' allowfullscreen' +
    ' sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-presentation allow-top-navigation-by-user-activation">' +
    '</iframe>' +
    '<script>' +
    'var tv = document.getElementById("tv");' +
    'var adSels = ' + JSON.stringify(adblockSelectors) + ';' +
    'function killAds(doc) {' +
    '  try {' +
    '    doc.querySelectorAll(adSels).forEach(function(el){ el.style.cssText="display:none!important"; });' +
    '    var all = doc.querySelectorAll("*");' +
    '    for(var i=0;i<all.length;i++){' +
    '      var el=all[i]; var st=window.getComputedStyle ? null : null;' +
    '      var style=el.getAttribute("style")||"";' +
    '      if((style.includes("position:fixed")||style.includes("position: fixed"))&&' +
    '         el.tagName!=="VIDEO"&&el.id!=="tv"){' +
    '        el.style.cssText="display:none!important";' +
    '      }' +
    '    }' +
    '  } catch(e){}' +
    '}' +
    'tv.addEventListener("load", function(){' +
    '  try {' +
    '    var doc = tv.contentDocument || tv.contentWindow.document;' +
    '    var style = doc.createElement("style");' +
    '    style.textContent = adSels + "{display:none!important;visibility:hidden!important;}";' +
    '    doc.head.appendChild(style);' +
    '    setInterval(function(){ killAds(doc); }, 800);' +
    '  } catch(e) { setInterval(function(){ killAds(document); }, 800); }' +
    '});' +
    '<\/script></body></html>';

  res.set('Content-Type', 'text/html');
  res.send(html);
});

// ═══════════════════════════════════════════════════════════
// IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════
const connected    = {}; // socketId → { userId, username, avatar, serverId, channelId }
const voiceRooms   = {}; // channelId → [socketId]
const watchParties = {}; // channelId → wp state
const musicBots    = {}; // channelId → mb state
const typingTimers = {};

function getMb(cid) {
  if (!musicBots[cid]) musicBots[cid] = { queue:[], playing:false, current:null, volume:80, paused:false };
  return musicBots[cid];
}
function getWp(cid) {
  if (!watchParties[cid]) watchParties[cid] = {
    active:false, videoId:null, title:null, url:null,
    type:'youtube', playing:false, currentTime:0,
    startedBy:null, lastSync:Date.now()
  };
  return watchParties[cid];
}
function calcWpTime(wp) {
  if (!wp.playing) return wp.currentTime||0;
  return (wp.currentTime||0) + (Date.now()-wp.lastSync)/1000;
}
function getOnlineMembers(serverId) {
  return Object.values(connected)
    .filter(c => c.serverId === serverId)
    .map(c => ({ userId:c.userId, username:c.username, avatar:c.avatar, status:c.status||'online' }));
}
function getVoiceUsers(cid) {
  return (voiceRooms[cid]||[]).map(sid => {
    const c = connected[sid];
    return c ? { socketId:sid, userId:c.userId, username:c.username, avatar:c.avatar } : null;
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════
io.on('connection', socket => {

  // ── AUTH ───────────────────────────────────────────────
  socket.on('auth', async token => {
    const d = verifyTok(token);
    if (!d) { socket.emit('auth-error','Sesión inválida.'); return; }
    const user = await User.findByIdAndUpdate(d.id, { status:'online', lastSeen:new Date() }, { new:true });
    if (!user) { socket.emit('auth-error','Usuario no encontrado.'); return; }
    connected[socket.id] = { userId:user._id.toString(), username:user.username, avatar:user.avatar, status:'online', serverId:null, channelId:null };
    socket.join('user:'+user._id);
    socket.emit('auth-ok', safeUser(user));
    io.emit('user-status', { userId:user._id, status:'online' });
    // Unirse a rooms de sus servidores
    const u = await User.findById(user._id).populate('servers');
    for (const srv of u.servers) socket.join('srv:'+srv._id);
  });

  // ── JOIN SERVER ────────────────────────────────────────
  socket.on('join-server', async ({ serverId }) => {
    const me = connected[socket.id]; if (!me) return;
    const srv = await SrvModel.findById(serverId)
      .populate('channels')
      .populate('members.user','username avatar status customStatus');
    if (!srv) return;
    if (!srv.members.some(m => m.user._id.toString() === me.userId)) return;
    me.serverId = serverId;
    socket.join('srv:'+serverId);
    // Emitir miembros online a todos del server
    io.to('srv:'+serverId).emit('online-members', getOnlineMembers(serverId));
    socket.emit('server-state', { server:srv, onlineMembers: getOnlineMembers(serverId) });
  });

  // ── JOIN CHANNEL ───────────────────────────────────────
  socket.on('join-channel', async ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    if (me.channelId) socket.leave('ch:'+me.channelId);
    me.channelId = channelId;
    socket.join('ch:'+channelId);
    const msgs = await Message.find({ channel:channelId, deleted:false }).sort({ createdAt:-1 }).limit(50).lean();
    socket.emit('channel-history', { channelId, messages: msgs.reverse() });
    const wp = getWp(channelId);
    if (wp.playing) { wp.currentTime = calcWpTime(wp); wp.lastSync = Date.now(); }
    socket.emit('watch-state', { ...wp, channelId });
    socket.emit('music-state', { ...getMb(channelId), channelId });
    // Vibe, pins, focus, canvas state
    const vb = getVibe(channelId);
    socket.emit('vibe-update', { channelId, vibe: vb.vibe });
    socket.emit('pins-update', { channelId, pins: pins.get(channelId)||[] });
    const fs = focusSessions.get(channelId);
    if (fs && fs.active) socket.emit('focus-state', { ...fs, channelId });
    socket.emit('canvas-state', { channelId, strokes: getCanvas(channelId).strokes });
  });

  // ── SEND MESSAGE ───────────────────────────────────────
  socket.on('send-message', async ({ channelId, content, replyToId, attachments }) => {
    const me = connected[socket.id]; if (!me) return;
    if (!content?.trim() && !attachments?.length) return;
    clearTyping(channelId, me.userId);
    const ch = await Channel.findById(channelId);
    if (!ch) return;
    if (content?.trim().startsWith('/')) {
      await handleCmd(socket, me, ch, content.trim());
      return;
    }
    let replyPreview = null;
    if (replyToId) {
      const orig = await Message.findById(replyToId);
      replyPreview = orig?.content?.slice(0,80)||null;
    }
    const msg = await Message.create({
      channel: channelId, server: ch.server,
      author: me.userId, authorName: me.username, authorAvatar: me.avatar,
      content: content?.trim()||'',
      replyTo: replyToId||null, replyPreview,
      attachments: attachments||[],
    });
    io.to('ch:'+channelId).emit('new-message', { ...msg.toObject(), channelId });
    bumpVibe(channelId);
  });

  // ── DM ─────────────────────────────────────────────────
  socket.on('send-dm', async ({ toUserId, content, attachments }) => {
    const me = connected[socket.id]; if (!me) return;
    if (!content?.trim() && !attachments?.length) return;
    let dm = await DM.findOne({ participants:{ $all:[me.userId, toUserId] } });
    if (!dm) dm = await DM.create({ participants:[me.userId, toUserId] });
    dm.messages.push({ author:me.userId, authorName:me.username, authorAvatar:me.avatar, content:content?.trim()||'', createdAt:new Date(), attachments:attachments||[] });
    dm.lastMessage = new Date();
    await dm.save();
    const saved = dm.messages[dm.messages.length-1];
    const room = 'dm:'+[me.userId, toUserId].sort().join(':');
    io.to(room).emit('dm-message', { dmId:dm._id, message:saved, participants:dm.participants });
    socket.emit('dm-message', { dmId:dm._id, message:saved, participants:dm.participants });
  });

  socket.on('join-dm', ({ withUserId }) => {
    const me = connected[socket.id]; if (!me) return;
    socket.join('dm:'+[me.userId, withUserId].sort().join(':'));
  });

  // ── TYPING ─────────────────────────────────────────────
  socket.on('typing-start', ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    socket.to('ch:'+channelId).emit('typing', { userId:me.userId, username:me.username, channelId });
    const key = channelId+':'+me.userId;
    clearTimeout(typingTimers[key]);
    typingTimers[key] = setTimeout(() => io.to('ch:'+channelId).emit('typing-stop',{ userId:me.userId, channelId }), 4000);
  });
  socket.on('typing-stop', ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    clearTyping(channelId, me.userId);
    socket.to('ch:'+channelId).emit('typing-stop',{ userId:me.userId, channelId });
  });
  function clearTyping(cid, uid) {
    const k = cid+':'+uid; clearTimeout(typingTimers[k]); delete typingTimers[k];
  }

  // ── REACTIONS ──────────────────────────────────────────
  socket.on('react', async ({ messageId, emoji, channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    const msg = await Message.findById(messageId);
    if (!msg) return;
    const ex = msg.reactions.find(r => r.emoji===emoji);
    if (ex) {
      const i = ex.users.map(String).indexOf(me.userId);
      if (i>=0) ex.users.splice(i,1); else ex.users.push(me.userId);
    } else msg.reactions.push({ emoji, users:[me.userId] });
    await msg.save();
    io.to('ch:'+channelId).emit('reaction-update',{ messageId, reactions:msg.reactions });
  });

  // ── STATUS ─────────────────────────────────────────────
  socket.on('set-status', async ({ status }) => {
    const me = connected[socket.id]; if (!me) return;
    me.status = status;
    await User.findByIdAndUpdate(me.userId, { status });
    io.emit('user-status',{ userId:me.userId, status });
    if (me.serverId) io.to('srv:'+me.serverId).emit('online-members', getOnlineMembers(me.serverId));
  });

  // ── WATCH PARTY ────────────────────────────────────────
  socket.on('watch-start', async ({ channelId, url, type }) => {
    const me = connected[socket.id]; if (!me) return;
    const wp = getWp(channelId);
    if (type==='iframe') {
      Object.assign(wp, { active:true, type:'iframe', url, videoId:null, title:'⚽ Fútbol Libre', playing:true, currentTime:0, startedBy:me.username, lastSync:Date.now() });
    } else {
      const vid = extractVideoId(url);
      if (!vid) { socket.emit('watch-error','Link inválido.'); return; }
      const info = await getVideoInfo(vid);
      Object.assign(wp, { active:true, type:'youtube', videoId:vid, url:null, title:info.title, playing:false, currentTime:0, startedBy:me.username, lastSync:Date.now() });
      await Message.create({ channel:channelId, authorName:'🎬 Watch Party', content:`**${me.username}** inició Watch Party: ${info.title}`, type:'bot' });
    }
    io.to('ch:'+channelId).emit('watch-state',{ ...wp, channelId });
  });

  socket.on('watch-play', ({ channelId, currentTime }) => {
    const wp = getWp(channelId);
    wp.playing=true; wp.currentTime=currentTime||0; wp.lastSync=Date.now();
    // Broadcast a TODOS incluyendo al que lo mandó
    io.to('ch:'+channelId).emit('watch-cmd',{ action:'play', currentTime:wp.currentTime, ts:wp.lastSync, channelId });
  });
  socket.on('watch-pause', ({ channelId, currentTime }) => {
    const wp = getWp(channelId);
    wp.playing=false; wp.currentTime=currentTime||0; wp.lastSync=Date.now();
    // Broadcast a TODOS para que todos pausen
    io.to('ch:'+channelId).emit('watch-cmd',{ action:'pause', currentTime:wp.currentTime, ts:wp.lastSync, channelId });
  });
  socket.on('watch-sync-request', ({ channelId }) => {
    const wp = getWp(channelId);
    if (wp.playing) { wp.currentTime=calcWpTime(wp); wp.lastSync=Date.now(); }
    io.to('ch:'+channelId).emit('watch-cmd',{ action:wp.playing?'sync-play':'sync-pause', currentTime:wp.currentTime, ts:wp.lastSync, channelId });
  });
  socket.on('watch-stop', ({ channelId }) => {
    const wp = getWp(channelId);
    Object.assign(wp, { active:false, videoId:null, url:null, playing:false, currentTime:0, type:'youtube' });
    io.to('ch:'+channelId).emit('watch-state',{ ...wp, channelId });
  });

  // ── VOICE ──────────────────────────────────────────────
  socket.on('join-voice', ({ channelId }) => {
    const me = connected[socket.id]; if (!me) return;
    if (!voiceRooms[channelId]) voiceRooms[channelId]=[];
    voiceRooms[channelId] = voiceRooms[channelId].filter(id=>id!==socket.id);
    const existing = [...voiceRooms[channelId]];
    socket.emit('existing-peers', existing);
    existing.forEach(p => io.to(p).emit('peer-joined',{ peerId:socket.id, username:me.username, avatar:me.avatar }));
    voiceRooms[channelId].push(socket.id);
    socket.join('voice:'+channelId);
    socket.currentVoiceChannel = channelId;
    if (me.serverId) io.to('srv:'+me.serverId).emit('voice-users',{ channelId, users:getVoiceUsers(channelId) });
    socket.emit('voice-joined',{ channelId });
  });
  socket.on('leave-voice',     ()              => leaveVoice(socket));
  socket.on('offer',           ({ to, offer }) => io.to(to).emit('offer',         { from:socket.id, offer }));
  socket.on('answer',          ({ to, answer })=> io.to(to).emit('answer',        { from:socket.id, answer }));
  socket.on('ice-candidate',   ({ to, candidate })=> io.to(to).emit('ice-candidate',{ from:socket.id, candidate }));
  socket.on('voice-mute',      ({ muted })     => {
    const me=connected[socket.id]; if (!me) return;
    if (socket.currentVoiceChannel) io.to('voice:'+socket.currentVoiceChannel).emit('peer-mute',{ peerId:socket.id, muted });
  });

  // ── PIN ────────────────────────────────────────────────
  socket.on('pin-message', async ({messageId, channelId}) => {
    const me = connected[socket.id]; if (!me) return;
    const msg = await Message.findById(messageId); if (!msg) return;
    if (!pins.has(channelId)) pins.set(channelId, []);
    const cp = pins.get(channelId);
    if (cp.find(p => p.msgId === messageId)) return;
    cp.unshift({ msgId:messageId, content:(msg.content||'').slice(0,120), authorName:msg.authorName, pinnedBy:me.username, pinnedAt:new Date() });
    if (cp.length > 10) cp.pop();
    io.to('ch:'+channelId).emit('pins-update', { channelId, pins: cp });
  });
  socket.on('unpin-message', ({msgId, channelId}) => {
    if (!pins.has(channelId)) return;
    pins.set(channelId, pins.get(channelId).filter(p => p.msgId !== msgId));
    io.to('ch:'+channelId).emit('pins-update', { channelId, pins: pins.get(channelId) });
  });

  // ── POLL ───────────────────────────────────────────────
  socket.on('poll-vote', ({pollId, optionIdx}) => {
    const me = connected[socket.id]; if (!me) return;
    const poll = polls.get(pollId); if (!poll) return;
    poll.options.forEach(o => { const i = o.votes.indexOf(me.userId); if (i >= 0) o.votes.splice(i,1); });
    if (optionIdx >= 0 && optionIdx < poll.options.length) poll.options[optionIdx].votes.push(me.userId);
    const total = poll.options.reduce((s,o) => s + o.votes.length, 0);
    io.to('ch:'+poll.channelId).emit('poll-update', {
      pollId,
      options: poll.options.map(o => ({ text:o.text, count:o.votes.length, pct: total ? Math.round(o.votes.length/total*100) : 0, voted: o.votes.includes(me.userId) }))
    });
  });

  // ── CANVAS ─────────────────────────────────────────────
  socket.on('canvas-stroke', ({channelId, stroke}) => {
    const me = connected[socket.id]; if (!me) return;
    const cv = getCanvas(channelId);
    cv.strokes.push({ ...stroke, user: me.username });
    if (cv.strokes.length > 5000) cv.strokes = cv.strokes.slice(-3000);
    socket.to('ch:'+channelId).emit('canvas-stroke', { stroke: { ...stroke, user:me.username }, channelId });
    bumpVibe(channelId);
  });
  socket.on('canvas-state-req', ({channelId}) => {
    socket.emit('canvas-state', { channelId, strokes: getCanvas(channelId).strokes });
  });
  socket.on('canvas-clear', ({channelId}) => {
    const me = connected[socket.id]; if (!me) return;
    getCanvas(channelId).strokes = [];
    io.to('ch:'+channelId).emit('canvas-cleared', { channelId, by: me.username });
  });

  // ── FOCUS / POMODORO ───────────────────────────────────
  socket.on('focus-start', ({channelId, minutes, label}) => {
    const me = connected[socket.id]; if (!me) return;
    const mins = Math.min(Math.max(parseInt(minutes)||25, 1), 120);
    const session = { active:true, startedBy:me.username, endAt:Date.now()+mins*60000, label:label||'🎯 Focus', minutes:mins };
    focusSessions.set(channelId, session);
    io.to('ch:'+channelId).emit('focus-state', { ...session, channelId });
    setTimeout(() => {
      const cur = focusSessions.get(channelId);
      if (cur && cur.endAt === session.endAt) {
        focusSessions.set(channelId, { active:false });
        io.to('ch:'+channelId).emit('focus-end', { channelId, label: session.label });
      }
    }, mins * 60000);
  });
  socket.on('focus-stop', ({channelId}) => {
    focusSessions.set(channelId, { active:false });
    io.to('ch:'+channelId).emit('focus-end', { channelId });
  });

  // ── PARTYDO (host-controlled shared screen) ───────────
  socket.on('partydo-start', ({channelId}) => {
    const me = connected[socket.id]; if (!me) return;
    partydoHosts[channelId] = socket.id;
    const wp = getWp(channelId);
    Object.assign(wp, { active:true, type:'partydo', url:'/partydo-view', videoId:null, title:'⚽ Fútbol en Vivo', playing:true, currentTime:0, startedBy:me.username, lastSync:Date.now() });
    io.to('ch:'+channelId).emit('watch-state', { ...wp, channelId, partydoHost:socket.id });
  });
  socket.on('partydo-stop', ({channelId}) => {
    const me = connected[socket.id]; if (!me) return;
    if (partydoHosts[channelId] !== socket.id) return;
    delete partydoHosts[channelId];
    const wp = getWp(channelId);
    Object.assign(wp, { active:false, type:'youtube', url:null, videoId:null, playing:false });
    io.to('ch:'+channelId).emit('watch-state', { ...wp, channelId });
  });

    // ── VOICE PING (keepalive) ────────────────────────────
  socket.on('voice-ping', ({channelId}) => {
    // Just a keepalive — socket is alive, no-op
  });

  // ── osu!mania handlers ─────────────────────────────────
  socket.on('mania-score', ({ serverId, score, accuracy, maxCombo, rank }) => {
    if (!me || !serverId) return;
    const lb = getManiaLB(String(serverId));
    // Remove previous score for this user
    lb.scores = lb.scores.filter(s => String(s.userId) !== String(me._id));
    // Add new score
    lb.scores.push({
      userId: String(me._id),
      username: me.username,
      avatar: me.avatar || null,
      score: Number(score) || 0,
      accuracy: Number(accuracy) || 0,
      maxCombo: Number(maxCombo) || 0,
      rank: rank || 'D',
      ts: Date.now(),
    });
    // Sort by score desc
    lb.scores.sort((a, b) => b.score - a.score);
    // Keep top 50
    if (lb.scores.length > 50) lb.scores = lb.scores.slice(0, 50);
    // Broadcast updated leaderboard to everyone in this server
    io.to('srv:' + serverId).emit('mania-leaderboard', {
      serverId,
      scores: lb.scores,
    });
  });

  socket.on('mania-get-lb', ({ serverId }) => {
    if (!serverId) return;
    const lb = getManiaLB(String(serverId));
    socket.emit('mania-leaderboard', { serverId, scores: lb.scores });
  });

  // ── DISCONNECT ─────────────────────────────────────────
  socket.on('disconnect', async () => {
    const me = connected[socket.id];
    leaveVoice(socket);
    // Limpiar partydo host si era el host
    for (const [cid, sid] of Object.entries(partydoHosts)) {
      if (sid === socket.id) delete partydoHosts[cid];
    }
    if (me) {
      await User.findByIdAndUpdate(me.userId, { status:'offline', lastSeen:new Date() });
      io.emit('user-status',{ userId:me.userId, status:'offline' });
      if (me.serverId) io.to('srv:'+me.serverId).emit('online-members', getOnlineMembers(me.serverId));
    }
    delete connected[socket.id];
  });

  function leaveVoice(s) {
    const ch = s.currentVoiceChannel;
    if (!ch || !voiceRooms[ch]) return;
    voiceRooms[ch] = voiceRooms[ch].filter(id=>id!==s.id);
    io.to('voice:'+ch).emit('peer-left', s.id);
    s.leave('voice:'+ch);
    s.currentVoiceChannel = null;
    const me = connected[s.id];
    if (me?.serverId) io.to('srv:'+me.serverId).emit('voice-users',{ channelId:ch, users:getVoiceUsers(ch) });
  }
});

// ═══════════════════════════════════════════════════════════
// BOT COMMANDS
// ═══════════════════════════════════════════════════════════
async function handleCmd(socket, me, channel, text) {
  const cid   = channel._id.toString();
  const parts = text.split(' ');
  const cmd   = parts[0].toLowerCase();
  const args  = parts.slice(1).join(' ');
  const mb    = getMb(cid);
  const emitMb = () => io.to('ch:'+cid).emit('music-state',{ ...mb, channelId:cid });
  const botMsg = async t => {
    const m = await Message.create({ channel:cid, server:channel.server, authorName:'🤖 KoldBot', content:t, type:'bot' });
    io.to('ch:'+cid).emit('new-message',{ ...m.toObject(), channelId:cid });
  };
  // Emitir comando del usuario
  const um = await Message.create({ channel:cid, server:channel.server, author:me.userId, authorName:me.username, authorAvatar:me.avatar, content:text });
  io.to('ch:'+cid).emit('new-message',{ ...um.toObject(), channelId:cid });

  switch(cmd) {
    case '/play': {
      if (!args) { await botMsg('❄️ `/play nombre canción`'); return; }
      await botMsg(`🔍 Buscando **${args}**...`);
      const r = await searchYT(args);
      if (!r.length) { await botMsg('❌ Sin resultados.'); return; }
      const song = { ...r[0], requestedBy:me.username };
      mb.queue.push(song);
      if (!mb.playing) await playNext(mb, cid, botMsg);
      else { await botMsg(`✅ **${song.title}** en cola (#${mb.queue.length})`); emitMb(); }
      break;
    }
    case '/watch': {
      if (!args) { await botMsg('🎬 `/watch URL_YouTube`'); return; }
      const vid = extractVideoId(args);
      if (!vid) { await botMsg('❌ Link inválido.'); return; }
      const info = await getVideoInfo(vid);
      const wp = getWp(cid);
      Object.assign(wp, { active:true, type:'youtube', videoId:vid, title:info.title, playing:false, currentTime:0, startedBy:me.username, lastSync:Date.now() });
      io.to('ch:'+cid).emit('watch-state',{ ...wp, channelId:cid });
      await botMsg(`🎬 Watch Party: **${info.title}**`);
      break;
    }
    case '/partydo': {
      // Partydo: host-controlled, shared iframe with adblock
      partydoHosts[cid] = socket.id;
      const wp = getWp(cid);
      Object.assign(wp, { active:true, type:'partydo', url:'/partydo-view', videoId:null, title:'⚽ Fútbol en Vivo', playing:true, currentTime:0, startedBy:me.username, lastSync:Date.now() });
      io.to('ch:'+cid).emit('watch-state', { ...wp, channelId:cid, partydoHost:socket.id });
      await botMsg(`⚽ **${me.username}** abrió el Fútbol en Vivo. Solo él puede controlarlo. ¡Usa /stop para cerrar!`);
      break;
    }
    case '/skip':   { if(!mb.current){await botMsg('❌ Nada sonando.');return;} await botMsg('⏭️ Saltado.'); await playNext(mb,cid,botMsg); break; }
    case '/stop':   { mb.queue=[];mb.playing=false;mb.current=null;mb.paused=false;emitMb();io.to('ch:'+cid).emit('music-stop',{channelId:cid});await botMsg('⏹️ Detenido.'); break; }
    case '/pause':  { if(!mb.playing){await botMsg('❌ Sin música.');return;} mb.paused=true;emitMb();io.to('ch:'+cid).emit('music-pause',{channelId:cid});await botMsg('⏸️ Pausada.'); break; }
    case '/resume': { if(!mb.paused){await botMsg('❌ No pausada.');return;} mb.paused=false;emitMb();io.to('ch:'+cid).emit('music-resume',{channelId:cid});await botMsg('▶️ Reanudada.'); break; }
    case '/volume': { const v=parseInt(args);if(isNaN(v)||v<0||v>100){await botMsg('❌ `/volume 0-100`');return;} mb.volume=v;emitMb();io.to('ch:'+cid).emit('music-volume',{v,channelId:cid});await botMsg(`🔊 ${v}%`); break; }
    case '/queue':  { if(!mb.current&&!mb.queue.length){await botMsg('📋 Cola vacía.');return;} let t='📋 **Cola:**\n';if(mb.current)t+=`▶️ ${mb.current.title}\n`;mb.queue.forEach((s,i)=>t+=`${i+1}. ${s.title}\n`);await botMsg(t); break; }
    case '/np':     { if(!mb.current){await botMsg('❌ Nada.');return;} await botMsg(`🎵 **${mb.current.title}** — ${mb.current.requestedBy}`); break; }
    // ── 🎲 ROLL ─────────────────────────────────────────
    case '/roll': {
      const faces = Math.min(Math.max(parseInt(args)||6, 2), 1000);
      const result = Math.floor(Math.random() * faces) + 1;
      await botMsg(`🎲 **${me.username}** tiró un d${faces} → **${result}**`);
      io.to('ch:'+cid).emit('dice-roll', { user:me.username, faces, result, channelId:cid });
      break;
    }

    // ── 📊 POLL ──────────────────────────────────────────
    case '/poll': {
      // /poll "pregunta" opcion1|opcion2|opcion3
      const pMatch = args.match(/^"([^"]+)"\s+(.+)$/);
      if (!pMatch) { await botMsg('❌ Uso: `/poll "Pregunta?" opcion1|opcion2|opcion3`'); break; }
      const question = pMatch[1];
      const opts = pMatch[2].split('|').map(s=>s.trim()).filter(Boolean).slice(0,5);
      if (opts.length < 2) { await botMsg('❌ Mínimo 2 opciones.'); break; }
      const pollId = nanoid(8);
      polls.set(pollId, { question, options:opts.map(t=>({text:t,votes:[]})), createdBy:me.username, channelId:cid });
      const m2 = await Message.create({ channel:cid, server:channel.server, authorName:'📊 Encuesta', content:`__POLL__${pollId}`, type:'bot' });
      const pollData = { pollId, question, options:opts.map(t=>({text:t,count:0,pct:0,voted:false})) };
      io.to('ch:'+cid).emit('new-message', { ...m2.toObject(), channelId:cid, pollData });
      break;
    }

    // ── 🌐 TRANSLATE ─────────────────────────────────────
    case '/translate': {
      const langMap = {es:'es',en:'en',fr:'fr',de:'de',it:'it',pt:'pt',ja:'ja',ko:'ko',zh:'zh',ar:'ar',ru:'ru'};
      const langArg = parts[1]?.toLowerCase();
      const targetCode = langMap[langArg] || 'en';
      const textToTr = parts.slice(langArg && langMap[langArg] ? 2 : 1).join(' ');
      if (!textToTr) { await botMsg('❌ `/translate en Hola mundo`'); break; }
      const translated = await translateText(textToTr, targetCode);
      await botMsg(`🌐 [${targetCode.toUpperCase()}] ${translated}`);
      break;
    }

    // ── 🔔 ALARM ─────────────────────────────────────────
    case '/alarm': {
      const timeArg = parts[1]; const alLabel = parts.slice(2).join(' ') || '⏰ Alarma';
      let triggerAt;
      if (timeArg?.includes(':')) {
        const [h,m] = timeArg.split(':').map(Number);
        const t = new Date(); t.setHours(h,m,0,0);
        if (t <= new Date()) t.setDate(t.getDate()+1);
        triggerAt = t.getTime();
      } else {
        const mins = parseInt(timeArg);
        if (isNaN(mins)||mins<1) { await botMsg('❌ `/alarm 20:00 Partido` o `/alarm 30 Descanso`'); break; }
        triggerAt = Date.now() + mins*60000;
      }
      const alId = nanoid(6);
      alarms.set(alId, { channelId:cid, label:alLabel, triggerAt, createdBy:me.username });
      const diff = Math.round((triggerAt - Date.now())/60000);
      await botMsg(`🔔 Alarma **"${alLabel}"** en ${diff} min (${new Date(triggerAt).toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'})})`);
      break;
    }

    // ── 🎯 FOCUS ─────────────────────────────────────────
    case '/focus': {
      if (args === 'stop') { socket.emit('focus-stop', {channelId:cid}); focusSessions.set(cid,{active:false}); io.to('ch:'+cid).emit('focus-end',{channelId:cid}); await botMsg('🎯 Sesión focus terminada.'); break; }
      const fMins = Math.min(Math.max(parseInt(args)||25,1),120);
      const fLabel = args.replace(/^\d+\s*/,'').trim() || '🎯 Focus';
      const fSession = { active:true, startedBy:me.username, endAt:Date.now()+fMins*60000, label:fLabel, minutes:fMins };
      focusSessions.set(cid, fSession);
      io.to('ch:'+cid).emit('focus-state', { ...fSession, channelId:cid });
      await botMsg(`🎯 **Sesión Focus** ${fMins} min iniciada por **${me.username}**. ¡A concentrarse!`);
      setTimeout(() => {
        const cur = focusSessions.get(cid);
        if (cur && cur.endAt === fSession.endAt) { focusSessions.set(cid,{active:false}); io.to('ch:'+cid).emit('focus-end',{channelId:cid,label:fLabel}); }
      }, fMins*60000);
      break;
    }

    // ── 🎨 DRAW ──────────────────────────────────────────
    case '/draw': {
      io.to('ch:'+cid).emit('open-canvas', { channelId:cid });
      await botMsg(`🎨 **${me.username}** abrió la pizarra colaborativa. ¡Todos pueden dibujar!`);
      break;
    }

    // ── 💾 SNAPSHOT ──────────────────────────────────────
    case '/snapshot': {
      await botMsg(`💾 Descarga el historial: [📥 snapshot-${cid.slice(-6)}.html](/api/channels/${cid}/snapshot)`);
      break;
    }

    // ── 📌 PIN ───────────────────────────────────────────
    case '/pin': {
      await botMsg('📌 Haz clic derecho (o mantén pulsado en móvil) en un mensaje y elige **Fijar**.');
      break;
    }

    case '/skip':   { if(!mb.current){await botMsg('❌ Nada sonando.');return;} await botMsg('⏭️ Saltado.'); await playNext(mb,cid,botMsg); break; }
    case '/stop':   { mb.queue=[];mb.playing=false;mb.current=null;mb.paused=false;emitMb();io.to('ch:'+cid).emit('music-stop',{channelId:cid});await botMsg('⏹️ Detenido.'); break; }
    case '/pause':  { if(!mb.playing){await botMsg('❌ Sin música.');return;} mb.paused=true;emitMb();io.to('ch:'+cid).emit('music-pause',{channelId:cid});await botMsg('⏸️ Pausada.'); break; }
    case '/resume': { if(!mb.paused){await botMsg('❌ No pausada.');return;} mb.paused=false;emitMb();io.to('ch:'+cid).emit('music-resume',{channelId:cid});await botMsg('▶️ Reanudada.'); break; }
    case '/volume': { const v=parseInt(args);if(isNaN(v)||v<0||v>100){await botMsg('❌ `/volume 0-100`');return;} mb.volume=v;emitMb();io.to('ch:'+cid).emit('music-volume',{v,channelId:cid});await botMsg(`🔊 ${v}%`); break; }
    case '/queue':  { if(!mb.current&&!mb.queue.length){await botMsg('📋 Cola vacía.');return;} let qt='📋 **Cola:**\n';if(mb.current)qt+=`▶️ ${mb.current.title}\n`;mb.queue.forEach((s,i)=>qt+=`${i+1}. ${s.title}\n`);await botMsg(qt); break; }
    case '/np':     { if(!mb.current){await botMsg('❌ Nada.');return;} await botMsg(`🎵 **${mb.current.title}** — ${mb.current.requestedBy}`); break; }
    case '/help':   { await botMsg('🤖 **Comandos disponibles:**\n🎵 `/play` `/watch` `/partydo` `/skip` `/stop` `/pause` `/resume` `/volume` `/queue` `/np`\n🎮 `/roll [caras]` `/poll "pregunta" op1|op2` `/alarm HH:MM label` `/focus [mins]`\n🛠️ `/translate [lang] texto` `/draw` `/snapshot` `/pin`'); break; }
    default:        { await botMsg('❓ Comando desconocido. Usa `/help`.'); }
  }
}

async function playNext(mb, cid, botMsg) {
  if (!mb.queue.length) {
    mb.playing=false;mb.current=null;
    io.to('ch:'+cid).emit('music-state',{...mb,channelId:cid});
    io.to('ch:'+cid).emit('music-ended',{channelId:cid});
    if (botMsg) await botMsg('✅ Cola terminada.');
    return;
  }
  mb.current=mb.queue.shift();mb.playing=true;mb.paused=false;
  io.to('ch:'+cid).emit('music-state',{...mb,channelId:cid});
  io.to('ch:'+cid).emit('music-play',{...mb.current,channelId:cid});
  if (botMsg) await botMsg(`🎵 **${mb.current.title}** — ${mb.current.requestedBy}`);
}

// ═══════════════════════════════════════════════════════════
// YOUTUBE HELPERS
// ═══════════════════════════════════════════════════════════
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) { const m = url.match(p); if (m) return m[1]; }
  return null;
}
async function getVideoInfo(videoId) {
  return new Promise(resolve => {
    https.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve({title:JSON.parse(d).title});}catch{resolve({title:'Video'});} });
    }).on('error',()=>resolve({title:'Video'}));
  });
}
async function searchYT(query) {
  return new Promise(resolve => {
    const q = encodeURIComponent(query);
    https.get(`https://www.youtube.com/results?search_query=${q}`,{headers:{'User-Agent':'Mozilla/5.0'}}, res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try {
          const ids    = [...new Set((d.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g)||[]).map(m=>m.slice(11,-1)))].slice(0,5);
          const titles = (d.match(/"title":\{"runs":\[{"text":"([^"]+)"/g)||[]).map(t=>{const m=t.match(/"text":"([^"]+)"/);return m?m[1]:'Sin título';}).slice(0,5);
          resolve(ids.map((id,i)=>({ videoId:id, title:titles[i]||`Video ${i+1}`, thumbnail:`https://img.youtube.com/vi/${id}/mqdefault.jpg` })));
        } catch { resolve([]); }
      });
    }).on('error',()=>resolve([]));
  });
}

server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════╗`);
  console.log(`║  DISKOLD v4.2  by Kold       ║`);
  console.log(`║  :${PORT}                      ║`);
  console.log(`╚══════════════════════════════╝\n`);
});
