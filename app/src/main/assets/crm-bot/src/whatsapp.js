const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const fsAsync = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

const { handleMessage } = require('./flow');
const { initScheduler } = require('./scheduler');
const { syncContacts, getAllContacts, addManualContact, removeContact } = require('./contacts');
const { getSettings, updateUser, getUser, deleteUser, updateMessage, getLidMap, saveLidMap } = require('./database');
const { normalizePhone } = require('./utils');
const agendaService = require('./services/agendaService');
const { findKeywordMatch } = require('./keywords');
const messageSender = require('./services/messageSender'); 

const TOWER_URL = 'http://localhost:8888/api/instances/report';
const INSTANCE_ID = 'bot_' + (process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 3000);

const authDir = 'auth_info_baileys';
const uploadDir = path.join(__dirname, '../public/uploads');
const dataDir = path.join(__dirname, '../data');

// Mapa LID -> telefono real: tabla lid_map en data/crm.db (database.js).
// getLidMap / saveLidMap se importan de database.js.


class WhatsAppService extends EventEmitter {
    constructor() {
        super();
        this.sock = null;
        this.qr = null;
        this.status = 'disconnected';
        this.isShuttingDown = false;
        
        this.userMessageBuffers = new Map();
        this.userMessageTimers = new Map();
        this.hilosActivos = new Set();
        this.processedMessages = [];
    }

    async reportToTower() {
        try {
            await fetch(TOWER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: INSTANCE_ID, status: this.status, qr: this.qr, version: '2.2.0' })
            });
        } catch (e) {}
    }

    async connect() {
        if (['connecting', 'rebooting', 'connected'].includes(this.status)) return;
        
        this.status = 'connecting';
        this.reportToTower();
        console.log("🔄 Iniciando conexión a WhatsApp...");

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 2000,
            connectTimeoutMs: 60000,
            syncFullHistory: false,
            browser: ["CRM Bot", "Chrome", "2.0.0"],
        });

        this.sock.ev.on('creds.update', () => {
            saveCreds();
            if (this.status === 'qr_ready' && this.sock.authState.creds.me) {
                console.log("🔄 QR Escaneado exitosamente. Generando sesión...");
                this.status = 'loading'; 
                this.qr = null; 
            }
        });
        
        // Borrar un chat en el teléfono: sale de la lista del panel pero
        // se conservan el número, el nombre y el estado del bot (paso y
        // pausa). El borrado desde el panel es solo local: no se propaga
        // al teléfono.
        this.sock.ev.on('chats.delete', this.handleChatsDelete.bind(this));
        // Reacciones y mensajes eliminados (el espejo en vivo).
        this.sock.ev.on('messages.reaction', this.handleMessagesReaction.bind(this));
        this.sock.ev.on('messages.delete', this.handleMessagesDelete.bind(this));

        this.sock.ev.on('connection.update', this.handleConnectionUpdate.bind(this));
        this.sock.ev.on('presence.update', this.handlePresenceUpdate.bind(this));
        this.sock.ev.on('messages.upsert', this.handleMessagesUpsert.bind(this));
        this.sock.ev.on('contacts.upsert', this.handleContactsUpsert.bind(this));
    }

    async esperarInternetYConectar() {
        if (this.isShuttingDown) return;
        console.log("📡 Sin red. Esperando conexión a Internet en silencio...");
        let hasInternet = false;
        
        while (!hasInternet && !this.isShuttingDown) {
            try {
                await require('dns').promises.lookup('google.com');
                hasInternet = true;
            } catch (err) {
                await new Promise(r => setTimeout(r, 5000));
            }
        }
        
        if (!this.isShuttingDown) {
            console.log("🌐 ¡Internet detectado! Reanudando conexión a WhatsApp...");
            this.connect();
        }
    }

    handleConnectionUpdate(update) {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            this.qr = qr;
            this.status = 'qr_ready';
            this.reportToTower();
            this.emit('qr', qr); 
        }

        if (connection === 'close') {
            const reason = (lastDisconnect.error)?.output?.statusCode;
            const isLoggedOut = reason === DisconnectReason.loggedOut;
            const shouldReconnect = !isLoggedOut;
            
            this.status = 'disconnected';
            this.qr = null;
            this.reportToTower();
            this.emit('status', 'disconnected');

            if (isLoggedOut) {
                console.log("⚠️ Sesión cerrada desde el celular. Limpiando credenciales y generando nuevo QR...");
                try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
                if (!this.isShuttingDown) setTimeout(() => this.connect(), 3000);
            } else if (shouldReconnect && !this.isShuttingDown) {
                this.esperarInternetYConectar();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot CONECTADO');
            this.status = 'connected';
            this.qr = null;
            this.reportToTower();
            this.emit('status', 'connected');
            initScheduler(this.sock);
        }
    }

    handlePresenceUpdate(m) {
        const fullJid = m.id;
        const incomingPhoneRaw = normalizePhone(fullJid.replace(/[^0-9]/g, ''));
        const estado = m.presences[fullJid]?.lastKnownPresence; 

        if (this.userMessageTimers.has(incomingPhoneRaw) && estado) {
            const timerData = this.userMessageTimers.get(incomingPhoneRaw);
            if (estado === 'composing') {
                clearTimeout(timerData.timer);
                timerData.timer = setTimeout(() => this.procesarMensajeAgrupado(incomingPhoneRaw), 10000);
            } 
            else if (estado === 'paused') {
                clearTimeout(timerData.timer);
                this.procesarMensajeAgrupado(incomingPhoneRaw);
            }
        }
    }

    async handleContactsUpsert(contacts) {
        syncContacts(contacts);
        let lidMap = getLidMap();
        let updated = false;
        const currentContactsList = getAllContacts(); 
        
        for (const c of contacts) {
            const cId = c.id || '';
            const cLid = c.lid || '';

            if (c.name && cId.includes('@s.whatsapp.net')) {
                const finalRealPhone = normalizePhone(cId.replace(/[^0-9]/g, ''));
                const currentUser = getUser(finalRealPhone) || {};
                const userHistory = currentUser.history || {};
                userHistory.nombre = c.name; 
                
                const existingContact = currentContactsList.find(x => normalizePhone(x.phone) === finalRealPhone);
                let targetBotState = existingContact?.bot_enabled !== undefined ? existingContact.bot_enabled : (currentUser.bot_enabled !== undefined ? currentUser.bot_enabled : true);
                
                addManualContact(finalRealPhone, c.name, targetBotState);
                await updateUser(finalRealPhone, { name: c.name, history: userHistory, bot_enabled: targetBotState });
                this.emit('user_update', { phone: finalRealPhone, name: c.name, bot_enabled: targetBotState });
            }

            if (cId.includes('@s.whatsapp.net') && cLid.includes('@lid')) {
                const cleanPhone = cId.replace(/[^0-9]/g, '');
                const cleanLid = cLid.replace(/[^0-9]/g, '');
                const finalRealPhone = normalizePhone(cleanPhone);
                const lidKey = normalizePhone(cleanLid);

                if (cleanPhone && cleanLid && lidMap[cleanLid] !== finalRealPhone) {
                    lidMap[cleanLid] = finalRealPhone;
                    updated = true;
                }

                // Fusión LID → teléfono: corre aunque el mapping ya existiera
                // en lid_map.json, porque hay registros partidos de antes de
                // que existiera este código (self-healing). Si el usuario
                // bajo el LID ya se fusionó (archivado) o no existe, no hace
                // nada: es idempotente.
                if (cleanPhone && cleanLid && lidKey && lidKey !== finalRealPhone) {
                    await this.migrateLidUser(lidKey, cleanLid, finalRealPhone);
                }
            }
        }
        if (updated) saveLidMap(lidMap);
    }

    // ==========================================
    // 🔀 FUSIÓN LID → TELÉFONO
    // ==========================================
    // Cuando se aprende (o ya se conocía) el mapping LID → teléfono real,
    // el cliente tiene su historial partido: lo que escribió antes de que
    // guardaras el contacto vive bajo la clave LID, y lo nuevo bajo el
    // teléfono. Esta fusión lo une en el registro del teléfono:
    // historial, mensajes, paso actual, estado de pausa y citas. El
    // registro viejo queda archivado (soft delete existente) y su entrada
    // en el panel se elimina, para no ver al mismo cliente dos veces.
    // Es idempotente: si el registro LID ya está archivado o no existe,
    // no hace nada. Si algo falla a mitad, el error se registra y el
    // mensaje/historial viejo sigue donde estaba (no se borra nada antes
    // de haberlo copiado al registro nuevo).
    async migrateLidUser(lidKey, cleanLid, finalRealPhone) {
        try {
            const lidUser = getUser(lidKey);
            if (!lidUser || !lidUser.phone || lidUser.archived) return false;
            const phoneUser = getUser(finalRealPhone) || {};

            // Historial: el del teléfono manda en los campos que ya tenga
            // (p. ej. el nombre guardado en el contacto); el resto viene del LID.
            const mergedHistory = { ...(lidUser.history || {}), ...(phoneUser.history || {}) };

            // Mensajes: se unen, se quitan duplicados por id, se ordenan por
            // fecha y se conservan los últimos 30 (igual que updateUser).
            const seenIds = new Set();
            const mergedMessages = [...(lidUser.messages || []), ...(phoneUser.messages || [])]
                .filter(m => m && m.id && !seenIds.has(m.id) && seenIds.add(m.id))
                .sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')))
                .slice(-30);

            // Paso: el del LID (ahí iba la conversación), salvo que sea el
            // inicial y el del teléfono tenga uno real.
            const lidStep = lidUser.current_step;
            const phoneStep = phoneUser.current_step;
            const current_step = (lidStep && lidStep !== 'BIENVENIDA') ? lidStep : (phoneStep || lidStep || 'BIENVENIDA');

            // Estado de pausa: manda el del LID, que es el registro vivo de
            // la conversación. El del teléfono suele ser un cascarón creado
            // por la sincronización de contactos.
            const mergedBotEnabled = lidUser.bot_enabled !== undefined ? lidUser.bot_enabled : phoneUser.bot_enabled;

            // Último mensaje: el del registro con actividad más reciente.
            const useLidLast = String(lidUser.last_active || '') >= String(phoneUser.last_active || '');

            await updateUser(finalRealPhone, {
                history: mergedHistory,
                messages: mergedMessages,
                current_step,
                name: phoneUser.name || lidUser.name,
                jid: `${finalRealPhone}@s.whatsapp.net`,
                lid: cleanLid,
                bot_enabled: mergedBotEnabled,
                last_message: useLidLast ? (lidUser.last_message || '') : (phoneUser.last_message || ''),
                last_active: useLidLast ? (lidUser.last_active || '') : (phoneUser.last_active || ''),
            });

            // El panel debe mostrar el mismo estado de pausa que el usuario.
            addManualContact(finalRealPhone, phoneUser.name || lidUser.name, mergedBotEnabled);

            // Archivar el registro viejo (soft delete) y quitar su entrada
            // del panel. Esto va DESPUÉS de copiar todo al registro nuevo.
            deleteUser(lidKey);
            removeContact(lidKey);

            // Migrar también sus citas: mismo cliente, nueva clave.
            try {
                const agenda = await agendaService.getAgenda();
                let changed = false;
                for (const date of Object.keys(agenda)) {
                    const list = agenda[date];
                    if (!Array.isArray(list)) continue;
                    for (const c of list) {
                        if (c && normalizePhone(String(c.phone || '')) === lidKey) {
                            c.phone = finalRealPhone;
                            c.jid = `${finalRealPhone}@s.whatsapp.net`;
                            changed = true;
                        }
                    }
                }
                if (changed) await agendaService.saveAgenda(agenda);
            } catch (e) {
                console.error('⚠️ No se pudieron migrar las citas del LID:', e.message);
            }

            console.log(`🔀 LID ${lidKey} fusionado en ${finalRealPhone}: historial, mensajes y citas migrados.`);
            this.emit('user_update', { phone: finalRealPhone, name: phoneUser.name || lidUser.name, bot_enabled: mergedBotEnabled });
            return true;
        } catch (e) {
            console.error('⚠️ Error fusionando LID → teléfono:', e);
            return false;
        }
    }

    // Borrar un chat en el teléfono: sale de la lista (archivado) pero se
    // conservan el número, el nombre, el paso del flujo y la pausa del bot.
    async handleChatsDelete(deletedChats) {
        for (const jid of deletedChats || []) {
            const dbPhoneKey = normalizePhone(String(jid).replace(/[^0-9]/g, ''));
            const user = getUser(dbPhoneKey);
            if (user && user.phone) {
                await updateUser(dbPhoneKey, {
                    last_message: '',
                    messages: [],
                    archived: true
                });
            }
            this.emit('chat_deleted', { phone: dbPhoneKey });
        }
    }

    // Aplica una reacción a un mensaje guardado (o la quita si el texto
    // viene vacío) y avisa al panel en vivo. Si el mensaje ya no está en
    // el historial (solo se guardan los últimos 30) o ya fue eliminado,
    // no hay burbuja que pintar.
    async applyReaction(dbPhoneKey, targetId, reactionText) {
        if (!targetId) return;
        const updated = updateMessage(dbPhoneKey, targetId, { reaction: reactionText || null });
        if (!updated || updated.deleted) return;
        this.emit('new_message_ui', { type: 'reaction', phone: dbPhoneKey, targetId: targetId, reactionText: reactionText || '' });
    }

    // Reacciones que llegan por el evento propio de Baileys. También llegan
    // como reactionMessage dentro de upsert; ambos caminos terminan en
    // applyReaction, así que el resultado es el mismo aunque lleguen los dos.
    async handleMessagesReaction(reactions) {
        for (const r of reactions || []) {
            const remoteJid = r.key?.remoteJid;
            if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@broadcast')) continue;
            const dbPhoneKey = normalizePhone(remoteJid.replace(/[^0-9]/g, ''));
            await this.applyReaction(dbPhoneKey, r.key?.id, r.reaction?.text || '');
        }
    }

    // Mensajes eliminados ("para todos") y vaciado de chat.
    async handleMessagesDelete(payload) {
        if (!payload) return;
        // Vaciar chat: todos los mensajes pasan a eliminados.
        if (payload.all && payload.jid) {
            const dbPhoneKey = normalizePhone(String(payload.jid).replace(/[^0-9]/g, ''));
            const user = getUser(dbPhoneKey);
            if (user && Array.isArray(user.messages)) {
                for (const m of user.messages) {
                    if (m && m.id) updateMessage(dbPhoneKey, m.id, { deleted: true, text: '🚫 Este mensaje fue eliminado', mediaUrl: null, reaction: null, quoted: null });
                }
                this.emit('new_message_ui', { type: 'chat_cleared', phone: dbPhoneKey });
            }
            return;
        }
        for (const key of payload.keys || []) {
            const dbPhoneKey = normalizePhone(String(key.remoteJid || '').replace(/[^0-9]/g, ''));
            const targetId = key.id;
            if (!targetId) continue;
            const before = getUser(dbPhoneKey);
            const oldMsg = (before.messages || []).find(m => m && m.id === targetId);
            const oldText = oldMsg ? oldMsg.text : null;
            const oldMedia = oldMsg ? oldMsg.mediaUrl : null;
            const updated = updateMessage(dbPhoneKey, targetId, { deleted: true, text: '🚫 Este mensaje fue eliminado', mediaUrl: null, reaction: null, quoted: null });
            if (!updated) continue;
            // El contenido borrado no se conserva ni en disco: el archivo
            // multimedia (imagen, audio, video o sticker) se borra.
            if (oldMedia && typeof oldMedia === 'string' && oldMedia.startsWith('/uploads/')) {
                try { fs.unlinkSync(path.join(uploadDir, path.basename(oldMedia))); } catch (e) {}
            }
            // Si era el último mensaje, la lista muestra el placeholder.
            if (oldText && before.last_message === oldText) {
                await updateUser(dbPhoneKey, { last_message: '🚫 Este mensaje fue eliminado' });
            }
            this.emit('new_message_ui', { type: 'message_deleted', phone: dbPhoneKey, targetId: targetId });
        }
    }

    // Extrae el mensaje citado de un mensaje entrante (si responde a otro).
    // Devuelve null cuando no hay cita.
    extractQuoted(msg, dbPhoneKey) {
        const content = msg.message?.extendedTextMessage || msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.stickerMessage || msg.message?.audioMessage;
        const ctx = content?.contextInfo;
        if (!ctx?.quotedMessage) return null;
        const qm = ctx.quotedMessage;
        const qText = qm.conversation || qm.extendedTextMessage?.text || qm.imageMessage?.caption || qm.videoMessage?.caption
            || (qm.audioMessage ? '🎵 Audio' : qm.stickerMessage ? '👾 Sticker' : qm.imageMessage ? '📷 Imagen' : qm.videoMessage ? '🎥 Video' : '');
        return {
            id: ctx.stanzaId || '',
            text: qText || '',
            // En un chat 1 a 1, el citado es del cliente (su JID) o mío.
            fromMe: !!ctx.participant && normalizePhone(String(ctx.participant)) !== dbPhoneKey
        };
    }

    async handleMessagesUpsert({ messages, type }) {
        if (type !== 'notify' && type !== 'append') return;

        for (const msg of messages) {
            if (!msg.message || msg.message.protocolMessage || msg.messageStubType) continue;

            const msgId = msg.key.id;
            if (this.processedMessages.includes(msgId)) continue;
            this.processedMessages.push(msgId);
            if (this.processedMessages.length > 500) this.processedMessages.shift();

            let remoteJid = msg.key.remoteJid;
            if (remoteJid && remoteJid.includes('@lid')) {
                let lidMap = getLidMap();
                const cleanLid = remoteJid.replace(/[^0-9]/g, '');
                if (lidMap[cleanLid]) {
                    remoteJid = `${lidMap[cleanLid]}@s.whatsapp.net`;
                    msg.key.remoteJid = remoteJid; 
                }
            }

            if (remoteJid && (remoteJid.includes('@g.us') || remoteJid.includes('@broadcast'))) continue;

            const isMe = msg.key.fromMe;
            const dbPhoneKey = normalizePhone(remoteJid.replace(/[^0-9]/g, ''));
            
            // Reacción: mismo camino que el evento messages.reaction, para
            // que quede guardada en el mensaje y no solo pintada en vivo.
            if (msg.message?.reactionMessage) {
                const targetId = msg.message.reactionMessage.key.id;
                const reactionText = msg.message.reactionMessage.text;
                await this.applyReaction(dbPhoneKey, targetId, reactionText);
                continue;
            }

            let mediaUrl = null;
            let msgText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

            if (!msgText && msg.message?.imageMessage?.caption) msgText = msg.message.imageMessage.caption;
            else if (!msgText && msg.message?.videoMessage?.caption) msgText = msg.message.videoMessage.caption;

            const hasMedia = msg.message?.imageMessage || msg.message?.audioMessage || msg.message?.stickerMessage || msg.message?.videoMessage;

            if (hasMedia) {
                try {
                    let ext = 'jpeg';
                    if (msg.message?.audioMessage) ext = 'ogg';
                    else if (msg.message?.stickerMessage) ext = 'webp';
                    else if (msg.message?.videoMessage) ext = 'mp4';

                    const buffer = await downloadMediaMessage(msg, 'buffer', { }, { logger: pino({ level: 'silent' }) });
                    const fileName = `media_${Date.now()}.${ext}`;
                    await fsAsync.writeFile(path.join(uploadDir, fileName), buffer); 
                    mediaUrl = `/uploads/${fileName}`;

                    if (!msgText) {
                        if (msg.message?.audioMessage) msgText = '🎵 Audio';
                        else if (msg.message?.stickerMessage) msgText = '👾 Sticker';
                        else if (msg.message?.videoMessage) msgText = '🎥 Video';
                        else if (msg.message?.imageMessage) msgText = '📷 Imagen';
                    }
                } catch (e) { console.error("❌ Error descargando multimedia:", e.message); }
            }

            // Tipo del mensaje (el sticker se pinta sin burbuja, como en WhatsApp).
            let msgType = 'text';
            if (msg.message?.stickerMessage) msgType = 'sticker';
            else if (msg.message?.audioMessage) msgType = 'audio';
            else if (msg.message?.videoMessage) msgType = 'video';
            else if (msg.message?.imageMessage) msgType = 'image';

            // Mensaje citado: a qué mensaje responde este (si responde a uno).
            const quoted = this.extractQuoted(msg, dbPhoneKey);

            let currentUser = getUser(dbPhoneKey) || { phone: dbPhoneKey, messages: [] };
            
            const timestampIso = new Date().toISOString();
            
            // 🔥 Guardamos el 'id' único de este mensaje en la base de datos
            await updateUser(dbPhoneKey, {
                last_message: msgText || (mediaUrl ? '📎 Multimedia' : ''),
                last_active: timestampIso,
                newMessage: {
                    id: msgId, 
                    text: msgText,
                    mediaUrl: mediaUrl,
                    fromMe: isMe,
                    stepId: currentUser.current_step,
                    timestamp: timestampIso,
                    type: msgType,
                    quoted: quoted,
                    reaction: null,
                    deleted: false
                }
            });

            this.emit('new_message_ui', {
                id: msgId,
                phone: dbPhoneKey,
                text: msgText,
                mediaUrl: mediaUrl,
                fromMe: isMe,
                stepId: currentUser.current_step,
                msgType: msgType,
                quoted: quoted,
                rawMsg: msg 
            });

            if (isMe) continue; 

            if (msgText.trim() || mediaUrl) {
                if (!this.userMessageBuffers.has(dbPhoneKey)) this.userMessageBuffers.set(dbPhoneKey, []);
                
                const isPlaceholder = ['🎵 Audio', '👾 Sticker', '🎥 Video', '📷 Imagen'].includes(msgText.trim());
                if (msgText.trim() && !isPlaceholder) {
                    this.userMessageBuffers.get(dbPhoneKey).push(msgText);
                } else if (mediaUrl) {
                    this.userMessageBuffers.get(dbPhoneKey).push("[Multimedia adjunta]");
                }
            }

            if (this.userMessageTimers.has(dbPhoneKey)) clearTimeout(this.userMessageTimers.get(dbPhoneKey).timer);

            const nuevoTimer = setTimeout(() => this.procesarMensajeAgrupado(dbPhoneKey), 5000);
            this.userMessageTimers.set(dbPhoneKey, { timer: nuevoTimer, msg: msg });
        }
    }

    async procesarMensajeAgrupado(dbPhoneKey) {
        if (this.hilosActivos.has(dbPhoneKey)) return;

        const timerData = this.userMessageTimers.get(dbPhoneKey);
        if (!timerData) return;

        const finalMsg = timerData.msg;
        const bufferInfo = [...(this.userMessageBuffers.get(dbPhoneKey) || [])];
        
        this.userMessageBuffers.delete(dbPhoneKey);
        this.userMessageTimers.delete(dbPhoneKey);

        if (bufferInfo.length === 0) return;
        const joinedText = bufferInfo.join('\n').trim();
        
        this.hilosActivos.add(dbPhoneKey);

        try {
            if (finalMsg.message.extendedTextMessage) finalMsg.message.extendedTextMessage.text = joinedText;
            else finalMsg.message = { conversation: joinedText };

            const remoteJid = finalMsg.key.remoteJid;
            const currentUserState = getUser(dbPhoneKey) || {};
            const currentStep = currentUserState.current_step || 'BIENVENIDA';

            if (currentUserState.bot_enabled === false) {
                console.log(`⏸️ Bot pausado para ${dbPhoneKey}. Ignorando mensajes.`);
                return;
            }

            const botMessagesSent = (currentUserState.messages || []).filter(m => m.fromMe).length;
            const isFirstInteraction = (botMessagesSent === 0);

            if (isFirstInteraction) {
                console.log(`👋 Nuevo cliente detectado (${dbPhoneKey}). Enviando BIENVENIDA automáticamente.`);
                await messageSender.sendStepMessage(this.sock, remoteJid, 'BIENVENIDA', currentUserState);
                return;
            }

            const keywordMatch = await findKeywordMatch(joinedText);

            if (keywordMatch) {
                if (keywordMatch.isFallback) {
                    if (currentStep !== 'BIENVENIDA') {
                        const fallbackText = "🤖 *Recuerda que soy un bot.* Por el momento no tengo respuesta a tu pregunta. Por favor, selecciona una opción del menú.";
                        await messageSender.send(this.sock, remoteJid, fallbackText);
                        return;
                    }
                } else {
                    console.log(`🧠 Interceptor activado: "${keywordMatch.keywords}"`);
                    
                    if (keywordMatch.media && keywordMatch.media.length > 0) {
                        for (let i = 0; i < keywordMatch.media.length; i++) {
                            const relativePath = keywordMatch.media[i].startsWith('/') ? keywordMatch.media[i].slice(1) : keywordMatch.media[i];
                            const absolutePath = path.join(__dirname, '../public', relativePath);
                            const payloadObj = { image: { url: absolutePath } };
                            if (i === 0) payloadObj.caption = keywordMatch.answer;
                            await this.sock.sendMessage(remoteJid, payloadObj);
                        }
                    } else {
                        await messageSender.send(this.sock, remoteJid, keywordMatch.answer);
                    }
                    return; 
                }
            }

            await handleMessage(this.sock, finalMsg);
            
        } catch (err) {
            console.error("❌ Error procesando mensaje unificado:", err);
        } finally {
            this.hilosActivos.delete(dbPhoneKey);
        }
    }
}

const whatsappService = new WhatsAppService();
module.exports = whatsappService;