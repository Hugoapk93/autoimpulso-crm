const fs = require('fs');
const fsAsync = require('fs').promises; // 🔥 Usado para guardado no bloqueante
const path = require('path');

const contactsPath = path.join(__dirname, '../data/contacts.json');

// ==========================================
// 🧠 ESTADO EN MEMORIA (CACHE)
// ==========================================
let contactsCache = [];
let isCacheLoaded = false;
let writeLock = Promise.resolve();

// Carga inicial (Solo ocurre una vez al arrancar el servidor)
const loadCache = () => {
    if (isCacheLoaded) return;
    try {
        if (fs.existsSync(contactsPath)) {
            contactsCache = JSON.parse(fs.readFileSync(contactsPath, 'utf-8'));
        }
    } catch (e) {
        // JSON corrupto: antes se iniciaba con la caché vacía y el siguiente
        // persistCache sobrescribía el archivo, perdiendo los contactos.
        // Se respalda primero, igual que en database.js.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${contactsPath}.corrupto-${stamp}`;
        try {
            fs.renameSync(contactsPath, backupPath);
            console.error(`⚠️ Error cargando caché de contactos (JSON corrupto). Respaldo en ${backupPath}. Iniciando vacío.`);
        } catch (backupErr) {
            console.error(`⚠️ Error cargando caché de contactos y NO se pudo respaldar (${backupErr.message}). Iniciando vacío.`);
        }
        contactsCache = [];
    }
    isCacheLoaded = true;
};

// Persistencia Asíncrona (No bloquea el Event Loop)
const persistCache = () => {
    writeLock = writeLock.then(async () => {
        const tempPath = `${contactsPath}.${Date.now()}.tmp`;
        try {
            await fsAsync.writeFile(tempPath, JSON.stringify(contactsCache, null, 2));
            await fsAsync.rename(tempPath, contactsPath);
        } catch (e) {
            console.error("🔥 Error crítico guardando contactos en disco:", e);
        }
    }).catch(() => {});
};

// ==========================================
// 🛠️ UTILIDADES SEGURAS DE TELÉFONO
// ==========================================
// Reemplaza el frágil "getLast10" por una normalización blindada
const normalizePhone = (jidOrPhone) => {
    if (!jidOrPhone) return '';
    let clean = String(jidOrPhone).split('@')[0].replace(/\D/g, '');
    
    if (clean.startsWith('52') && clean.length >= 12) {
        return '52' + clean.slice(clean.length === 13 ? 3 : 2);
    }
    if (clean.length === 10) return '52' + clean;
    return clean;
};

// ==========================================
// 🚀 FUNCIONES CORE (Operan en O(1) u O(N) en RAM)
// ==========================================

function addManualContact(phone, name, enabled) {
    loadCache();
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return { success: false, message: 'Teléfono inválido' };

    let existingContact = contactsCache.find(c => normalizePhone(c.phone) === cleanPhone);

    if (existingContact) {
        if (name && name !== cleanPhone) existingContact.name = name;
        
        if (typeof enabled === 'boolean') {
            existingContact.bot_enabled = enabled;
        }

        existingContact.phone = cleanPhone; 
        existingContact.last_synced = new Date().toISOString();
        
        persistCache();
        console.log(`✏️ Contacto actualizado en caché: ${name} (${cleanPhone}) | Bot: ${existingContact.bot_enabled ? 'ACTIVO' : 'PAUSADO'}`);
        return { success: true, message: 'Actualizado' };
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;

    contactsCache.push({
        phone: cleanPhone,
        jid: jid,
        name: name || cleanPhone,
        bot_enabled: enabled !== undefined ? enabled : true,
        last_synced: new Date().toISOString(),
        added_at: new Date().toISOString()
    });

    persistCache();
    console.log(`👤 Nuevo contacto guardado en caché: ${name} (${cleanPhone})`);
    return { success: true, message: 'Creado' };
}

function syncContacts(waContacts) {
    if (!waContacts || waContacts.length === 0) return;
    loadCache();
    
    const now = new Date().toISOString();
    let hasChanges = false;

    waContacts.forEach(waContact => {
        const jid = waContact.id;
        const phone = normalizePhone(jid);
        if (!phone) return;
        
        let localContact = contactsCache.find(c => normalizePhone(c.phone) === phone);
        const name = waContact.name || waContact.notify || waContact.verifiedName || phone;

        if (localContact) {
            if (localContact.name !== name && name !== phone) {
                localContact.name = name;
                localContact.last_synced = now;
                hasChanges = true;
            }
        } else {
            contactsCache.push({
                phone: phone,
                jid: `${phone}@s.whatsapp.net`,
                name: name,
                bot_enabled: false, // Regla de seguridad
                last_synced: now,
                added_at: now
            });
            hasChanges = true;
        }
    });

    if (hasChanges) persistCache();
}

function getAllContacts() {
    loadCache();
    return contactsCache.map(c => ({
        phone: c.phone, 
        name: c.name, 
        bot_enabled: c.bot_enabled,
        last_synced: c.last_synced, 
        added_at: c.added_at
    })).sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''));
}

function toggleContactBot(phoneOrJid, enable) {
    loadCache();
    const cleanId = normalizePhone(phoneOrJid);
    
    let contact = contactsCache.find(c => normalizePhone(c.phone) === cleanId);

    if (contact) {
        contact.bot_enabled = enable;
        persistCache();
        return { success: true, newState: enable };
    }
    return { success: false, message: 'Contacto no encontrado' };
}

function isBotDisabled(jid) {
    loadCache();
    const cleanId = normalizePhone(jid);
    
    let contact = contactsCache.find(c => normalizePhone(c.phone) === cleanId);
    return contact ? (contact.bot_enabled === false) : false;
}

// Elimina un contacto por teléfono o JID (lo usa la fusión LID → teléfono
// para quitar la entrada vieja bajo la clave LID, que si no quedaría
// duplicada en el panel).
function removeContact(phoneOrJid) {
    loadCache();
    const cleanId = normalizePhone(phoneOrJid);
    const idx = contactsCache.findIndex(c => normalizePhone(c.phone) === cleanId);
    if (idx === -1) return false;
    contactsCache.splice(idx, 1);
    persistCache();
    return true;
}

module.exports = { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact, removeContact };