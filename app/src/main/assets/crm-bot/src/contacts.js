// ==========================================
// 👥 contacts.js — SQLite (node:sqlite)
//
// Misma API pública que la versión JSON. Cambia solo el almacén:
// antes había DOS copias de contacts.json en memoria (la caché de
// este módulo y la de database.js, que la cargaba sin usarla) y cada
// una escribía el archivo por su lado. Ahora hay una sola tabla
// `contacts` en data/crm.db, compartida con database.js a través de
// la misma conexión (getDb), así que el panel y el bot ya no pueden
// divergir.
//
// Sin cambios para quien lo importa: syncContacts, getAllContacts,
// toggleContactBot, isBotDisabled, addManualContact, removeContact.
// ==========================================
const { getDb, withTransaction } = require('./database');

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
// 🚀 FUNCIONES CORE
// ==========================================

function addManualContact(phone, name, enabled) {
    const db = getDb();
    const cleanPhone = normalizePhone(phone);
    if (!cleanPhone) return { success: false, message: 'Teléfono inválido' };

    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(cleanPhone);

    if (existing) {
        const newName = (name && name !== cleanPhone) ? name : existing.name;
        const newEnabled = (typeof enabled === 'boolean') ? (enabled ? 1 : 0) : existing.bot_enabled;
        db.prepare('UPDATE contacts SET name = ?, bot_enabled = ?, phone = ?, last_synced = ? WHERE phone = ?')
            .run(newName, newEnabled, cleanPhone, now, cleanPhone);
        console.log(`✏️ Contacto actualizado: ${name} (${cleanPhone}) | Bot: ${newEnabled ? 'ACTIVO' : 'PAUSADO'}`);
        return { success: true, message: 'Actualizado' };
    }

    const jid = `${cleanPhone}@s.whatsapp.net`;

    db.prepare(`INSERT INTO contacts(phone, jid, name, bot_enabled, last_synced, added_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(
        cleanPhone, jid, name || cleanPhone,
        enabled !== undefined ? (enabled ? 1 : 0) : 1, now, now);

    console.log(`👤 Nuevo contacto guardado: ${name} (${cleanPhone})`);
    return { success: true, message: 'Creado' };
}

function syncContacts(waContacts) {
    if (!waContacts || waContacts.length === 0) return;
    withTransaction(() => {
        const db = getDb();
        const now = new Date().toISOString();

        waContacts.forEach(waContact => {
            const jid = waContact.id;
            const phone = normalizePhone(jid);
            if (!phone) return;

            const localContact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
            const name = waContact.name || waContact.notify || waContact.verifiedName || phone;

            if (localContact) {
                if (localContact.name !== name && name !== phone) {
                    db.prepare('UPDATE contacts SET name = ?, last_synced = ? WHERE phone = ?')
                        .run(name, now, phone);
                }
            } else {
                db.prepare(`INSERT INTO contacts(phone, jid, name, bot_enabled, last_synced, added_at)
                    VALUES (?, ?, ?, 0, ?, ?)`).run(phone, `${phone}@s.whatsapp.net`, name, now, now);
            }
        });
    });
}

function getAllContacts() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM contacts').all();
    return rows.map(c => ({
        phone: c.phone,
        name: c.name,
        bot_enabled: c.bot_enabled === null || c.bot_enabled === undefined ? undefined : !!c.bot_enabled,
        last_synced: c.last_synced,
        added_at: c.added_at
    })).sort((a, b) => (b.added_at || '').localeCompare(a.added_at || ''));
}

function toggleContactBot(phoneOrJid, enable) {
    const db = getDb();
    const cleanId = normalizePhone(phoneOrJid);

    const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(cleanId);
    if (contact) {
        db.prepare('UPDATE contacts SET bot_enabled = ? WHERE phone = ?')
            .run(enable ? 1 : 0, cleanId);
        return { success: true, newState: enable };
    }
    return { success: false, message: 'Contacto no encontrado' };
}

function isBotDisabled(jid) {
    const db = getDb();
    const cleanId = normalizePhone(jid);

    const contact = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(cleanId);
    return contact ? (contact.bot_enabled === 0) : false;
}

// Elimina un contacto por teléfono o JID (lo usa la fusión LID → teléfono
// para quitar la entrada vieja bajo la clave LID, que si no quedaría
// duplicada en el panel).
function removeContact(phoneOrJid) {
    const db = getDb();
    const cleanId = normalizePhone(phoneOrJid);
    const info = db.prepare('DELETE FROM contacts WHERE phone = ?').run(cleanId);
    return info.changes > 0;
}

module.exports = { syncContacts, getAllContacts, toggleContactBot, isBotDisabled, addManualContact, removeContact };
