/* global io, QRCode */
'use strict';

/**
 * SyncShip — pantalla principal (proyector / TV).
 * Recibe game:state del servidor y dibuja todo en Canvas.
 * Lobby, panel de pilotos y game over son overlays HTML sobre el Canvas.
 */

(function () {
  // -------------------------------------------------------------------------
  // Referencias DOM
  // -------------------------------------------------------------------------
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');

  const $ = (id) => document.getElementById(id);
  const lobby = $('lobby');
  const lobbyCount = $('lobby-count');
  const lobbyPlayers = $('lobby-players');
  const btnStart = $('btn-start');
  const startHint = $('start-hint');
  const pilotsPanel = $('pilots-panel');
  const panelCount = $('panel-count');
  const panelList = $('panel-list');
  const qrMini = $('qr-mini');
  const gameover = $('gameover');
  const finalScore = $('final-score');
  const bestSyncEl = $('best-sync');
  const gameoverCount = $('gameover-count');
  const btnReset = $('btn-reset');
  const toast = $('toast');

  const MAX_LOBBY_CHIPS = 60;
  const MAX_PANEL_ROWS = 28;
  const MIN_PLAYERS_DEFAULT = 2;

  // -------------------------------------------------------------------------
  // Estado local
  // -------------------------------------------------------------------------
  let W = 0;
  let H = 0;
  let dpr = 1;
  // Campo de juego: el espacio normalizado 0..1 del servidor se mapea a la franja
  // debajo del HUD para que la nave y los obstáculos no tapen vidas/score.
  let FIELD_TOP = 0;
  let FIELD_H = 0;
  const fy = (y) => FIELD_TOP + y * FIELD_H;
  const fh = (h) => h * FIELD_H;

  let state = {
    phase: 'lobby',
    ship: { y: 0.5, vy: 0 },
    obstacles: [],
    score: 0,
    lives: 3,
    avgTilt: 0,
    sync: 0,
    playerCount: 0,
  };

  let displayY = 0.5;       // posición interpolada de la nave (normalizada)
  let displayTilt = 0;
  let displaySync = 0;
  let shake = { until: 0, intensity: 0 };
  let flash = { until: 0 };
  let floaters = [];        // textos flotantes (+DODGE)
  let explosions = [];      // partículas de explosión
  let thrust = [];          // partículas del propulsor
  let lastFrame = performance.now();
  let lastPlayers = [];
  let lastCount = 0;
  let minPlayers = MIN_PLAYERS_DEFAULT;

  // -------------------------------------------------------------------------
  // Estrellas (parallax de 3 capas)
  // -------------------------------------------------------------------------
  const layers = [
    { count: 150, size: 1.0, speed: 0.2, stars: [], alpha: 0.6 },
    { count: 80, size: 1.5, speed: 0.5, stars: [], alpha: 0.8 },
    { count: 30, size: 2.0, speed: 1.0, stars: [], alpha: 1.0 },
  ];

  function seedStars() {
    for (const layer of layers) {
      layer.stars = [];
      for (let i = 0; i < layer.count; i++) {
        layer.stars.push({
          x: Math.random() * W,
          y: Math.random() * H,
          tw: Math.random() * Math.PI * 2,
        });
      }
    }
  }

  function drawStars(dt) {
    const speedScale = state.phase === 'playing' ? 1 + Math.min(state.score / 3000, 1) * 1.5 : 0.6;
    for (const layer of layers) {
      ctx.fillStyle = '#ffffff';
      for (const s of layer.stars) {
        s.x -= layer.speed * speedScale * (dt / 16.67);
        if (s.x < -2) {
          s.x = W + 2;
          s.y = Math.random() * H;
        }
        s.tw += 0.02;
        ctx.globalAlpha = layer.alpha * (0.7 + 0.3 * Math.sin(s.tw));
        ctx.fillRect(s.x, s.y, layer.size, layer.size);
      }
    }
    ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Canvas sizing
  // -------------------------------------------------------------------------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    FIELD_TOP = Math.min(H * 0.13, 140);
    FIELD_H = H - FIELD_TOP - 12;
    seedStars();
  }

  window.addEventListener('resize', resize);
  resize();

  // -------------------------------------------------------------------------
  // Helpers de dibujo
  // -------------------------------------------------------------------------
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // -------------------------------------------------------------------------
  // Nave
  // -------------------------------------------------------------------------
  function drawShip(dt) {
    const shipX = 0.1 * W;
    const shipW = 0.08 * W;
    const shipH = fh(0.10);
    const cx = shipX + shipW / 2;
    const cy = fy(displayY);
    const tilt = -displayTilt * 0.35; // inclinación visual (radianes)

    // Propulsor: partículas
    for (let i = 0; i < 3; i++) {
      thrust.push({
        x: shipX + shipW * 0.05,
        y: cy + (Math.random() - 0.5) * shipH * 0.35,
        vx: -(3 + Math.random() * 4),
        vy: (Math.random() - 0.5) * 1.5,
        life: 1,
        size: 3 + Math.random() * 5,
        hue: 20 + Math.random() * 35,
      });
    }
    for (const p of thrust) {
      p.x += p.vx * (dt / 16.67);
      p.y += p.vy * (dt / 16.67);
      p.life -= 0.06 * (dt / 16.67);
      if (p.life <= 0) continue; // radio negativo lanzaría IndexSizeError en arc()
      ctx.globalAlpha = p.life;
      ctx.fillStyle = `hsl(${p.hue}, 100%, ${50 + p.life * 30}%)`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
    }
    thrust = thrust.filter((p) => p.life > 0);
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt);

    // Glow
    ctx.shadowColor = '#00f5ff';
    ctx.shadowBlur = 25;

    // Cuerpo principal (forma de flecha/trapecio)
    const hw = shipW / 2;
    const hh = shipH / 2;
    ctx.fillStyle = '#00f5ff';
    ctx.beginPath();
    ctx.moveTo(hw, 0);                       // nariz
    ctx.lineTo(-hw * 0.45, -hh * 0.55);
    ctx.lineTo(-hw, -hh * 0.35);
    ctx.lineTo(-hw * 0.85, 0);
    ctx.lineTo(-hw, hh * 0.35);
    ctx.lineTo(-hw * 0.45, hh * 0.55);
    ctx.closePath();
    ctx.fill();

    // Alas
    ctx.fillStyle = '#7b2fff';
    ctx.beginPath();
    ctx.moveTo(-hw * 0.2, -hh * 0.4);
    ctx.lineTo(-hw * 0.7, -hh);
    ctx.lineTo(-hw * 0.95, -hh * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-hw * 0.2, hh * 0.4);
    ctx.lineTo(-hw * 0.7, hh);
    ctx.lineTo(-hw * 0.95, hh * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;

    // Cabina
    ctx.fillStyle = '#0a1a2e';
    roundRect(hw * 0.05, -hh * 0.22, hw * 0.45, hh * 0.44, 6);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    roundRect(hw * 0.12, -hh * 0.16, hw * 0.2, hh * 0.14, 3);
    ctx.fill();

    ctx.restore();
  }

  // -------------------------------------------------------------------------
  // Obstáculos
  // -------------------------------------------------------------------------
  function drawObstacles(now) {
    for (const ob of state.obstacles) {
      const x = ob.x * W;
      const y = fy(ob.y);
      const w = ob.w * W;
      const h = fh(ob.h);

      ctx.save();
      // Pequeña rotación visual dependiente del id para dar vida.
      const wobble = Math.sin(now / 600 + ob.id) * 0.02;
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(wobble);
      ctx.translate(-(x + w / 2), -(y + h / 2));

      ctx.shadowColor = ob.type === 'split' ? '#ff3860' : '#ff8c1a';
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#1b1f2e';
      roundRect(x, y, w, h, 10);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.lineWidth = 3;
      ctx.strokeStyle = ob.type === 'split' ? '#ff3860' : '#ff8c1a';
      ctx.stroke();

      // Textura: rayas diagonales sutiles
      ctx.clip();
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 2;
      for (let d = -h; d < w + h; d += 18) {
        ctx.beginPath();
        ctx.moveTo(x + d, y);
        ctx.lineTo(x + d - h, y + h);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // -------------------------------------------------------------------------
  // Efectos
  // -------------------------------------------------------------------------
  function triggerHit(shipY) {
    const now = performance.now();
    shake = { until: now + 300, intensity: 5 };
    flash = { until: now + 250 };
    const cx = 0.14 * W;
    const cy = fy(typeof shipY === 'number' ? shipY : displayY);
    for (let i = 0; i < 20; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 6;
      explosions.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, size: 2 + Math.random() * 4,
        color: Math.random() < 0.5 ? '#ff3860' : '#ffdd57',
      });
    }
  }

  function triggerDodge() {
    floaters.push({
      x: 0.18 * W + Math.random() * 40,
      y: fy(displayY) - 40,
      life: 1,
      text: '+DODGE',
    });
  }

  function drawEffects(dt, now) {
    // Explosiones
    for (const p of explosions) {
      p.x += p.vx * (dt / 16.67);
      p.y += p.vy * (dt / 16.67);
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.life -= 0.025 * (dt / 16.67);
      if (p.life <= 0) continue;
      ctx.globalAlpha = p.life;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    explosions = explosions.filter((p) => p.life > 0);
    ctx.globalAlpha = 1;

    // Textos flotantes
    ctx.font = `700 ${Math.max(18, H * 0.03)}px Orbitron, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const f of floaters) {
      f.y -= 1.2 * (dt / 16.67);
      f.life -= 0.017 * (dt / 16.67);
      ctx.globalAlpha = Math.max(f.life, 0);
      ctx.fillStyle = '#23d160';
      ctx.shadowColor = '#23d160';
      ctx.shadowBlur = 12;
      ctx.fillText(f.text, f.x, f.y);
    }
    floaters = floaters.filter((f) => f.life > 0);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // Flash rojo
    if (now < flash.until) {
      const a = (flash.until - now) / 250;
      ctx.fillStyle = `rgba(255, 56, 96, ${0.35 * a})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // -------------------------------------------------------------------------
  // HUD
  // -------------------------------------------------------------------------
  function drawShield(x, y, size, filled) {
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.moveTo(0, -size / 2);
    ctx.lineTo(size / 2, -size / 3);
    ctx.lineTo(size / 2, size / 6);
    ctx.quadraticCurveTo(size / 2, size / 2, 0, size / 2 + size / 8);
    ctx.quadraticCurveTo(-size / 2, size / 2, -size / 2, size / 6);
    ctx.lineTo(-size / 2, -size / 3);
    ctx.closePath();
    if (filled) {
      ctx.fillStyle = '#00f5ff';
      ctx.shadowColor = '#00f5ff';
      ctx.shadowBlur = 12;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(232,234,246,0.25)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawHUD(now) {
    const pad = 28;
    const hudFont = Math.max(16, Math.min(H * 0.035, 34));

    // Vidas
    for (let i = 0; i < 3; i++) {
      drawShield(pad + 18 + i * 40, pad + 18, 28, i < state.lives);
    }

    // Pilotos
    ctx.font = `600 ${hudFont * 0.6}px Inter, sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = '#e8eaf6';
    ctx.fillText(`👥 ${state.playerCount} pilotos conectados`, pad, pad + 48);

    // Score
    ctx.font = `700 ${hudFont}px Orbitron, monospace`;
    ctx.textAlign = 'right';
    ctx.fillStyle = '#00f5ff';
    ctx.shadowColor = '#00f5ff';
    ctx.shadowBlur = 14;
    ctx.fillText(String(state.score).padStart(5, '0'), W - pad, pad);
    ctx.shadowBlur = 0;
    ctx.font = `500 ${hudFont * 0.45}px Orbitron, monospace`;
    ctx.fillStyle = '#6272a4';
    ctx.fillText('SCORE', W - pad, pad + hudFont + 4);

    // Título centrado
    ctx.textAlign = 'center';
    ctx.font = `900 ${hudFont * 0.8}px Orbitron, monospace`;
    ctx.fillStyle = '#00f5ff';
    ctx.shadowColor = '#00f5ff';
    ctx.shadowBlur = 10;
    ctx.fillText('SYNCSHIP', W / 2, pad - 4);
    ctx.shadowBlur = 0;

    // Barra de sincronía
    const barW = Math.min(W * 0.36, 520);
    const barH = 14;
    const bx = W / 2 - barW / 2;
    const by = pad + hudFont * 0.8 + 14;
    ctx.fillStyle = 'rgba(232,234,246,0.08)';
    roundRect(bx, by, barW, barH, 7);
    ctx.fill();

    const pulse = displaySync > 0.75 ? 0.8 + 0.2 * Math.sin(now / 150) : 1;
    const color = displaySync > 0.75 ? '#23d160' : displaySync > 0.45 ? '#00f5ff' : '#ffdd57';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = displaySync > 0.75 ? 18 * pulse : 6;
    roundRect(bx, by, Math.max(barW * displaySync, barH), barH, 7);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.font = `500 ${hudFont * 0.42}px Orbitron, monospace`;
    ctx.fillStyle = '#6272a4';
    ctx.textBaseline = 'top';
    ctx.fillText(`SINCRONÍA ${Math.round(displaySync * 100)}%`, W / 2, by + barH + 6);

    // Indicador de dirección del grupo
    const arrow = displayTilt > 0.15 ? '▲' : displayTilt < -0.15 ? '▼' : '●';
    ctx.font = `700 ${hudFont * 0.7}px Orbitron, monospace`;
    ctx.fillStyle = '#e8eaf6';
    ctx.textAlign = 'left';
    ctx.fillText(arrow, pad, pad + 48 + hudFont * 0.9);
  }

  // -------------------------------------------------------------------------
  // Loop de render
  // -------------------------------------------------------------------------
  function frame(now) {
    const dt = Math.min(now - lastFrame, 50);
    lastFrame = now;

    // Interpolación suave
    displayY = lerp(displayY, state.ship.y, 0.15);
    displayTilt = lerp(displayTilt, state.avgTilt, 0.1);
    displaySync = lerp(displaySync, state.sync, 0.08);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#03040a';
    ctx.fillRect(0, 0, W, H);

    // Screen shake
    if (now < shake.until) {
      const k = shake.intensity * ((shake.until - now) / 300);
      ctx.translate((Math.random() - 0.5) * 2 * k, (Math.random() - 0.5) * 2 * k);
    }

    drawStars(dt);

    if (state.phase === 'playing' || state.phase === 'gameover') {
      drawObstacles(now);
      drawShip(dt);
      drawEffects(dt, now);
      drawHUD(now);
    } else {
      // En lobby, dibujar la nave flotando suavemente como decoración.
      displayY = 0.5 + Math.sin(now / 900) * 0.04;
      state.ship.y = displayY;
      drawShip(dt);
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);

  // -------------------------------------------------------------------------
  // Lista de pilotos (lobby + panel lateral)
  // -------------------------------------------------------------------------
  function renderPlayerList(players, count) {
    lastPlayers = players;
    lastCount = count;

    // ---- Lobby: chips ----
    lobbyPlayers.textContent = '';
    if (players.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'pilot-empty';
      empty.textContent = 'Esperando pilotos…';
      lobbyPlayers.appendChild(empty);
    } else {
      const shown = players.slice(0, MAX_LOBBY_CHIPS);
      for (const p of shown) {
        const chip = document.createElement('span');
        chip.className = 'pilot-chip' + (p.idle ? ' idle' : '');
        chip.textContent = p.name;
        lobbyPlayers.appendChild(chip);
      }
      if (players.length > MAX_LOBBY_CHIPS) {
        const more = document.createElement('span');
        more.className = 'pilot-chip more';
        more.textContent = `+${players.length - MAX_LOBBY_CHIPS} más`;
        lobbyPlayers.appendChild(more);
      }
    }

    lobbyCount.textContent = `${count} ${count === 1 ? 'piloto listo' : 'pilotos listos'}`;
    gameoverCount.textContent = `${count} ${count === 1 ? 'piloto conectado' : 'pilotos conectados'}`;

    const ready = count >= minPlayers;
    btnStart.disabled = !ready;
    startHint.textContent = ready
      ? '¡Listos! Presiona para despegar'
      : `Se necesitan al menos ${minPlayers} pilotos (faltan ${minPlayers - count})`;

    // ---- Panel lateral ----
    panelCount.textContent = String(count);
    panelList.textContent = '';
    const rows = players.slice(0, MAX_PANEL_ROWS);
    for (const p of rows) {
      const li = document.createElement('li');
      li.className = p.idle ? 'idle' : p.contributing ? 'sync' : 'off';
      li.textContent = p.name;
      li.title = p.idle ? 'Sin señal' : p.contributing ? 'Sincronizado' : 'Desincronizado';
      panelList.appendChild(li);
    }
    if (players.length > MAX_PANEL_ROWS) {
      const li = document.createElement('li');
      li.className = 'more';
      li.textContent = `+${players.length - MAX_PANEL_ROWS} más`;
      panelList.appendChild(li);
    }
  }

  // -------------------------------------------------------------------------
  // Fases / overlays
  // -------------------------------------------------------------------------
  let currentPhase = null;

  function applyPhase(phase) {
    if (phase === currentPhase) return;
    currentPhase = phase;

    lobby.classList.toggle('hidden', phase !== 'lobby');
    pilotsPanel.classList.toggle('hidden', phase === 'lobby');
    qrMini.classList.toggle('hidden', phase === 'lobby');
    gameover.classList.toggle('hidden', phase !== 'gameover');

    if (phase === 'playing') {
      floaters = [];
      explosions = [];
      displayY = 0.5;
    }
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), 2500);
  }

  // -------------------------------------------------------------------------
  // QR
  // -------------------------------------------------------------------------
  function makeQR(containerId, labelId, size) {
    const joinUrl = window.location.origin + '/play';
    const container = document.getElementById(containerId);
    container.textContent = '';
    if (typeof QRCode === 'undefined') {
      container.textContent = 'QR no disponible (sin conexión al CDN)';
      container.style.color = '#ffdd57';
    } else {
      new QRCode(container, {
        text: joinUrl,
        width: size,
        height: size,
        colorDark: '#00f5ff',
        colorLight: '#03040a',
        correctLevel: QRCode.CorrectLevel.M,
      });
    }
    document.getElementById(labelId).textContent = joinUrl.replace(/^https?:\/\//, '');
  }

  makeQR('qr-lobby', 'qr-lobby-label', 200);
  makeQR('qr-game', 'qr-game-label', 120);

  // -------------------------------------------------------------------------
  // Socket.io
  // -------------------------------------------------------------------------
  const socket = io({ transports: ['websocket', 'polling'] });

  socket.on('connect', () => {
    socket.emit('screen:join');
  });

  socket.on('game:state', (s) => {
    state = s;
    if (s.phase === 'gameover') {
      // Una pantalla que se conecta después del game over no recibió game:over: tomar del estado.
      finalScore.textContent = String(s.score).padStart(5, '0');
      bestSyncEl.textContent = `${Math.round((s.bestSync || 0) * 100)}%`;
    }
    applyPhase(s.phase);
  });

  socket.on('lobby:update', (data) => {
    if (typeof data.minPlayers === 'number') minPlayers = data.minPlayers;
    renderPlayerList(data.players || [], data.count || 0);
    if (data.phase) applyPhase(data.phase);
  });

  socket.on('player:count', (data) => {
    state.playerCount = data.count;
  });

  socket.on('game:hit', (data) => {
    triggerHit(data && data.shipY);
    if (data && typeof data.lives === 'number') state.lives = data.lives;
  });

  socket.on('game:dodge', () => triggerDodge());

  socket.on('game:over', (data) => {
    finalScore.textContent = String(data.finalScore).padStart(5, '0');
    bestSyncEl.textContent = `${data.bestSync}%`;
    applyPhase('gameover');
  });

  socket.on('game:error', (data) => showToast(data.message || 'Error'));

  socket.on('disconnect', () => showToast('Conexión perdida con el servidor. Reintentando…'));

  btnStart.addEventListener('click', () => {
    if (btnStart.disabled) return;
    socket.emit('game:start');
  });

  btnReset.addEventListener('click', () => {
    socket.emit('game:reset');
  });

  // Atajos de teclado para el anfitrión: Enter/Espacio inicia, R reinicia.
  window.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && currentPhase === 'lobby' && !btnStart.disabled) {
      socket.emit('game:start');
    } else if ((e.key === 'r' || e.key === 'R') && currentPhase === 'gameover') {
      socket.emit('game:reset');
    }
  });

  applyPhase('lobby');
  renderPlayerList([], 0);
})();
