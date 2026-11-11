const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 1. 🛠️ Importaciones de Utilidades
const { normalizePhone } = require('./utils');

// 2. 🗄️ Importaciones de la Base de Datos
const { 
    getKeywords, saveKeyword, deleteKeyword, 
    getFullFlow, saveFlowStep, deleteFlowStep, 
    getSettings, saveSettings, 
    getAllUsers, updateUser, getUser, deleteUser
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
// --- Mapa LID -> telefono real (data/lid_map.json, lo escribe whatsapp.js) ---
// GET /users y GET /contacts lo exponen como `lid` para que el panel pueda
// fusionar en una sola fila el registro LID y el del telefono real.
// POST /contacts/link-lid usa la misma fusion que la Fase 3 del backend
// (migrateLidUser en whatsapp.js), aqui como funcion local para no
// depender del cliente de Baileys desde el router.
const lidMapPath = path.join(__dirname, '../data/lid_map.json');
function getLidMap() {
    try {
        if (!fs.existsSync(lidMapPath)) return {};
        const data = JSON.parse(fs.readFileSync(lidMapPath, 'utf-8'));
        return (data && typeof data === 'object') ? data : {};
    } catch (e) { return {}; }
}
function saveLidMap(data) {
    try { fs.writeFileSync(lidMapPath, JSON.stringify(data, null, 2)); } catch (e) { console.error('Error guardando lid_map.json:', e.message); }
}
// lid (digitos) -> telefono real, a partir de lid_map.json.
function getLidToPhoneMap() {
    const map = {};
    const lidMap = getLidMap();
    Object.keys(lidMap).forEach(lid => { map[normalizePhone(lid)] = normalizePhone(lidMap[lid]); });
    return map;
}

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