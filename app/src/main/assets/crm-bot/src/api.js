const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');

// 1. 🛠️ Importaciones de Utilidades
const { normalizePhone } = require('./utils');

// 2. 🗄️ Importaciones de la Base de Datos
const { 
    getKeywords, saveKeyword, deleteKeyword, 
    getFullFlow, saveFlowStep, deleteFlowStep, 
    getSettings, saveSettings, 
    getAllUsers, updateUser, getUser, deleteUser,
    initializeDB,
    getLidMap, saveLidMap, getLidToPhoneMap,
    getDb, closeDb, saveSubscription
} = require('./database');

// 3. 👥 Importaciones del Dominio
const { getAllContacts, toggleContactBot, addManualContact, removeContact } = require('./contacts');

// 4. 🤖 Importaciones de Servicios Nuevos (Desacoplados)
const waService = require('./whatsapp'); // El Singleton que creamos antes
const agendaService = require('./services/agendaService');
const { fallbackJid } = agendaService; // Misma regla LID/teléfono que bookAppointment
const messageSender = require('./services/messageSender');
const botEvents = require('./events'); // Para emitir eventos a la UI

const router = express.Router();

// 🌐 URL local (LAN) del panel, SIN token: solo es la IP local del teléfono
// y el puerto, algo que cualquiera en la misma WiFi puede ver. Sirve para
// que el panel (pantalla del QR) muestre el link para abrirlo en la laptop.
// Va ANTES de requireApiToken porque el QR aparece antes de entrar al panel.
// Si no hay WiFi (sin IP local), responde { url: null } y el panel no
// muestra la tarjeta.
function getLanIp() {
    const ifaces = os.networkInterfaces();
    // Preferir el WiFi (wlan0 en Android/Termux).
    for (const name of ['wlan0', 'eth0']) {
        const addrs = ifaces[name] || [];
        const ip = addrs.find(a => a.family === 'IPv4' && !a.internal);
        if (ip) return ip.address;
    }
    for (const name of Object.keys(ifaces)) {
        const addrs = ifaces[name] || [];
        const ip = addrs.find(a => a.family === 'IPv4' && !a.internal);
        if (ip) return ip.address;
    }
    return null;
}
function getServerPort() {
    try {
        const portFile = path.join(__dirname, '../.port');
        if (fs.existsSync(portFile)) {
            const p = Number(fs.readFileSync(portFile, 'utf-8').trim());
            if (p > 0 && p < 65536) return p;
        }
    } catch (e) {}
    return Number(process.env.PORT) || 3000;
}
router.get('/lan-url', (req, res) => {
    const ip = getLanIp();
    if (!ip) return res.json({ url: null });
    res.json({ url: `http://${ip}:${getServerPort()}` });
});

// 🔐 Autenticación de la API: todas las rutas de este router exigen el
// token compartido (ver src/auth.js). Sin API_TOKEN configurado el
// middleware responde 503 en vez de dejar la API abierta.
// El frontend debe enviar `x-api-token` o `Authorization: Bearer` en
// TODAS las llamadas a /api, incluido GET /status.
const { requireApiToken } = require('./auth');
router.use(requireApiToken);

// 🔔 Push: el panel las llama en registerPush() (public/js/main.js):
// primero GET /vapid-key para suscribirse con la clave pública, luego
// POST /subscribe con la suscripción. Sin ellas el navegador nunca se
// suscribe y sendPushNotification no tiene a quién avisar.
router.get('/vapid-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) {
        return res.status(503).json({ error: 'Push no configurado: falta VAPID_PUBLIC_KEY en el .env del servidor.' });
    }
    res.json({ key });
});

router.post('/subscribe', (req, res) => {
    try {
        const sub = req.body || {};
        if (!sub.endpoint || typeof sub.endpoint !== 'string'
            || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
            return res.status(400).json({ success: false, message: 'Suscripción push inválida: falta endpoint o keys.' });
        }
        // saveSubscription ya evita duplicados por endpoint (database.js).
        saveSubscription(sub);
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Error en /subscribe:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});
// --- Mapa LID -> telefono real (tabla lid_map en data/crm.db, lo escribe
// whatsapp.js). GET /users y GET /contacts lo exponen como `lid` para que
// el panel pueda fusionar en una sola fila el registro LID y el del
// telefono real. POST /contacts/link-lid usa la misma fusion que la Fase 3
// del backend (migrateLidUser en whatsapp.js), aqui como funcion local para
// no depender del cliente de Baileys desde el router.
// getLidMap / saveLidMap / getLidToPhoneMap se importan de database.js.

// Fusion LID -> telefono: une historial, mensajes, paso, pausa y citas del
// registro viejo en el del telefono real; archiva el viejo (soft delete) y
// quita su entrada del panel. Es idempotente: si el registro viejo ya esta
// archivado o no existe, solo mueve la entrada del panel y devuelve false.
// Nada se borra antes de haberlo copiado al registro nuevo.
async function migrateLidUserToPhone(lidKey, finalRealPhone) {
    const lidUser = getUser(lidKey);
    const lidExists = !!(lidUser && lidUser.phone && !lidUser.archived);
    if (lidExists) {
        const phoneUser = getUser(finalRealPhone) || {};
        const mergedHistory = { ...(lidUser.history || {}), ...(phoneUser.history || {}) };
        const seenIds = new Set();
        const mergedMessages = [...(lidUser.messages || []), ...(phoneUser.messages || [])]
            .filter(m => m && m.id && !seenIds.has(m.id) && seenIds.add(m.id))
            .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
            .slice(-30);
        const lidStep = lidUser.current_step;
        const phoneStep = phoneUser.current_step;
        const current_step = (lidStep && lidStep !== 'BIENVENIDA') ? lidStep : (phoneStep || lidStep || 'BIENVENIDA');
        const mergedBotEnabled = lidUser.bot_enabled !== undefined ? lidUser.bot_enabled : phoneUser.bot_enabled;
        const useLidLast = String(lidUser.last_active || '') >= String(phoneUser.last_active || '');
        await updateUser(finalRealPhone, {
            history: mergedHistory,
            messages: mergedMessages,
            current_step,
            name: phoneUser.name || lidUser.name,
            jid: `${finalRealPhone}@s.whatsapp.net`,
            lid: lidKey,
            bot_enabled: mergedBotEnabled,
            last_message: useLidLast ? (lidUser.last_message || '') : (phoneUser.last_message || ''),
            last_active: useLidLast ? (lidUser.last_active || '') : (phoneUser.last_active || ''),
        });
        addManualContact(finalRealPhone, phoneUser.name || lidUser.name, mergedBotEnabled);
        deleteUser(lidKey);
        try {
            const agenda = await agendaService.getAgenda();
            let changed = false;
            for (const date of Object.keys(agenda)) {
                const list = agenda[date];
                if (!Array.isArray(list)) continue;
                for (const c of list) {
                    if (c && normalizePhone(String(c.phone || '')) === lidKey) {
                        c.phone = finalRealPhone;
                        c.jid = `${finalRealPhone}@s.whatsapp.net`;
                        changed = true;
                    }
                }
            }
            if (changed) await agendaService.saveAgenda(agenda);
        } catch (e) {
            console.error('⚠️ No se pudieron migrar las citas del LID:', e.message);
        }
        console.log(`🔀 LID ${lidKey} fusionado en ${finalRealPhone}: historial, mensajes y citas migrados.`);
    }
    // Quitar la entrada vieja del panel (aunque el usuario ya no exista).
    removeContact(lidKey);
    return lidExists;
}


// --- CONFIGURACIÓN DE SUBIDA DE ARCHIVOS (Multer) ---
const storage = multer.diskStorage({
    destination: (req, res, cb) => cb(null, path.join(__dirname, '../public/uploads/')),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// ==========================================
// 📞 RUTAS DE CONTACTOS Y CRM
// ==========================================
router.post('/crm/execute', async (req, res) => {
    try {
        const { phone, stepId } = req.body;
        if (!stepId || !phone) return res.status(400).json({ error: "Faltan parámetros (phone o stepId)." });
        
        const targetPhone = normalizePhone(phone);
        await updateUser(targetPhone, { current_step: stepId });
        
        const user = getUser(targetPhone) || { phone: targetPhone };
        
        // Simulación
        if (targetPhone === 'TEST_SIMULADOR' || targetPhone.includes('1234567')) {
            await messageSender.sendStepMessage(null, targetPhone, stepId, user);
            return res.json({ success: true });
        }

        // WhatsApp Real a través del Servicio
        if (waService.status !== 'connected') {
            return res.status(503).json({ error: "El bot de WhatsApp está offline." });
        }
        
        // JID guardado o, si no hay, el de respaldo (LID -> @lid, teléfono -> @s.whatsapp.net)
        let targetJid = user.jid || fallbackJid(targetPhone);
        await messageSender.sendStepMessage(waService.sock, targetJid, stepId, user);
        
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Error en CRM Execute:", e);
        res.status(500).json({ error: "Error interno del servidor" });
    }
});

router.post('/contacts/update', async (req, res) => {
    try {
        const { phone, name, enable, bot_enabled, historyVars } = req.body;
        if (!phone) return res.status(400).json({ success: false, message: 'Falta teléfono' });

        const finalEnableState = bot_enabled !== undefined ? bot_enabled : enable;
        const targetPhone = normalizePhone(phone);

        // getUser() devuelve {} (no null) cuando el contacto no existe, así
        // que el `|| { history: {} }` nunca se activaba y `user.history`
        // era undefined -> "Cannot set properties of undefined".
        const existingUser = getUser(targetPhone);
        const user = (existingUser && existingUser.history) ? existingUser : { history: {} };
        if (name) user.history.nombre = name;
        if (historyVars) Object.assign(user.history, historyVars);
        
        await updateUser(targetPhone, { name, bot_enabled: finalEnableState, history: user.history });
        addManualContact(targetPhone, name, finalEnableState);

        // Desacoplado de la UI: Emitimos el evento en lugar de usar global.io
        botEvents.emit('user_update', { phone: targetPhone, name, bot_enabled: finalEnableState });
        
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Error en update contact:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Vincula un LID (o un numero viejo) con el telefono real: fusiona el
// historial en el registro del telefono. La usa el panel al editar un
// contacto y cambiarle el numero. Antes esta ruta no existia y el panel
// recibia 404, asi que la fusion nunca se hacia.
router.post('/contacts/link-lid', async (req, res) => {
    try {
        const { lidPhone, realPhone, lid, phone } = req.body;
        const sourceRaw = lidPhone || lid;
        const targetRaw = realPhone || phone;
        if (!sourceRaw || !targetRaw) return res.status(400).json({ success: false, message: 'Faltan lidPhone y realPhone' });
        const lidKey = normalizePhone(sourceRaw);
        const finalRealPhone = normalizePhone(targetRaw);
        if (!lidKey || !finalRealPhone) return res.status(400).json({ success: false, message: 'Teléfono inválido' });
        if (lidKey === finalRealPhone) return res.status(400).json({ success: false, message: 'El LID y el teléfono real son el mismo' });

        const merged = await migrateLidUserToPhone(lidKey, finalRealPhone);

        // Registrar el mapping para que GET /users y GET /contacts lo
        // expongan y el panel fusione las filas. Solo se guarda cuando la
        // clave parece un LID (un telefono real normalizado tiene 12 digitos
        // y un LID 15); una correccion de numero entre telefonos reales no
        // va en lid_map.json.
        if (lidKey.length > 12) {
            const lidMap = getLidMap();
            if (lidMap[lidKey] !== finalRealPhone) {
                lidMap[lidKey] = finalRealPhone;
                saveLidMap(lidMap);
            }
        }

        botEvents.emit('user_update', { phone: finalRealPhone });
        res.json({ success: true, merged });
    } catch (e) {
        console.error('❌ Error en link-lid:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});


router.post('/contacts/toggle', async (req, res) => {
    try {
        const { phone, enable, bot_enabled } = req.body;
        const targetPhone = normalizePhone(phone);
        const finalEnableState = bot_enabled !== undefined ? bot_enabled : enable;

        await updateUser(targetPhone, { bot_enabled: finalEnableState });
        const result = toggleContactBot(targetPhone, finalEnableState);
        
        res.json(result || { success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/contacts/delete', async (req, res) => {
    const deleted = deleteUser(normalizePhone(req.body.phone));
    res.json({ success: deleted });
});

// ==========================================
// 💬 RUTAS DE MENSAJERÍA
// ==========================================
router.post('/send-message', async (req, res) => {
    try {
        const { phone, text, mediaUrl } = req.body;
        
        const targetPhone = normalizePhone(phone);
        
        if (!messageSender.esSimulador(targetPhone) && (waService.status !== 'connected' || !waService.sock)) {
            return res.status(503).json({ error: "Bot offline" });
        }

        await messageSender.send(waService.sock, targetPhone, text, mediaUrl);
        
        res.json({ success: true });
    } catch (e) {
        console.error("❌ Error en send-message:", e);
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 📅 RUTAS DE AGENDA (Totalmente Asíncronas)
// ==========================================
router.get('/agenda', async (req, res) => {
    try {
        const agenda = await agendaService.getAgenda();
        res.json(agenda);
    } catch (e) {
        res.status(500).json({ error: "Error leyendo agenda" });
    }
});

router.post('/agenda/book', async (req, res) => {
    try {
        const { date, time, phone, name, note } = req.body;
        if (!date || !time) return res.status(400).json({ success: false, message: 'Faltan datos' });

        // 1) Fecha pasada: ni se intenta reservar
        if (agendaService.isDateInPast(date, time)) {
            return res.json({ success: false, message: 'Esa fecha ya pasó. Elige una fecha futura.' });
        }

        // 2) Reglas de negocio: día cerrado, fuera de horario o intervalo inválido
        const rules = agendaService.validateBusinessRules(time, date);
        if (!rules.valid) {
            return res.json({ success: false, message: rules.reason });
        }

        // 3) Pre-chequeo rápido (el resultado que manda es el de bookAppointment,
        // que es atómico: si dos paneles piden el mismo hueco a la vez, solo uno gana)
        const isAvailable = await agendaService.checkAvailability(date, time);
        if (!isAvailable) return res.json({ success: false, message: 'Horario ocupado' });

        const targetPhone = phone ? normalizePhone(phone) : '';
        // JID guardado o de respaldo LID/teléfono; antes siempre era
        // @s.whatsapp.net, un JID inexistente para usuarios LID.
        const user = targetPhone ? getUser(targetPhone) : null;
        const targetJid = (user && user.jid) || fallbackJid(targetPhone);

        const booked = await agendaService.bookAppointment(date, time, targetPhone, name || 'Evento', targetJid, note);
        if (!booked) {
            return res.json({ success: false, message: 'Horario ocupado' });
        }

        res.json({ success: true, message: 'Cita agendada correctamente' });
    } catch (e) {
        console.error("❌ Error agendando cita:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/agenda/delete', async (req, res) => {
    try {
        const { date, time } = req.body;
        const db = await agendaService.getAgenda();
        
        if (db[date]) {
            db[date] = db[date].filter(c => c.time !== time);
            if (db[date].length === 0) delete db[date];
            await agendaService.saveAgenda(db);
            res.json({ success: true });
        } else {
            res.json({ success: false });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: "Error borrando cita" });
    }
});

// ==========================================
// ⚙️ RUTAS DE CONFIGURACIÓN Y ESTADO
// ==========================================
router.get('/status', (req, res) => {
    const sessionExists = waService.status !== 'rebooting' && require('fs').existsSync(path.join(__dirname, '../auth_info_baileys'));
    res.json({
        status: waService.status,
        isConnected: waService.status === 'connected',
        qr: waService.qr,
        sessionExists,
        statusString: waService.status
    });
});

// 💾 Respaldo = el archivo crm.db, tal cual (sin cifrar ni comprimir).
// Descargar baja el crm.db directo; Cargar acepta solo un crm.db suelto.
// Al descargar se vacía el WAL para que el archivo sea autoconsistente.
router.get('/backup/download', (req, res) => {
    try {
        try { getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
        const dbPath = path.join(__dirname, '../data/crm.db');
        if (!fs.existsSync(dbPath)) {
            return res.status(404).json({ success: false, error: 'Todavía no hay base de datos (crm.db).' });
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="crm.db"');
        res.sendFile(dbPath);
    } catch (e) {
        console.error('Error descargando crm.db:', e.message);
        res.status(500).json({ success: false, error: 'No se pudo descargar el crm.db.' });
    }
});
const backupUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
router.post('/backup/restore', backupUpload.single('backup'), (req, res) => {
    try {
        if (!req.file || !req.file.buffer) {
            return res.status(400).json({ success: false, error: 'No se recibió ningún archivo.' });
        }
        const buf = req.file.buffer;
        // Solo se acepta un crm.db suelto (empieza con "SQLite format 3").
        if (!(buf.length >= 15 && buf.subarray(0, 15).toString('latin1') === 'SQLite format 3')) {
            return res.status(400).json({ success: false, error: 'Solo se acepta un archivo crm.db.' });
        }
        const dataDir = path.join(__dirname, '../data');
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        try { closeDb(); } catch (e) {}
        for (const suffix of ['-wal', '-shm']) {
            try { fs.unlinkSync(path.join(dataDir, 'crm.db' + suffix)); } catch (e) {}
        }
        fs.writeFileSync(path.join(dataDir, 'crm.db'), buf);
        // Recargar la BD para que el panel lea lo restaurado.
        initializeDB();
        res.json({ success: true, restored: 1, type: 'crm.db' });
    } catch (e) {
        console.error('Error restaurando crm.db:', e.message);
        res.status(400).json({ success: false, error: e.message || 'No se pudo cargar el crm.db.' });
    }
});

router.post('/auth/init', (req, res) => {
    if (waService.status === 'disconnected') {
        waService.connect();
        res.json({ message: 'Iniciando conexión...' });
    } else {
        res.json({ message: `Ya en proceso (${waService.status})` });
    }
});

router.post('/logout', async (req, res) => {
    try {
        waService.status = 'rebooting';
        waService.qr = null;
        if (waService.sock) {
            try { await waService.sock.logout(); } catch (e) { }
            try { waService.sock.end(undefined); } catch (e) { }
            waService.sock = null;
        }
        
        await new Promise(r => setTimeout(r, 500)); // Pausa de seguridad
        
        const authPath = path.join(__dirname, '../auth_info_baileys');
        if (require('fs').existsSync(authPath)) {
            require('fs').rmSync(authPath, { recursive: true, force: true });
        }
        
        waService.status = 'disconnected';
        waService.connect();
        res.json({ success: true, message: 'Reinicio completado.' });
    } catch (e) { 
        res.status(500).json({ error: 'Error al reiniciar' }); 
    }
});

// ==========================================
// 🤖 RUTAS DE SISTEMA (Flow, Settings, etc)
// ==========================================
router.get('/keywords', (req, res) => res.json(getKeywords()));
router.post('/keywords', (req, res) => res.json({ success: true, rule: saveKeyword(req.body) }));
router.delete('/keywords/:id', (req, res) => { deleteKeyword(req.params.id); res.json({ success: true }); });

router.get('/flow', (req, res) => res.json(getFullFlow()));
router.post('/flow/step', async (req, res) => { await saveFlowStep(req.body.stepId, req.body.stepData); res.json({ success: true }); });
router.delete('/flow/step/:id', async (req, res) => { await deleteFlowStep(req.params.id); res.json({ success: true }); });

// 🔥 ESCUDO PARA LA INTERFAZ
router.get('/users', (req, res) => {
    const lidToPhone = getLidToPhoneMap();
    const users = getAllUsers().map(u => {
        const out = { ...u, phone: normalizePhone(u.phone) };
        // El registro del telefono real lleva su LID, si se conoce.
        Object.keys(lidToPhone).forEach(lid => { if (lidToPhone[lid] === out.phone) out.lid = lid; });
        return out;
    });
    res.json(users);
});

// 📊 Exportar contactos a Excel (.xlsx real, sin dependencias nuevas).
// Un .xlsx es un ZIP con XMLs: se construye a mano con zlib (deflate) y
// un CRC32 implementado aquí (Node no trae uno).
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipFiles(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const f of files) {
        const nameBuf = Buffer.from(f.name, 'utf8');
        const deflated = zlib.deflateRawSync(f.data);
        const crc = crc32(f.data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(deflated.length, 18);
        local.writeUInt32LE(f.data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, nameBuf, deflated);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(deflated.length, 20);
        central.writeUInt32LE(f.data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBuf);
        offset += 30 + nameBuf.length + deflated.length;
    }
    const centralDir = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralDir.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    return Buffer.concat([...localParts, centralDir, end]);
}
function escapeXml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function buildContactsXlsx(contacts) {
    const headers = ['Teléfono', 'Nombre', 'Bot activado', 'Última sincronización', 'Fecha de alta'];
    const colLetter = (i) => String.fromCharCode(65 + i);
    let rowsXml = '';
    const allRows = [headers, ...contacts.map(c => [
        c.phone || '',
        c.name || '',
        c.bot_enabled === undefined ? '' : (c.bot_enabled ? 'Sí' : 'No'),
        c.last_synced || '',
        c.added_at || ''
    ])];
    allRows.forEach((row, ri) => {
        const r = ri + 1;
        const style = ri === 0 ? ' s="1"' : '';
        rowsXml += `<row r="${r}">`;
        row.forEach((val, ci) => {
            rowsXml += `<c r="${colLetter(ci)}${r}" t="inlineStr"${style}><is><t>${escapeXml(val)}</t></is></c>`;
        });
        rowsXml += '</row>';
    });
    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`;
    const files = [
        { name: '[Content_Types].xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`, 'utf8') },
        { name: '_rels/.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`, 'utf8') },
        { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contactos" sheetId="1" r:id="rId1"/></sheets></workbook>`, 'utf8') },
        { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`, 'utf8') },
        { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml, 'utf8') },
        { name: 'xl/styles.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`, 'utf8') }
    ];
    return zipFiles(files);
}
router.get('/contacts/export', (req, res) => {
    try {
        const contacts = getAllContacts();
        const xlsx = buildContactsXlsx(contacts);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="contactos.xlsx"');
        res.send(xlsx);
    } catch (e) {
        console.error('Error exportando contactos:', e.message);
        res.status(500).json({ success: false, error: 'No se pudo generar el Excel.' });
    }
});

router.get('/contacts', (req, res) => {
    const lidToPhone = getLidToPhoneMap();
    const contacts = getAllContacts().map(c => {
        const out = { ...c, phone: normalizePhone(c.phone) };
        Object.keys(lidToPhone).forEach(lid => { if (lidToPhone[lid] === out.phone) out.lid = lid; });
        return out;
    });
    res.json(contacts);
});

router.get('/settings', (req, res) => {
    const current = getSettings();
    if (!current.customVars) current.customVars = {};
    // 🔥 FIX: Devolver el objeto directamente para que coincida con el frontend
    res.json(current); 
});

router.post('/settings', async (req, res) => {
    const current = getSettings();
    const newSettings = req.body;

    // Merge recursivo (deep merge): el merge anterior era de un solo nivel,
    // así que guardar `schedule.days` con un solo día reemplazaba todos los
    // demás días. Ahora cada día se fusiona con el que ya existía.
    const deepMerge = (base, incoming) => {
        const out = { ...(base || {}) };
        for (const key in incoming) {
            const inVal = incoming[key];
            const baseVal = out[key];
            if (inVal !== null && typeof inVal === 'object' && !Array.isArray(inVal)
                && baseVal !== null && typeof baseVal === 'object' && !Array.isArray(baseVal)) {
                out[key] = deepMerge(baseVal, inVal);
            } else {
                out[key] = inVal;
            }
        }
        return out;
    };

    const updatedSettings = deepMerge(current, newSettings);

    delete updatedSettings.ai_config; // Protección de seguridad
    await saveSettings(updatedSettings);
    res.json({ success: true });
});

router.post('/upload', upload.array('images', 10), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
    res.json({ urls: req.files.map(f => '/uploads/' + f.filename) });
});

module.exports = router;