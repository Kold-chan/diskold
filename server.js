/**
 * DISKOLD — Servidor Principal
 * Creado por Kold
 * Chat en tiempo real + señalización WebRTC para llamadas de voz
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const users = {};        // socketId → username
const rooms = {};        // roomId   → [socketId, ...]

io.on('connection', (socket) => {

  // ── Registro ──────────────────────────────────────────
  socket.on('register', (username) => {
    users[socket.id] = username;
    io.emit('user-list', buildUserList());
    broadcast_system(`${username} entró a Diskold`);
  });

  // ── Chat ──────────────────────────────────────────────
  socket.on('chat-message', (text) => {
    io.emit('chat-message', {
      user: users[socket.id] || 'Anónimo',
      text,
      time: new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    });
  });

  // ── Voz: unirse ───────────────────────────────────────
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

  // ── Voz: salir ────────────────────────────────────────
  socket.on('leave-voice', () => leaveVoice(socket));

  // ── WebRTC relay ──────────────────────────────────────
  socket.on('offer',         ({ to, offer })     => io.to(to).emit('offer',         { from: socket.id, offer }));
  socket.on('answer',        ({ to, answer })    => io.to(to).emit('answer',        { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  // ── Desconexión ───────────────────────────────────────
  socket.on('disconnect', () => {
    const name = users[socket.id];
    if (name) broadcast_system(`${name} salió de Diskold`);
    leaveVoice(socket);
    delete users[socket.id];
    io.emit('user-list', buildUserList());
  });

  // ── Helpers ───────────────────────────────────────────
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

  function broadcast_system(text) {
    io.emit('chat-message', {
      system: true,
      text,
      time: new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    });
  }

  function buildUserList() {
    return Object.entries(users).map(([id, name]) => ({ id, name }));
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  DISKOLD  —  by Kold              ║`);
  console.log(`║  http://localhost:${PORT}            ║`);
  console.log(`╚══════════════════════════════════╝\n`);
});
