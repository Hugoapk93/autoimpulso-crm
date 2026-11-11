const { getUser, updateUser, getFlowStep, getFullFlow, getSettings } = require('./database');
const { addManualContact } = require('./contacts');
const { isSimilar, normalizePhone } = require('./utils');
const { processError } = require('./handlers'); 
const stepHandlers = require('./stepHandlers'); 
const botEvents = require('./events'); 

// 🔥 REEMPLAZO: Usamos el servicio unificado en lugar de funciones de UI sueltas
const messageSender = require('./services/messageSender'); 

const INITIAL_STEP = 'BIENVENIDA';

// ==========================================
// 🛠️ FUNCIONES AUXILIARES PURAS
// ==========================================

const parseMessageData = (msg) => {
    const remoteJid = msg.key.remoteJid;
    const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
    
    return {
        remoteJid,
        text,
        isImage: !!msg.message?.imageMessage,
        isVideo: !!msg.message?.videoMessage,
        isAudio: !!msg.message?.audioMessage,
        isSticker: !!msg.message?.stickerMessage,
        incomingPhone: normalizePhone(remoteJid.split('@')[0])
    };
};

const handleMediaRejection = async (sock, remoteJid, dbKey, user, msgData, globalErrors) => {
    const { isAudio, isImage, isVideo } = msgData;
    let errMsg = null;

    if (isAudio && globalErrors.media?.audio) errMsg = globalErrors.media.audio;
    else if ((isImage || isVideo) && globalErrors.media?.image) errMsg = globalErrors.media.image;

    if (errMsg) {
        console.log(`⚠️ Respondiendo a multimedia no permitida de ${dbKey}: ${errMsg}`);
        
        // 🔥 DESACOPLADO: El servicio decide si lo manda por WA o al Frontend
        await messageSender.send(sock, remoteJid, errMsg);
        
        const currentStepConfig = getFlowStep(user.current_step);
        if (currentStepConfig) {
            await processError(currentStepConfig, user, dbKey, remoteJid, sock, null);
        }
        return true; 
    }
    return false;
};

const checkGlobalJumps = (text, fullFlow) => {
    for (const [stepId, config] of Object.entries(fullFlow)) {
        if (config.type === 'espera_catalogo') continue;
        if (config.keywords?.some(k => isSimilar(text, k))) return stepId;
    }
    return null;
};

// ==========================================
// 🚀 MOTOR PRINCIPAL DEL CHATBOT
// ==========================================

const handleMessage = async (sock, msg) => {
    try {
        const msgData = parseMessageData(msg);
        const { remoteJid, isSticker } = msgData;
        let { text } = msgData;

        if (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast') || isSticker) return;

        const dbKey = msgData.incomingPhone;
        let user = getUser(dbKey);

        if (user && user.bot_enabled === false) {
            console.log(`⏸️ [FLOW] Bot en pausa para ${dbKey}. Se ignora el procesamiento.`);
            return; 
        }

        const settings = getSettings();
        const globalErrors = settings.globalErrors || {};
        const errorsActive = globalErrors.active !== false;

        // 1. Manejo de Nuevos Usuarios sin Texto (Imágenes/Audios)
        if (!text && !user?.phone) {
            if (msgData.isImage) {
                console.log("📸 Cliente nuevo mandó imagen. Inyectando 'Hola'.");
                text = "Hola"; 
            } else if (msgData.isAudio && errorsActive && globalErrors.media?.audio) {
                await handleMediaRejection(sock, remoteJid, dbKey, {}, msgData, globalErrors);
                return;
            } else {
                return;
            }
        } 
        
        // 2. Manejo de Usuarios Existentes con Multimedia No Permitida
        if (!text && user?.phone && errorsActive) {
            const blocked = await handleMediaRejection(sock, remoteJid, dbKey, user, msgData, globalErrors);
            if (blocked) return;
        }

        // 3. Inicialización o Actualización de Estado del Usuario
        const timestamp = new Date().toISOString();
        let isFlowReset = false;

        if (!user?.phone) {
            await updateUser(dbKey, { current_step: INITIAL_STEP, history: {}, jid: remoteJid, last_active: timestamp });
            user = getUser(dbKey);
            isFlowReset = true;
        } else {
            await updateUser(dbKey, { last_active: timestamp, jid: remoteJid });
        }

        if (user.blocked) return;

        // 4. Controlador de Transiciones (Máquina de Estados)
        const ejecutarTransicion = async (destinoId) => {
            const destConf = getFlowStep(destinoId);
            const isFin = destConf && ['fin_bot', 'fin'].includes(destConf.type);

            await updateUser(dbKey, { 
                current_step: destinoId,
                bot_enabled: isFin ? false : undefined 
            });

            const updatedUser = getUser(dbKey);

            if (isFin) {
                console.log(`🏁 El cliente ${dbKey} aterrizó en el fin. Bot apagado.`);
                addManualContact(dbKey, updatedUser.name || dbKey, false);
            }

            // Emitimos evento local para que app.js lo mande al WebSockets
            botEvents.emit('user_update', { 
                phone: dbKey, 
                current_step: destinoId, 
                bot_enabled: updatedUser.bot_enabled 
            });

            // 🔥 DESACOPLADO: messageSender se encarga de formatear botones/listas y enviar
            await messageSender.sendStepMessage(sock, remoteJid, destinoId, updatedUser);
        };

        if (isFlowReset) {
            return await ejecutarTransicion(INITIAL_STEP);
        }

        // 5. Evaluación de Saltos Globales
        const jumpStep = checkGlobalJumps(text, getFullFlow());
        const currentConf = getFlowStep(user.current_step);

        if (jumpStep && jumpStep !== user.current_step && currentConf?.type !== 'filtro') {
            console.log(`🔀 Keyword Salto Global: ${jumpStep}`);
            return await ejecutarTransicion(jumpStep);
        }

        if (!currentConf || user.current_step === 'undefined') {
            return await ejecutarTransicion(INITIAL_STEP);
        }

        // 6. Ejecución del Patrón Strategy
        const stepProcessor = stepHandlers[currentConf.type];
        
        if (!stepProcessor) {
            console.warn(`⚠️ Tipo de paso desconocido o no implementado: ${currentConf.type}`);
            return;
        }

        const nextStepId = await stepProcessor(currentConf, text, user, dbKey, remoteJid, sock, msg);

        if (nextStepId) {
            await ejecutarTransicion(nextStepId);
        }

    } catch (err) {
        console.error("🔥 ERROR CRÍTICO EN FLOW:", err);
    }
};

module.exports = { handleMessage };