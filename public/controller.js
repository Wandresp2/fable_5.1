/* global io */
'use strict';

/**
 * SyncShip — controlador del celular.
 * Lee DeviceOrientation (beta = inclinación adelante/atrás), lo normaliza a -1..1
 * y lo envía al servidor con throttle. Muestra feedback de si el jugador está
 * aportando al promedio del grupo.
 */

(function () {
  const $ = (id) => document.getElementById(id);

  // Pantallas
  const screenJoin = $('screen-join');
  const screenPermission = $('screen-permission');
  const screenGame = $('screen-game');

  // Unión
  const inputName = $('input-name');
  const btnJoin = $('btn-join');
  const joinStatus = $('join-status');

  // Permiso
  const btnPermission = $('btn-permission');
  const btnSkipPermission = $('btn-skip-permission');
  const permissionStatus = $('permission-status');

  // Juego
  const myName = $('my-name');
  const playerCount = $('player-count');
  const phaseMsg = $('phase-msg');
  const tiltBox = $('tilt-box');
  const tiltBall = $('tilt-ball');
  const tiltGhost = $('tilt-ghost');
  const fallbackBtns = $('fallback-btns');
  const btnUp = $('btn-up');
  const btnDown = $('btn-down');
  const badge = $('badge');
  const directionArrow = $('direction-arrow');
  const miniScore = $('mini-score');
  const miniLives = $('mini-lives');
  const btnRecalibrate = $('btn-recalibrate');

  // -------------------------------------------------------------------------
  // Estado
  // -------------------------------------------------------------------------
  const THROTTLE_MS = 100;
  const HEARTBEAT_MS = 1000;
  const NOISE_DELTA = 0.02;
  const TILT_RANGE_DEG = 30;  // ±30° desde la posición neutral = tilt ±1

  let socket = null;
  let joined = false;
  let pilotName = '';
  let phase = 'lobby';

  let currentTilt = 0;
  let lastSent = 0;
  let lastTilt = 0;
  let baseBeta = null;         // beta de referencia (posición neutral)
  let latestBeta = null;
  let sensorActive = false;
  let usingFallback = false;
  let sensorWatchdog = null;
  let lastFeedback = { contributing: false, avgTilt: 0 };

  // -------------------------------------------------------------------------
  // Helpers UI
  // -------------------------------------------------------------------------
  function show(screen) {
    for (const s of [screenJoin, screenPermission, screenGame]) {
      s.classList.toggle('hidden', s !== screen);
    }
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function updateTiltVisual() {
    // Recorrido disponible dentro del contenedor.
    const travel = tiltBox.clientHeight / 2 - 40;
    tiltBall.style.transform = `translateY(${-currentTilt * travel}px)`;
    tiltGhost.style.transform = `translateY(${-clamp(lastFeedback.avgTilt, -1, 1) * travel}px)`;

    directionArrow.textContent = currentTilt > 0.15 ? '↑ SUBIR' : currentTilt < -0.15 ? '↓ BAJAR' : '— NEUTRAL';
  }

  function setBadge(kind, text) {
    badge.className = 'badge ' + kind;
    badge.textContent = text;
    tiltBall.classList.toggle('off', kind === 'off');
  }

  function setPhase(p, extra) {
    phase = p;
    if (p === 'lobby') {
      phaseMsg.textContent = 'ESPERANDO AL ANFITRIÓN…';
      setBadge('wait', '⏳ Esperando que inicie la misión');
    } else if (p === 'playing') {
      phaseMsg.textContent = '🚀 MISIÓN EN CURSO';
    } else if (p === 'gameover') {
      phaseMsg.textContent = '💥 MISIÓN FALLIDA';
      setBadge('wait', extra ? `Score final: ${extra}` : 'Esperando nueva misión…');
    }
  }

  // -------------------------------------------------------------------------
  // Envío de tilt
  // -------------------------------------------------------------------------
  function sendTilt(value, force) {
    currentTilt = clamp(value, -1, 1);
    updateTiltVisual();
    if (!socket || !joined) return;

    const now = Date.now();
    if (!force) {
      if (now - lastSent < THROTTLE_MS) return;
      // Filtrar ruido, pero respetar el heartbeat para que el servidor no nos marque idle.
      if (Math.abs(currentTilt - lastTilt) < NOISE_DELTA && now - lastSent < HEARTBEAT_MS) return;
    }
    lastSent = now;
    lastTilt = currentTilt;
    socket.emit('motion:update', { tilt: currentTilt });
  }

  // Heartbeat: garantiza al menos un envío por segundo aunque el usuario esté quieto.
  setInterval(() => {
    if (joined && Date.now() - lastSent >= HEARTBEAT_MS) sendTilt(currentTilt, true);
  }, 250);

  // -------------------------------------------------------------------------
  // Sensor
  // -------------------------------------------------------------------------
  function onOrientation(event) {
    if (event.beta === null || event.beta === undefined) return;
    latestBeta = event.beta;

    if (!sensorActive) {
      sensorActive = true;
      clearTimeout(sensorWatchdog);
      if (baseBeta === null) baseBeta = latestBeta;
      fallbackBtns.classList.add('hidden');
      usingFallback = false;
    }
    if (usingFallback) return;

    // Positivo = inclinar el borde superior hacia ti (nave sube).
    const rel = latestBeta - baseBeta;
    sendTilt(rel / TILT_RANGE_DEG, false);
  }

  function startSensor() {
    window.addEventListener('deviceorientation', onOrientation, true);
    // Si en 1.5 s no llega ningún evento, activar botones táctiles.
    sensorWatchdog = setTimeout(() => {
      if (!sensorActive) enableFallback('Sensor no disponible: usa los botones.');
    }, 1500);
  }

  function enableFallback(reason) {
    usingFallback = true;
    fallbackBtns.classList.remove('hidden');
    btnRecalibrate.classList.add('hidden');
    if (reason) phaseMsg.textContent = reason.toUpperCase();
    setTimeout(() => setPhase(phase), 2500);
  }

  function recalibrate() {
    if (latestBeta !== null) {
      baseBeta = latestBeta;
      sendTilt(0, true);
      btnRecalibrate.textContent = '✅ Calibrado';
      setTimeout(() => (btnRecalibrate.textContent = '🎯 Recalibrar posición neutral'), 1200);
    }
  }

  // Botones de fallback (pointer events cubren touch y mouse).
  function bindHold(btn, value) {
    const press = (e) => {
      e.preventDefault();
      btn.classList.add('pressed');
      sendTilt(value, true);
    };
    const release = (e) => {
      if (e) e.preventDefault();
      btn.classList.remove('pressed');
      sendTilt(0, true);
    };
    btn.addEventListener('pointerdown', press);
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  bindHold(btnUp, 1);
  bindHold(btnDown, -1);

  // Teclado (útil para probar en escritorio).
  window.addEventListener('keydown', (e) => {
    if (!joined) return;
    if (e.key === 'ArrowUp') { usingFallback = true; sendTilt(1, true); }
    if (e.key === 'ArrowDown') { usingFallback = true; sendTilt(-1, true); }
  });
  window.addEventListener('keyup', (e) => {
    if (!joined) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') sendTilt(0, true);
  });

  // -------------------------------------------------------------------------
  // Flujo de unión
  // -------------------------------------------------------------------------
  function needsPermission() {
    return typeof DeviceOrientationEvent !== 'undefined' &&
           typeof DeviceOrientationEvent.requestPermission === 'function';
  }

  function hasOrientationAPI() {
    return typeof window.DeviceOrientationEvent !== 'undefined';
  }

  function connectAndJoin() {
    if (!socket) {
      socket = io({ transports: ['websocket', 'polling'] });
      bindSocket();
    } else if (socket.connected) {
      socket.emit('player:join', { name: pilotName });
    }
  }

  function bindSocket() {
    socket.on('connect', () => {
      // Reconexión incluida: siempre re-unirse con el mismo nombre.
      socket.emit('player:join', { name: pilotName });
    });

    socket.on('player:joined', (data) => {
      joined = true;
      pilotName = data.name;
      myName.textContent = data.name;
      playerCount.textContent = data.playerCount;
      setPhase(data.phase);
      show(screenGame);
      updateTiltVisual();
      sendTilt(currentTilt, true);
    });

    socket.on('player:rejected', (data) => {
      joinStatus.textContent = data.message || 'No se pudo unir.';
      btnJoin.disabled = false;
      show(screenJoin);
    });

    socket.on('player:feedback', (data) => {
      lastFeedback = data;
      playerCount.textContent = data.playerCount;
      miniScore.textContent = data.score;
      miniLives.textContent = data.lives;
      if (data.phase === 'playing') {
        if (phase !== 'playing') setPhase('playing');
        if (data.contributing) setBadge('ok', '✅ Tu movimiento está aportando');
        else setBadge('off', '⚠️ Sincronízate con el grupo');
      }
      updateTiltVisual();
    });

    socket.on('player:count', (data) => {
      if (data && typeof data.count === 'number') playerCount.textContent = data.count;
    });

    socket.on('game:started', (data) => {
      if (data && typeof data.playerCount === 'number') playerCount.textContent = data.playerCount;
      setPhase('playing');
      setBadge('ok', '🚀 ¡Despegue! Inclina con el grupo');
      if (navigator.vibrate) navigator.vibrate(80);
    });

    socket.on('game:over', (data) => {
      setPhase('gameover', data && data.finalScore);
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    });

    socket.on('game:lobby', (data) => {
      if (data && typeof data.playerCount === 'number') playerCount.textContent = data.playerCount;
      setPhase('lobby');
    });

    socket.on('disconnect', () => {
      joined = false;
      phaseMsg.textContent = 'RECONECTANDO…';
    });
  }

  btnJoin.addEventListener('click', () => {
    pilotName = inputName.value.trim().slice(0, 16);
    btnJoin.disabled = true;
    joinStatus.textContent = '';

    if (!hasOrientationAPI()) {
      // Escritorio o navegador sin sensor: botones directamente.
      enableFallback('');
      connectAndJoin();
      return;
    }

    if (needsPermission()) {
      show(screenPermission);
      return;
    }

    startSensor();
    connectAndJoin();
  });

  btnPermission.addEventListener('click', () => {
    permissionStatus.textContent = '';
    DeviceOrientationEvent.requestPermission()
      .then((state) => {
        if (state === 'granted') {
          startSensor();
        } else {
          permissionStatus.textContent = 'Permiso denegado. Puedes jugar con los botones.';
          enableFallback('');
        }
        connectAndJoin();
      })
      .catch(() => {
        permissionStatus.textContent = 'No se pudo activar el sensor. Usaremos botones.';
        enableFallback('');
        connectAndJoin();
      });
  });

  btnSkipPermission.addEventListener('click', () => {
    enableFallback('');
    connectAndJoin();
  });

  btnRecalibrate.addEventListener('click', recalibrate);

  inputName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoin.click();
  });

  // Mantener la pantalla encendida si el navegador lo permite.
  if ('wakeLock' in navigator) {
    const requestLock = () => navigator.wakeLock.request('screen').catch(() => {});
    btnJoin.addEventListener('click', requestLock, { once: true });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && joined) requestLock();
    });
  }

  window.addEventListener('resize', updateTiltVisual);
  updateTiltVisual();
})();
