'use strict';

/**
 * SyncShip — servidor principal.
 * Express sirve los archivos estáticos; Socket.io transporta el tiempo real;
 * un game loop a 20 ticks/s mueve la nave según el promedio del tilt de todos los celulares.
 *
 * Todo el estado vive en memoria de este proceso (sin base de datos).
 */

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT) || 3000;
const TICK_MS = 50;                 // 20 ticks por segundo
const FEEDBACK_EVERY = 4;           // player:feedback cada 4 ticks (200 ms)
const LOBBY_REFRESH_EVERY = 10;     // lobby:update (lista de pilotos) cada 10 ticks (500 ms) durante el juego
const IDLE_AFTER_MS = 3000;         // sin motion:update → el piloto se marca idle y no cuenta en el promedio
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 250;
const MAX_NAME_LEN = 16;
const CONTRIBUTING_THRESHOLD = 0.3; // |myTilt - avgTilt| < 0.3 → aporta

const SHIP_X = 0.1;
const SHIP_W = 0.08;
const SHIP_H = 0.10;

// ---------------------------------------------------------------------------
// Estado del juego
// ---------------------------------------------------------------------------

const gameState = {
  phase: 'lobby',        // 'lobby' | 'playing' | 'gameover'
  players: new Map(),    // socketId → { name, tilt, lastSeen, joinedAt }
  ship: { y: 0.5, vy: 0 },
  obstacles: [],         // [{ id, x, y, w, h, speed, type }]
  score: 0,
  lives: 3,
  avgTilt: 0,
  sync: 0,               // 0..1, qué tan alineados están los tilts
  bestSync: 0,
  tick: 0,
  nextObstacleIn: 40,
};

let nextObstacleId = 1;
let joinCounter = 0;
let loopTick = 0; // cuenta ticks en cualquier fase (para refrescos periódicos)

function resetGame() {
  gameState.ship.y = 0.5;
  gameState.ship.vy = 0;
  gameState.obstacles = [];
  gameState.score = 0;
  gameState.lives = 3;
  gameState.avgTilt = 0;
  gameState.sync = 0;
  gameState.bestSync = 0;
  gameState.tick = 0;
  gameState.nextObstacleIn = 40;
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w &&
         a.x + a.w > b.x &&
         a.y < b.y + b.h &&
         a.y + a.h > b.y;
}

function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  // Quitar caracteres de control y espacios sobrantes.
  const clean = raw.replace(/[\x00-\x1f\x7f<>]/g, '').trim();
  return clean.slice(0, MAX_NAME_LEN);
}

function isIdle(player, now) {
  return now - player.lastSeen > IDLE_AFTER_MS;
}

function isContributing(player) {
  return Math.abs(player.tilt - gameState.avgTilt) < CONTRIBUTING_THRESHOLD;
}

/** Lista serializable de pilotos para las pantallas. */
function buildPlayerList() {
  const now = Date.now();
  const list = [];
  for (const [id, p] of gameState.players) {
    const idle = isIdle(p, now);
    list.push({
      id,
      name: p.name,
      idle,
      contributing: gameState.phase === 'playing' && !idle && isContributing(p),
    });
  }
  // Orden estable: por llegada.
  list.sort((a, b) => gameState.players.get(a.id).joinedAt - gameState.players.get(b.id).joinedAt);
  return list;
}

function emitLobbyUpdate() {
  io.to('screens').emit('lobby:update', {
    phase: gameState.phase,
    players: buildPlayerList(),
    count: gameState.players.size,
    minPlayers: MIN_PLAYERS,
  });
  io.to('screens').emit('player:count', { count: gameState.players.size });
}

/** Feedback individual a cada celular. volatile=true durante el juego (puede perderse un frame). */
function emitPlayerFeedback(volatile) {
  for (const [id, p] of gameState.players) {
    const sock = io.sockets.sockets.get(id);
    if (!sock) continue;
    const target = volatile ? sock.volatile : sock;
    target.emit('player:feedback', {
      contributing: gameState.phase === 'playing' && isContributing(p),
      myTilt: p.tilt,
      avgTilt: gameState.avgTilt,
      phase: gameState.phase,
      playerCount: gameState.players.size,
      score: gameState.score,
      lives: gameState.lives,
    });
  }
}

function snapshotState() {
  return {
    phase: gameState.phase,
    ship: { y: gameState.ship.y, vy: gameState.ship.vy },
    obstacles: gameState.obstacles,
    score: gameState.score,
    lives: gameState.lives,
    avgTilt: gameState.avgTilt,
    sync: gameState.sync,
    bestSync: gameState.bestSync,
    playerCount: gameState.players.size,
  };
}

// ---------------------------------------------------------------------------
// Obstáculos
// ---------------------------------------------------------------------------

function difficulty() {
  // 0 al inicio, crece suavemente con el score. Tope en 1.
  return clamp(gameState.score / 3000, 0, 1);
}

function spawnObstacle() {
  const d = difficulty();
  const speed = 0.010 + d * 0.012;          // unidades normalizadas por tick
  const w = 0.05 + Math.random() * 0.03;
  const roll = Math.random();
  const groupId = nextObstacleId++;

  if (roll < 0.35) {
    // TOP: barrera arriba, la nave debe bajar.
    const h = 0.35 + Math.random() * 0.2 + d * 0.1;
    gameState.obstacles.push({ id: groupId, x: 1.05, y: 0, w, h, speed, type: 'top', group: groupId });
  } else if (roll < 0.7) {
    // BOTTOM: barrera abajo, la nave debe subir.
    const h = 0.35 + Math.random() * 0.2 + d * 0.1;
    gameState.obstacles.push({ id: groupId, x: 1.05, y: 1 - h, w, h, speed, type: 'bottom', group: groupId });
  } else {
    // SPLIT: arriba y abajo con brecha en el centro.
    const gap = 0.32 - d * 0.10;
    const gapY = 0.2 + Math.random() * (0.6 - gap);
    gameState.obstacles.push({ id: groupId, x: 1.05, y: 0, w, h: gapY, speed, type: 'split', group: groupId });
    gameState.obstacles.push({ id: nextObstacleId++, x: 1.05, y: gapY + gap, w, h: 1 - (gapY + gap), speed, type: 'split', group: groupId });
  }

  // Ticks hasta el siguiente: entre ~2.5 s y ~1.2 s según dificultad.
  gameState.nextObstacleIn = Math.round(50 - d * 26 + Math.random() * 12);
}

// ---------------------------------------------------------------------------
// Game loop
// ---------------------------------------------------------------------------

function gameTick() {
  loopTick++;

  // Refresco periódico (1 s) en cualquier fase: estado idle en la lista de la pantalla
  // y conteo de pilotos en los celulares mientras esperan en el lobby.
  if (gameState.phase !== 'playing') {
    if (loopTick % 20 === 0 && gameState.players.size > 0) {
      emitLobbyUpdate();
      io.to('players').emit('player:count', { count: gameState.players.size });
    }
    return;
  }

  gameState.tick++;
  const now = Date.now();

  // 1. Promedio y sincronía de los pilotos activos.
  let sum = 0;
  let active = 0;
  const tilts = [];
  for (const p of gameState.players.values()) {
    if (isIdle(p, now)) continue;
    sum += p.tilt;
    active++;
    tilts.push(p.tilt);
  }
  gameState.avgTilt = active > 0 ? sum / active : 0;

  if (active > 1) {
    let variance = 0;
    for (const t of tilts) variance += (t - gameState.avgTilt) ** 2;
    const stddev = Math.sqrt(variance / active);
    gameState.sync = clamp(1 - stddev / 0.5, 0, 1);
  } else {
    gameState.sync = active === 1 ? 1 : 0;
  }
  if (gameState.sync > gameState.bestSync) gameState.bestSync = gameState.sync;

  // 2. Física de la nave (tilt positivo = subir = y decrece).
  const ship = gameState.ship;
  ship.vy -= gameState.avgTilt * 0.015;
  ship.vy *= 0.85;
  ship.y += ship.vy;
  ship.y = clamp(ship.y, 0.05, 0.95);

  // 3. Mover obstáculos y detectar esquives.
  const shipRect = { x: SHIP_X, y: ship.y - SHIP_H / 2, w: SHIP_W, h: SHIP_H };
  const dodgedGroups = new Set();
  const remaining = [];
  for (const ob of gameState.obstacles) {
    ob.x -= ob.speed;
    if (ob.x + ob.w < 0) {
      if (!ob.hit) dodgedGroups.add(ob.group);
      continue;
    }
    remaining.push(ob);
  }
  gameState.obstacles = remaining;

  if (dodgedGroups.size > 0) {
    gameState.score += 50 * dodgedGroups.size;
    io.to('screens').emit('game:dodge', { score: gameState.score });
  }

  // 4. Colisiones.
  let collided = false;
  for (const ob of gameState.obstacles) {
    if (!ob.hit && rectsOverlap(shipRect, ob)) {
      collided = true;
      // Marcar todo el grupo como golpeado para no descontar dos vidas en un SPLIT.
      for (const other of gameState.obstacles) {
        if (other.group === ob.group) other.hit = true;
      }
      break;
    }
  }

  if (collided) {
    gameState.lives--;
    // Quitar los obstáculos golpeados.
    gameState.obstacles = gameState.obstacles.filter((o) => !o.hit);
    io.to('screens').emit('game:hit', { lives: gameState.lives, shipY: ship.y });

    if (gameState.lives <= 0) {
      gameState.lives = 0;
      gameState.phase = 'gameover';
      io.emit('game:over', {
        finalScore: gameState.score,
        bestSync: Math.round(gameState.bestSync * 100),
      });
      io.to('screens').emit('game:state', snapshotState());
      emitPlayerFeedback(false);
      emitLobbyUpdate();
      return;
    }
  }

  // 5. Nuevos obstáculos.
  gameState.nextObstacleIn--;
  if (gameState.nextObstacleIn <= 0) spawnObstacle();

  // 6. Score por sobrevivir.
  gameState.score += 1;

  // 7. Emitir estado a las pantallas (volatile: si se pierde un frame no importa).
  io.to('screens').volatile.emit('game:state', snapshotState());

  // 8. Feedback individual a los celulares.
  if (gameState.tick % FEEDBACK_EVERY === 0) emitPlayerFeedback(true);

  // 9. Refrescar la lista de pilotos (estado "aportando") en las pantallas.
  if (gameState.tick % LOBBY_REFRESH_EVERY === 0) emitLobbyUpdate();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.get('/play', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'play.html'));
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    phase: gameState.phase,
    players: gameState.players.size,
    uptime: Math.round(process.uptime()),
  });
});

const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e4,   // los mensajes son diminutos; limita abusos
  pingInterval: 10000,
  pingTimeout: 20000,
  perMessageDeflate: false, // menos CPU con cientos de conexiones
});

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  // ---- Pantalla principal ----
  socket.on('screen:join', () => {
    socket.join('screens');
    socket.emit('game:state', snapshotState());
    socket.emit('lobby:update', {
      phase: gameState.phase,
      players: buildPlayerList(),
      count: gameState.players.size,
      minPlayers: MIN_PLAYERS,
    });
  });

  socket.on('game:start', () => {
    if (!socket.rooms.has('screens')) return;
    if (gameState.phase === 'playing') return;
    if (gameState.players.size < MIN_PLAYERS) {
      socket.emit('game:error', { message: `Se necesitan al menos ${MIN_PLAYERS} pilotos.` });
      return;
    }
    resetGame();
    gameState.phase = 'playing';
    io.emit('game:started', { playerCount: gameState.players.size });
    io.to('screens').emit('game:state', snapshotState());
    emitLobbyUpdate();
    for (const p of gameState.players.values()) p.lastSeen = Date.now();
  });

  socket.on('game:reset', () => {
    if (!socket.rooms.has('screens')) return;
    resetGame();
    gameState.phase = 'lobby';
    io.emit('game:lobby', { playerCount: gameState.players.size });
    io.to('screens').emit('game:state', snapshotState());
    emitLobbyUpdate();
  });

  // ---- Celular ----
  socket.on('player:join', (data) => {
    if (gameState.players.size >= MAX_PLAYERS && !gameState.players.has(socket.id)) {
      socket.emit('player:rejected', { message: 'La sala está llena.' });
      return;
    }
    const existing = gameState.players.get(socket.id);
    let name = sanitizeName(data && data.name);
    if (!name) {
      joinCounter++;
      name = existing ? existing.name : `Piloto #${joinCounter}`;
    }
    if (existing) {
      existing.name = name;
      existing.lastSeen = Date.now();
    } else {
      gameState.players.set(socket.id, {
        name,
        tilt: 0,
        lastSeen: Date.now(),
        joinedAt: Date.now(),
      });
    }
    socket.join('players');
    socket.emit('player:joined', {
      id: socket.id,
      name,
      phase: gameState.phase,
      playerCount: gameState.players.size,
    });
    emitLobbyUpdate();
  });

  socket.on('motion:update', (data) => {
    const p = gameState.players.get(socket.id);
    if (!p) return;
    const tilt = data && typeof data.tilt === 'number' ? data.tilt : 0;
    if (!Number.isFinite(tilt)) return;
    p.tilt = clamp(tilt, -1, 1);
    p.lastSeen = Date.now();
  });

  socket.on('disconnect', () => {
    if (gameState.players.delete(socket.id)) {
      emitLobbyUpdate();
    }
  });
});

setInterval(gameTick, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SyncShip escuchando en http://localhost:${PORT}`);
  console.log(`   Pantalla principal: http://localhost:${PORT}/`);
  console.log(`   Controlador:        http://localhost:${PORT}/play`);
});
