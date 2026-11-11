const fs = require('fs');
const fsAsync = require('fs').promises;
const path = require('path');

const dataDir = path.join(__dirname, '../data');
const paths = {
    users: path.join(dataDir, 'users.json'),
    flow: path.join(dataDir, 'flow.json'),
    settings: path.join(dataDir, 'settings.json'),
    keywords: path.join(dataDir, 'keywords.json'),
    contacts: path.join(dataDir, 'contacts.json'),
    subscriptions: path.join(dataDir, 'subscriptions.json')
};

// ==========================================
// 🧠 CACHÉ EN MEMORIA (Lecturas en 0ms)
// ==========================================
const dbCache = {
    users: [],
    flow: {},
    settings: { schedule: { active: false, days: {} } },
    keywords: [],
    contacts: [],
    subscriptions: []
};

// ==========================================
// 🛡️ MOTOR DE I/O SEGURO Y ASÍNCRONO
// ==========================================
let saveLocks = {}; 

function safeReadJSONSync(filePath, defaultVal) {
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultVal, null, 2));
        return defaultVal;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
        // El JSON está corrupto: antes se volvía a los valores por defecto
        // y el siguiente guardado SOBRESCRIBÍA el archivo corrupto, con lo
        // que los datos se perdían para siempre. Ahora el archivo se
        // respalda primero y el bot sigue con los valores por defecto.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = `${filePath}.corrupto-${stamp}`;
        try {
            fs.renameSync(filePath, backupPath);
            console.error(`⚠️ ${filePath} está corrupto. Respaldo guardado en ${backupPath}. Se usan valores por defecto.`);
        } catch (backupErr) {
            console.error(`⚠️ ${filePath} está corrupto y NO se pudo respaldar (${backupErr.message}). Se usan valores por defecto.`);
        }
        return defaultVal;
    }
}

async function safeWriteJSONAsync(key, filePath, data) {
    if (!saveLocks[key]) saveLocks[key] = Promise.resolve();

    saveLocks[key] = saveLocks[key].then(async () => {
        const tempPath = `${filePath}.${Date.now()}.tmp`;
        try {
            await fsAsync.writeFile(tempPath, JSON.stringify(data, null, 2));
            await fsAsync.rename(tempPath, filePath);
        } catch (e) {
            console.error(`🔥 ERROR FATAL al guardar ${key}:`, e);
        }
    }).catch(() => {});
}

let saveTimeouts = {};
function scheduleSave(key, filePath) {
    if (saveTimeouts[key]) clearTimeout(saveTimeouts[key]);
    saveTimeouts[key] = setTimeout(() => {
        safeWriteJSONAsync(key, filePath, dbCache[key]);
        delete saveTimeouts[key];
    }, 200); 
}

// ==========================================
// 🚀 INICIALIZACIÓN Y MIGRACIONES
// ==========================================
function normalizeStepId(id) {
    if (!id) return '';
    return String(id).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
}

function runFlowMigration() {
    let hasChanges = false;
    const newFlow = {};

    for (const key of Object.keys(dbCache.flow)) {
        const normKey = normalizeStepId(key);
        const step = { ...dbCache.flow[key] };
        
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
        newFlow[normKey] = step;
        if (normKey !== key) hasChanges = true;
    }

    if (hasChanges) {
        dbCache.flow = newFlow;
        scheduleSave('flow', paths.flow);
        console.log("🧹 Migración de tarjetas completada.");
    }
}

function initializeDB() {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    dbCache.users = safeReadJSONSync(paths.users, []);
    dbCache.flow = safeReadJSONSync(paths.flow, {});
    dbCache.settings = safeReadJSONSync(paths.settings, { schedule: { active: false, days: {} } });
    dbCache.keywords = safeReadJSONSync(paths.keywords, []);
    dbCache.contacts = safeReadJSONSync(paths.contacts, []);
    dbCache.subscriptions = safeReadJSONSync(paths.subscriptions, []);

    runFlowMigration();
    console.log("🗄️ Base de datos cargada en memoria exitosamente.");
}

// ==========================================
// 👥 OPERACIONES DE USUARIOS
// ==========================================

// 🔥 FIX: Al cargar la lista en el frontend, omitimos a los usuarios "archivados" (los que borraste)
function getAllUsers() { 
    return dbCache.users.filter(u => !u.archived); 
}

function getUser(phone) { 
    return dbCache.users.find(u => u.phone === phone) || {}; 
}

async function updateUser(phone, updates) {
    let userIndex = dbCache.users.findIndex(u => u.phone === phone);

    if (userIndex === -1) {
        dbCache.users.push({ phone, history: {}, messages: [], current_step: 'BIENVENIDA' });
        userIndex = dbCache.users.length - 1;
    } 

    if (!dbCache.users[userIndex].messages) {
        dbCache.users[userIndex].messages = [];
    }

    if (updates.newMessage) {
        dbCache.users[userIndex].messages.push(updates.newMessage);
        
        if (dbCache.users[userIndex].messages.length > 30) {
            dbCache.users[userIndex].messages = dbCache.users[userIndex].messages.slice(-30);
        }
        
        // 🔥 FIX: Si nos escribe de nuevo, le quitamos la etiqueta de archivado para que regrese a la interfaz
        dbCache.users[userIndex].archived = false; 
        
        delete updates.newMessage; 
    }

    if (updates.history) {
        updates.history = { ...dbCache.users[userIndex].history, ...updates.history };
    }
    
    dbCache.users[userIndex] = { ...dbCache.users[userIndex], ...updates };
    scheduleSave('users', paths.users);
}

// Actualiza un mensaje guardado por id (reacción o borrado). Devuelve el
// mensaje actualizado, o null si ya no está en el historial (solo se
// guardan los últimos 30 por contacto).
function updateMessage(phone, msgId, patch) {
    const userIndex = dbCache.users.findIndex(u => u.phone === phone);
    if (userIndex === -1) return null;
    const msgs = dbCache.users[userIndex].messages || [];
    const m = msgs.find(x => x && x.id === msgId);
    if (!m) return null;
    Object.assign(m, patch);
    scheduleSave('users', paths.users);
    return m;
}

function deleteUser(phone) {
    let userIndex = dbCache.users.findIndex(u => u.phone === phone);
    
    if (userIndex !== -1) {
        // 🔥 FIX: En lugar de destruir el registro (Hard Delete), hacemos un Vaciar Chat (Soft Delete)
        dbCache.users[userIndex].messages = [];
        dbCache.users[userIndex].last_message = '';
        // El paso del flujo y la pausa del bot se conservan: borrar el chat
        // lo saca de la lista, no reinicia la conversación con el cliente.
        dbCache.users[userIndex].unreadCount = 0;
        dbCache.users[userIndex].archived = true; // Lo ocultamos de la interfaz visual
        
        scheduleSave('users', paths.users);
        return true;
    }
    return false;
}

// ==========================================
// 🤖 OPERACIONES DE FLUJO Y CONFIGURACIÓN
// ==========================================
function getFullFlow() { return dbCache.flow; }
function getFlowStep(id) { return dbCache.flow[normalizeStepId(id)]; }

async function saveFlowStep(id, data) {
    const normId = normalizeStepId(id);
    if (data.next_step) data.next_step = normalizeStepId(data.next_step);
    if (data.options) {
        data.options.forEach(o => { if (o.next_step) o.next_step = normalizeStepId(o.next_step); });
    }

    if (id !== normId && dbCache.flow[id]) delete dbCache.flow[id];
    dbCache.flow[normId] = data;
    
    scheduleSave('flow', paths.flow);
}

async function deleteFlowStep(id) {
    const normId = normalizeStepId(id);
    if (dbCache.flow[normId]) { 
        delete dbCache.flow[normId]; 
        scheduleSave('flow', paths.flow); 
    }
}

function getSettings() { return dbCache.settings; }
async function saveSettings(s) {
    dbCache.settings = { ...dbCache.settings, ...s };
    scheduleSave('settings', paths.settings);
}

// ==========================================
// 🏷️ REGLAS, SUBSCRIPCIONES Y TIEMPO
// ==========================================
function getKeywords() { return dbCache.keywords; }
function saveKeyword(rule) {
    const index = dbCache.keywords.findIndex(k => k.id === rule.id);
    if (index !== -1) dbCache.keywords[index] = rule;
    else {
        if (!rule.id) rule.id = 'kw_' + Date.now();
        dbCache.keywords.push(rule);
    }
    scheduleSave('keywords', paths.keywords);
    return rule;
}
function deleteKeyword(id) {
    dbCache.keywords = dbCache.keywords.filter(k => k.id !== id);
    scheduleSave('keywords', paths.keywords);
}

function getSubscriptions() { return dbCache.subscriptions; }
function saveSubscription(sub) {
    if (!dbCache.subscriptions.find(s => s.endpoint === sub.endpoint)) {
        dbCache.subscriptions.push(sub);
        scheduleSave('subscriptions', paths.subscriptions);
    }
}
function removeSubscription(endpoint) {
    dbCache.subscriptions = dbCache.subscriptions.filter(s => s.endpoint !== endpoint);
    scheduleSave('subscriptions', paths.subscriptions);
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

module.exports = {
    initializeDB,
    getAllUsers, getUser, updateUser, deleteUser, updateMessage,
    getFullFlow, getFlowStep, saveFlowStep, deleteFlowStep,
    getSettings, saveSettings,
    getKeywords, saveKeyword, deleteKeyword,
    getSubscriptions, saveSubscription, removeSubscription,
    getSystemTime
};