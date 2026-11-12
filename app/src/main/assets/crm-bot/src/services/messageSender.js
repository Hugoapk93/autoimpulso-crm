const fs = require('fs');
const path = require('path');
const { getFlowStep, saveFlowStep, updateUser, getUser, getSettings } = require('../database');
const { addManualContact } = require('../contacts');
// isBusinessClosed vive en src/services/agendaService.js: la versión que
// Hugo eligió (agendaService-2) YA lo exporta. El import '../agenda' ya no
// funciona porque agenda.js se eliminó del proyecto: con él, el bot no
// arrancaba (Cannot find module '../agenda') y caían 7 módulos en cadena.
const { isBusinessClosed } = require('./agendaService');
const botEvents = require('../events');
const { replaceDynamicVariables } = require('../validators');
const { normalizePhone } = require('../utils'); // Normalización oficial

const SIMULATOR_PHONE = '5218991234567';
const INITIAL_STEP = 'BIENVENIDA';
const publicFolder = path.resolve(__dirname, '../../public');
const esSimulador = (jid) => String(jid).includes(SIMULATOR_PHONE);

// ==========================================
// 🆔 LID vs TELÉFONO
// ==========================================
// Un LID NO es un teléfono: son dígitos que WhatsApp asigna a quien no está
// en tus contactos. normalizePhone() no lo puede convertir en número real,
// y no debe intentarlo: para un '@lid' devuelve los dígitos del LID, y esa
// es la clave estable del usuario en la BD hasta que aparezca el mapping
// LID -> teléfono (ver NOTAS.md, fusión en whatsapp.js).
//
// Cuando solo tenemos dígitos sueltos (panel web, API, sin '@'), hay que
// decidir el sufijo sin adivinar por la longitud a ciegas. OJO: primero se
// normaliza, porque un teléfono MX con prefijo 521 tiene 13 dígitos y NO
// es un LID:
//   - Teléfono MX normalizado: 12 dígitos empezando por 52 (o 10 locales)
//     -> '@s.whatsapp.net'
//   - Normalizado con más de 12 dígitos -> es un LID -> '@lid'
// Un LID típico tiene 15-16 dígitos; un teléfono MX nunca pasa de 12
// después de normalizar.
const resolveBareJid = (rawId) => {
    const normalized = normalizePhone(rawId);
    if (normalized.length > 12) return `${normalized}@lid`;
    return `${normalized}@s.whatsapp.net`;
};

// ==========================================
// 🌐 COMUNICACIÓN CON LA INTERFAZ WEB
// ==========================================
const enviarAlFrontend = (jid, contenido, type = 'text') => {
    const cleanPhone = normalizePhone(jid) || 'TEST_SIMULADOR';
    const isImageObj = typeof contenido === 'object' && contenido.url;
    const textPayload = isImageObj ? (contenido.caption || '') : String(contenido);

    botEvents.emit('message_ui', {
        phone: cleanPhone,
        to: cleanPhone,
        text: textPayload.replace(/\n/g, '<br>'),
        mediaUrl: isImageObj ? contenido.url : null,
        fromMe: true,
        timestamp: Date.now(),
        stepId: 'SIMULADOR_IA'
    });
};

const typing = async (sock, jid, length) => {
    if (esSimulador(jid)) return;
    let msBase = Math.min(Math.max(length * 30, 500), 4000);
    try {
        await sock.sendPresenceUpdate('composing', jid);
        await new Promise(r => setTimeout(r, msBase));
        await sock.sendPresenceUpdate('paused', jid);
    } catch(e) {}
};

// ==========================================
// 🚀 ENVÍO DIRECTO Y SIMPLE (Desde Interfaz Web)
// ==========================================
const send = async (sock, remoteJid, text, mediaUrl = null) => {
    if (esSimulador(remoteJid)) {
        const payload = mediaUrl ? { url: mediaUrl, caption: text } : text;
        enviarAlFrontend(remoteJid, payload, mediaUrl ? 'image' : 'text');
    } else {
        if (sock && sock.user) {
            // 🔥 CORREGIDO: antes un ID sin '@' siempre terminaba en
            // '@s.whatsapp.net', así que responder desde el panel a un
            // usuario LID construía un JID inexistente. Ahora un LID
            // suelto resuelve a '@lid' y un teléfono a '@s.whatsapp.net'.
            // Si ya trae '@' (ej. '...@lid'), se respeta tal cual.
            let jid = remoteJid.includes('@') ? remoteJid : resolveBareJid(remoteJid);

            // Consultar a los servidores de WhatsApp el JID oficial
            if (!jid.includes('@lid')) {
                try {
                    const waRecord = await sock.onWhatsApp(jid);
                    if (waRecord && waRecord[0] && waRecord[0].exists) {
                        jid = waRecord[0].jid;
                    }
                } catch (e) {
                    console.log(`⚠️ Error al verificar número en WA, intentando a la fuerza...`);
                }
            }

            try {
                if (mediaUrl) {
                    const finalPath = path.join(publicFolder, mediaUrl.replace(/^\//, ''));
                    if (fs.existsSync(finalPath)) {
                        await sock.sendMessage(jid, { image: { url: finalPath }, caption: text || '' });
                    } else {
                        console.error("❌ Imagen no encontrada en:", finalPath);
                    }
                } else if (text) {
                    await sock.sendMessage(jid, { text });
                }
            } catch (e) {
                console.error("❌ Error crítico enviando mensaje manual a WA:", e);
            }
        }
    }
};

// ==========================================
// 🧠 ORQUESTADOR DE PASOS DEL FLUJO
// ==========================================
const sendStepMessage = async (sock, jid, stepId, userData = {}) => {
    if (!jid || jid.startsWith('undefined') || jid === '@s.whatsapp.net' || jid === 'null@s.whatsapp.net') return false;

    let step = getFlowStep(stepId);
    if (!step && stepId === INITIAL_STEP) {
        step = { type: 'menu', message: '¡Hola! Bienvenido.', options: [] };
        await saveFlowStep(INITIAL_STEP, step);
    }
    if (!step) return false;
    if (step.type === 'espera_catalogo') return true;

    // Normalizamos la clave del cliente para consultar y actualizar la BD.
    // Para un '@lid', normalizePhone devuelve los dígitos del LID: esa es
    // la clave con la que whatsapp.js/flow.js guardaron a ese usuario, así
    // que aquí NO se parte el historial. La fusión LID -> teléfono, cuando
    // aparezca el mapping, se hace en whatsapp.js (ver NOTAS.md).
    const cleanClientPhone = normalizePhone(jid);

    if (step.type === 'fin_bot') {
        const contactName = userData.history?.nombre || userData.history?.cliente || userData.pushName || cleanClientPhone;
        addManualContact(cleanClientPhone, contactName, false);
    }

    let messageText = step.message || '';
    if (step.type === 'cita') messageText = step.msg_date || "📅 ¿Para qué día te gustaría agendar?";

    let isClosed = false;

    if (step.type === 'filtro') {
        if (isBusinessClosed()) {
            isClosed = true;
            const settings = getSettings();
            const tz = settings.timezone || "America/Matamoros";
            const currentDay = String(new Date(new Date().toLocaleString("en-US", {timeZone: tz})).getDay());

            const customDayMsg = settings.schedule?.days?.[currentDay]?.offline_message;
            messageText = customDayMsg || settings.schedule?.offline_message || "⛔ Nuestro horario de atención ha terminado.";
        }

        const hist = userData.history || {};
        let variablesResumen = Object.keys(hist).map(k => `📝 ${k.replace(/_/g, ' ')}: ${hist[k]}`).join('\n');

        botEvents.emit('push_notification', {
            title: isClosed ? `⚠️ Solicitud Cerrada (${cleanClientPhone})` : `⚠️ Solicitud: ${cleanClientPhone}`,
            body: `${variablesResumen || 'Ver detalles en Monitor...'}\nEnviado a las: ${new Date().toLocaleTimeString('es-MX')}`,
            url: `/#activity?chat=${cleanClientPhone}`
        });
    }

    // Delegamos el Parseo de Variables Dinámicas al motor centralizado
    const tz = getSettings().timezone || "America/Matamoros";

    if (messageText) {
        messageText = replaceDynamicVariables(messageText, userData, tz);

        if (step.type === 'menu' && step.options?.length > 0) {
            messageText += '\n\n' + step.options.map((opt, i) => `${i + 1}️⃣ *${opt.label}*`).join('\n');
        }
    }

    if (!esSimulador(jid) && !jid.includes('@lid') && sock?.user) {
        try {
            const waRecord = await sock.onWhatsApp(jid);
            if (!waRecord?.[0]?.exists) return false;
            jid = waRecord[0].jid;
        } catch (e) {}
    }

    let mediaList = Array.isArray(step.media) ? step.media : (step.media ? [step.media] : []);
    if (step.type === 'filtro' && isClosed) mediaList = [];
    let sentImage = false, isSuccess = true;
    // delivered: ¿realmente salió algo (imagen o texto) hacia el cliente?
    // Sin esto, un envío que no salió (sin conexión, paso sin mensaje)
    // devolvía true y el recordatorio se marcaba como enviado.
    let delivered = false;

    for (let i = 0; i < mediaList.length; i++) {
        const finalPath = path.join(publicFolder, mediaList[i].replace(/^\//, ''));
        if (fs.existsSync(finalPath)) {
            const caption = (i === 0) ? messageText : "";
            try {
                if (esSimulador(jid)) {
                    enviarAlFrontend(jid, { url: mediaList[i], caption }, 'image');
                    sentImage = true; delivered = true;
                } else if (sock?.user) {
                    await sock.sendMessage(jid, { image: { url: finalPath }, caption });
                    sentImage = true; delivered = true;
                }
                if (mediaList.length > 1) await new Promise(r => setTimeout(r, 800));
            } catch (e) { isSuccess = false; }
        }
    }

    if (!sentImage && messageText) {
        await typing(sock, jid, messageText.length);
        try {
            if (esSimulador(jid)) { enviarAlFrontend(jid, messageText); delivered = true; }
            else if (sock?.user) { await sock.sendMessage(jid, { text: messageText }); delivered = true; }
        } catch (e) { isSuccess = false; }
    }

    if (isSuccess) {
        const cleanLastMsg = (messageText || (sentImage ? '📷 Imagen' : '...')).replace(/[\r\n]+/g, ' ');
        const timestampIso = new Date().toISOString();

        let updateData = {
            last_message: cleanLastMsg,
            last_active: timestampIso
        };

        if (esSimulador(jid)) {
            updateData.newMessage = {
                text: messageText,
                mediaUrl: sentImage ? mediaList[0] : null,
                fromMe: true,
                stepId: stepId,
                timestamp: timestampIso
            };
        }

        await updateUser(cleanClientPhone, updateData);
    }

    if (step.type === 'message' && step.next_step && step.next_step !== stepId) {
        setTimeout(async () => {
             const checkUser = getUser(cleanClientPhone);
             if (checkUser?.current_step === stepId) {
                 await updateUser(cleanClientPhone, { current_step: step.next_step });
                 // Avisar al panel: el paso cambio (puede ser un filtro);
                 // sin este evento los botones no aparecen hasta re-entrar.
                 botEvents.emit('user_update', { phone: cleanClientPhone, current_step: step.next_step });
                 await sendStepMessage(sock, jid, step.next_step, userData);
             }
        }, 1500);
    }

    return isSuccess && delivered;
};

module.exports = { sendStepMessage, send, esSimulador, resolveBareJid };
