# 🎮 SyncShip

Juego web multijugador colaborativo: una sala de 50 a 200 personas pilota **una sola nave espacial** inclinando sus celulares. La nave sigue el **promedio** del movimiento de todos, así que solo avanza si el grupo se sincroniza.

- La **pantalla principal** (`/`) se proyecta en un TV o proyector: muestra el QR, la lista de pilotos conectados, el botón **INICIAR MISIÓN** y el juego.
- Cada participante escanea el QR y abre el **controlador** (`/play`) en su celular.

Stack: Node.js + Express + Socket.io. HTML/CSS/JS vanilla, Canvas 2D, sin frameworks, sin bundlers, sin base de datos.

---

## 1. Correr localmente

```bash
git clone <repo>
cd syncship
npm install
node server.js
# Pantalla principal:  http://localhost:3000
# Controlador:         http://localhost:3000/play
```

Para probar sin celulares, abre 2 o más pestañas de `http://localhost:3000/play`. En escritorio el controlador detecta que no hay sensor y muestra botones **▲ SUBIR / ▼ BAJAR** (también sirven las flechas del teclado).

---

## 2. Uso en sala

1. Proyecta `https://TU-APP.onrender.com/` en la pantalla grande.
2. Los participantes escanean el QR con la cámara del celular. Se abre `/play`.
3. Cada uno escribe su nombre (opcional), acepta el permiso del sensor (iOS) y presiona **UNIRME A LA MISIÓN**.
4. Sus nombres aparecen en tiempo real en la lista del lobby de la pantalla principal.
5. Cuando haya al menos **2 pilotos**, el anfitrión presiona **🚀 INICIAR MISIÓN** (o Enter / Espacio).
6. Durante el juego el **panel lateral derecho** lista a todos los pilotos:
   - **Cian** = sincronizado con el promedio del grupo.
   - **Amarillo** = desincronizado.
   - **Gris** = sin señal (celular bloqueado o sin enviar datos).
7. Al perder las 3 vidas aparece **MISIÓN FALLIDA** con el score final y la mejor sincronía. **NUEVA MISIÓN** (o tecla `R`) vuelve al lobby con los pilotos ya conectados.

Consejos para la sala:
- Pide que sostengan el celular como si leyeran un mensaje y presionen **Recalibrar** si la nave se va sola hacia un lado.
- Inclinar el borde superior del celular **hacia ti** = la nave **sube**. Alejarlo = **baja**.
- El QR sigue visible en la esquina inferior derecha durante el juego para que la gente pueda unirse en cualquier momento.

---

## 3. Por qué Vercel no sirve

Vercel es una plataforma **serverless**: cada request puede ejecutarse en una instancia distinta y las funciones tienen tiempo de vida limitado. Socket.io necesita una **conexión TCP persistente hacia un mismo proceso de Node** que además mantiene el estado del juego en memoria. Eso en Vercel no es posible sin agregar adapters externos (Redis, servicios de WebSocket de terceros) que complican innecesariamente el MVP. El archivo `vercel.json` se incluye solo como referencia y contiene esta advertencia.

Usa **Render** (configuración incluida) o **Railway**.

---

## 4. Deploy en Render (recomendado, gratis) — archivo `render.yaml`

El repo incluye `render.yaml`, un **Blueprint** de Render que define todo el servicio. Pasos:

1. Sube el proyecto a un repositorio de GitHub (rama `main`).
2. Crea una cuenta en <https://render.com> y conecta tu cuenta de GitHub.
3. En el dashboard: **New +** → **Blueprint**.
4. Selecciona el repositorio. Render detecta `render.yaml` y muestra el servicio `syncship`.
5. Presiona **Apply**. Render ejecuta `npm install` y arranca con `node server.js`.
6. En 1–3 minutos tendrás una URL tipo `https://syncship.onrender.com`.
7. Verifica: `https://syncship.onrender.com/health` debe responder `{"ok":true,...}`.
8. Proyecta `https://syncship.onrender.com/` y comparte el QR.

Cada `git push` a `main` redespliega automáticamente.

Alternativa manual sin Blueprint: **New +** → **Web Service** → conectar repo → Runtime `Node`, Build Command `npm install`, Start Command `node server.js`, Instance Type `Free`. No necesitas configurar `PORT`: Render lo inyecta y el servidor lo lee de `process.env.PORT`.

### Sobre el plan Free de Render

- Soporta WebSockets sin configuración extra.
- El servicio **se dorme tras 15 minutos sin tráfico**. La primera visita tarda 30–60 s en despertar. **Abre la URL 1–2 minutos antes del evento.**
- Con la pantalla principal abierta el servicio no se dorme, porque el socket mantiene tráfico.
- Si el servicio se reinicia, el estado (jugadores, partida) se pierde y todos deben volver a unirse. Es normal para un MVP en memoria.

---

## 5. Deploy en Railway (alternativa)

Railway ya no tiene plan gratuito permanente (crédito de prueba y luego plan Hobby de pago), pero no tiene sleep.

1. Crear cuenta en <https://railway.app>.
2. **New Project** → **Deploy from GitHub repo** → conectar el repositorio.
3. Railway detecta `package.json` y usa `npm start` automáticamente.
4. En **Settings → Networking** genera un dominio público.
5. No es necesario definir `PORT`; Railway inyecta el suyo.
6. Compartir `https://tu-app.up.railway.app/play` como QR en la sala.

---

## 6. Probar con celulares en local (ngrok)

Los sensores de movimiento solo funcionan en **HTTPS** (o en `localhost`). Para probar con celulares reales desde tu PC:

```bash
# Instalar ngrok: https://ngrok.com
node server.js
ngrok http 3000
# Abrir la URL https://xxxx.ngrok-free.app en el proyector y en los celulares
```

El QR de la pantalla principal se genera con la URL actual, así que apuntará automáticamente a la URL de ngrok.

---

## 7. Arquitectura rápida

```
[Pantalla /]  ←── game:state (20/s), lobby:update, game:hit, game:dodge, game:over ──  [server.js]
                                                                                          ↑ motion:update (≤10/s por celular)
[Celular /play] ←── player:feedback (5/s), game:started, game:over, game:lobby ───────────┘
```

- **Game loop** a 20 ticks/s en el servidor. Promedia el tilt de los pilotos activos, aplica física con fricción, mueve obstáculos (patrones TOP / BOTTOM / SPLIT), detecta colisiones en coordenadas normalizadas 0–1.
- **Sincronía** = `1 - desviación estándar de los tilts / 0.5`. Llena la barra superior y define quién "aporta".
- Un piloto sin enviar datos por 3 s se marca **idle**, deja de contar en el promedio pero sigue en la lista hasta que se desconecta.
- Todo el estado vive en memoria del proceso. Sin base de datos.

Estructura:

```
├── server.js            Express + Socket.io + game loop
├── package.json         express, socket.io
├── render.yaml          Deploy en Render (Blueprint)
├── vercel.json          Solo referencia: advertencia de WebSockets
├── .env.example         PORT=3000
└── public/
    ├── index.html       Pantalla principal
    ├── game.js          Canvas: estrellas, nave, obstáculos, HUD, lobby, panel de pilotos
    ├── play.html        Controlador
    ├── controller.js    DeviceOrientation, calibración, fallback, socket
    └── style.css        Estilos compartidos
```

---

## 8. Limitaciones conocidas

- **Estado en memoria:** si el servidor se reinicia, la partida se pierde y los pilotos deben volver a escanear.
- **iOS** exige una acción del usuario para activar el sensor (botón "Activar sensor de movimiento"). Es una restricción del sistema.
- El sensor requiere **HTTPS**. En local solo funciona en `localhost` o vía ngrok.
- Probado para hasta ~200 conexiones simultáneas en una sola instancia. El envío de feedback a celulares va a 5 mensajes/s por jugador para mantener la carga baja.
- Con más de 60 pilotos, el lobby muestra 60 nombres y "+N más"; el panel lateral muestra 28 y "+N más".
- El botón **Iniciar misión** y **Nueva misión** solo existen en la pantalla principal (el anfitrión controla la partida).
