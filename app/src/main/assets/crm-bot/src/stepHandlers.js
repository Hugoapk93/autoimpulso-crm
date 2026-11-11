const { handleMenuStep, handleInputStep, handleCitaStep, processError } = require('./handlers');
const { matchWildcardPhrase } = require('./validators'); // 🔥 Importamos el validador
const messageSender = require('./services/messageSender'); 
const { updateUser } = require('./database');
const { addManualContact } = require('./contacts');
const botEvents = require('./events');

const delay = (ms) => new Promise(res => setTimeout(res, ms));

const stepHandlers = {
    menu: handleMenuStep,
    input: handleInputStep,
    cita: handleCitaStep,
    
    espera_catalogo: async (config, text, user, dbKey, remoteJid, sock) => {
        // 🔥 Evaluamos la frase delegando la lógica al validador centralizado
        const { match, extractedData } = matchWildcardPhrase(config.exact_phrase, text);
        
        if (!match) {
            const errMsg = config.error_message || "⚠️ Por favor, responde usando el formato indicado para continuar.";
            await processError(config, user, dbKey, remoteJid, sock, errMsg, 'catalogo');
            return null; // Detiene el flujo
        }

        // Si se extrajo un dato gracias al asterisco, lo guardamos en el historial del cliente
        if (extractedData) {
            console.log(`✅ Dato extraído del catálogo para ${dbKey}: ${extractedData}`);
            await updateUser(dbKey, { history: { producto_interes: extractedData } });
        }
        
        if (config.message && config.message.trim() !== '') {
            await messageSender.send(sock, remoteJid, config.message);
            await delay(1000); 
        }
        
        return config.next_step;
    },

    filtro: () => null,
    message: () => null,

    fin_bot: async (config, text, user, dbKey) => {
        await updateUser(dbKey, { bot_enabled: false });
        addManualContact(dbKey, user.name || dbKey, false);
        botEvents.emit('user_update', { phone: dbKey, bot_enabled: false });
        return null;
    },
    
    fin: async (config, text, user, dbKey) => {
        return stepHandlers.fin_bot(config, text, user, dbKey);
    }
};

module.exports = stepHandlers;