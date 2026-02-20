/**
 * DISKOLD v3.3 — Chat + Voz + Música per-canal + Watch Party + /partydo
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

// ── Canales ───────────────────────────────────────────────
const CHANNELS = {
  'kbros': { password: 'moscosos' },
  'vcby':  { password: 'akatsuki' },
};
const VOICE_ROOMS = {
  'kbros': { password: 'moscosos' },
  'vcby':  { password: 'akatsuki' },
};

// ── DB ────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'users.json');
function readDB()   { try { return JSON.parse(fs.readFileSync(DB_PATH,'utf8')); } catch(e) { return {users:[]}; } }
function writeDB(d) { fs.writeFileSync(DB_PATH, JSON.stringify(d,null,2)); }
function hashPwd(p) { return crypto.createHash('sha256').update(p+'diskold_salt_kold').digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }
const sessions = {};

app.post('/api/register', (req,res) => {
  const {username,password,avatar}=req.body;
  if(!username||!password) return res.json({ok:false,error:'Faltan datos.'});
  if(username.length<2||username.length>20) return res.json({ok:false,error:'Nombre: 2-20 caracteres.'});
  if(password.length<4) return res.json({ok:false,error:'Contraseña muy corta.'});
  const db=readDB();
  if(db.users.find(u=>u.username.toLowerCase()===username.toLowerCase()))
    return res.json({ok:false,error:'Usuario ya existe.'});
  const user={id:crypto.randomUUID(),username,password:hashPwd(password),avatar:avatar||null,createdAt:new Date().toISOString()};
  db.users.push(user); writeDB(db);
  const token=genToken(); sessions[token]={username,avatar:user.avatar,id:user.id};
  res.json({ok:true,token,username,avatar:user.avatar});
});

app.post('/api/login', (req,res) => {
  const {username,password}=req.body;
  const db=readDB();
  const user=db.users.find(u=>u.username.toLowerCase()===username.toLowerCase());
  if(!user) return res.json({ok:false,error:'Usuario no encontrado.'});
  if(user.password!==hashPwd(password)) return res.json({ok:false,error:'Contraseña incorrecta.'});
  const token=genToken(); sessions[token]={username:user.username,avatar:user.avatar,id:user.id};
  res.json({ok:true,token,username:user.username,avatar:user.avatar});
});

app.post('/api/update-avatar', (req,res) => {
  const {token,avatar}=req.body;
  if(!token||!sessions[token]) return res.json({ok:false,error:'No autenticado.'});
  const s=sessions[token]; const db=readDB();
  const user=db.users.find(u=>u.username===s.username);
  if(!user) return res.json({ok:false,error:'No encontrado.'});
  user.avatar=avatar; writeDB(db); sessions[token].avatar=avatar;
  io.emit('avatar-updated',{username:s.username,avatar});
  res.json({ok:true});
});

app.post('/api/verify', (req,res) => {
  const {token}=req.body;
  if(token&&sessions[token]) res.json({ok:true,...sessions[token]});
  else res.json({ok:false});
});

// ── Watch Party por canal ─────────────────────────────────
const watchParties = {};
Object.keys(CHANNELS).forEach(ch => {
  watchParties[ch] = { active:false, videoId:null, title:null, url:null, type:'youtube',
                       playing:false, currentTime:0, startedBy:null, lastSync:Date.now() };
});
function getWp(ch) { return watchParties[ch] || watchParties[Object.keys(CHANNELS)[0]]; }
function calcCurrentTime(wp) {
  if(!wp.playing) return wp.currentTime||0;
  return (wp.currentTime||0)+(Date.now()-wp.lastSync)/1000;
}
function extractVideoId(url) {
  const pp=[/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,/^([a-zA-Z0-9_-]{11})$/];
  for(const p of pp){const m=url.match(p);if(m)return m[1];}
  return null;
}
async function getVideoInfo(videoId) {
  return new Promise(resolve=>{
    https.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{try{const j=JSON.parse(d);resolve({title:j.title});}catch(e){resolve({title:'Video de YouTube'});}});
    }).on('error',()=>resolve({title:'Video de YouTube'}));
  });
}

// ── Music Bot — UNO POR CANAL ─────────────────────────────
const musicBots = {};
Object.keys(CHANNELS).forEach(ch => {
  musicBots[ch] = { queue:[], playing:false, current:null, volume:80, paused:false };
});
function getMb(ch) { return musicBots[ch] || musicBots[Object.keys(CHANNELS)[0]]; }

async function searchYouTube(query) {
  return new Promise(resolve=>{
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

app.get('/api/search',async(req,res)=>{const r=await searchYouTube(req.query.q||'');res.json({results:r});});

// ── Socket.io ─────────────────────────────────────────────
const users      = {};
const voiceRooms = {};

io.on('connection', socket => {

  socket.on('auth', token => {
    const s=sessions[token];
    if(!s){socket.emit('auth-error','Sesión inválida.');return;}
    const defaultCh=Object.keys(CHANNELS)[0];
    users[socket.id]={username:s.username, avatar:s.avatar, channel:defaultCh};
    socket.join('ch:'+defaultCh);
    io.emit('user-list',buildUserList());
    socket.to('ch:'+defaultCh).emit('chat-message',{system:true,text:`${s.username} entró a Diskold`,time:now()});
    socket.emit('auth-ok',s);
    // Enviar estado de música del canal por defecto
    socket.emit('music-state',{...getMb(defaultCh), channel:defaultCh});
    // Enviar watch party del canal
    const wp=getWp(defaultCh);
    if(wp.playing){wp.currentTime=calcCurrentTime(wp);wp.lastSync=Date.now();}
    socket.emit('watch-state',{...wp,channel:defaultCh});
    // Confirmar canal
    socket.emit('channel-joined',{channel:defaultCh});
  });

  socket.on('join-channel',({channel})=>{
    if(!users[socket.id]||!CHANNELS[channel]) return;
    const prev=users[socket.id].channel;
    if(prev===channel){
      // Reenviar estado actual aunque ya esté en el canal (fix bug Android)
      socket.emit('channel-joined',{channel});
      return;
    }
    socket.leave('ch:'+prev);
    socket.to('ch:'+prev).emit('chat-message',{system:true,text:`${users[socket.id].username} salió del canal`,time:now()});
    users[socket.id].channel=channel;
    socket.join('ch:'+channel);
    socket.to('ch:'+channel).emit('chat-message',{system:true,text:`${users[socket.id].username} entró al canal`,time:now()});
    io.emit('user-list',buildUserList());
    // Enviar estado del canal nuevo
    socket.emit('music-state',{...getMb(channel),channel});
    const wp=getWp(channel);
    if(wp.playing){wp.currentTime=calcCurrentTime(wp);wp.lastSync=Date.now();}
    socket.emit('watch-state',{...wp,channel});
    socket.emit('channel-joined',{channel});
  });

  socket.on('chat-message',text=>{
    if(!users[socket.id]) return;
    const {username,avatar,channel}=users[socket.id];
    if(text.startsWith('/')){handleBotCommand(socket,username,channel,text);return;}
    io.to('ch:'+channel).emit('chat-message',{user:username,avatar,text,time:now(),channel});
  });

  socket.on('bot-command',data=>{
    if(!users[socket.id]) return;
    handleBotCommand(socket,users[socket.id].username,users[socket.id].channel,data.command);
  });

  // ── Watch Party ────────────────────────────────────────
  socket.on('watch-start',async({url, type})=>{
    if(!users[socket.id]) return;
    const channel=users[socket.id].channel;
    const wp=getWp(channel);

    if(type==='iframe'){
      // Fútbol libre u otro iframe — no necesita videoId
      wp.active=true; wp.type='iframe'; wp.url=url; wp.videoId=null; wp.title='Fútbol Libre';
      wp.playing=true; wp.currentTime=0;
      wp.startedBy=users[socket.id].username; wp.lastSync=Date.now();
      io.to('ch:'+channel).emit('watch-state',{...wp,channel});
      io.to('ch:'+channel).emit('chat-message',{bot:true,user:'⚽ Party',
        text:`**${users[socket.id].username}** abrió Fútbol Libre Watch Party`,time:now(),channel});
      return;
    }

    // YouTube
    const videoId=extractVideoId(url);
    if(!videoId){socket.emit('watch-error','Link de YouTube inválido.');return;}
    const info=await getVideoInfo(videoId);
    wp.active=true; wp.type='youtube'; wp.videoId=videoId; wp.url=null; wp.title=info.title;
    wp.playing=false; wp.currentTime=0;
    wp.startedBy=users[socket.id].username; wp.lastSync=Date.now();
    io.to('ch:'+channel).emit('watch-state',{...wp,channel});
    io.to('ch:'+channel).emit('chat-message',{bot:true,user:'🎬 Watch Party',
      text:`**${users[socket.id].username}** inició:\n🎥 ${info.title}`,time:now(),channel});
  });

  socket.on('watch-play',({currentTime,channel:ch})=>{
    if(!users[socket.id]) return;
    const channel=ch||users[socket.id].channel;
    const wp=getWp(channel);
    wp.playing=true; wp.currentTime=currentTime||0; wp.lastSync=Date.now();
    io.to('ch:'+channel).emit('watch-cmd',{action:'play',currentTime:wp.currentTime,ts:wp.lastSync});
  });

  socket.on('watch-pause',({currentTime,channel:ch})=>{
    if(!users[socket.id]) return;
    const channel=ch||users[socket.id].channel;
    const wp=getWp(channel);
    wp.playing=false; wp.currentTime=currentTime||0; wp.lastSync=Date.now();
    io.to('ch:'+channel).emit('watch-cmd',{action:'pause',currentTime:wp.currentTime,ts:wp.lastSync});
  });

  socket.on('watch-sync-request',({channel:ch}={})=>{
    const channel=(ch||users[socket.id]?.channel)||Object.keys(CHANNELS)[0];
    const wp=getWp(channel);
    if(wp.playing){wp.currentTime=calcCurrentTime(wp);wp.lastSync=Date.now();}
    io.to('ch:'+channel).emit('watch-cmd',{
      action:wp.playing?'sync-play':'sync-pause',
      currentTime:wp.currentTime, ts:wp.lastSync
    });
  });

  socket.on('watch-stop',({channel:ch}={})=>{
    if(!users[socket.id]) return;
    const channel=ch||users[socket.id].channel;
    const wp=getWp(channel);
    wp.active=false;wp.videoId=null;wp.url=null;wp.playing=false;wp.currentTime=0;wp.type='youtube';
    io.to('ch:'+channel).emit('watch-state',{...wp,channel});
    io.to('ch:'+channel).emit('chat-message',{bot:true,user:'🎬 Watch Party',
      text:`**${users[socket.id].username}** terminó el Watch Party.`,time:now(),channel});
  });

  // ── WebRTC ─────────────────────────────────────────────
  socket.on('join-voice',roomId=>{
    if(!users[socket.id]||!VOICE_ROOMS[roomId]) return;
    if(!voiceRooms[roomId]) voiceRooms[roomId]=[];
    // Quitar si ya estaba (reconexión)
    voiceRooms[roomId]=voiceRooms[roomId].filter(id=>id!==socket.id);
    const existing=voiceRooms[roomId];
    socket.emit('existing-peers',[...existing]);
    existing.forEach(p=>io.to(p).emit('peer-joined',{peerId:socket.id,username:users[socket.id].username}));
    voiceRooms[roomId].push(socket.id);
    socket.join('voice:'+roomId);
    socket.currentVoiceRoom=roomId;
    emitVoiceUsers();
    // Confirmar al cliente que está en la sala
    socket.emit('voice-joined',{roomId});
  });

  socket.on('leave-voice',()=>leaveVoice(socket));
  socket.on('offer',({to,offer})=>io.to(to).emit('offer',{from:socket.id,offer}));
  socket.on('answer',({to,answer})=>io.to(to).emit('answer',{from:socket.id,answer}));
  socket.on('ice-candidate',({to,candidate})=>io.to(to).emit('ice-candidate',{from:socket.id,candidate}));

  socket.on('disconnect',()=>{
    const u=users[socket.id];
    if(u) socket.to('ch:'+u.channel).emit('chat-message',{system:true,text:`${u.username} salió de Diskold`,time:now()});
    leaveVoice(socket);
    delete users[socket.id];
    io.emit('user-list',buildUserList());
  });

  function leaveVoice(s){
    const room=s.currentVoiceRoom;
    if(!room||!voiceRooms[room]) return;
    voiceRooms[room]=voiceRooms[room].filter(id=>id!==s.id);
    io.to('voice:'+room).emit('peer-left',s.id);
    s.leave('voice:'+room);
    s.currentVoiceRoom=null;
    emitVoiceUsers();
  }

  function emitVoiceUsers(){
    const state={};
    Object.keys(VOICE_ROOMS).forEach(room=>{
      state[room]=(voiceRooms[room]||[]).map(id=>({id,name:users[id]?.username||'Anónimo'}));
    });
    io.emit('voice-users',state);
  }
});

// ── Bot (por canal, música separada) ─────────────────────
async function handleBotCommand(socket, username, channel, text){
  const parts=text.trim().split(' '); const cmd=parts[0].toLowerCase(); const args=parts.slice(1).join(' ');
  io.to('ch:'+channel).emit('chat-message',{user:username,avatar:users[socket.id]?.avatar,text,time:now(),channel});
  const mb=getMb(channel);
  const botMsg=t=>io.to('ch:'+channel).emit('chat-message',{bot:true,user:'🤖 KoldBot',text:t,time:now(),channel});
  const emitMb=()=>io.to('ch:'+channel).emit('music-state',{...mb,channel});

  switch(cmd){
    case '/play':{
      if(!args){botMsg('❄️ Uso: `/play nombre canción`');return;}
      botMsg(`🔍 Buscando **${args}**...`);
      const r=await searchYouTube(args);
      if(!r.length){botMsg('❌ Sin resultados.');return;}
      const song={...r[0],requestedBy:username};
      mb.queue.push(song);
      if(!mb.playing) playNext(mb,channel,botMsg);
      else{botMsg(`✅ **${song.title}** en cola (#${mb.queue.length})`);emitMb();}
      break;
    }
    case '/watch':{
      if(!args){botMsg('🎬 Uso: `/watch [YouTube URL]`');return;}
      const vid=extractVideoId(args);if(!vid){botMsg('❌ Link inválido.');return;}
      const info=await getVideoInfo(vid);
      const wp=getWp(channel);
      wp.active=true;wp.type='youtube';wp.videoId=vid;wp.url=null;wp.title=info.title;
      wp.playing=false;wp.currentTime=0;wp.startedBy=username;wp.lastSync=Date.now();
      io.to('ch:'+channel).emit('watch-state',{...wp,channel});
      botMsg(`🎬 Watch Party:\n🎥 ${info.title}`);
      break;
    }
    case '/partydo':{
      const wp=getWp(channel);
      wp.active=true;wp.type='iframe';wp.url='https://www.futbollibre.net';wp.videoId=null;
      wp.title='⚽ Fútbol Libre';wp.playing=true;wp.currentTime=0;
      wp.startedBy=username;wp.lastSync=Date.now();
      io.to('ch:'+channel).emit('watch-state',{...wp,channel});
      botMsg(`⚽ **${username}** abrió Fútbol Libre para todos.`);
      break;
    }
    case '/skip':{if(!mb.current){botMsg('❌ Nada.');return;}botMsg('⏭️ Saltado.');playNext(mb,channel,botMsg);break;}
    case '/stop':{mb.queue=[];mb.playing=false;mb.current=null;mb.paused=false;emitMb();io.to('ch:'+channel).emit('music-stop',{channel});botMsg('⏹️ Detenido.');break;}
    case '/pause':{if(!mb.playing){botMsg('❌ Sin música.');return;}mb.paused=true;emitMb();io.to('ch:'+channel).emit('music-pause',{channel});botMsg('⏸️ Pausada.');break;}
    case '/resume':{if(!mb.paused){botMsg('❌ No pausada.');return;}mb.paused=false;emitMb();io.to('ch:'+channel).emit('music-resume',{channel});botMsg('▶️ Reanudada.');break;}
    case '/volume':{const v=parseInt(args);if(isNaN(v)||v<0||v>100){botMsg('❌ `/volume 0-100`');return;}mb.volume=v;emitMb();io.to('ch:'+channel).emit('music-volume',{v,channel});botMsg(`🔊 ${v}%`);break;}
    case '/queue':{if(!mb.current&&!mb.queue.length){botMsg('📋 Cola vacía.');return;}let msg='📋 **Cola:**\n';if(mb.current)msg+=`▶️ ${mb.current.title}\n`;mb.queue.forEach((s,i)=>msg+=`${i+1}. ${s.title}\n`);botMsg(msg);break;}
    case '/np':{if(!mb.current){botMsg('❌ Nada.');return;}botMsg(`🎵 **${mb.current.title}** — ${mb.current.requestedBy}`);break;}
    case '/help':{botMsg('🤖 `/play` `/watch [URL]` `/partydo` `/skip` `/stop` `/pause` `/resume` `/volume` `/queue` `/np`');break;}
    default:{botMsg('❓ Usa `/help`.');}
  }
}

function playNext(mb, channel, botMsg){
  if(!mb.queue.length){
    mb.playing=false;mb.current=null;
    io.to('ch:'+channel).emit('music-state',{...mb,channel});
    io.to('ch:'+channel).emit('music-ended',{channel});
    if(botMsg)botMsg('✅ Cola terminada.');return;
  }
  mb.current=mb.queue.shift();mb.playing=true;mb.paused=false;
  io.to('ch:'+channel).emit('music-state',{...mb,channel});
  io.to('ch:'+channel).emit('music-play',{...mb.current,channel});
  if(botMsg)botMsg(`🎵 **${mb.current.title}** — ${mb.current.requestedBy}`);
}

function now(){return new Date().toLocaleTimeString('es',{hour:'2-digit',minute:'2-digit'});}
function buildUserList(){return Object.entries(users).map(([id,u])=>({id,name:u.username,avatar:u.avatar,channel:u.channel}));}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  DISKOLD v3.3  by Kold               ║`);
  console.log(`║  http://localhost:${PORT}              ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});
