const { getSettings, saveSettings, updateUser, getUser } = require('./database');
const { normalizePhone } = require('./utils');
// La agenda que Hugo eligió vive en src/services/agendaService.js
// (agendaService-2). Es el módulo único de agenda: api.js, handlers.js,
// nlpService.js, messageSender.js y este archivo lo importan directamente,
// así que todos comparten el mismo candado y el mismo agenda.json.
const agendaService = require('./services/agendaService');
const messageSender = require('./services/messageSender');

// 🔥 CONTROL DE CICLOS Y MUTEX
let isSchedulerRunning = false;
let schedulerInterval = null; // Guarda el reloj para poder destruirlo
let activeSock = null; // Siempre guardará la conexión viva más reciente

const getRealLocalTimeForScheduler = () => {
    const settings = getSettings();
    const tz = settings.timezone || "America/Matamoros";
    const now = new Date(new Date().toLocaleString("en-US", {timeZone: tz}));
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return {
        dateStr: `${y}-${m}-${d}`,
        timeStr: `${h}:${min}`,
        timezone: tz
    };
};

// ==========================================
// 🆔 JID DEL RECORDATORIO (LID vs TELÉFONO)
// ==========================================
// ANTES: (dbPhone.length > 15 ? `${dbPhone}@lid` : `${dbPhone}@s.whatsapp.net`)
// Eso fallaba con un LID típico de 15 dígitos: 15 > 15 es falso, así que el
// recordatorio se mandaba a '...@s.whatsapp.net' con los dígitos del LID,
// un JID que no existe, y el cliente nunca lo recibía.
//
// AHORA, en este orden, sin adivinar por la longitud:
//   1. El JID guardado en la cita (appt.jid) o en el usuario (userData.jid):
//      la agenda ya guarda el JID real ('...@lid' o '...@s.whatsapp.net').
//   2. Si ese JID guardado es '@s.whatsapp.net' pero sus dígitos son de un
//      LID (> 12 dígitos, un teléfono MX nunca pasa de 12), se corrige a
//      '@lid'. Son citas viejas que la API guardó mal.
//   3. Si no hay JID guardado, se resuelve desde los dígitos con la misma
//      regla que messageSender.resolveBareJid().
const resolveReminderJid = (appt, userData, dbPhone) => {
    const stored = (appt.jid || userData.jid || '').trim();
    if (stored.includes('@')) {
        const [userPart, domain] = stored.split('@');
        const digits = userPart.replace(/\D/g, '');
        // OJO: normalizar primero. Un teléfono con prefijo 521 tiene 13
        // dígitos y NO es un LID; solo un normalizado de más de 12 lo es.
        if (domain === 's.whatsapp.net' && normalizePhone(digits).length > 12) {
            return `${normalizePhone(digits)}@lid`; // JID viejo guardado mal por la API
        }
        return stored;
    }
    return messageSender.resolveBareJid(dbPhone);
};

const checkScheduler = async () => {
    // 1. Evitamos ejecutar si el bot está desconectado o el socket no existe
    if (!activeSock) return;

    // (Eliminado el candado estricto de readyState que causaba el falso positivo)

    if (isSchedulerRunning) {
        console.log("⏳ [Scheduler] Bloqueado: Hay un envío de recordatorios en curso. Esperando...");
        return;
    }

    try {
        const settings = getSettings();
        if (!settings.scheduler || !settings.scheduler.active) return;

        const config = settings.scheduler;
        if (!config.time || !config.target_step) return;

        const sysTime = getRealLocalTimeForScheduler();
        const todayStr = sysTime.dateStr;
        const currentTime = sysTime.timeStr;

        if (config.last_run === todayStr) return;
        if (currentTime < config.time) return;

        isSchedulerRunning = true;

        console.log(`⏰ [Scheduler] Hora configurada alcanzada (${currentTime} en ${sysTime.timezone}). Iniciando revisión...`);

        const agendaData = await agendaService.getAgenda();
        const todayAppts = agendaData[todayStr] || [];

        if (todayAppts.length === 0) {
            console.log("📅 Hoy no hay citas agendadas. Cerrando scheduler del día.");
            await saveSettings({ scheduler: { ...config, last_run: todayStr } });
            isSchedulerRunning = false;
            return;
        }

        console.log(`🔍 Analizando ${todayAppts.length} citas para hoy...`);
        let movedCount = 0;
        let allSuccess = true;
        let hasChanges = false;

        for (const appt of todayAppts) {
            if (appt.recordatorio_enviado) continue;

            if (appt.created_at) {
                const createdFormatter = new Intl.DateTimeFormat("en-CA", {
                    timeZone: sysTime.timezone, year: 'numeric', month: '2-digit', day: '2-digit'
                });
                if (createdFormatter.format(new Date(appt.created_at)) === todayStr) {
                    console.log(`⏩ Saltando a ${appt.name} (Agendó hoy mismo).`);
                    appt.recordatorio_enviado = true;
                    hasChanges = true;
                    continue;
                }
            }

            const dbPhone = (appt.phone || "").replace(/\D/g, '');
            if (!dbPhone) continue;

            // El cliente se mueve al paso del recordatorio, pero su estado
            // de pausa NO se toca. Antes se hacía toggleContactBot(dbPhone,
            // true) y bot_enabled: true, lo que reactivaba el bot a clientes
            // que el operador había pausado (o que terminaron el flujo en
            // fin_bot, que apaga el bot). El recordatorio no necesita
            // reactivar nada: sendStepMessage no consulta bot_enabled, solo
            // el flujo de mensajes entrantes lo hace. Así el recordatorio
            // llega igual, y el bot sigue en pausa como estaba.
            const storedUser = getUser(dbPhone) || {};
            const userData = { phone: dbPhone, ...storedUser };
            const wasPaused = storedUser.bot_enabled === false;
            if (wasPaused) console.log(`⏸️ ${appt.name} tiene el bot en pausa: se envía el recordatorio sin reactivarlo.`);

            console.log(`🚀 Moviendo a ${appt.name} al paso: ${config.target_step}`);
            await updateUser(dbPhone, { current_step: config.target_step });

            const targetJid = resolveReminderJid(appt, userData, dbPhone);

            try {
                // 🔥 Usamos activeSock para garantizar que enviamos por la conexión VIVA
                await messageSender.sendStepMessage(activeSock, targetJid, config.target_step, userData);

                appt.recordatorio_enviado = true;
                hasChanges = true;
                movedCount++;

                const delayMs = Math.floor(Math.random() * (8000 - 5000 + 1)) + 5000;
                await new Promise(r => setTimeout(r, delayMs));
            } catch (err) {
                console.log(`⚠️ Falló el envío a ${appt.name} (JID: ${targetJid}). Error: ${err.message}`);
                allSuccess = false;
            }
        }

        if (hasChanges) {
            await agendaService.saveAgenda(agendaData);
        }

        if (allSuccess) {
            await saveSettings({ scheduler: { ...config, last_run: todayStr } });
            console.log(`✅ [Scheduler] Día cerrado correctamente. ${movedCount} recordatorios enviados reales.`);
        }
    } catch (e) {
        console.error("🔥 Error en Scheduler:", e);
    } finally {
        isSchedulerRunning = false;
    }
};

const initScheduler = (sock) => {
    // 1. Siempre actualizamos a la conexión más fresca
    activeSock = sock;

    // 2. Destruimos el reloj fantasma anterior si es que hubo una desconexión
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
    }

    console.log("🕰️ Módulo Scheduler (Recordatorios) -> INICIADO");
    schedulerInterval = setInterval(() => checkScheduler(), 60000);
};

// checkScheduler se exporta para poder probarlo sin esperar al intervalo.
module.exports = { initScheduler, resolveReminderJid, checkScheduler };
