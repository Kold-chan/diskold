/**
 * DISKOLD — Servidor Principal
 * Creado por Kold
 * Chat en tiempo real + señalización WebRTC + Bot de música
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const https   = require('https');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const users = {};
const rooms = {};

// ── Estado del bot de música ──────────────────────────────
const musicBot = {
  queue: [],        // { title, videoId, thumbnail, duration, requestedBy }
  playing: false,
  current: null,
  volume: 80,
  paused: false,
};

// ── API YouTube (sin key, usando scraping de oEmbed + search) ──
async function searchYouTube(query) {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(query);
    const url = `https://www.youtube.com/results?search_query=${q}`;
    
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          // Extraer videoIds del HTML de resultados
          const matches = data.match(/"videoId":"([a-zA-Z0-9_-]{11})"/g);
          if (!matches || matches.length === 0) return resolve([]);
          
          // Sacar IDs únicos
          const ids = [...new Set(matches.map(m => m.replace('"videoId":"', '').replace('"', '')))].slice(0, 5);
          
          // Extraer títulos
          const titleMatches = data.match(/"title":{"runs":\[{"text":"([^"]+)"/g) || [];
          const titles = titleMatches.map(t => {
            const m = t.match(/"text":"([^"]+)"/);
            return m ? m[1] : 'Sin título';
          }).slice(0, 5);

          const results = ids.map((id, i) => ({
            videoId: id,
            title: titles[i] || `Video ${i + 1}`,
            thumbnail: `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
            url: `https://www.youtube.com/watch?v=${id}`
          }));

          resolve(results);
        } catch(e) {
          resolve([]);
        }
      });
    }).on('error', reject);
  });
}

// ── Endpoint para buscar música ───────────────────────────
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json({ results: [] });
  try {
    const results = await searchYouTube(q);
    res.json({ results });
  } catch(e) {
    res.json({ results: [] });
  }
});

// ── Endpoint para obtener info de video ───────────────────
app.get('/api/video/:id', (req, res) => {
  const { id } = req.params;
  https.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, (r) => {
    let data = '';
    r.on('data', c => data += c);
    r.on('end', () => {
      try { res.json(JSON.parse(data)); }
      catch(e) { res.json({}); }
    });
  }).on('error', () => res.json({}));
});

// ── Estado del bot (para nuevos usuarios) ─────────────────
app.get('/api/music-state', (req, res) => {
  res.json(musicBot);
});

io.on('connection', (socket) => {

  socket.on('register', (username) => {
    users[socket.id] = username;
    io.emit('user-list', buildUserList());
    broadcast_system(`${username} entró a Diskold`);
    // Enviar estado actual del bot al nuevo usuario
    socket.emit('music-state', musicBot);
  });

  socket.on('chat-message', (text) => {
    const username = users[socket.id] || 'Anónimo';
    
    // ── Detectar comandos del bot ──────────────────────────
    if (text.startsWith('/')) {
      handleBotCommand(socket, username, text);
      return;
    }

    io.emit('chat-message', {
      user: username,
      text,
      time: now()
    });
  });

  // ── Comandos del bot vía socket ───────────────────────────
  socket.on('bot-command', (data) => {
    handleBotCommand(socket, users[socket.id] || 'Anónimo', data.command);
  });

  // ── WebRTC ────────────────────────────────────────────────
  socket.on('join-voice', (roomId) => {
    if (!rooms[roomId]) rooms[roomId] = [];
    const peers = rooms[roomId].filter(id => id !== socket.id);
    socket.emit('existing-peers', peers);
    peers.forEach(peerId => {
      io.to(peerId).emit('peer-joined', { peerId: socket.id, username: users[socket.id] });
    });
    rooms[roomId].push(socket.id);
    socket.join(roomId);
    socket.currentRoom = roomId;
    emitVoiceUsers(roomId);
  });

  socket.on('leave-voice', () => leaveVoice(socket));

  socket.on('offer',         ({ to, offer })     => io.to(to).emit('offer',         { from: socket.id, offer }));
  socket.on('answer',        ({ to, answer })    => io.to(to).emit('answer',        { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    const name = users[socket.id];
    if (name) broadcast_system(`${name} salió de Diskold`);
    leaveVoice(socket);
    delete users[socket.id];
    io.emit('user-list', buildUserList());
  });

  // ── Helpers ───────────────────────────────────────────────
  function leaveVoice(socket) {
    if (!socket.currentRoom || !rooms[socket.currentRoom]) return;
    rooms[socket.currentRoom] = rooms[socket.currentRoom].filter(id => id !== socket.id);
    io.to(socket.currentRoom).emit('peer-left', socket.id);
    emitVoiceUsers(socket.currentRoom);
    socket.leave(socket.currentRoom);
    socket.currentRoom = null;
  }

  function emitVoiceUsers(roomId) {
    io.emit('voice-users', {
      roomId,
      users: (rooms[roomId] || []).map(id => ({ id, name: users[id] || 'Anónimo' }))
    });
  }
});

// ── Manejo de comandos del bot ────────────────────────────
async function handleBotCommand(socket, username, text) {
  const parts = text.trim().split(' ');
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  // Mostrar el comando en el chat
  io.emit('chat-message', {
    user: username,
    text,
    time: now()
  });

  switch(cmd) {
    case '/play': {
      if (!args) {
        botMsg('❄️ Uso: `/play nombre de la canción`');
        return;
      }
      botMsg(`🔍 Buscando **${args}**...`);
      try {
        const results = await searchYouTube(args);
        if (!results.length) {
          botMsg('❌ No encontré resultados. Intenta con otro nombre.');
          return;
        }
        const song = results[0];
        song.requestedBy = username;
        musicBot.queue.push(song);
        
        if (!musicBot.playing) {
          playNext();
        } else {
          botMsg(`✅ **${song.title}** agregada a la cola (posición ${musicBot.queue.length})`);
          io.emit('music-state', musicBot);
        }
      } catch(e) {
        botMsg('❌ Error al buscar. Intenta de nuevo.');
      }
      break;
    }

    case '/skip': {
      if (!musicBot.current) {
        botMsg('❌ No hay nada reproduciéndose.');
        return;
      }
      botMsg(`⏭️ **${username}** saltó la canción.`);
      playNext();
      break;
    }

    case '/stop': {
      musicBot.queue = [];
      musicBot.playing = false;
      musicBot.current = null;
      musicBot.paused = false;
      io.emit('music-state', musicBot);
      io.emit('music-stop');
      botMsg('⏹️ Música detenida y cola limpiada.');
      break;
    }

    case '/queue': {
      if (!musicBot.current && !musicBot.queue.length) {
        botMsg('📋 La cola está vacía. Usa `/play canción` para agregar música.');
        return;
      }
      let msg = '📋 **Cola de reproducción:**\n';
      if (musicBot.current) msg += `▶️ **Ahora:** ${musicBot.current.title} — pedida por ${musicBot.current.requestedBy}\n`;
      musicBot.queue.forEach((s, i) => {
        msg += `${i+1}. ${s.title} — pedida por ${s.requestedBy}\n`;
      });
      botMsg(msg);
      break;
    }

    case '/pause': {
      if (!musicBot.playing) { botMsg('❌ No hay música reproduciéndose.'); return; }
      musicBot.paused = true;
      io.emit('music-state', musicBot);
      io.emit('music-pause');
      botMsg('⏸️ Música pausada. Usa `/resume` para continuar.');
      break;
    }

    case '/resume': {
      if (!musicBot.paused) { botMsg('❌ La música no está pausada.'); return; }
      musicBot.paused = false;
      io.emit('music-state', musicBot);
      io.emit('music-resume');
      botMsg('▶️ Música reanudada.');
      break;
    }

    case '/volume': {
      const vol = parseInt(args);
      if (isNaN(vol) || vol < 0 || vol > 100) {
        botMsg('❌ Uso: `/volume 0-100`');
        return;
      }
      musicBot.volume = vol;
      io.emit('music-state', musicBot);
      io.emit('music-volume', vol);
      botMsg(`🔊 Volumen ajustado a **${vol}%**`);
      break;
    }

    case '/nowplaying':
    case '/np': {
      if (!musicBot.current) {
        botMsg('❌ No hay nada reproduciéndose ahora.');
        return;
      }
      botMsg(`🎵 **Ahora suena:** ${musicBot.current.title}\n👤 Pedida por: ${musicBot.current.requestedBy}`);
      break;
    }

    case '/help': {
      botMsg(
        '🤖 **Comandos de KoldBot:**\n' +
        '`/play [canción]` — Busca y reproduce\n' +
        '`/skip` — Salta la canción actual\n' +
        '`/stop` — Detiene y limpia la cola\n' +
        '`/pause` — Pausa la música\n' +
        '`/resume` — Reanuda la música\n' +
        '`/volume [0-100]` — Ajusta el volumen\n' +
        '`/queue` — Ver la cola\n' +
        '`/np` — Ver qué suena ahora\n' +
        '`/help` — Ver esta ayuda'
      );
      break;
    }

    default: {
      botMsg(`❓ Comando desconocido. Usa \`/help\` para ver los comandos.`);
    }
  }
}

function playNext() {
  if (musicBot.queue.length === 0) {
    musicBot.playing = false;
    musicBot.current = null;
    io.emit('music-state', musicBot);
    io.emit('music-ended');
    botMsg('✅ Cola terminada. Usa `/play` para más música.');
    return;
  }
  musicBot.current = musicBot.queue.shift();
  musicBot.playing = true;
  musicBot.paused = false;
  io.emit('music-state', musicBot);
  io.emit('music-play', musicBot.current);
  botMsg(`🎵 **Ahora suena:** ${musicBot.current.title} — pedida por ${musicBot.current.requestedBy}`);
}

function botMsg(text) {
  io.emit('chat-message', {
    bot: true,
    user: '🤖 KoldBot',
    text,
    time: now()
  });
}

function now() {
  return new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function buildUserList() {
  return Object.entries(users).map(([id, name]) => ({ id, name }));
}

function broadcast_system(text) {
  io.emit('chat-message', { system: true, text, time: now() });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  DISKOLD  —  by Kold              ║`);
  console.log(`║  http://localhost:${PORT}            ║`);
  console.log(`╚══════════════════════════════════╝\n`);
});
