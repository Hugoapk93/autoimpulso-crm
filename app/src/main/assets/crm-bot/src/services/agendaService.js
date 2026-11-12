// ==========================================
// 📅 agendaService.js — SQLite (node:sqlite)
//
// Misma API pública que la versión JSON. Cambia solo el almacén:
// la agenda ya no es data/agenda.json sino la tabla `agenda` en
// data/crm.db (misma conexión que database.js).
//
// Lo que esto arregla de verdad:
// - bookAppointment es UNA transacción (BEGIN IMMEDIATE + PRIMARY KEY
//   (date, time)): si dos procesos reservan el mismo hueco a la vez,
//   solo uno gana. El candado en memoria de antes solo protegía
//   dentro de un mismo proceso; dos procesos confirmaban el mismo
//   hueco y solo quedaba guardada una cita (reproducido, ver NOTAS).
// - getAgenda/saveAgenda siguen existiendo con la misma forma
//   ({ fecha: [citas] }) para el scheduler, la API y la fusión LID,
//   que mutan el objeto y lo guardan. saveAgenda reemplaza la tabla
//   entera en una transacción, como antes reemplazaba el archivo.
// ==========================================
const { getSettings, getFullFlow, getDb, withTransaction } = require('../database');
const { normalizePhone } = require('../utils'); // Para el JID de respaldo (LID vs teléfono)

// ==========================================
// 1. ACCESO A LA TABLA agenda
// ==========================================

const agendaRowToEntry = (row) => {
    const entry = {
        time: row.time,
        phone: row.phone,
        name: row.name,
        jid: row.jid,
        created_at: row.created_at
    };
    if (row.note !== null && row.note !== undefined) entry.note = row.note;
    if (row.recordatorio_enviado) entry.recordatorio_enviado = true;
    return entry;
};

const getAgenda = async () => {
    const rows = getDb().prepare('SELECT * FROM agenda ORDER BY date, time').all();
    const out = {};
    for (const row of rows) {
        if (!out[row.date]) out[row.date] = [];
        out[row.date].push(agendaRowToEntry(row));
    }
    return out;
};

// Reemplazo completo de la agenda (la usa el scheduler tras marcar
// recordatorios, la API al borrar y la fusión LID al migrar citas).
const saveAgenda = async (data) => {
    withTransaction(() => {
        const db = getDb();
        db.prepare('DELETE FROM agenda').run();
        const insert = db.prepare(`INSERT OR REPLACE INTO agenda
            (date, time, phone, name, jid, note, created_at, recordatorio_enviado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const date of Object.keys(data || {})) {
            for (const c of (data[date] || [])) {
                if (!c || !c.time) continue;
                insert.run(
                    String(date), String(c.time),
                    c.phone === undefined || c.phone === null ? null : String(c.phone),
                    c.name === undefined || c.name === null ? null : String(c.name),
                    c.jid === undefined || c.jid === null ? null : String(c.jid),
                    c.note === undefined || c.note === null ? null : String(c.note),
                    c.created_at === undefined || c.created_at === null ? null : String(c.created_at),
                    c.recordatorio_enviado ? 1 : 0
                );
            }
        }
    });
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
// 2. LECTURA DE CONFIGURACIÓN (Desde la BD)
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
    const row = getDb().prepare('SELECT 1 AS x FROM agenda WHERE date = ? AND time = ?').get(date, time);
    return !row;
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
    // 🔥 ATÓMICO: leer-revisar-guardar corre dentro de UNA transacción
    // SQLite (BEGIN IMMEDIATE) con PRIMARY KEY (date, time). Antes el
    // candado solo vivía en este proceso: dos procesos podían leer
    // "libre" a la vez, confirmar los dos y guardar solo uno.
    const db = getDb();
    db.exec('BEGIN IMMEDIATE');
    try {
        // Si no se proporcionó el JID (retrocompatibilidad), lo generamos.
        if (!userJid) {
            try {
                const { getUser } = require('../database');
                const user = getUser(phone);
                userJid = user?.jid || fallbackJid(phone);
            } catch (e) {
                userJid = fallbackJid(phone);
            }
        }

        // Limpieza Inteligente (Auto-Reagendado): quita las citas viejas
        // de este teléfono. OJO: esto va ANTES de comprobar el hueco,
        // pero si el hueco está ocupado se hace ROLLBACK, así que la
        // cita vieja NO se pierde cuando la reserva falla (igual que
        // antes, donde el return sin guardar descartaba la limpieza).
        db.prepare('DELETE FROM agenda WHERE phone = ?').run(phone);

        const occupied = db.prepare('SELECT 1 AS x FROM agenda WHERE date = ? AND time = ?').get(date, time);
        if (occupied) {
            db.exec('ROLLBACK');
            return false;
        }

        // La nota es opcional (solo la pone /agenda/book desde el panel).
        // Se guarda dentro de la misma transacción, así que una cita
        // confirmada nunca pierde su nota.
        db.prepare(`INSERT INTO agenda(date, time, phone, name, jid, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
            String(date), String(time), phone === undefined || phone === null ? null : String(phone),
            name === undefined || name === null ? null : String(name),
            userJid === undefined || userJid === null ? null : String(userJid),
            (note === undefined || note === null || String(note).trim() === '') ? null : String(note),
            new Date().toISOString()
        );
        db.exec('COMMIT');
        return true;
    } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) { /* sin transacción */ }
        console.error('🔥 Error reservando cita:', e.message);
        return false;
    }
};

module.exports = {
    getAgenda, saveAgenda, validateBusinessRules, checkAvailability, bookAppointment,
    isDateInPast, isBusinessClosed, friendlyDate, getAvailableSlots, timeToMinutes,
    getCitaInterval, getCitaIntervalSync: getCitaInterval, // Exportamos ambos nombres por seguridad
    fallbackJid // JID de respaldo LID/teléfono, misma regla que usa bookAppointment
};
