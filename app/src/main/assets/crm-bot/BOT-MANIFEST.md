# BOT-MANIFEST.md — Árbol del bot de WhatsApp para el fork de Termux

**Proyecto:** Autoimpulso CRM (bot de WhatsApp en Node.js: Baileys + Express + Socket.io, puerto 3000).
**Destino en el teléfono:** `$HOME/crm-bot` (los scripts `setup-crm.sh` / `start-crm.sh` de este mismo
directorio los moverá el padre a `assets/`; aquí quedan redactados).
**Fecha de armado:** 2026-11-10.
**Regla aplicada:** estado final verificado = backend instalado + todos los fixes entregados y
verificados + panel v3. **NO** incluye la migración SQLite (no instalada) ni `node_modules`
(se instalan con `npm install` en el teléfono). No hay ningún `.env` real ni tokens en el árbol.

**Método de selección:** cada archivo final se eligió por **diff byte a byte** contra las entregas,
no solo por el número del sufijo `-N`. Donde varias entregas tocaban el mismo archivo se comprobó
que el archivo subido por Hugo (`-N` mayor) **ya es la fusión** de esas entregas (diff 0 contra la
entrega más reciente de la cadena); en esos casos no hizo falta fusionar a mano nada. Las
fusiones que ya venían hechas en el archivo instalado se documentan abajo como "fusión heredada".

---

## 1. Backend — origen de cada archivo

| Archivo final | Fuente exacta | Qué entrega/fix incluye |
|---|---|---|
| `app.js` | `~/workspace/user/files/app-3.js` | **Fusión heredada (diff 0 contra `espejo/app.js`):** Fase 2 (`initializePushNotifications()` en `try/catch`, no tumba el arranque sin VAPID) + Fase 3 (`uncaughtException`/`unhandledRejection` ya no hacen `process.exit(1)`; el apagado intencional sí) + espejo (reenvío `waService.on('chat_deleted')` → `io.emit('chat_deleted')` al panel). |
| `src/api.js` | `~/workspace/user/files/api-6.js` | **Fusión heredada (diff 0 contra `frontend-fase2/src/api.js`):** Fase 1 completa (auth `requireApiToken` 401/503, `/contacts/update` sin crash en contacto nuevo, `/agenda/book` reescrito con validación + nota + JID LID-aware, `/crm/execute` con `fallbackJid()`, `/settings` con deep merge) + rutas link-lid de frontend-fase2 (`GET /users` y `GET /contacts` exponen `lid`; `POST /contacts/link-lid` con fusión idempotente local `migrateLidUser`). |
| `src/auth.js` | `~/workspace/user/files/auth.js` | Fase 1, nuevo. `requireApiToken`; compara en tiempo constante; acepta `API_TOKEN` o `ADMIN_TOKEN` (fallback); sin `API_TOKEN` configurado responde 503 en todo. |
| `src/handlers.js` | `~/workspace/user/files/handlers-3.js` | Fase 1 (diff 0). `processError` ya no es mudo (responde por categoría, 3er intento ofrece asesor, no duplica aviso de multimedia); `handleCitaStep` respeta el retorno de `bookAppointment` y pasa el `remoteJid` real. |
| `src/whatsapp.js` | `~/workspace/user/files/whatsapp-3.js` | **Fusión heredada (diff 0 contra `espejo/src/whatsapp.js`):** Fase 3 (`migrateLidUser` LID→teléfono, idempotente y autocurativa; respaldo de `lid_map.json` corrupto) + espejo (reacciones persistentes vía `messages.reaction` y upsert unificados, `quoted` guardado, `type` incl. `sticker`, `messages.delete` → placeholder + borrado del archivo multimedia + `chat_cleared`, `chats.delete` archiva conservando paso/nombre/pausa y emite `chat_deleted`). |
| `src/database.js` | `~/workspace/user/files/database-3.js` | **Fusión heredada (diff 0 contra `espejo/src/database.js`):** Fase 3 (JSON corrupto → respaldo `<nombre>.corrupto-<timestamp>` antes de usar defaults) + espejo (`updateMessage()` para guardar/quitar reacción y marcar eliminado). |
| `src/contacts.js` | `~/workspace/user/files/contacts-5.js` | **Fusión heredada (diff 0 contra `verificacion-final/src/contacts.js`):** Fase 3 (`removeContact()`, respaldo de `contacts.json` corrupto) + corrección de la verificación final (su `loadCache()` es el de la Fase 3; el `contacts-4.js` instalado antes tenía `removeContact` pero el `loadCache` viejo sin respaldo). |
| `src/scheduler.js` | `~/workspace/user/files/scheduler-3.js` | Fase 2 (diff 0). `resolveReminderJid()` exportado (LID 15 dígitos → `@lid`, corrección de JID viejo mal guardado, 521 NO es LID); el recordatorio ya no reactiva el bot pausado; `checkScheduler()` exportado. |
| `src/flow.js` | `~/workspace/user/files/flow.js` | Original de Hugo, sin fix entregado. Sin cambios. |
| `src/stepHandlers.js` | `~/workspace/user/files/stepHandlers.js` | Original de Hugo, sin fix entregado. Sin cambios. |
| `src/events.js` | `~/workspace/user/files/events.js` | Original de Hugo (bus de eventos), sin fix entregado. |
| `src/logger.js` | `~/workspace/user/files/logger.js` | Original de Hugo. **Huérfano:** ningún módulo lo requiere (verificado en la verificación final y aquí: 0 requires). Se incluye porque forma parte del proyecto; es inofensivo. |
| `src/validators.js` | `~/workspace/user/files/validators.js` | Original de Hugo, sin fix entregado. |
| `src/utils.js` | `~/workspace/user/files/utils.js` | Original de Hugo (backend: `normalizePhone`, `normalizeText`, etc.). **No estaba en la lista del encargo, pero es obligatorio:** `app.js`, `api.js`, `scheduler.js`, `flow.js`, `messageSender.js`, `agendaService.js` y `nlpService.js` lo requieren. Sin él el bot no arranca. |
| `src/keywords.js` | `~/workspace/user/files/keywords.js` | Original de Hugo (backend: `findKeywordMatch` con Fuse). **Tampoco estaba en la lista del encargo, pero es obligatorio:** `whatsapp.js` hace `require('./keywords')`. Sin él el bot no arranca. |
| `src/services/agendaService.js` | `~/workspace/user/files/agendaService-3.js` | **Fusión heredada (diff 0 contra `fase-3/src/services/agendaService.js`):** Fase 1 (`bookAppointment` atómico, `fallbackJid()` exportado, `require('../database')` corregido, 6º parámetro `note` opcional) + Fase 3 (respaldo de `agenda.json` corrupta). |
| `src/services/messageSender.js` | `~/workspace/user/files/messageSender-4.js` | Original de `codigo-completo` (diff 0). Sin fixes posteriores. Usa `isBusinessClosed` de `agendaService` y `resolveBareJid`. |
| `src/services/nlpService.js` | `~/workspace/user/files/nlpService-4.js` | Fase 3 (diff 0). AM/PM inferido con el horario del **día pedido** (`targetDate` sincronizado con `response.date`), no el de hoy. |
| `src/services/pushService.js` | `~/workspace/user/files/pushService-2.js` | Fase 2 (diff 0). `initializePushNotifications()` valida VAPID primero y devuelve `false` sin lanzar; `isPushEnabled()` nuevo; `sendPushNotification()` no hace nada con el push apagado. |

### No incluidos (backend) — decisión documentada

- `src/agenda.js` (el `agenda.js` original de 305 líneas en `user/files/`): módulo viejo sustituido por
  `src/services/agendaService.js`. **Nadie lo requiere** (verificado: 0 `require('./agenda')` en código
  en todo el árbol; solo aparece mencionado en un comentario de `messageSender.js`). No se empaqueta.
- `flow_-_copia.js`, `validators_-_copia.js`: respaldos viejos que nadie importa.
- `api-sqlite-push/` y `migracion-sqlite/`: **excluidos a propósito** (la migración SQLite no está instalada;
  el `api.js` fusionado de ese lote necesita `getLidMap`/`getLidToPhoneMap` del `database.js` SQLite).

---

## 2. Panel (public/) — origen de cada archivo

| Archivo final | Fuente exacta | Qué entrega/fix incluye |
|---|---|---|
| `public/index.html` | `~/workspace/your_files/interfaz-movil-v3/index.html` | **Panel v3** (sobre interfaz-movil-v2 + interfaz-profesional). Tuerca y `+` separados en móvil; escritorio idéntico a v2. **Verificado: contiene el paso `#stepToken` del lote panel-token** (3 ocurrencias de `stepToken`/`submitApiToken`), marca "Autoimpulso CRM", `logo.png`, `icon.png`/`icon-192.png`, `manifest.json`, `/css/styles.css` y `js/main.js` como módulo. Los CDN externos (Google Fonts, Font Awesome, qrious) se dejan como en v3; **no** se incluye `vendor/` (era solo para pruebas). |
| `public/css/styles.css` | `~/workspace/your_files/interfaz-movil-v3/css/styles.css` | Estilos v3 (profesional + encabezados de vista + FAB móvil v3). |
| `public/js/main.js` | `~/workspace/user/files/main-5.js` | **Fusión heredada (diff 0 contra `lista-tiempo-real/js/main.js`):** panel-token (`checkStatus` contempla 401/503, paso del token, `crm:unauthorized`, guarda `apiConnected`) + frontend-fase2 + espejo (escucha `chat_deleted`, reacción/borrado/vaciado en vivo) + lista-tiempo-real (`scheduleActivityReload()` con debounce 500 ms para chat nuevo o borrado que vuelve a escribir; handler `new_user` ya no mete objeto crudo). |
| `public/js/api.js` | `~/workspace/user/files/api-5.js` | Panel-token (diff 0). Wrapper de `fetch` que añade `x-api-token` a toda llamada `/api` (incluidas las de otros módulos con `fetch` directo); token en `localStorage` (`crm_api_token`); 401 → evento `crm:unauthorized`. |
| `public/js/contacts.js` | `~/workspace/user/files/contacts-6.js` | Frontend-fase2 **más un fix posterior** (ver §4 Ambigüedad 1): comparación normalizada 52/521 al vincular número (evita el 400 "son el mismo") y toast específico. |
| `public/js/flow.js` | `~/workspace/user/files/flow-4.js` | Frontend-fase3 (diff 0). Incluye el fix del botón `+ Paso`. |
| `public/js/keywords.js` | `~/workspace/user/files/keywords-4.js` | Frontend-fase3 (diff 0, con `escapeHTML` y botones por `data-*`). |
| `public/js/settings.js` | `~/workspace/your_files/verificacion-final/js/settings.js` | Corrección de la verificación final (diff 0 contra `settings-3.js` subido): el reloj observa `#view-config` (la vista real de Ajustes), no `#view-settings` (que no existe); el intervalo se limpia al salir de Ajustes. |
| `public/js/utils.js` | `~/workspace/user/files/utils-3.js` | Frontend-fase3 (diff 0). |
| `public/js/agenda.js` | `~/workspace/user/files/agenda-3.js` | Frontend-fase1 (diff 0). |
| `public/js/chat/chatWindow.js` | `~/workspace/user/files/chatWindow-3.js` | Espejo (diff 0 contra `espejo/js/chat/chatWindow.js`). Citas con borde verde, sticker sin burbuja a 140 px, "🚫 Este mensaje fue eliminado", reacciones persistentes, texto escapado. |
| `public/js/chat/chatList.js` | `~/workspace/user/files/chatList-3.js` | Frontend-fase3 (diff 0). |
| `public/js/chat/chatInput.js` | `~/workspace/user/files/chatInput-2.js` | Frontend-fase3 (diff 0). |
| `public/js/chat/mediaUi.js` | `~/workspace/user/files/mediaUi-2.js` | Frontend-fase3 (diff 0 contra `frontend-fase3/js/chat/mediaUi.js`). |
| `public/sw.js` | `~/workspace/your_files/interfaz-profesional/sw.js` | **Elegido sobre `user/files/sw-2.js`:** caché `flow-crm-v5` (el `sw-2.js` instalado trae `flow-crm-v4`) y precachea `./logo.png` (el viejo precacheaba `./logo.svg`, que no existe en el árbol). Incluye el fix del fetch que dejaba pasar `/socket.io` y `/api/` (el polling se rompía con cache-first) y el manejo de push/clic. La NOTAS de v3 también cita la caché `flow-crm-v5`, coherente. |
| `public/manifest.json` | `~/workspace/your_files/interfaz-profesional/manifest.json` | **Elegido sobre `user/files/manifest.json`:** nombre `"Autoimpulso CRM"` (el viejo dice `"Whats Bot CRM"`). Iconos `icon-192.png` / `icon-512.png`. |
| `public/logo.png`, `public/icon-192.png`, `public/icon-512.png` | `~/workspace/your_files/interfaz-profesional/` | Logotipo e iconos PWA. `logo.png`, `icon-512.png` e `icon.png` son el mismo bytes (md5 `6e6402a7…`); `icon-192.png` es su versión 192. |
| `public/icon.png` | `~/workspace/your_files/interfaz-profesional/icon.png` | **Extra fuera de la lista del encargo, pero obligatorio:** `index.html` lo referencia como favicon (`<link rel="icon" href="icon.png">`). Sin él habría un 404. |
| `public/uploads/.gitkeep` | (creado aquí) | Directorio de destino de `multer` en `src/api.js` (`public/uploads/`). Vacío en el árbol; el bot lo necesita en runtime para subir media del panel. |
| `data/.gitkeep` | (creado aquí) | Los JSON de datos (`users.json`, `contacts.json`, `agenda.json`, `flow.json`, `keywords.json`, `settings.json`, `subscriptions.json`, `lid_map.json`) los crea `initializeDB()` en el primer arranque; no se empaquetan datos reales. |

---

## 3. Fusiones hechas a mano

**Ninguna.** Todas las colisiones entre entregas (app.js en fase-2/fase-3/espejo; whatsapp.js y
database.js en fase-3/espejo; agendaService.js en fase-1/fase-3; api.js en fase-1/frontend-fase2;
main.js en panel-token/frontend-fase2/espejo/lista-tiempo-real) ya estaban resueltas en los archivos
subidos por Hugo: cada archivo `-N` mayor es **byte-idéntico** a la entrega más reciente de su cadena
(comprobado con `diff`, ver §6). Por eso el árbol copia esos archivos tal cual en vez de
re-fusionar: re-fusionar a mano habría arriesgado perder un cambio ya integrado.

---

## 4. Ambigüedades y huecos conocidos

1. **`public/js/contacts.js` (contacts-6.js) trae un fix sin lote conocido.** Contra su base
   (`frontend-fase2/js/contacts.js`) el diff es: comparación con `getCleanPhone()` a ambos lados al
   vincular número (52 vs 521, evita el 400 "son el mismo") y toast `"⚠️ Ese número es el mismo que
   ya tiene el contacto"`. Ese cambio no está en ninguna carpeta de entrega de las fuentes de este
   encargo. Se tomó tal cual del archivo instalado subido por Hugo (es el más reciente), pero no se
   pudo atribuir a un lote ni verificar su prueba asociada.
2. **Rutas push ausentes (hueco conocido, no es un error de este árbol).** `public/js/main.js:690-698`
   (`registerPush()`) llama a `GET /api/vapid-key` y `POST /api/subscribe`, que **no existen** en
   `src/api.js`. Esas rutas se entregaron en `push-endpoints/` (probado 8/8) pero ese lote **no estaba
   en las fuentes de este encargo** y su instalación quedó pendiente de decisión de Hugo, así que no
   se incluyó. Consecuencia: el registro push simplemente no ocurre; `registerPush()` lo tolera
   (`if (!response.ok) return` + `try/catch`), no rompe el panel. Si se añaden algún día, ojo: hoy
   `registerPush` usa `fetch` directo sin token y el router exige token en todo (`requireApiToken`),
   así que daría 401 salvo que se llame por el wrapper de `js/api.js` o se exima la ruta.
3. **Versiones de `package.json` inferidas (ver §5).** Hugo nunca subió su `package.json` real.
   Las versiones son conservadoras y compatibles con el código; debe contrastarlas con el suyo
   antes de `npm install` en el teléfono.
4. **Panel v3: instalación sin confirmar en su momento.** El encargo ordena empaquetar v3 y eso se
   hizo (`index.html` + `css/styles.css` de `interfaz-movil-v3/`). La coherencia se verificó aquí:
   v3 contiene el wizard `#stepToken`, y `main-5.js` (instalado) importa los 12 módulos que el
   árbol incluye (41/41 imports resuelven, ver §6).
5. **Fases 2 y 3 del backend: instalación no confirmada en su momento en la máquina de Hugo.**
   Para este árbol no afecta: los archivos subidos (`app-3.js`, `whatsapp-3.js`, `database-3.js`,
   `agendaService-3.js`, `nlpService-4.js`, `scheduler-3.js`, `pushService-2.js`, `contacts-5.js`)
   son byte-idénticos a las entregas, así que el contenido empaquetado es el de los fixes
   independientemente de lo que hoy corra en su PC.
6. **Sin prueba en vivo.** No hay Android/Termux, ni Baileys real, ni navegador con el panel en este
   entorno. La verificación es estática (sintaxis + resolución de módulos + referencias). La
   primera prueba real es arrancar el bot en el teléfono y escanear el QR.

---

## 5. Dependencias inferidas (`package.json`)

Extraídas con `grep` de todos los `require()` del backend. Ninguna sobra; ninguna falta para
arrancar (verificado por la resolución de requires, §6).

| Dependencia | Versión puesta | Justificación |
|---|---|---|
| `@whiskeysockets/baileys` | `^6.7.0` | `whatsapp.js` usa la API de la v6: `default: makeWASocket`, `useMultiFileAuthState`, `DisconnectReason`, `fetchLatestBaileysVersion`, `downloadMediaMessage` y logger `pino({ level: 'silent' })`. El major 6 es el compatible con ese estilo de import; la v7 cambió parte de esa superficie. |
| `express` | `^4.21.2` | `express.json()`, `express.static('public')`, `Router`, `app.use('/api', …)`. Se pincha la 4 (estable y la de la época del código) y no la 5, que cambió el enrutado. |
| `socket.io` | `^4.7.5` | `new Server(server, { cors: … })` + `io.emit`/`io.on('connection')` en `app.js`. API de la v4. |
| `cors` | `^2.8.5` | `app.use(cors())` en `app.js`. |
| `dotenv` | `^16.4.5` | `require('dotenv').config()` en la primera línea de `app.js` (carga el `.env`). |
| `multer` | `^1.4.5-lts.1` | `multer.diskStorage` con destino `public/uploads/` en `src/api.js`. Línea LTS 1.x, la conservadora. |
| `fuse.js` | `^7.0.0` | `new Fuse(...)` en `src/handlers.js` y `src/keywords.js` (búsqueda difusa de palabras clave). |
| `web-push` | `^3.6.7` | `webpush.setVapidDetails` / envío en `src/services/pushService.js`. |
| `pino` | `^9.3.2` | `require('pino')` directo en `src/whatsapp.js` (logger de Baileys en silencio). |
| `node` (engines) | `>=18` | Mínimo que exige Baileys 6. |

**No incluidas a propósito:** `qrcode-terminal` (el QR no se imprime en consola: `whatsapp.js` emite
el evento `qr` y `app.js` lo reenvía por socket al panel, que lo dibuja con qrious); `node:sqlite`
(la migración SQLite está excluida); ningún `devDependency` (no hay tests empaquetados).
`scripts.start` es `node app.js`, como pide el encargo.

## `.env.example`

Variables leídas del código con `grep` de `process.env` en todo el backend (incluida la
desestructuración de `pushService.js`): `PORT` (default 3000 en `app.js:184`), `API_TOKEN` (obligatorio;
sin él, 503 en toda la API), `ADMIN_TOKEN` (fallback aceptado por `src/auth.js:16`), `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_EMAIL` (opcionales; sin ellas el push queda desactivado y el bot arranca
igual). Todos los valores están vacíos salvo `PORT=3000`; el ejemplo explica cómo generar el token
y las VAPID. **No hay ningún `.env` real en el árbol.**

## Scripts de Termux (en `bot/`, el padre los moverá a `assets/`)

- `setup-crm.sh` — shebang `#!/data/data/com.termux/files/usr/bin/bash`, `set -e`. Si falta `node`,
  `pkg install -y nodejs` (necesita internet); `cd` a su propio directorio; `npm install --no-audit
  --no-fund`; crea `data/` y `public/uploads/` si no existen; **si no existe `.env`, lo crea desde
  `.env.example` y genera un `API_TOKEN` aleatorio** (lo muestra en pantalla y queda en
  `~/crm-bot/.env`; el panel lo pide una sola vez al entrar); toca `.installed`; `exec node app.js`.
  *(Mejora del padre sobre la primera versión: antes solo avisaba que faltaba `.env` y el bot
  arrancaba con la API en 503; ahora el primer arranque ya funciona sin editar nada a mano.
  Si Hugo migra su `.env` propio, el setup lo respeta y no lo toca.)*
- `start-crm.sh` — mismo shebang y `set -e`; `cd` a su propio directorio; `exec node app.js`.
- Ambos pasaron `bash -n` (sintaxis OK). Sin tokens ni rutas de usuario.

---

## 6. Verificación (script `/tmp/verify-bot.js`, solo lectura, 13/13 checks OK)

| Check | Resultado |
|---|---|
| `node --check` a todos los `.js` del árbol (backend 19 + panel 13 incl. `sw.js`) | **32/32 OK** |
| `require('./…')` / `require('../…')` del backend resuelven a un archivo del árbol | **59/59** (el único aparente fallo inicial era un `require('./database')` dentro de un comentario en `agendaService.js:285`; el código real usa `require('../database')`) |
| `import … from './…'` del panel resuelven archivo + nombre exportado | **41/41** (incluye `import './contacts.js'` por efectos y los imports circulares `main.js` ↔ `chat/*`, que son ES modules válidos) |
| Referencias locales de `index.html` (`css/styles.css`, `js/main.js`, `logo.png`, `icon.png`, `icon-192.png`, `manifest.json`) existen en `public/` | **6/6** |
| Precache local de `sw.js` (`./`, `./index.html`, `./manifest.json`, `./logo.png`) existe | **4/4** |
| Iconos del `manifest.json` existen; nombre `"Autoimpulso CRM"` | OK |
| `main.js` registra `./sw.js` y el archivo existe | OK |
| Script inline de `index.html` (FAB v3) pasa `node --check` | **1/1 OK** |
| Sin archivos con sufijo `-N` en el árbol | OK (0) |
| Sin `.env` real; `.env.example` sin valores (solo `PORT=3000`) | OK |
| Sin `require('./agenda')` en código (módulo eliminado) | OK (0) |
| Sin referencias a `vendor/` (solo para pruebas) | OK (0) |
| Sin secretos hardcodeados en `.js`/`.html`/`.json` | OK (0) |
| `package.json` válido, `scripts.start === "node app.js"` | OK |
| `setup-crm.sh` / `start-crm.sh` pasan `bash -n` | OK |

**Totales:** 46 archivos en el árbol (32 `.js`, 1 `.html`, 1 `.css`, 1 `manifest.json`, 4 `.png`,
`package.json`, `.env.example`, 2 `.sh`, 2 `.gitkeep` y este `BOT-MANIFEST.md`). Cero fallos en la verificación estática.
Pendiente de prueba en vivo: arranque en Termux + escaneo del QR + primera descarga real del panel.
