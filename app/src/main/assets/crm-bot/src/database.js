// ==========================================
// 🗄️ database.js — SQLite (node:sqlite)
//
// Reemplaza los 6 JSON de data/ (users, flow, settings, keywords,
// contacts, subscriptions) + lid_map.json y agenda.json, que ahora viven
// en data/crm.db. No requiere instalar nada: `node:sqlite` viene
// incluido en Node 24 (el proyecto corre en v24.21.0) y es síncrono,
// igual que los getters antiguos (getUser, getSettings...).
//
// API PÚBLICA: idéntica a la versión JSON. Ningún otro módulo cambia
// por este archivo: mismos nombres, mismos argumentos, mismos valores
// de retorno. Lo único añadido son exports extra al final
// (getLidMap, saveLidMap, getLidToPhoneMap, getDb, withTransaction,
// migrateFromJson, closeDb) que usan api.js, whatsapp.js, contacts.js,
// agendaService.js y el script de migración.
//
// Decisiones de diseño (ver NOTAS.md):
// - Una sola conexión compartida (getDb) para todo el proceso, con
//   WAL: las escrituras son atómicas y duraderas en cuanto la función
//   retorna (antes había un debounce de 200 ms y el dato se perdía si
//   el proceso moría en esa ventana). El candado en memoria de la
//   agenda no protegía entre procesos; la transacción + UNIQUE sí.
// - Los objetos flexibles (flow, settings, keywords, subscriptions)
//   se guardan como JSON en una columna: el bot añade campos nuevos
//   sin migraciones de esquema. Usuarios, mensajes, contactos y citas
//   sí son tablas normalizadas: ahí es donde importan la atomicidad
//   (reserva, reacción, borrado) y las consultas por clave.
// - Los getters devuelven COPIAS, no la referencia viva de antes.
//   Nadie dependía de mutar el retorno sin llamar a updateUser /
//   saveSettings después (revisado en todos los llamadores), y así
//   una mutación accidental ya no cambia la BD sin guardar.
// - `undefined` en updateUser significa "no tocar ese campo" (antes
//   el spread lo ponía en undefined y JSON lo borraba al guardar, lo
//   que podía desactivar la pausa del bot por accidente).
// ==========================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normalizePhone } = require('./utils');

const dataDir = path.join(__dirname, '../data');
const dbPath = path.join(dataDir, 'crm.db');

// Rutas de los JSON antiguos. Solo las usa la migración (una vez);
// el bot ya no las lee ni las escribe.
const jsonPaths = {
    users: path.join(dataDir, 'users.json'),
    flow: path.join(dataDir, 'flow.json'),
    settings: path.join(dataDir, 'settings.json'),
    keywords: path.join(dataDir, 'keywords.json'),
    contacts: path.join(dataDir, 'contacts.json'),
    subscriptions: path.join(dataDir, 'subscriptions.json'),
    agenda: path.join(dataDir, 'agenda.json'),
    lidMap: path.join(dataDir, 'lid_map.json')
};

const DEFAULT_SETTINGS = { schedule: { active: false, days: {} } };

let db = null;

// ==========================================
// 🔌 APERTURA Y ESQUEMA
// ==========================================
function ensureDb() {
    if (db) return db;
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(dbPath);
    // WAL: lectores no bloquean al escritor y viceversa; un corte de luz
    // no deja el archivo a medias (la transacción se confirma o no).
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            phone TEXT PRIMARY KEY,
            name TEXT,
            jid TEXT,
            lid TEXT,
            current_step TEXT,
            bot_enabled INTEGER,
            archived INTEGER NOT NULL DEFAULT 0,
            last_message TEXT,
            last_active TEXT,
            unread_count INTEGER,
            error_count INTEGER,
            blocked INTEGER,
            history TEXT NOT NULL DEFAULT '{}',
            extra TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
            msg_id TEXT,
            text TEXT,
            media_url TEXT,
            from_me INTEGER,
            step_id TEXT,
            timestamp TEXT,
            type TEXT,
            quoted TEXT,
            reaction TEXT,
            deleted INTEGER NOT NULL DEFAULT 0,
            extra TEXT NOT NULL DEFAULT '{}',
            UNIQUE(phone, msg_id)
        );
        CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
        CREATE TABLE IF NOT EXISTS flow_steps (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS kv (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS keywords (
            id TEXT PRIMARY KEY,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscriptions (
            endpoint TEXT PRIMARY KEY,
            data TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS contacts (
            phone TEXT PRIMARY KEY,
            jid TEXT,
            name TEXT,
            bot_enabled INTEGER,
            last_synced TEXT,
            added_at TEXT,
            extra TEXT NOT NULL DEFAULT '{}'
        );
        CREATE TABLE IF NOT EXISTS agenda (
            date TEXT NOT NULL,
            time TEXT NOT NULL,
            phone TEXT,
            name TEXT,
            jid TEXT,
            note TEXT,
            created_at TEXT,
            recordatorio_enviado INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY(date, time)
        );
        CREATE TABLE IF NOT EXISTS lid_map (
            lid TEXT PRIMARY KEY,
            phone TEXT NOT NULL
        );
    `);
    return db;
}

function getDb() { return ensureDb(); }

function closeDb() {
    if (!db) return;
    try { db.close(); } catch (e) { /* ya cerrada */ }
    db = null;
}

// Ejecuta fn dentro de una transacción inmediata (un solo escritor).
// Si ya hay una transacción abierta (p. ej. updateUser llamado desde
// la migración), ejecuta fn sin abrir otra.
function withTransaction(fn) {
    const conn = ensureDb();
    if (conn.isTransaction) return fn();
    conn.exec('BEGIN IMMEDIATE');
    try {
        const result = fn();
        conn.exec('COMMIT');
        return result;
    } catch (e) {
        try { conn.exec('ROLLBACK'); } catch (_) { /* sin transacción */ }
        throw e;
    }
}

// ==========================================
// 🛠️ AYUDAS INTERNAS
// ==========================================
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const parseJson = (text, fallback) => {
    try { const v = JSON.parse(text); return v === null || v === undefined ? fallback : v; }
    catch (e) { return fallback; }
};
const boolToInt = (v) => (v === undefined || v === null ? null : (v ? 1 : 0));

// Campos conocidos del usuario; todo lo demás va a la columna `extra`
// y se devuelve mezclado al reconstruir, como antes.
const USER_KNOWN = new Set(['phone', 'history', 'messages', 'newMessage', 'name', 'jid', 'lid',
    'current_step', 'bot_enabled', 'archived', 'last_message', 'last_active',
    'unreadCount', 'error_count', 'blocked']);
const MSG_KNOWN = new Set(['id', 'text', 'mediaUrl', 'fromMe', 'stepId', 'timestamp',
    'type', 'quoted', 'reaction', 'deleted']);

function messageRowToObject(row) {
    if (!row) return null;
    const m = {};
    if (row.msg_id !== null && row.msg_id !== undefined) m.id = row.msg_id;
    if (row.text !== null && row.text !== undefined) m.text = row.text;
    m.mediaUrl = row.media_url === null || row.media_url === undefined ? null : row.media_url;
    if (row.from_me !== null && row.from_me !== undefined) m.fromMe = !!row.from_me;
    if (row.step_id !== null && row.step_id !== undefined) m.stepId = row.step_id;
    if (row.timestamp !== null && row.timestamp !== undefined) m.timestamp = row.timestamp;
    if (row.type !== null && row.type !== undefined) m.type = row.type;
    if (row.quoted !== null && row.quoted !== undefined) m.quoted = parseJson(row.quoted, null);
    else m.quoted = null;
    m.reaction = row.reaction === null || row.reaction === undefined ? null : row.reaction;
    m.deleted = !!row.deleted;
    const extra = parseJson(row.extra || '{}', {});
    return { ...extra, ...m };
}

function userRowToObject(row, messages) {
    if (!row) return {};
    const history = parseJson(row.history || '{}', {});
    const extra = parseJson(row.extra || '{}', {});
    const u = { ...extra };
    u.phone = row.phone;
    u.history = history;
    u.messages = messages || [];
    if (row.current_step !== null && row.current_step !== undefined) u.current_step = row.current_step;
    if (row.name !== null && row.name !== undefined) u.name = row.name;
    if (row.jid !== null && row.jid !== undefined) u.jid = row.jid;
    if (row.lid !== null && row.lid !== undefined) u.lid = row.lid;
    if (row.bot_enabled !== null && row.bot_enabled !== undefined) u.bot_enabled = !!row.bot_enabled;
    if (row.archived) u.archived = true;
    if (row.last_message !== null && row.last_message !== undefined) u.last_message = row.last_message;
    if (row.last_active !== null && row.last_active !== undefined) u.last_active = row.last_active;
    if (row.unread_count !== null && row.unread_count !== undefined) u.unreadCount = row.unread_count;
    if (row.error_count !== null && row.error_count !== undefined) u.error_count = row.error_count;
    if (row.blocked !== null && row.blocked !== undefined) u.blocked = !!row.blocked;
    return u;
}

function getUserMessages(phone) {
    const rows = ensureDb().prepare('SELECT * FROM messages WHERE phone = ? ORDER BY id').all(phone);
    return rows.map(messageRowToObject);
}

// INSERT OR REPLACE: si el mensaje ya existe (mismo phone + msg_id) se
// actualiza en su sitio; si no tiene id (simulador), msg_id es NULL y
// UNIQUE lo deja insertar como fila nueva, igual que el push de antes.
function insertMessageRow(phone, m) {
    if (!m || typeof m !== 'object') return;
    const extra = {};
    for (const k of Object.keys(m)) if (!MSG_KNOWN.has(k)) extra[k] = m[k];
    ensureDb().prepare(`INSERT OR REPLACE INTO messages
        (phone, msg_id, text, media_url, from_me, step_id, timestamp, type, quoted, reaction, deleted, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        phone,
        m.id === undefined || m.id === null ? null : String(m.id),
        m.text === undefined || m.text === null ? null : String(m.text),
        m.mediaUrl === undefined || m.mediaUrl === null ? null : String(m.mediaUrl),
        boolToInt(m.fromMe),
        m.stepId === undefined || m.stepId === null ? null : String(m.stepId),
        m.timestamp === undefined || m.timestamp === null ? null : String(m.timestamp),
        m.type === undefined || m.type === null ? null : String(m.type),
        m.quoted === undefined || m.quoted === null ? null : JSON.stringify(m.quoted),
        m.reaction === undefined || m.reaction === null ? null : String(m.reaction),
        m.deleted ? 1 : 0,
        JSON.stringify(extra)
    );
}

// Escribe (o reescribe) la fila del usuario a partir del objeto completo.
// Sin transacción propia: la abre quien la llama.
function upsertUserRow(user) {
    const extra = {};
    for (const k of Object.keys(user)) if (!USER_KNOWN.has(k)) extra[k] = user[k];
    ensureDb().prepare(`INSERT INTO users
        (phone, name, jid, lid, current_step, bot_enabled, archived, last_message, last_active, unread_count, error_count, blocked, history, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET
        name = excluded.name, jid = excluded.jid, lid = excluded.lid,
        current_step = excluded.current_step, bot_enabled = excluded.bot_enabled,
        archived = excluded.archived, last_message = excluded.last_message,
        last_active = excluded.last_active, unread_count = excluded.unread_count,
        error_count = excluded.error_count, blocked = excluded.blocked,
        history = excluded.history, extra = excluded.extra`).run(
        user.phone,
        user.name === undefined ? null : String(user.name),
        user.jid === undefined ? null : String(user.jid),
        user.lid === undefined ? null : String(user.lid),
        user.current_step === undefined ? 'BIENVENIDA' : String(user.current_step),
        boolToInt(user.bot_enabled),
        user.archived ? 1 : 0,
        user.last_message === undefined ? null : String(user.last_message),
        user.last_active === undefined ? null : String(user.last_active),
        user.unreadCount === undefined || user.unreadCount === null ? null : Number(user.unreadCount),
        user.error_count === undefined || user.error_count === null ? null : Number(user.error_count),
        boolToInt(user.blocked),
        JSON.stringify(user.history || {}),
        JSON.stringify(extra)
    );
    ensureDb().prepare('DELETE FROM messages WHERE phone = ?').run(user.phone);
    for (const m of (user.messages || [])) insertMessageRow(user.phone, m);
}

// ==========================================
// 🚀 INICIALIZACIÓN Y MIGRACIÓN AUTOMÁTICA
// ==========================================
function normalizeStepId(id) {
    if (!id) return '';
    return String(id).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
}

function runFlowMigration() {
    const conn = ensureDb();
    const rows = conn.prepare('SELECT id, data FROM flow_steps').all();
    let hasChanges = false;
    const renamed = [];
    for (const row of rows) {
        const step = parseJson(row.data, {});
        const normKey = normalizeStepId(row.id);
        if (step.next_step) {
            const normNext = normalizeStepId(step.next_step);
            if (step.next_step !== normNext) { step.next_step = normNext; hasChanges = true; }
        }
        if (step.options) {
            step.options.forEach(opt => {
                if (opt.next_step) {
                    const normNext = normalizeStepId(opt.next_step);
                    if (opt.next_step !== normNext) { opt.next_step = normNext; hasChanges = true; }
                }
            });
        }
        if (normKey !== row.id) { renamed.push([row.id, normKey, step]); hasChanges = true; }
        else if (hasChanges) { conn.prepare('UPDATE flow_steps SET data = ? WHERE id = ?').run(JSON.stringify(step), row.id); }
    }
    for (const [oldId, newId, step] of renamed) {
        conn.prepare('DELETE FROM flow_steps WHERE id = ?').run(oldId);
        conn.prepare('INSERT OR REPLACE INTO flow_steps(id, data) VALUES (?, ?)').run(newId, JSON.stringify(step));
    }
    if (hasChanges) console.log("🧹 Migración de tarjetas completada.");
}

function initializeDB() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const isNewDb = !fs.existsSync(dbPath);
    ensureDb();
    // Primera vez con SQLite y JSON antiguos presentes: migrar solos.
    // Si ya existe crm.db con datos, no se toca nada.
    if (isNewDb) {
        const report = migrateFromJson({ auto: true });
        if (report.migrated) {
            console.log(`🗄️ Migrados desde JSON: ${report.counts.users} usuarios, ${report.counts.flow} pasos, ${report.counts.keywords} keywords, ${report.counts.contacts} contactos, ${report.counts.agenda} citas, ${report.counts.subscriptions} suscripciones, ${report.counts.lidMap} mappings LID. Respaldo en ${report.backupDir}`);
        }
    }
    runFlowMigration();
    console.log("🗄️ Base de datos SQLite lista en data/crm.db.");
}

// ==========================================
// 👥 OPERACIONES DE USUARIOS
// ==========================================

// 🔥 FIX (igual que antes): al cargar la lista, omitimos a los usuarios
// "archivados" (los que borraste del panel).
function getAllUsers() {
    const rows = ensureDb().prepare('SELECT * FROM users WHERE archived = 0 ORDER BY rowid').all();
    return rows.map(r => userRowToObject(r, getUserMessages(r.phone)));
}

function getUser(phone) {
    if (!phone) return {};
    const row = ensureDb().prepare('SELECT * FROM users WHERE phone = ?').get(String(phone));
    if (!row) return {};
    return userRowToObject(row, getUserMessages(row.phone));
}

async function updateUser(phone, updates) {
    if (!phone) return;
    updates = updates || {};
    withTransaction(() => {
        const conn = ensureDb();
        let row = conn.prepare('SELECT * FROM users WHERE phone = ?').get(String(phone));
        if (!row) {
            conn.prepare(`INSERT INTO users(phone, current_step, history, archived)
                VALUES (?, 'BIENVENIDA', '{}', 0)`).run(String(phone));
            row = conn.prepare('SELECT * FROM users WHERE phone = ?').get(String(phone));
        }
        const user = userRowToObject(row, getUserMessages(row.phone));

        // Mensaje nuevo: se añade y se conservan solo los últimos 30.
        if (updates.newMessage) {
            insertMessageRow(String(phone), updates.newMessage);
            conn.prepare(`DELETE FROM messages WHERE phone = ? AND id NOT IN
                (SELECT id FROM messages WHERE phone = ? ORDER BY id DESC LIMIT 30)`)
                .run(String(phone), String(phone));
            conn.prepare('UPDATE users SET archived = 0 WHERE phone = ?').run(String(phone));
            user.archived = false;
        }

        // Reemplazo completo del historial de mensajes (fusión LID,
        // vaciado de chat). Sin recorte: el llamador ya trae los 30.
        if (Array.isArray(updates.messages)) {
            conn.prepare('DELETE FROM messages WHERE phone = ?').run(String(phone));
            for (const m of updates.messages) insertMessageRow(String(phone), m);
        }

        // El historial se fusiona (merge superficial), como antes: un
        // history:{} no borra las variables viejas.
        let history = user.history || {};
        if (updates.history && typeof updates.history === 'object') {
            history = { ...history, ...updates.history };
        }

        const sets = [];
        const params = [];
        const setCol = (col, value) => { sets.push(`${col} = ?`); params.push(value); };
        if (updates.name !== undefined) setCol('name', updates.name === null ? null : String(updates.name));
        if (updates.jid !== undefined) setCol('jid', updates.jid === null ? null : String(updates.jid));
        if (updates.lid !== undefined) setCol('lid', updates.lid === null ? null : String(updates.lid));
        if (updates.current_step !== undefined) setCol('current_step', updates.current_step === null ? null : String(updates.current_step));
        if (updates.bot_enabled !== undefined) setCol('bot_enabled', boolToInt(updates.bot_enabled));
        if (updates.archived !== undefined) setCol('archived', updates.archived ? 1 : 0);
        if (updates.last_message !== undefined) setCol('last_message', updates.last_message === null ? null : String(updates.last_message));
        if (updates.last_active !== undefined) setCol('last_active', updates.last_active === null ? null : String(updates.last_active));
        if (updates.unreadCount !== undefined) setCol('unread_count', updates.unreadCount === null ? null : Number(updates.unreadCount));
        if (updates.error_count !== undefined) setCol('error_count', updates.error_count === null ? null : Number(updates.error_count));
        if (updates.blocked !== undefined) setCol('blocked', boolToInt(updates.blocked));
        setCol('history', JSON.stringify(history));
        // Campos extra desconocidos: se mezclan en `extra`, no se pierden.
        const extra = parseJson(row.extra || '{}', {});
        let extraChanged = false;
        for (const k of Object.keys(updates)) {
            if (!USER_KNOWN.has(k) && updates[k] !== undefined) { extra[k] = updates[k]; extraChanged = true; }
        }
        if (extraChanged) setCol('extra', JSON.stringify(extra));

        params.push(String(phone));
        conn.prepare(`UPDATE users SET ${sets.join(', ')} WHERE phone = ?`).run(...params);
    });
}

// Actualiza un mensaje guardado por id (reacción o borrado). Devuelve el
// mensaje actualizado, o null si ya no está en el historial (solo se
// guardan los últimos 30 por contacto).
function updateMessage(phone, msgId, patch) {
    if (!phone || msgId === undefined || msgId === null) return null;
    return withTransaction(() => {
        const conn = ensureDb();
        const row = conn.prepare('SELECT * FROM messages WHERE phone = ? AND msg_id = ?')
            .get(String(phone), String(msgId));
        if (!row) return null;
        const sets = [];
        const params = [];
        const setCol = (col, value) => { sets.push(`${col} = ?`); params.push(value); };
        if (patch.text !== undefined) setCol('text', patch.text === null ? null : String(patch.text));
        if (patch.mediaUrl !== undefined) setCol('media_url', patch.mediaUrl === null ? null : String(patch.mediaUrl));
        if (patch.fromMe !== undefined) setCol('from_me', boolToInt(patch.fromMe));
        if (patch.stepId !== undefined) setCol('step_id', patch.stepId === null ? null : String(patch.stepId));
        if (patch.timestamp !== undefined) setCol('timestamp', patch.timestamp === null ? null : String(patch.timestamp));
        if (patch.type !== undefined) setCol('type', patch.type === null ? null : String(patch.type));
        if (patch.quoted !== undefined) setCol('quoted', patch.quoted === null ? null : JSON.stringify(patch.quoted));
        if (patch.reaction !== undefined) setCol('reaction', patch.reaction === null ? null : String(patch.reaction));
        if (patch.deleted !== undefined) setCol('deleted', patch.deleted ? 1 : 0);
        const extra = parseJson(row.extra || '{}', {});
        let extraChanged = false;
        for (const k of Object.keys(patch || {})) {
            if (!MSG_KNOWN.has(k) && patch[k] !== undefined) { extra[k] = patch[k]; extraChanged = true; }
        }
        if (extraChanged) setCol('extra', JSON.stringify(extra));
        if (sets.length > 0) {
            params.push(String(phone), String(msgId));
            conn.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE phone = ? AND msg_id = ?`).run(...params);
        }
        const updated = conn.prepare('SELECT * FROM messages WHERE phone = ? AND msg_id = ?')
            .get(String(phone), String(msgId));
        return messageRowToObject(updated);
    });
}

function deleteUser(phone) {
    if (!phone) return false;
    return withTransaction(() => {
        const conn = ensureDb();
        const row = conn.prepare('SELECT phone FROM users WHERE phone = ?').get(String(phone));
        if (!row) return false;
        // Soft delete (igual que antes): se vacía el chat y se archiva,
        // pero se conservan el número, el nombre, el paso y la pausa.
        conn.prepare('DELETE FROM messages WHERE phone = ?').run(String(phone));
        conn.prepare(`UPDATE users SET last_message = '', unread_count = 0, archived = 1
            WHERE phone = ?`).run(String(phone));
        return true;
    });
}

// ==========================================
// 🤖 OPERACIONES DE FLUJO Y CONFIGURACIÓN
// ==========================================
function getFullFlow() {
    const rows = ensureDb().prepare('SELECT id, data FROM flow_steps ORDER BY rowid').all();
    const out = {};
    for (const r of rows) out[r.id] = parseJson(r.data, {});
    return out;
}
function getFlowStep(id) {
    const row = ensureDb().prepare('SELECT data FROM flow_steps WHERE id = ?').get(normalizeStepId(id));
    return row ? parseJson(row.data, {}) : undefined;
}

async function saveFlowStep(id, data) {
    const normId = normalizeStepId(id);
    if (data.next_step) data.next_step = normalizeStepId(data.next_step);
    if (data.options) {
        data.options.forEach(o => { if (o.next_step) o.next_step = normalizeStepId(o.next_step); });
    }
    withTransaction(() => {
        const conn = ensureDb();
        if (id !== normId) conn.prepare('DELETE FROM flow_steps WHERE id = ?').run(String(id));
        conn.prepare('INSERT OR REPLACE INTO flow_steps(id, data) VALUES (?, ?)')
            .run(normId, JSON.stringify(data));
    });
}

async function deleteFlowStep(id) {
    ensureDb().prepare('DELETE FROM flow_steps WHERE id = ?').run(normalizeStepId(id));
}

function getSettings() {
    const row = ensureDb().prepare("SELECT value FROM kv WHERE key = 'settings'").get();
    return clone(row ? parseJson(row.value, clone(DEFAULT_SETTINGS)) : clone(DEFAULT_SETTINGS));
}
async function saveSettings(s) {
    const current = getSettings();
    const merged = { ...current, ...(s || {}) };
    ensureDb().prepare("INSERT OR REPLACE INTO kv(key, value) VALUES ('settings', ?)")
        .run(JSON.stringify(merged));
}

// ==========================================
// 🏷️ REGLAS, SUBSCRIPCIONES Y TIEMPO
// ==========================================
function getKeywords() {
    const rows = ensureDb().prepare('SELECT data FROM keywords ORDER BY rowid').all();
    return rows.map(r => parseJson(r.data, {}));
}
function saveKeyword(rule) {
    const conn = ensureDb();
    if (rule.id) {
        conn.prepare('INSERT OR REPLACE INTO keywords(id, data) VALUES (?, ?)')
            .run(String(rule.id), JSON.stringify(rule));
    } else {
        // Igual que antes (kw_<timestamp>), con sufijo si dos reglas
        // nacen en el mismo milisegundo y chocarían en la clave.
        let id = 'kw_' + Date.now();
        let n = 1;
        while (conn.prepare('SELECT 1 FROM keywords WHERE id = ?').get(id)) id = 'kw_' + Date.now() + '_' + (n++);
        rule.id = id;
        conn.prepare('INSERT INTO keywords(id, data) VALUES (?, ?)').run(id, JSON.stringify(rule));
    }
    return rule;
}
function deleteKeyword(id) {
    ensureDb().prepare('DELETE FROM keywords WHERE id = ?').run(String(id));
}

function getSubscriptions() {
    const rows = ensureDb().prepare('SELECT data FROM subscriptions ORDER BY rowid').all();
    return rows.map(r => parseJson(r.data, {}));
}
function saveSubscription(sub) {
    if (!sub || !sub.endpoint) return;
    ensureDb().prepare('INSERT OR IGNORE INTO subscriptions(endpoint, data) VALUES (?, ?)')
        .run(String(sub.endpoint), JSON.stringify(sub));
}
function removeSubscription(endpoint) {
    ensureDb().prepare('DELETE FROM subscriptions WHERE endpoint = ?').run(String(endpoint));
}

// ==========================================
// 🔀 MAPA LID -> TELÉFONO (antes data/lid_map.json)
// ==========================================
function getLidMap() {
    const rows = ensureDb().prepare('SELECT lid, phone FROM lid_map').all();
    const out = {};
    for (const r of rows) out[r.lid] = r.phone;
    return out;
}
function saveLidMap(data) {
    withTransaction(() => {
        const conn = ensureDb();
        conn.prepare('DELETE FROM lid_map').run();
        for (const lid of Object.keys(data || {})) {
            if (lid === undefined || lid === null || data[lid] === undefined || data[lid] === null) continue;
            conn.prepare('INSERT OR REPLACE INTO lid_map(lid, phone) VALUES (?, ?)')
                .run(String(lid), String(data[lid]));
        }
    });
}
// lid (dígitos) -> teléfono real, con ambos lados normalizados,
// igual que lo hacía api.js sobre el JSON.
function getLidToPhoneMap() {
    const map = {};
    const lidMap = getLidMap();
    Object.keys(lidMap).forEach(lid => { map[normalizePhone(lid)] = normalizePhone(lidMap[lid]); });
    return map;
}

function getSystemTime() {
    const tz = getSettings().timezone || "America/Matamoros";
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    });

    const parts = formatter.formatToParts(new Date());
    const vals = {};
    parts.forEach(p => vals[p.type] = p.value);

    const hourStr = vals.hour === '24' ? '00' : vals.hour;
    const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: 'short' });
    const dayMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };

    return {
        timezone: tz,
        dateString: `${vals.year}-${vals.month}-${vals.day}`,
        timeString: `${hourStr}:${vals.minute}`,
        dayOfWeek: dayMap[dayFormatter.format(new Date())]
    };
}

// ==========================================
// 📥 MIGRACIÓN DESDE JSON (una sola vez)
// ==========================================
// Lee los JSON antiguos y los vuelca a crm.db en UNA transacción: o
// entra todo o no entra nada. Los JSON no se borran: se copian a
// data/backup-json-<timestamp>/ y quedan como respaldo.
// - Corrupto: se respalda como <nombre>.corrupto-<timestamp> (igual que
//   hacía el lector JSON) y esa tabla arranca vacía, sin tumbar el resto.
// - Idempotente con --force: reescribir los mismos JSON deja los mismos
//   datos. Sin --force y con la BD ya poblada, no hace nada.
function readJsonForMigration(filePath, defaultVal, report, key) {
    if (!fs.existsSync(filePath)) return { value: defaultVal, present: false };
    try {
        return { value: JSON.parse(fs.readFileSync(filePath, 'utf-8')), present: true };
    } catch (e) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${filePath}.corrupto-${stamp}`;
        try {
            fs.copyFileSync(filePath, backupPath);
            report.warnings.push(`${path.basename(filePath)} corrupto; respaldo en ${backupPath}`);
        } catch (backupErr) {
            report.warnings.push(`${path.basename(filePath)} corrupto y NO se pudo respaldar (${backupErr.message})`);
        }
        return { value: defaultVal, present: true, corrupt: true };
    }
}

function dbHasData() {
    // Sin archivo no hay datos (y no se crea el archivo solo por mirar).
    if (!fs.existsSync(dbPath)) return false;
    const conn = ensureDb();
    const count = (sql) => conn.prepare(sql).get().c;
    return count('SELECT COUNT(*) AS c FROM users') > 0
        || count('SELECT COUNT(*) AS c FROM flow_steps') > 0
        || count('SELECT COUNT(*) AS c FROM keywords') > 0
        || count('SELECT COUNT(*) AS c FROM contacts') > 0
        || count('SELECT COUNT(*) AS c FROM agenda') > 0
        || count('SELECT COUNT(*) AS c FROM subscriptions') > 0
        || count('SELECT COUNT(*) AS c FROM lid_map') > 0;
}

function migrateFromJson(opts = {}) {
    const { force = false, dryRun = false, auto = false } = opts;
    // OJO: no se abre (ni se crea) crm.db hasta saber que hay algo que
    // migrar y que no es un dry-run: un --dry-run no debe dejar un
    // crm.db vacío que luego impida la automigración del arranque.
    const report = {
        migrated: false, dryRun: !!dryRun, backupDir: null,
        counts: { users: 0, messages: 0, flow: 0, settings: 0, keywords: 0, contacts: 0, subscriptions: 0, agenda: 0, lidMap: 0 },
        warnings: []
    };
    const read = {};
    for (const key of Object.keys(jsonPaths)) {
        const def = key === 'flow' || key === 'lidMap' || key === 'agenda' ? {} : (key === 'settings' ? null : []);
        read[key] = readJsonForMigration(jsonPaths[key], def, report, key);
    }
    const anyJson = Object.values(read).some(r => r.present);
    if (!anyJson) return { ...report, reason: 'no-json' };
    if (!force && !auto && dbHasData()) return { ...report, reason: 'db-not-empty' };
    if (auto && dbHasData()) return { ...report, reason: 'db-not-empty' };

    // Contar lo que se migraría (también sirve para --dry-run).
    const users = Array.isArray(read.users.value) ? read.users.value : [];
    const flow = (read.flow.value && typeof read.flow.value === 'object') ? read.flow.value : {};
    const keywords = Array.isArray(read.keywords.value) ? read.keywords.value : [];
    const contacts = Array.isArray(read.contacts.value) ? read.contacts.value : [];
    const subs = Array.isArray(read.subscriptions.value) ? read.subscriptions.value : [];
    const agenda = (read.agenda.value && typeof read.agenda.value === 'object') ? read.agenda.value : {};
    const lidMap = (read.lidMap.value && typeof read.lidMap.value === 'object') ? read.lidMap.value : {};
    report.counts.users = users.length;
    report.counts.messages = users.reduce((n, u) => n + ((u.messages || []).length), 0);
    report.counts.flow = Object.keys(flow).length;
    report.counts.settings = read.settings.present ? 1 : 0;
    report.counts.keywords = keywords.length;
    report.counts.contacts = contacts.length;
    report.counts.subscriptions = subs.length;
    report.counts.agenda = Object.values(agenda).reduce((n, list) => n + ((list || []).length), 0);
    report.counts.lidMap = Object.keys(lidMap).length;

    if (dryRun) return { ...report, migrated: false, reason: 'dry-run' };

    // A partir de aquí sí se escribe: abrir/crear la BD.
    ensureDb();

    // Respaldo de los JSON originales antes de tocar la BD.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(dataDir, `backup-json-${stamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    report.backupDir = backupDir;
    for (const key of Object.keys(jsonPaths)) {
        if (read[key].present && fs.existsSync(jsonPaths[key])) {
            try { fs.copyFileSync(jsonPaths[key], path.join(backupDir, path.basename(jsonPaths[key]))); }
            catch (e) { report.warnings.push(`No se pudo respaldar ${path.basename(jsonPaths[key])}: ${e.message}`); }
        }
    }

    withTransaction(() => {
        const conn = ensureDb();
        for (const u of users) {
            if (!u || !u.phone) continue;
            upsertUserRow({ ...u, phone: String(u.phone) });
        }
        for (const id of Object.keys(flow)) {
            conn.prepare('INSERT OR REPLACE INTO flow_steps(id, data) VALUES (?, ?)')
                .run(normalizeStepId(id), JSON.stringify(flow[id]));
        }
        if (read.settings.present && read.settings.value && typeof read.settings.value === 'object') {
            conn.prepare("INSERT OR REPLACE INTO kv(key, value) VALUES ('settings', ?)")
                .run(JSON.stringify(read.settings.value));
        }
        for (const rule of keywords) {
            if (!rule) continue;
            const id = rule.id ? String(rule.id) : 'kw_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            conn.prepare('INSERT OR REPLACE INTO keywords(id, data) VALUES (?, ?)')
                .run(id, JSON.stringify({ ...rule, id }));
        }
        for (const c of contacts) {
            if (!c || !c.phone) continue;
            const extra = {};
            for (const k of Object.keys(c)) {
                if (!['phone', 'jid', 'name', 'bot_enabled', 'last_synced', 'added_at'].includes(k)) extra[k] = c[k];
            }
            conn.prepare(`INSERT INTO contacts(phone, jid, name, bot_enabled, last_synced, added_at, extra)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(phone) DO UPDATE SET jid = excluded.jid, name = excluded.name,
                bot_enabled = excluded.bot_enabled, last_synced = excluded.last_synced,
                added_at = excluded.added_at, extra = excluded.extra`).run(
                String(c.phone),
                c.jid === undefined ? null : String(c.jid),
                c.name === undefined ? null : String(c.name),
                boolToInt(c.bot_enabled),
                c.last_synced === undefined ? null : String(c.last_synced),
                c.added_at === undefined ? null : String(c.added_at),
                JSON.stringify(extra));
        }
        for (const s of subs) {
            if (!s || !s.endpoint) continue;
            conn.prepare('INSERT OR REPLACE INTO subscriptions(endpoint, data) VALUES (?, ?)')
                .run(String(s.endpoint), JSON.stringify(s));
        }
        // La agenda es una foto completa: se reemplaza entera.
        conn.prepare('DELETE FROM agenda').run();
        for (const date of Object.keys(agenda)) {
            for (const appt of (agenda[date] || [])) {
                if (!appt || !appt.time) continue;
                conn.prepare(`INSERT OR REPLACE INTO agenda
                    (date, time, phone, name, jid, note, created_at, recordatorio_enviado)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    String(date), String(appt.time),
                    appt.phone === undefined ? null : String(appt.phone),
                    appt.name === undefined ? null : String(appt.name),
                    appt.jid === undefined ? null : String(appt.jid),
                    appt.note === undefined ? null : String(appt.note),
                    appt.created_at === undefined ? null : String(appt.created_at),
                    appt.recordatorio_enviado ? 1 : 0);
            }
        }
        conn.prepare('DELETE FROM lid_map').run();
        for (const lid of Object.keys(lidMap)) {
            if (lidMap[lid] === undefined || lidMap[lid] === null) continue;
            conn.prepare('INSERT OR REPLACE INTO lid_map(lid, phone) VALUES (?, ?)')
                .run(String(lid), String(lidMap[lid]));
        }
    });
    report.migrated = true;
    return report;
}

module.exports = {
    initializeDB,
    getAllUsers, getUser, updateUser, deleteUser, updateMessage,
    getFullFlow, getFlowStep, saveFlowStep, deleteFlowStep,
    getSettings, saveSettings,
    getKeywords, saveKeyword, deleteKeyword,
    getSubscriptions, saveSubscription, removeSubscription,
    getSystemTime,
    // Nuevos (aditivos): los usan api.js, whatsapp.js, contacts.js,
    // agendaService.js y scripts/migrate-to-sqlite.js.
    getLidMap, saveLidMap, getLidToPhoneMap,
    getDb, withTransaction, migrateFromJson, closeDb
};
