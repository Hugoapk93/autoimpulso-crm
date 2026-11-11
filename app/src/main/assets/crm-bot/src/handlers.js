const Fuse = require('fuse.js');

// 1. 🗄️ Importaciones de BD y Utilidades puras
const { basicClean, isQuestion, processVariable } = require('./validators');
const { updateUser, getKeywords, saveKeyword, getSystemTime } = require('./database');
const { validateBusinessRules, checkAvailability, bookAppointment, isDateInPast, friendlyDate, getAvailableSlots, timeToMinutes } = require('./services/agendaService');

// 2. 🤖 Importaciones de Nuevos Servicios Aislados
const nlpService = require('./services/nlpService'); // Maneja regex y extracciones
const messageSender = require('./services/messageSender'); // Orquesta si es simulador o WA real
const botEvents = require('./events'); // Nuestro bus de eventos sin globales

// ==========================================
// 🛠️ MANEJADORES AUXILIARES
// ==========================================

async function handleDudaPendiente(rawText) {
    try {
        const todasLasReglas = getKeywords();
        if (!todasLasReglas.find(regla => regla.keywords === rawText)) {
            saveKeyword({ id: 'kw_' + Date.now(), keywords: rawText, answer: "" });
        }
    } catch (err) {
        console.error("Error guardando duda pendiente:", err);
    }
}

// Mensajes por categoría de error (lo que valida processVariable en
// validators.js). Si el paso trae su propio error_message, ese manda.
const ERROR_MESSAGES = {
    menu: 'No entendí tu respuesta. Elige una de las opciones del menú, por favor 👆',
    catalogo: '⚠️ Por favor, responde usando el formato indicado para continuar.',
    name: 'Ese nombre no parece válido. ¿Me lo escribes de nuevo, solo con letras?',
    date: 'Esa fecha no parece válida. Escríbela como día/mes/año, por ejemplo 15/03/1990.',
    email: 'Ese correo no parece válido. ¿Me lo escribes de nuevo?',
    curp: 'Esa CURP no parece válida. ¿Me la escribes de nuevo?',
    rfc: 'Ese RFC no parece válido. ¿Me lo escribes de nuevo?',
    phone: 'Ese teléfono no parece válido. ¿Me lo escribes de nuevo con 10 dígitos?',
    zip: 'Ese código postal no parece válido. ¿Me lo escribes de nuevo?'
};

async function processError(stepConfig, user, dbKey, remoteJid, sock, defaultMsg, category = null) {
    // flow.js llama con defaultMsg === null cuando YA envió el mensaje
    // (p. ej. multimedia no permitida): ahí solo se cuenta y se ancla,
    // para no mandar un segundo mensaje.
    const silentAnchor = defaultMsg === null && !stepConfig?.error_message && !category;
    const errorCount = (user?.error_count || 0) + 1;
    try {
        await updateUser(dbKey, { error_count: errorCount });
    } catch (e) { console.error('Error guardando error_count:', e); }

    if (!silentAnchor) {
        const msg = (defaultMsg && String(defaultMsg).trim())
            || stepConfig?.error_message
            || ERROR_MESSAGES[category]
            || 'No entendí tu mensaje. ¿Me lo puedes repetir de otra forma?';
        // A partir del tercer intento fallido seguido, ofrecer ayuda humana
        // en vez de repetir el mismo mensaje.
        const finalMsg = errorCount >= 3
            ? `${msg}\n\nSi lo prefieres, un asesor te atiende en cuanto pueda. 🙏`
            : msg;
        try {
            await messageSender.send(sock, remoteJid, finalMsg);
        } catch (e) { console.error('Error enviando mensaje de error al cliente:', e); }
    }

    console.log(`⚠️ Respuesta inválida de ${dbKey} (intento ${errorCount}, categoría: ${category || 'general'}). ${silentAnchor ? 'Sin mensaje nuevo (ya se avisó);' : 'Se le respondió y'} se quedó en el paso actual.`);
    return null; // Ancla el bot en el paso actual
}

// ==========================================
// 📋 MANEJADOR DE MENÚS (Navegación)
// ==========================================

async function handleMenuStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const cleanText = text.trim();
    const inputLimpio = basicClean(cleanText);

    // 1. Selección por número rápido
    const matchNumero = cleanText.match(/\b(\d+)\b/);
    if (matchNumero && stepConfig.options?.length > 0) {
        const optionIndex = parseInt(matchNumero[1]) - 1; 
        if (optionIndex >= 0 && optionIndex < stepConfig.options.length) {
            return stepConfig.options[optionIndex].next_step;
        }
    }

    // 2. Coincidencia exacta/parcial Inteligente
    if (stepConfig.options?.length > 0) {
        for (const opt of stepConfig.options) {
            const labelLimpio = basicClean(opt.label);
            const regexPalabraExacta = new RegExp(`\\b${labelLimpio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);

            if (inputLimpio === labelLimpio || 
                (inputLimpio.length >= 3 && labelLimpio.includes(inputLimpio)) || 
                (labelLimpio.length >= 3 && inputLimpio.includes(labelLimpio)) || 
                regexPalabraExacta.test(inputLimpio)) {
                return opt.next_step;
            }
        }
        
        // 3. Búsqueda difusa (Errores ortográficos)
        const fuse = new Fuse(stepConfig.options.map(opt => ({ label: basicClean(opt.label), next_step: opt.next_step })), {
            keys: ['label'], threshold: 0.4, ignoreLocation: true
        });

        const fuzzyResults = fuse.search(inputLimpio);
        if (fuzzyResults.length > 0) return fuzzyResults[0].item.next_step;
    }

    if (isQuestion(text)) await handleDudaPendiente(text);
    return await processError(stepConfig, user, dbKey, remoteJid, sock, "", 'menu');
}

// ==========================================
// ✍️ MANEJADOR DE INPUTS (Captura de datos)
// ==========================================

async function handleInputStep(stepConfig, text, user, dbKey, remoteJid, sock) {
    const varName = (stepConfig.save_var || 'temp').trim();
    const textoDirecto = text.trim();

    // 1. Extracción con NLP
    let valorExtraido = nlpService.smartExtract(varName, textoDirecto);

    // 🔥 2. Validación y Normalización Dinámica Centralizada
    const validation = processVariable(varName, valorExtraido);

    if (!validation.isValid) {
        if (isQuestion(textoDirecto)) await handleDudaPendiente(textoDirecto);
        return await processError(stepConfig, user, dbKey, remoteJid, sock, "", validation.errorCategory);
    }

    if (isQuestion(textoDirecto)) {
        await handleDudaPendiente(textoDirecto);
        return await processError(stepConfig, user, dbKey, remoteJid, sock, "");
    }

    // 3. Guardado incondicional (ahora con el valor normalizado correctamente)
    const history = { ...user.history, [varName]: validation.value };
    await updateUser(dbKey, { history, error_count: 0 });
    
    return stepConfig.next_step;
}

// ==========================================
// 📅 MANEJADOR DE CITAS (Orquestador Limpio)
// ==========================================

async function handleCitaStep(stepConfig, text, user, dbKey, remoteJid, sock, msg) {
    if (isQuestion(text)) await handleDudaPendiente(text);

    // 1. Extraer Intención usando el servicio
    const { date, time } = nlpService.extractDateTime(text);
    const history = { ...user.history };
    const interval = parseInt(stepConfig.interval) || 30;

    if (date) {
        history.fecha = date;
        history.hora = time; // Si time es null, borra cualquier hora vieja que tuviera guardada
    } else if (time) {
        // Si el cliente solo dio la hora (ej: "a las 5"), la guardamos
        history.hora = time;
    }
    
    // Si es un evento de día completo (intervalo 1440 = 24h) y no hay hora, ponemos 08:00
    if (history.fecha && interval === 1440 && !history.hora) history.hora = '08:00';

    // 2. Limpiar fechas caducadas (Si agendó para un día que ya pasó, borramos todo)
    if (history.fecha && history.fecha < getSystemTime().dateString) {
        delete history.fecha;
        delete history.hora;
    }
    
    await updateUser(dbKey, { history });

    // 3. Solicitar Datos Faltantes (Usando el nuevo MessageSender)
    if (!history.fecha) {
        await messageSender.send(sock, remoteJid, stepConfig.msg_date || "📅 ¿Para qué día te gustaría agendar?");
        return null;
    }
    if (!history.hora) {
        const txt = (stepConfig.msg_time || `Perfecto, para el *{{fecha}}*.\n¿A qué hora puedes venir?`).replace('{{fecha}}', friendlyDate(history.fecha));
        await messageSender.send(sock, remoteJid, txt);
        return null;
    }

    // 4. Validar Reglas de Negocio (Horarios e intervalos)
    if (interval < 1440 && !nlpService.isValidInterval(history.hora, interval)) {
        await messageSender.send(sock, remoteJid, nlpService.getIntervalErrorMessage(history.hora, interval));
        // Borramos la hora errónea para que la vuelva a pedir
        await updateUser(dbKey, { history: { ...history, hora: null } });
        return null;
    }

    if (isDateInPast(history.fecha, history.hora)) {
        await messageSender.send(sock, remoteJid, "⚠️ Fecha pasada. \nIndica una futura.");
        await updateUser(dbKey, { history: { ...history, hora: null } });
        return null;
    }

    const rules = validateBusinessRules(history.hora, history.fecha);
    if (!rules.valid) {
        await messageSender.send(sock, remoteJid, rules.reason);
        await updateUser(dbKey, { history: { ...history, hora: null } });
        return null;
    }

    // 5. Validar Disponibilidad y Ofrecer Alternativas
    const isAvailable = await checkAvailability(history.fecha, history.hora);
    if (!isAvailable) {
        const alternativasTxt = await nlpService.buildAlternativesMessage(history.fecha, history.hora, interval);
        await messageSender.send(sock, remoteJid, alternativasTxt);
        await updateUser(dbKey, { history: { ...history, hora: null } });
        return null;
    }

    // 6. Ejecutar Acción Principal (Guardar en Agenda)
    const finalName = history.nombre || msg.pushName || 'Cliente';
    // remoteJid es el JID real de WhatsApp (@lid o @s.whatsapp.net): es
    // más fiable que buscarlo en la BD, y evita que la cita quede con un
    // JID inventado cuando el usuario es LID.
    const booked = await bookAppointment(history.fecha, history.hora, dbKey, finalName, remoteJid);
    if (!booked) {
        // El hueco se ocupó entre el chequeo y la reserva: no confirmar
        // una cita que no existe; ofrecer alternativas y quedarse en el paso.
        const alternativasTxt = await nlpService.buildAlternativesMessage(history.fecha, history.hora, interval);
        await messageSender.send(sock, remoteJid, alternativasTxt);
        await updateUser(dbKey, { history: { ...history, hora: null } });
        return null;
    }

    // 7. Disparar Eventos Globales (Desacoplado)
    botEvents.emit('new_message_ui', { phone: dbKey, fromMe: false }); // Esto disparará el Push en app.js
    
    // 8. Finalizar
    if (user.error_count > 0) await updateUser(dbKey, { error_count: 0 }); 

    if (stepConfig.next_step) {
        return stepConfig.next_step; 
    } else {
        await messageSender.send(sock, remoteJid, `✅ Cita confirmada: ${friendlyDate(history.fecha)} a las ${history.hora}`);
        return null;
    }
}

module.exports = { handleMenuStep, handleInputStep, handleCitaStep, processError };