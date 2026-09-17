# 🎮 SyncShip — Prompt Maestro para Claude Code

> Documento de contexto completo para construir el MVP de SyncShip: juego web multijugador colaborativo controlado por sensores de movimiento del celular.

---

## Visión del Proyecto

Construye **SyncShip**, un juego web multijugador colaborativo en tiempo real donde una sala de **50 a 200 personas** controla colectivamente una **nave espacial** usando el acelerómetro de sus teléfonos.

El juego corre en una **única pantalla principal** (proyector o TV) y cada participante se conecta desde su celular como controlador físico. La mecánica central es la **sincronía grupal**: la nave responde al promedio del movimiento de todos los celulares conectados al mismo tiempo. Si el grupo no se coordina, la nave no responde bien y chocan.

El objetivo es un MVP funcional, visual y sorprendente. Algo que al proyectarse en una sala haga que la gente quiera participar inmediatamente.

---

## Restricciones Técnicas (No Negociables)

- **Sin frameworks de UI.** Nada de React, Vue, Svelte, Angular. HTML/CSS/JS vanilla únicamente.
- **Sin bundlers.** Nada de Webpack, Vite, Parcel. Los archivos se sirven directamente.
- **Sin TypeScript.** JavaScript puro.
- **Sin base de datos.** Todo el estado del juego vive en memoria del servidor (el proceso de Node.js).
- **Mínimas dependencias npm.** Solo `express` y `socket.io`. Nada más.
- **Compatible con deploy en Railway o Render** (free tier). Documentar por qué Vercel no sirve para WebSockets persistentes.

---

## Stack Técnico

| Capa | Tecnología |
|---|---|
| Servidor | Node.js + Express |
| Tiempo real | Socket.io (WebSockets) |
| Renderizado del juego | Canvas API (nativo del browser) |
| Sensor del celular | DeviceOrientation API / DeviceMotion API |
| QR Code | qrcode.js via CDN (sin npm) |
| Estrellas / partículas | Canvas 2D puro |
| Fuentes | Google Fonts — "Orbitron" para el HUD, "Inter" para el controlador |

---

## Arquitectura del Sistema

```
[Pantalla principal /]          [Servidor Node.js]          [Celular /play]
  Canvas Game Renderer   ←──── Socket.io broadcast ────→   DeviceOrientation
  HUD + QR Code                                             Tilt normalizado
  Score / Lives / Sync                Socket.io             UI de piloto
                               ←── motion:update ───
                               ──── game:state ────→
                               ──── player:feedback →
```

### Flujo de una sesión

1. El anfitrión abre `/` en un proyector o pantalla grande.
2. El QR aparece en pantalla. Los participantes lo escanean con su celular.
3. El celular abre `/play`, piden permiso al sensor, ingresan su nombre y se unen.
4. El servidor cuenta jugadores. Con ≥2 conectados, el juego puede iniciar.
5. Cada celular envía su tilt cada 100ms → el servidor promedia → actualiza posición de la nave → emite `game:state` → la pantalla principal renderiza.
6. Si la nave choca, pierde una vida. Con 0 vidas: Game Over con score final.

---

## Estructura de Archivos

```
syncship/
├── server.js               ← Servidor principal: Express + Socket.io + game loop
├── package.json            ← Solo dependencias: express, socket.io
├── .env.example            ← PORT=3000
├── public/
│   ├── index.html          ← Pantalla principal del juego (TV/proyector)
│   ├── play.html           ← Controlador para celular
│   ├── game.js             ← Lógica de Canvas: rendering, partículas, efectos
│   ├── controller.js       ← Lógica DeviceOrientation + Socket.io + UI celular
│   └── style.css           ← Estilos compartidos (variables CSS, reset, fuentes)
├── README.md               ← Deploy, uso, ngrok, instrucciones de sala
└── vercel.json             ← Config con advertencia de limitación WebSocket
```

---

## server.js — Lógica Completa del Servidor

### Estado del juego en memoria

```javascript
const gameState = {
  phase: 'lobby',      // 'lobby' | 'playing' | 'gameover'
  players: new Map(),  // socketId → { name, tilt, lastSeen }
  ship: {
    y: 0.5,            // posición vertical normalizada (0 = arriba, 1 = abajo)
    vy: 0,             // velocidad vertical
  },
  obstacles: [],       // [{ x, y, width, height, speed, type }]
  particles: [],       // efectos visuales server-side (opcional, puede ser client-side)
  score: 0,
  lives: 3,
  avgTilt: 0,
  tick: 0,
  nextObstacleIn: 60,  // ticks hasta próximo obstáculo
}
```

### Estructura de un jugador

```javascript
// gameState.players.get(socketId):
{
  name: 'Piloto #42',
  tilt: 0.0,          // -1.0 (inclinado atrás) a 1.0 (inclinado adelante)
  lastSeen: Date.now() // timestamp del último motion:update recibido
}
```

### Game Loop

- **Frecuencia:** `setInterval` cada **50ms** (20 ticks por segundo).
- En cada tick:
  1. Si `phase !== 'playing'`, salir.
  2. Limpiar jugadores inactivos: eliminar del Map si `Date.now() - lastSeen > 3000`.
  3. Calcular `avgTilt`: promedio de todos los `player.tilt` del Map.
  4. Actualizar física de la nave:
     - `ship.vy += avgTilt * 0.015` (aceleración proporcional al tilt)
     - `ship.vy *= 0.85` (amortiguación/fricción)
     - `ship.y += ship.vy`
     - Clamp: `ship.y = Math.max(0.05, Math.min(0.95, ship.y))`
  5. Mover obstáculos: `obstacle.x -= obstacle.speed`. Eliminar los que salgan por la izquierda.
  6. Detectar colisiones (rectángulos simples, coordenadas normalizadas).
  7. Si hay colisión: `lives--`, efecto de daño, eliminar obstáculo colisionado. Si `lives === 0`: `phase = 'gameover'`.
  8. Generar nuevos obstáculos cuando `nextObstacleIn` llega a 0.
  9. Incrementar `score` cada tick mientras se juega.
  10. Emitir `game:state` a todos los sockets con `socket.volatile.emit` (no crítico si se pierde un frame).
  11. Emitir `player:feedback` a cada celular individualmente.

### Generación de obstáculos

Cada obstáculo tiene uno de tres patrones:
- **TOP:** barrera en la parte superior, la nave debe bajar (tilt negativo).
- **BOTTOM:** barrera en la parte inferior, la nave debe subir (tilt positivo).
- **SPLIT:** dos barreras (arriba y abajo) con una brecha en el centro.

La velocidad y frecuencia aumentan con el score para incrementar la dificultad.

### Detección de colisiones

Coordenadas normalizadas (0–1). El servidor trabaja en espacio normalizado y el cliente escala al Canvas.

```javascript
function rectsOverlap(a, b) {
  return a.x < b.x + b.w &&
         a.x + a.w > b.x &&
         a.y < b.y + b.h &&
         a.y + a.h > b.y;
}

// La nave se trata como un rectángulo centrado en ship.y:
const shipRect = { x: 0.1, y: ship.y - 0.05, w: 0.08, h: 0.10 };
```

### Eventos Socket.io — Servidor

| Evento recibido | Origen | Acción del servidor |
|---|---|---|
| `player:join` | Celular | Registrar en Map, emitir `player:count` a pantalla |
| `motion:update` | Celular | Actualizar `tilt` y `lastSeen` del jugador |
| `game:start` | Pantalla | Cambiar `phase` a `'playing'`, reiniciar estado |
| `disconnect` | Cualquiera | Eliminar del Map, emitir `player:count` |

| Evento emitido | Destino | Payload |
|---|---|---|
| `game:state` | Pantalla (broadcast) | `{ phase, ship, obstacles, score, lives, avgTilt, playerCount }` |
| `player:count` | Pantalla | `{ count: number }` |
| `player:feedback` | Celular (individual) | `{ contributing: boolean, myTilt: number, avgTilt: number }` |
| `game:over` | Todos | `{ finalScore: number }` |

### Throttle de eventos de movimiento

En el **cliente** (controller.js), usar throttle de 100ms antes de emitir `motion:update`. No emitir si el delta de tilt es menor a 0.02 (reducir ruido).

---

## public/index.html — Pantalla Principal

### Layout

```
┌─────────────────────────────────────────────────────────┐
│  [❤️❤️❤️]              SYNCSHIP           [Score: 00000] │
│                                                          │
│  👥 127 pilotos   [====Barra de sincronía====]          │
│                                                          │
│         ★  ·  ·   ★   ·    ·  ★   ·   ·                │
│   🚀═══>                    [██████]                     │
│         ·  ★  ·   ·   ★    ·       ·  ★                 │
│                                    [████]                │
│                                                          │
│                                         [QR Code 120px] │
└─────────────────────────────────────────────────────────┘
```

### Canvas Game Renderer (game.js)

El Canvas ocupa el 100% del viewport. Todo se dibuja en el Canvas, incluyendo:

**Fondo estelar (parallax):**
- Capa 1: 150 estrellas pequeñas (1px), velocidad 0.2px/frame.
- Capa 2: 80 estrellas medianas (1.5px), velocidad 0.5px/frame.
- Capa 3: 30 estrellas grandes (2px), velocidad 1px/frame.
- Las estrellas se reciclan (cuando salen por la izquierda, reaparecen por la derecha).

**Nave espacial:**
- Dibujada con formas Canvas (no imagen externa para mantener simplicidad).
- Cuerpo principal: elipse/trapecio en color cian (#00f5ff) o blanco.
- Cabina: rectángulo redondeado más oscuro.
- Propulsor: partículas de fuego animadas detrás de la nave (naranja/amarillo).
- La posición Y se interpola suavemente: `displayY = lerp(displayY, ship.y * canvas.height, 0.15)`.

**Obstáculos:**
- Asteroides rectangulares (bloques) con bordes redondeados.
- Color: gris oscuro con borde naranja o rojo.
- Rotación visual (solo CSS transform o recalcular en Canvas).

**Efectos visuales:**
- **Colisión:** Screen shake (desplazar contexto Canvas ±5px random por 300ms) + flash rojo semitransparente.
- **Esquive exitoso:** Texto flotante "+DODGE" en verde que sube y desaparece en 1 segundo.
- **Explosión:** 20 partículas que salen en direcciones aleatorias al colisionar, con fade out.
- **Barra de sincronía:** cuando `avgTilt` tiene baja desviación estándar entre todos los jugadores, la barra se llena y pulsa en color verde/cian.

**HUD:**
- Vidas: iconos de escudo (dibujados con Canvas o emoji) en esquina superior izquierda.
- Score: texto con fuente "Orbitron" en esquina superior derecha.
- Contador de pilotos: `👥 127 pilotos conectados` debajo de las vidas.
- Barra de sincronía: barra horizontal centrada en la parte superior.

**Pantalla Lobby:**
- Fondo estelar animado continúa.
- QR code grande centrado (200x200px).
- Texto: "SYNCSHIP" en grande con efecto glow cian.
- Subtítulo: "Escanea el QR y únete a la misión".
- Contador pulsante: `⬤ 3 pilotos listos`.
- Botón "INICIAR MISIÓN" visible una vez haya ≥2 jugadores (click → emite `game:start`).

**Pantalla Game Over:**
- Overlay semitransparente oscuro.
- Texto "MISIÓN FALLIDA" en rojo con animación de entrada.
- Score final grande.
- "Mejor sincronía alcanzada: X%".
- Botón "NUEVA MISIÓN".

---

## public/play.html — Controlador del Celular

### Pantalla de unión

- Fondo oscuro con estrellas CSS (no Canvas, para rendimiento en móvil).
- Logo SYNCSHIP pequeño arriba.
- Input de nombre: placeholder "Tu nombre de piloto (opcional)".
- Botón grande "🚀 UNIRME A LA MISIÓN" — color cian, texto oscuro, border-radius grande.
- Debajo: instrucción simple con ícono de celular: "Inclina tu teléfono para controlar la nave".

### Solicitud de permisos (iOS 13+)

```javascript
// En iOS, DeviceOrientationEvent requiere permiso explícito
if (typeof DeviceOrientationEvent.requestPermission === 'function') {
  // Mostrar botón intermedio antes de pedir el permiso
  showPermissionScreen(); // pantalla con botón "Activar sensor de movimiento"
  // Al hacer click en ese botón:
  DeviceOrientationEvent.requestPermission()
    .then(state => {
      if (state === 'granted') startController();
      else showPermissionDeniedMessage();
    });
} else {
  // Android y browsers sin restricción
  startController();
}
```

### Pantalla de juego activo (controller.js)

```
┌────────────────────┐
│   👨‍🚀 Piloto #42    │
│   👥 127 conectados │
│                    │
│   ┌──────────────┐ │
│   │              │ │
│   │   INDICADOR  │ │
│   │   DE TILT    │ │  ← Círculo/barra que muestra
│   │              │ │     la inclinación actual
│   └──────────────┘ │
│                    │
│  ✅ Aportando      │  ← Verde si cerca del promedio
│                    │
│  Inclinación: ↑    │  ← Flecha de dirección
└────────────────────┘
```

**Indicador de tilt:**
- Un círculo que se mueve verticalmente dentro de un contenedor.
- Arriba = tilt positivo (nave sube), Abajo = tilt negativo (nave baja).
- El color cambia: cian cuando aporta, amarillo cuando está desincronizado.

**Indicador de contribución:**
- `✅ Tu movimiento está aportando` — fondo verde suave.
- `⚠️ Sincronízate con el grupo` — fondo amarillo.
- Basado en `player:feedback` del servidor: `contributing = Math.abs(myTilt - avgTilt) < 0.3`.

**Fallback sin sensor:**
- Si el dispositivo no soporta DeviceOrientation, mostrar dos botones táctiles:
  - Botón `▲ SUBIR` (presionar = tilt +1.0, soltar = tilt 0.0).
  - Botón `▼ BAJAR` (presionar = tilt -1.0, soltar = tilt 0.0).

**Lectura del sensor:**

```javascript
window.addEventListener('deviceorientation', (event) => {
  // event.beta: inclinación adelante/atrás (-180 a 180)
  // Normalizar al rango -1 a 1
  // Rango útil: -45° a +45°
  const raw = event.beta; // grados
  const normalized = Math.max(-1, Math.min(1, raw / 45));
  sendTilt(normalized);
}, true);
```

**Throttle del envío:**

```javascript
let lastSent = 0;
let lastTilt = 0;

function sendTilt(value) {
  const now = Date.now();
  if (now - lastSent < 100) return;          // throttle 100ms
  if (Math.abs(value - lastTilt) < 0.02) return; // filtrar ruido
  lastSent = now;
  lastTilt = value;
  socket.emit('motion:update', { tilt: value });
}
```

---

## public/style.css — Variables y Estilos Base

```css
:root {
  --color-bg: #03040a;
  --color-primary: #00f5ff;     /* cian neón */
  --color-secondary: #7b2fff;   /* púrpura */
  --color-danger: #ff3860;      /* rojo */
  --color-success: #23d160;     /* verde */
  --color-warning: #ffdd57;     /* amarillo */
  --color-text: #e8eaf6;
  --color-text-dim: #6272a4;
  --font-hud: 'Orbitron', monospace;
  --font-ui: 'Inter', sans-serif;
  --glow-cyan: 0 0 10px #00f5ff, 0 0 20px #00f5ff40;
  --glow-red: 0 0 10px #ff3860, 0 0 20px #ff386040;
}
```

---

## Generación del QR

Usar desde CDN sin npm:

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
```

```javascript
// En index.html, al cargar:
const joinUrl = window.location.origin + '/play';
new QRCode(document.getElementById('qr-container'), {
  text: joinUrl,
  width: 150,
  height: 150,
  colorDark: '#00f5ff',
  colorLight: '#03040a',
  correctLevel: QRCode.CorrectLevel.M
});
```

El QR debe ser siempre visible durante el juego, en la esquina inferior derecha, con tamaño 120–150px y un label debajo que muestre la URL corta.

---

## package.json

```json
{
  "name": "syncship",
  "version": "1.0.0",
  "description": "Juego multijugador colaborativo controlado por sensores del celular",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.7.2"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

---

## vercel.json

```json
{
  "version": 2,
  "builds": [
    { "src": "server.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/(.*)", "dest": "server.js" }
  ],
  "note": "ADVERTENCIA: Vercel no soporta WebSockets persistentes. Este archivo es solo para referencia. Usar Railway o Render para el deploy real."
}
```

---

## .env.example

```
PORT=3000
```

---

## README.md — Contenido Requerido

El README debe cubrir:

### 1. Qué es SyncShip
Descripción de una línea + instrucciones de uso en sala.

### 2. Correr localmente

```bash
git clone <repo>
cd syncship
npm install
node server.js
# Abrir http://localhost:3000 en el proyector
# Abrir http://localhost:3000/play en cada celular
```

### 3. Por qué Vercel no sirve
Explicación breve: Vercel es serverless, cada request puede correr en una instancia diferente. Socket.io requiere una conexión TCP persistente a **un mismo proceso** de Node. En Vercel, eso no es posible sin adapters adicionales (Redis, etc.) que complican innecesariamente el MVP.

### 4. Deploy en Railway (recomendado)

Paso a paso:
1. Crear cuenta en railway.app.
2. "New Project" → "Deploy from GitHub repo".
3. Conectar el repositorio.
4. Railway detecta el `package.json` automáticamente.
5. Variables de entorno: agregar `PORT=3000` (Railway también inyecta su propio `PORT`).
6. Deploy automático. Copiar la URL pública generada.
7. Compartir `https://tu-app.railway.app/play` como QR en la sala.

### 5. Deploy en Render (alternativa)

Similar a Railway: new Web Service, conectar repo, runtime Node, start command `node server.js`.

### 6. Probar con celulares en local (ngrok)

```bash
# Instalar ngrok: https://ngrok.com
ngrok http 3000
# Usar la URL https://xxxx.ngrok.io que genera
```

### 7. Uso en sala

- Proyectar `URL/` en pantalla grande.
- Los participantes escanean el QR con la cámara de su celular.
- Al cargar `/play`, aceptan el permiso del sensor y se unen.
- El anfitrión presiona "INICIAR MISIÓN" cuando haya suficientes pilotos.

### 8. Limitaciones conocidas

- Estado en memoria: si el servidor se reinicia, la partida se pierde.
- iOS requiere acción del usuario para activar el sensor (por diseño del sistema).
- Probado para hasta 200 conexiones simultáneas con una sola instancia.

---

## Criterios de Éxito del MVP

Al terminar de construir, el proyecto debe cumplir todo esto:

- [ ] `npm install && node server.js` funciona sin errores.
- [ ] Abrir `/` muestra la pantalla del juego con el QR generado correctamente.
- [ ] Abrir `/play` en un celular muestra el controlador y pide permiso al sensor.
- [ ] Al unirse un jugador, el contador en la pantalla principal se actualiza en tiempo real.
- [ ] La nave se mueve en respuesta al promedio del movimiento de los celulares.
- [ ] Los obstáculos aparecen, se mueven y se detectan colisiones correctamente.
- [ ] El juego termina con Game Over al perder las 3 vidas.
- [ ] La pantalla principal es visualmente impresionante proyectada en grande.
- [ ] El deploy en Railway funciona y es accesible desde Internet.
- [ ] 50+ celulares pueden conectarse sin que el servidor colapse.
- [ ] La latencia nave → movimiento es menor a 200ms en condiciones normales.

---

## Orden de Construcción Recomendado

1. `package.json` y `.env.example`
2. `server.js` — Estado, game loop, eventos Socket.io
3. `public/index.html` + `public/style.css` — Estructura base pantalla principal
4. `public/game.js` — Canvas renderer: estrellas, nave, obstáculos, HUD
5. `public/play.html` — Estructura controlador
6. `public/controller.js` — DeviceOrientation, socket, UI de feedback
7. `README.md`
8. `vercel.json`
9. Prueba de integración: conectar 3+ pestañas como controladores y verificar que la nave responde.

---

*Construido para ser jugado en vivo, en sala, con decenas de personas. Keep it fast. Keep it visual. Keep it fun.*
