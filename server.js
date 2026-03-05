/**
 * 🔥 FEUER WORKSHOP – Kollaborativer Server
 * Reines Node.js, keine externen Dependencies.
 * WebSocket-Protokoll nach RFC 6455 implementiert.
 *
 * Starten: node server.js
 * Standard-Port: 3000 (änderbar mit PORT=4000 node server.js)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// ─── SHARED STATE ───────────────────────────────────────────────────────────
let state = {
  notes: { bremst: [], antreibt: [], aendern: [], vision_braindump: [] },
  poker: {},
  workflow: { start: '', entscheid: '', done: '', deploy: '' },
  visions: [],
  participants: [],
  phase: 'braindump',
  timer: null,
};

// ─── CONNECTED CLIENTS ──────────────────────────────────────────────────────
const clients = new Map(); // socket → { id, name, color }
let clientIdCounter = 1;

const COLORS = ['#FF4500','#FFD700','#39FF14','#00BFFF','#FF1493','#AA44FF','#FF6B35','#4ECDC4'];

// ─── HTTP SERVER ─────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'client.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/admin') {
    const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sanitizedState()));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

// ─── WEBSOCKET HANDSHAKE (RFC 6455) ──────────────────────────────────────────
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }

  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );

  const clientId = clientIdCounter++;
  const clientColor = COLORS[(clientId - 1) % COLORS.length];
  clients.set(socket, { id: clientId, name: `Teilnehmer ${clientId}`, color: clientColor });

  console.log(`[+] Client ${clientId} verbunden. Gesamt: ${clients.size}`);

  // Send initial state to this client
  wsSend(socket, { type: 'INIT', state: sanitizedState(), clientId, clientColor });
  broadcastParticipants();

  // ── WebSocket frame parser ──
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) break;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) break;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskingKey = masked ? buffer.slice(offset, offset + 4) : null;
      if (masked) offset += 4;

      if (buffer.length < offset + payloadLen) break;

      const payload = buffer.slice(offset, offset + payloadLen);
      buffer = buffer.slice(offset + payloadLen);

      if (masked && maskingKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskingKey[i % 4];
        }
      }

      if (opcode === 0x8) { // Close
        socket.destroy();
        break;
      } else if (opcode === 0x9) { // Ping
        wsFrame(socket, 0xa, Buffer.alloc(0)); // Pong
      } else if (opcode === 0x1 || opcode === 0x2) { // Text/Binary
        try {
          const msg = JSON.parse(payload.toString('utf8'));
          handleMessage(socket, msg);
        } catch (e) {
          console.error('Parse error:', e.message);
        }
      }
    }
  });

  socket.on('close', () => {
    const info = clients.get(socket);
    console.log(`[-] Client ${info?.id} getrennt. Gesamt: ${clients.size - 1}`);
    clients.delete(socket);
    broadcastParticipants();
  });

  socket.on('error', (err) => {
    console.error('Socket error:', err.message);
    clients.delete(socket);
  });
});

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────────────
function handleMessage(socket, msg) {
  const client = clients.get(socket);
  if (!client) return;

  switch (msg.type) {

    case 'SET_NAME':
      client.name = (msg.name || '').slice(0, 30) || `Teilnehmer ${client.id}`;
      broadcastParticipants();
      break;

    case 'ADD_NOTE':
      if (state.notes[msg.board] !== undefined && msg.text?.trim()) {
        state.notes[msg.board].push({
          id: Date.now() + Math.random(),
          text: msg.text.trim().slice(0, 200),
          author: client.name,
          color: client.color,
          votes: 0,
          votedBy: [],
        });
        broadcast({ type: 'STATE_UPDATE', notes: state.notes });
      }
      break;

    case 'DELETE_NOTE':
      if (state.notes[msg.board]) {
        state.notes[msg.board] = state.notes[msg.board].filter(n => n.id !== msg.noteId);
        broadcast({ type: 'STATE_UPDATE', notes: state.notes });
      }
      break;

    case 'VOTE_NOTE':
      outer: for (const board of Object.keys(state.notes)) {
        for (const note of state.notes[board]) {
          if (note.id === msg.noteId) {
            if (!note.votedBy.includes(client.id)) {
              note.votes++;
              note.votedBy.push(client.id);
            } else {
              note.votes--;
              note.votedBy = note.votedBy.filter(id => id !== client.id);
            }
            broadcast({ type: 'STATE_UPDATE', notes: state.notes });
            break outer;
          }
        }
      }
      break;

    case 'POKER_VOTE':
      if (!state.poker[msg.situation]) state.poker[msg.situation] = {};
      state.poker[msg.situation][client.id] = {
        level: msg.level,
        name: client.name,
        color: client.color,
        revealed: false,
      };
      broadcast({ type: 'STATE_UPDATE', poker: state.poker });
      break;

    case 'REVEAL_POKER':
      if (state.poker[msg.situation]) {
        Object.values(state.poker[msg.situation]).forEach(v => v.revealed = true);
        broadcast({ type: 'STATE_UPDATE', poker: state.poker });
      }
      break;

    case 'RESET_POKER_SITUATION':
      state.poker[msg.situation] = {};
      broadcast({ type: 'STATE_UPDATE', poker: state.poker });
      break;

    case 'UPDATE_WORKFLOW':
      if (state.workflow[msg.field] !== undefined) {
        state.workflow[msg.field] = (msg.value || '').slice(0, 2000);
        broadcast({ type: 'STATE_UPDATE', workflow: state.workflow });
      }
      break;

    case 'ADD_VISION':
      if (msg.text?.trim()) {
        state.visions.push({
          id: Date.now() + Math.random(),
          text: msg.text.trim().slice(0, 300),
          author: client.name,
          color: client.color,
          likes: 0,
          likedBy: [],
        });
        broadcast({ type: 'STATE_UPDATE', visions: state.visions });
      }
      break;

    case 'LIKE_VISION':
      const vision = state.visions.find(v => v.id === msg.id);
      if (vision) {
        if (!vision.likedBy.includes(client.id)) {
          vision.likes++;
          vision.likedBy.push(client.id);
        } else {
          vision.likes--;
          vision.likedBy = vision.likedBy.filter(id => id !== client.id);
        }
        broadcast({ type: 'STATE_UPDATE', visions: state.visions });
      }
      break;

    case 'SET_PHASE':
      state.phase = msg.phase;
      broadcast({ type: 'STATE_UPDATE', phase: state.phase });
      break;

    case 'START_TIMER':
      state.timer = { endsAt: Date.now() + msg.seconds * 1000, seconds: msg.seconds };
      broadcast({ type: 'STATE_UPDATE', timer: state.timer });
      break;

    case 'STOP_TIMER':
      state.timer = null;
      broadcast({ type: 'STATE_UPDATE', timer: null });
      break;

    case 'RESET_ALL':
      state = {
        notes: { bremst: [], antreibt: [], aendern: [], vision_braindump: [] },
        poker: {},
        workflow: { start: '', entscheid: '', done: '', deploy: '' },
        visions: [],
        participants: [],
        phase: 'braindump',
        timer: null,
      };
      broadcast({ type: 'FULL_RESET', state: sanitizedState() });
      break;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sanitizedState() {
  return {
    notes: state.notes,
    poker: state.poker,
    workflow: state.workflow,
    visions: state.visions,
    phase: state.phase,
    timer: state.timer,
    participants: Array.from(clients.values()).map(c => ({
      id: c.id, name: c.name, color: c.color
    })),
  };
}

function broadcastParticipants() {
  broadcast({
    type: 'PARTICIPANTS',
    participants: Array.from(clients.values()).map(c => ({
      id: c.id, name: c.name, color: c.color
    }))
  });
}

function broadcast(msg, excludeSocket = null) {
  const data = JSON.stringify(msg);
  for (const [socket] of clients) {
    if (socket !== excludeSocket && !socket.destroyed) {
      wsSend(socket, msg);
    }
  }
}

function wsSend(socket, obj) {
  if (socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  wsFrame(socket, 0x1, data);
}

function wsFrame(socket, opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  try { socket.write(Buffer.concat([header, payload])); } catch(e) {}
}

// ─── START ───────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🔥 FEUER WORKSHOP SERVER LÄUFT`);
  console.log(`   → Teilnehmer: http://localhost:${PORT}`);
  console.log(`   → Admin:      http://localhost:${PORT}/admin`);
  console.log(`   → Im Netzwerk: http://<deine-IP>:${PORT}\n`);
});
