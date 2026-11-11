const fs = require('fs').promises;
const path = require('path');
const { getSettings, getFullFlow } = require('../database');
const { normalizePhone } = require('../utils'); // Para el JID de respaldo (LID vs teléfono)

const agendaPath = path.join(__dirname, '../../data/agenda.json');

// 🔥 MUTEX: Cola de promesas para evitar condiciones de carrera al guardar simultáneamente
let agendaWriteLock = Promise.resolve();

// ==========================================
// 1. MANEJO DE ARCHIVOS (No Bloqueante, Seguro y con Reintentos)
// ==========================================

const getAgenda = async () => {
    try {
        const data = await fs.readFile(agendaPath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        if (e.code === 'ENOENT') return {};
        // JSON corrupto: antes se devolvía {} y el siguiente guardado
        // sobrescribía el archivo, perdiendo las citas. Se respalda primero.
        if (e instanceof SyntaxError) {
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const backupPath = `${agendaPath}.corrupto-${stamp}`;
            try {
                await fs.rename(agendaPath, backupPath);
                console.error(`⚠️ ${agendaPath} está corrupto. Respaldo guardado en ${backupPath}. Se usa una agenda vacía.`);
            } catch (backupErr) {
                console.error(`⚠️ ${agendaPath} está corrupto y NO se pudo respaldar (${backupErr.message}). Se usa una agenda vacía.`);
            }
            return {};
        }
        console.error('⚠️ Error leyendo agenda:', e);
        return {};
    }
};

// Escritura real del archivo (con reintentos). NO encola nada: la usa
// saveAgenda y también bookAppointment cuando ya tiene el candado.
const writeAgendaFile = async (data) => {
    const tempPath = `${agendaPath}.${Date.now()}.tmp`; // Único por petición

    let attempts = 0;
    let success = false;

    while (attempts < 5 && !success) {
        try {
            await fs.writeFile(tempPath, JSON.stringify(data, null, 2));
            await fs.rename(tempPath, agendaPath);
            success = true;
        } catch (e) {
            // Si el archivo está ocupado por el sistema operativo, reintentamos
            if (e.code === 'ENOENT' || e.code === 'EPERM') {
                attempts++;
                await new Promise(r => setTimeout(r, 200));
            } else {
                console.error('🔥 CRITICAL: Fallo al guardar agenda:', e);
                throw e;
            }
        }
    }

    if (!success) {
         console.error(`CRITICAL: No se pudo guardar la agenda tras 5 intentos.`);
    }
};

const saveAgenda = async (data) => {
    // 🛡️ El Mutex asegura que las escrituras se encolen y no se pisen entre sí
    agendaWriteLock = agendaWriteLock.then(() => writeAgendaFile(data))
        .catch(() => {}); // Previene que un error tranque toda la cola para futuros guardados

    return agendaWriteLock;
};

// JID de respaldo cuando no nos dieron uno y el usuario no tiene jid
// guardado. Primero se normaliza: un teléfono con 521 tiene 13 dígitos y
// NO es un LID; un normalizado de más de 12 dígitos sí lo es.
const fallbackJid = (phone) => {
    const normalized = normalizePhone(phone);
    if (normalized.length > 12) return `${normalized}@lid`;
    return `${normalized}@s.whatsapp.net`;
};

// ==========================================
// 2. LECTURA DE CONFIGURACIÓN (Desde Memoria RAM)
// ==========================================

const getCitaInterval = () => {
    try {
        const flow = getFullFlow(); 
        if (flow) {
            for (const key in flow) {
                if (flow[key].type === 'cita' && flow[key].interval) {
                    return parseInt(flow[key].interval) || 30;
                }
            }
        }
    } catch (e) {
        console.error("No se pudo leer el intervalo del flujo en memoria, usando 30 por defecto.");
    }
    return 30;
};

// ==========================================
// 3. UTILIDADES DE TIEMPO PURO
// ==========================================

const friendlyDate = (dateStr) => {
    if (!dateStr) return dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
    return `${dias[date.getDay()]} ${d}/${m}/${y}`;
};

const timeToMinutes = (timeStr) => {
    if (!timeStr) return -1;
    const [h, m] = timeStr.split(':').map(Number);
    return (h * 60) + m;
};

// Reloj maestro blindado contra la hora UTC del servidor de hosting
const getRealLocalTime = () => {
    const settings = getSettings();
    const tz = settings.timezone || "America/Matamoros";
    
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', 
        hour: '2-digit', minute: '2-digit', hour12: false
    });
    
    const parts = formatter.formatToParts(new Date());
    const val = (type) => parts.find(p => p.type === type).value;
    
    const y = val('year'), m = val('month'), d = val('day');
    const h = val('hour') === '24' ? '00' : val('hour'); // Bypass al bug de medianoche de Intl
    const min = val('minute');

    return {
        dateStr: `${y}-${m}-${d}`,
        timeStr: `${h}:${min}`,
        hour: parseInt(h, 10),
        minute: parseInt(min, 10),
        dayOfWeek: new Date(`${y}-${m}-${d}T12:00:00`).getDay() 
    };
};

// ==========================================
// 4. LÓGICA DE NEGOCIO Y REGLAS
// ==========================================

const isDateInPast = (dateStr, timeStr) => {
    if (!dateStr || !timeStr) return false;
    const localNow = getRealLocalTime();
    if (dateStr < localNow.dateStr) return true;
    if (dateStr === localNow.dateStr && timeStr <= localNow.timeStr) return true;
    return false;
};

// Función rescatada de agenda.js para evaluar cierres inmediatos
const isBusinessClosed = () => {
    const settings = getSettings();
    if (!settings.schedule || !settings.schedule.active) return false; 

    const localNow = getRealLocalTime();
    const currentDay = String(localNow.dayOfWeek); 
    
    const dayConfig = settings.schedule.days[currentDay];
    if (!dayConfig || dayConfig.active === false || String(dayConfig.active) === "false") {
        return true; 
    }

    const currentMins = (localNow.hour * 60) + localNow.minute;
    const startMins = timeToMinutes(dayConfig.start || "09:00");
    const endMins = timeToMinutes(dayConfig.end || "19:00");

    if (startMins < endMins) {
        return currentMins < startMins || currentMins >= endMins;
    } else {
        return !(currentMins >= startMins || currentMins < endMins);
    }
};

const validateBusinessRules = (timeStr, dateStr = null) => {
    const settings = getSettings();
    if (!timeStr) return { valid: false, reason: "Falta la hora." };

    const [h, m] = timeStr.split(':').map(Number);
    const interval = getCitaInterval(); 
    
    if (interval !== 1440 && m % interval !== 0) {
        let ej = "ej: 4:00, 4:30";
        if (interval === 15) ej = "ej: 4:00, 4:15, 4:30";
        if (interval === 60) ej = "ej: 4:00, 5:00";
        return { valid: false, reason: `Solo agendamos en intervalos de ${interval} minutos (${ej}).` };
    }

    const localNow = getRealLocalTime();
    let targetDayOfWeek = localNow.dayOfWeek; 
    
    if (dateStr) {
        const [y, month, d] = dateStr.split('-').map(Number);
        const proposedDate = new Date(y, month - 1, d, 12, 0, 0); 
        targetDayOfWeek = proposedDate.getDay();
    }

    const dayConfig = settings.schedule?.days?.[String(targetDayOfWeek)];
    if (!dayConfig || dayConfig.active === false || String(dayConfig.active) === "false") {
         return { valid: false, reason: `⛔ Lo siento, ese día de la semana estamos cerrados.\nPor favor elige otro día.` };
    }

    const reqMins = (h * 60) + m;
    const sStart = dayConfig.start || "09:00";
    const sEnd = dayConfig.end || "19:00";
    const startMins = timeToMinutes(sStart);
    const endMins = timeToMinutes(sEnd);

    let isClosed = (startMins < endMins) 
        ? (reqMins < startMins || reqMins >= endMins) 
        : (reqMins >= endMins && reqMins < startMins);

    if (isClosed) {
        return { valid: false, reason: `⛔ Lo siento, a esa hora estamos cerrados.\n🕒 Nuestro horario para ese día es de *${sStart}* a *${sEnd}*.` };
    }

    return { valid: true, settings }; 
};

// ==========================================
// 5. OPERACIONES CRUD DE AGENDA
// ==========================================

const checkAvailability = async (date, time) => {
    const db = await getAgenda(); 
    return !(db[date] && db[date].some(c => c.time === time));
};

const getAvailableSlots = async (dateStr) => {
    const settings = getSettings();
    const localNow = getRealLocalTime();
    const intervalMinutes = getCitaInterval(); 

    const [y, m, d] = dateStr.split('-').map(Number);
    const dayOfWeek = new Date(y, m - 1, d, 12, 0, 0).getDay();
    const dayConfig = settings.schedule?.days?.[dayOfWeek];
    
    if (!dayConfig || dayConfig.active === false || String(dayConfig.active) === "false") return [];

    const startMins = timeToMinutes(dayConfig.start || "09:00");
    const endMins = timeToMinutes(dayConfig.end || "19:00");
    const allSlots = [];
    
    if (intervalMinutes === 1440) { 
         allSlots.push(`${String(Math.floor(startMins / 60)).padStart(2, '0')}:${String(startMins % 60).padStart(2, '0')}`);
    } else {
        for (let m = startMins; m < endMins; m += intervalMinutes) {
            allSlots.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
        }
    }

    const db = await getAgenda();
    const occupied = (db[dateStr] || []).map(c => c.time);
    let freeSlots = allSlots.filter(slot => !occupied.includes(slot));

    if (dateStr === localNow.dateStr) {
        const nowMins = (localNow.hour * 60) + localNow.minute;
        freeSlots = freeSlots.filter(slot => timeToMinutes(slot) >= (nowMins + 15));
    }

    return freeSlots;
};

const bookAppointment = async (date, time, phone, name, userJid, note) => {
    // 🔥 ATÓMICO: todo el leer-revisar-guardar corre dentro del candado.
    // Antes el candado solo cubría la escritura: dos reservas al mismo hueco
    // podían leer "libre" a la vez y la última escritura borraba a la
    // primera, con doble reserva confirmada a los dos clientes.
    let booked = false;
    agendaWriteLock = agendaWriteLock.then(async () => {
        const db = await getAgenda();

        // Si no se proporcionó el JID (retrocompatibilidad), lo generamos.
        // CORREGIDO: era require('./database'), ruta que no existe desde
        // src/services/ (es '../database'). El try/catch lo tragaba y el
        // JID siempre caía en '@s.whatsapp.net', mal para un LID.
        if (!userJid) {
            try {
                const { getUser } = require('../database');
                const user = getUser(phone);
                userJid = user?.jid || fallbackJid(phone);
            } catch (e) {
                userJid = fallbackJid(phone);
            }
        }

        // Limpieza Inteligente (Auto-Reagendado)
        for (const agendaDate in db) {
            if (Array.isArray(db[agendaDate])) {
                db[agendaDate] = db[agendaDate].filter(c => c.phone !== phone);
                if (db[agendaDate].length === 0) delete db[agendaDate];
            }
        }

        if (!db[date]) db[date] = [];
        if (db[date].some(c => c.time === time)) return; // Hueco ya ocupado

        // La nota es opcional (solo la pone /agenda/book desde el panel).
        // Se guarda dentro de la misma escritura atómica, así que una cita
        // confirmada nunca pierde su nota.
        const entry = {
            time, phone, name,
            jid: userJid,
            created_at: new Date().toISOString()
        };
        if (note !== undefined && note !== null && String(note).trim() !== '') entry.note = String(note);

        db[date].push(entry);

        db[date].sort((a, b) => a.time.localeCompare(b.time));
        await writeAgendaFile(db);
        booked = true;
    }).catch(() => { booked = false; });

    await agendaWriteLock;
    return booked;
};

module.exports = {
    getAgenda, saveAgenda, validateBusinessRules, checkAvailability, bookAppointment,
    isDateInPast, isBusinessClosed, friendlyDate, getAvailableSlots, timeToMinutes,
    getCitaInterval, getCitaIntervalSync: getCitaInterval, // Exportamos ambos nombres por seguridad
    fallbackJid // JID de respaldo LID/teléfono, misma regla que usa bookAppointment
};
