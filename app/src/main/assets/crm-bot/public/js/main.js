import { getCleanPhone, escapeHTML, formatSmartDate, showToast, pushNavigationLayer } from './utils.js';
import * as API from './api.js';
import { loadKeywords } from './keywords.js';
import { renderCalendar, loadSchedulerConfig } from './agenda.js';
import { initFlow, updateFlowUsers, getLinearFlowSequence } from './flow.js';
import { handleInputTyping, handleMainBtn, sendWaMsg } from './chat/chatInput.js';
import { smartRenderChats, renderChatList, exitSelectionMode, askDeleteSelectedChats, filterChats, removeChatFromUI } from './chat/chatList.js';
import { openWaChat, closeWaChat, toggleCurrentBot, askJump, executeJump, askCrmAction, executeCrmAction, toggleFlowDrawer, addBubble } from './chat/chatWindow.js';
import { uploadChatMedia, closeMediaPreview, sendPendingMedia } from './chat/mediaUi.js';

import { loadGlobalErrorsFromMemory } from './settings.js';
import './contacts.js'; 

const API_BASE = '';

let flow = {}, users = [];
let deferredPrompt;
let apptToDelete = null;
let allContactsCache = [];
let currentRefDate = new Date();
let currentChatPhone = null;
let pendingJumpStep = null;
let pendingCrmAction = null;

let isSelectionMode = false;
let selectedChats = []; 
let longPressTimer;
let ignoreClick = false;
let currentSearchQuery = '';

let pendingMediaFile = null;
let renderListTimer = null;

// ==========================================
// EXPORTACIONES 
// ==========================================
export const getAppState = () => ({
    currentChatPhone,
    users,
    flow,
    currentSearchQuery,
    allContactsCache
});
export const setAllContactsCache = (data) => allContactsCache = data;
export const setCurrentChatPhone = (phone) => currentChatPhone = phone;
export const setCurrentSearchQuery = (q) => currentSearchQuery = q;
export const reloadActivity = () => loadActivity();
export const refreshChats = (q) => filterChats(q);
export const closeChat = () => closeWaChat();

// --- SOCKET.IO ---
// Si socket.io no cargó (el servidor estaba caído al abrir la página),
// no romper todo el módulo: se usa un socket mudo y, en cuanto la API
// responda, la página se recarga para tener un socket real.
// La API y el socket no comparten autenticación: el socket conecta
// aunque el token falte o sea inválido, así que sin esta guarda cada
// (re)conexión disparaba loadActivity() y llenaba la consola de 401
// mientras el panel aún pedía el token. Solo se carga actividad cuando
// checkStatus ya confirmó la sesión (apiConnected).
let apiConnected = false;

// Recarga de la lista con debounce. Cuando llega un mensaje (o un
// user_update) de alguien que NO está en la lista — cliente nuevo, o
// cliente que escribió después de que borramos su chat del panel —
// smartRenderChats no tiene fila que actualizar y la lista no se
// entera: solo loadActivity() trae usuarios nuevos, porque GET /users
// ya los devuelve con el merge LID/nombre/estado del bot. Se pide con
// debounce para no refetchear por cada mensaje de una ráfaga, y solo
// si la sesión ya está confirmada (apiConnected), para no disparar
// 401 mientras el panel aún pide el token.
let activityReloadTimer = null;
function scheduleActivityReload() {
    if (!apiConnected) return;
    if (activityReloadTimer) return;
    activityReloadTimer = setTimeout(() => {
        activityReloadTimer = null;
        loadActivity();
    }, 500);
}

const socket = (typeof io === 'function') ? io({ reconnection: true }) : { on() {}, emit() {} };
socket.on('connect', () => { updateConnStatus(true); if (apiConnected) loadActivity(); });
socket.on('disconnect', () => { updateConnStatus(false); });

// 🔥 ACTUALIZADO: Eliminar de la UI visualmente
socket.on('chat_deleted', (data) => {
    if (data && data.phone) {
        const targetPhone = getCleanPhone(data.phone);
        // Borra el chat de la lista lateral y cierra la conversación activa si procede
        removeChatFromUI(targetPhone);
    }
});

socket.on('message', async (data) => {
    
    // 🔥 FIX REACCIONES: Si es una reacción, dibujarla sobre la burbuja correcta
    if (data.type === 'reaction') {
        const bubble = document.getElementById(`msg-${data.targetId}`);
        if (bubble) {
            let reactionBox = bubble.querySelector('.reaction-container');
            if (reactionBox) {
                if (data.reactionText) {
                    reactionBox.innerHTML = `<span style="background:var(--bg-panel, #202c33); border:1px solid rgba(255,255,255,0.1); border-radius:10px; padding:2px 5px; font-size:0.8rem; box-shadow: 0 1px 2px rgba(0,0,0,0.3);">${data.reactionText}</span>`;
                } else {
                    reactionBox.innerHTML = ''; // Reacción eliminada
                }
            }
        }
        
        // Guardamos la reacción en memoria
        const targetPhoneKey = getCleanPhone(data.phone || '');
        const userMem = users.find(u => getCleanPhone(u.phone) === targetPhoneKey || getCleanPhone(u.realDbPhone) === targetPhoneKey);
        if (userMem && userMem.messages) {
            const m = userMem.messages.find(x => x.id === data.targetId);
            if (m) m.reaction = data.reactionText;
        }
        return; 
    }

    // Mensaje eliminado en el teléfono: se marca en memoria y la burbuja
    // pasa al placeholder, sin tocar el resto del historial.
    if (data.type === 'message_deleted') {
        const targetPhoneKey = getCleanPhone(data.phone || '');
        const userMem = users.find(u => getCleanPhone(u.phone) === targetPhoneKey || getCleanPhone(u.realDbPhone) === targetPhoneKey);
        if (userMem && userMem.messages) {
            const m = userMem.messages.find(x => x.id === data.targetId);
            if (m) {
                m.deleted = true;
                m.text = '🚫 Este mensaje fue eliminado';
                m.mediaUrl = null;
                m.reaction = null;
                m.quoted = null;
                if (userMem.messages[userMem.messages.length - 1] === m) userMem.last_message = m.text;
            }
        }
        const bubble = document.getElementById(`msg-${data.targetId}`);
        if (bubble) {
            bubble.querySelectorAll('img, audio, video').forEach(el => { const w = el.closest('div'); if (w) w.remove(); });
            const quote = bubble.querySelector('.quote-block');
            if (quote) quote.remove();
            const rc = bubble.querySelector('.reaction-container');
            if (rc) rc.innerHTML = '';
            const ticks = bubble.querySelector('.fa-check-double, .fa-check');
            if (ticks && ticks.parentElement) ticks.parentElement.remove();
            let textEl = bubble.querySelector('.wa-bubble-text');
            if (textEl) textEl.innerHTML = '<em style="color:#8696a0;">🚫 Este mensaje fue eliminado</em>';
            else bubble.insertAdjacentHTML('afterbegin', '<div class="wa-bubble-text" style="line-height: 1.4;"><em style="color:#8696a0;">🚫 Este mensaje fue eliminado</em></div>');
        }
        if (userMem) smartRenderChats(targetPhoneKey);
        return;
    }

    // Vaciar el chat en el teléfono: se recarga la lista y se vuelve a
    // pintar la conversación abierta con los mensajes ya marcados.
    if (data.type === 'chat_cleared') {
        await reloadActivity();
        const targetPhoneKey = getCleanPhone(data.phone || '');
        if (getAppState().currentChatPhone && getCleanPhone(getAppState().currentChatPhone) === targetPhoneKey) {
            openWaChat(getAppState().currentChatPhone);
        }
        return;
    }

    let realText = data.text || data.body || data.caption || data.message || '';
    if(!realText && data.extendedTextMessage) realText = data.extendedTextMessage.text;
    if(!realText && data.conversation) realText = data.conversation;
    if(!realText && data.imageMessage) realText = data.imageMessage.caption || '';
    if(!realText && data.videoMessage) realText = data.videoMessage.caption || '🎥 Video';

    const targetPhoneKey = getCleanPhone(data.phone || data.from || data.to || '');
    let isMatch = false;

    if (currentChatPhone) {
        const currentKey = getCleanPhone(currentChatPhone);
        const msgFromKey = getCleanPhone(data.from || data.phone || '');
        const msgToKey   = getCleanPhone(data.to || data.phone || '');

        isMatch = (currentKey === msgFromKey || currentKey === msgToKey);

        if (!isMatch && typeof users !== 'undefined' && users.length > 0) {
            const senderUser = users.find(u => 
                getCleanPhone(u.phone) === msgFromKey || 
                getCleanPhone(u.realDbPhone) === msgFromKey ||
                (u.lidPhone && getCleanPhone(u.lidPhone) === msgFromKey)
            );
            if (senderUser && (getCleanPhone(senderUser.phone) === currentKey || getCleanPhone(senderUser.realDbPhone) === currentKey)) {
                isMatch = true; 
            }
        }
    }

    if (targetPhoneKey) {
        const userMem = (typeof users !== 'undefined' ? users : []).find(u => {
            const cleanPhone = getCleanPhone(u.phone);
            const cleanDb = getCleanPhone(u.realDbPhone);
            const cleanLid = u.lidPhone ? getCleanPhone(u.lidPhone) : null;
            return cleanPhone === targetPhoneKey || cleanDb === targetPhoneKey || cleanLid === targetPhoneKey;
        });

        if (userMem) {
            if (!userMem.messages) userMem.messages = [];
            
            // Agregamos el ID al historial para poder pegarle reacciones después
            userMem.messages.push({
                id: data.id,
                text: realText,
                fromMe: data.fromMe,
                stepId: data.stepId || null,
                timestamp: new Date().toISOString(),
                mediaUrl: data.mediaUrl || null,
                reaction: null,
                type: data.msgType || null,
                quoted: data.quoted || null,
                deleted: false
            });

            userMem.last_message = realText || (data.mediaUrl ? '📷 Imagen' : '');
            userMem.last_active = new Date().toISOString();
            if (data.stepId) userMem.current_step = data.stepId;
            
            if (isMatch && !document.hidden) {
                userMem.unreadCount = 0; 
            } else if (!data.fromMe) {
                userMem.unreadCount = (userMem.unreadCount || 0) + 1; 
            }
            
            smartRenderChats(getCleanPhone(userMem.phone));
        } else {
            // Chat nuevo (o que volvió tras borrarlo del panel): no está
            // en memoria, así que no hay fila que actualizar. Se recarga
            // la lista; GET /users ya lo trae con sus datos completos.
            scheduleActivityReload();
        }
    }

    if (isMatch) {
        if(realText || data.mediaUrl) {
            let quotedBy = null;
            if (data.quoted) {
                if (data.quoted.fromMe) quotedBy = 'Tú';
                else {
                    const sender = users.find(u => getCleanPhone(u.phone) === targetPhoneKey || getCleanPhone(u.realDbPhone) === targetPhoneKey);
                    quotedBy = sender ? (sender.savedName || sender.history?.nombre || 'Cliente') : 'Cliente';
                }
            }
            addBubble(realText, data.fromMe, data.stepId, new Date().toISOString(), data.mediaUrl, 1, data.id, null, { type: data.msgType || null, quoted: data.quoted ? { ...data.quoted, by: quotedBy } : null, deleted: false });
        }
    }

    if (!data.fromMe && (!isMatch || document.hidden)) {
        const audio = document.getElementById('alertSound');
        if (audio) audio.play().catch(e => console.log('Autoplay bloqueado hasta interacción'));
    }
});

socket.on('user_update', (data) => {
    const targetPhone = getCleanPhone(data.phone);
    const userIndex = users.findIndex(u => 
        getCleanPhone(u.phone) === targetPhone || 
        getCleanPhone(u.realDbPhone) === targetPhone ||
        (u.lidPhone && getCleanPhone(u.lidPhone) === targetPhone)
    );

    if (userIndex !== -1) {
        users[userIndex] = { ...users[userIndex], ...data };
        if (data.name) {
            users[userIndex].savedName = data.name;
            if (!users[userIndex].history) users[userIndex].history = {};
            users[userIndex].history.nombre = data.name;
        }
        smartRenderChats(getCleanPhone(users[userIndex].phone));
    } else {
        // El usuario no está en la lista (nuevo, o borrado del panel):
        // recargarla es lo que lo trae con sus datos completos.
        scheduleActivityReload();
    }

    if (currentChatPhone && (getCleanPhone(currentChatPhone) === targetPhone || (userIndex !== -1 && getCleanPhone(users[userIndex].realDbPhone) === targetPhone))) {
        if (data.name) {
            document.getElementById('waHeaderName').innerText = data.name;
            document.getElementById('waHeaderAvatar').innerText = data.name[0].toUpperCase();
        }
        if (data.bot_enabled !== undefined) {
            const sw = document.getElementById('waBotSwitch');
            if (sw) sw.checked = data.bot_enabled;
        }
    }
});

socket.on('new_user', (newUser) => {
    // Hoy el backend no emite este evento, pero si algún día lo hace,
    // la lista se recarga con el merge completo (LID, nombre, estado
    // del bot) en vez de meter un objeto crudo sin realDbPhone ni
    // lidPhone, que luego loadActivity trataría como otro usuario.
    if (!newUser || !newUser.phone) return;
    const exists = users.find(u =>
        getCleanPhone(u.phone) === getCleanPhone(newUser.phone) ||
        (u.lidPhone && getCleanPhone(u.lidPhone) === getCleanPhone(newUser.phone))
    );
    if (!exists) {
        scheduleActivityReload();
        showInAppNotify(`Nuevo cliente: ${newUser.name || newUser.phone}`);
    }
});

function showInAppNotify(text) {
    const el = document.getElementById('inAppNotify');
    if(!el) return;
    const txtEl = document.getElementById('notifyText');
    if(txtEl) txtEl.innerText = text.substring(0, 30) + (text.length>30?'...':'');
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 4000);
}

function updateConnStatus(online) {
    console.log('Socket status:', online ? 'Connected' : 'Disconnected');
}


function setupSearchBar() {
    const searchContainer = document.getElementById('waHeaderSearch');
    if (!searchContainer) return;

    const searchInput = searchContainer.querySelector('input');
    if (!searchInput) return;

    searchContainer.style.position = 'relative';

    const clearBtn = document.createElement('i');
    clearBtn.className = 'fas fa-times';
    clearBtn.style.cssText = 'position:absolute; right:12px; top:50%; transform:translateY(-50%); cursor:pointer; color:#888; display:none; padding: 5px;';
    
    searchContainer.appendChild(clearBtn);

    searchInput.addEventListener('input', () => {
        clearBtn.style.display = searchInput.value.length > 0 ? 'block' : 'none';
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        clearBtn.style.display = 'none';
        searchInput.focus(); 
        debounceFilterChats('');
    });
}


window.onload = () => {
    const wizard = document.getElementById('setupWizard');
    if(wizard) wizard.classList.remove('step-hidden');

    setupSearchBar();

    checkStatus();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW Fail', err));
    }
};

// Muestra el paso del token dentro del wizard (en vez del spinner).
// isServerError = el servidor no tiene API_TOKEN en el .env: no sirve
// escribir un token, hay que configurarlo en el servidor y reintentar.
function showTokenStep(message, isServerError = false) {
    const wizard = document.getElementById('setupWizard');
    if (wizard) wizard.classList.remove('step-hidden');
    const loading = document.getElementById('stepLoading');
    const qrStep = document.getElementById('stepQR');
    const tokenStep = document.getElementById('stepToken');
    if (loading) loading.classList.add('step-hidden');
    if (qrStep) qrStep.classList.add('step-hidden');
    const msg = document.getElementById('tokenStepMsg');
    if (msg) msg.textContent = message || '';
    const input = document.getElementById('apiTokenInput');
    if (input) { input.style.display = isServerError ? 'none' : ''; input.value = ''; }
    const btn = document.getElementById('tokenStepBtn');
    if (btn) btn.textContent = isServerError ? 'Reintentar' : 'Conectar';
    if (tokenStep) tokenStep.classList.remove('step-hidden');
    if (input && !isServerError) input.focus();
}

function submitApiToken() {
    const input = document.getElementById('apiTokenInput');
    const isServerError = !input || input.style.display === 'none';
    if (!isServerError && input) {
        const token = input.value.trim();
        if (!token) { input.focus(); return; }
        API.setApiToken(token);
    }
    const tokenStep = document.getElementById('stepToken');
    if (tokenStep) tokenStep.classList.add('step-hidden');
    const loading = document.getElementById('stepLoading');
    if (loading) loading.classList.remove('step-hidden');
    checkStatus();
}

// Si el token deja de ser válido en plena sesión (p. ej. cambió en el
// servidor), el panel vuelve a pedirlo en vez de quedarse vacío.
window.addEventListener('crm:unauthorized', () => {
    apiConnected = false;
    showTokenStep('El token dejó de ser válido. Escríbelo de nuevo para seguir.');
});

const checkStatus = async () => {
    const wizard = document.getElementById('setupWizard');
    try {
        const res = await fetch(`${API_BASE}/api/status`);

        // Sin token (o con uno incorrecto) el backend responde 401.
        // Antes este caso se ignoraba: res.status era undefined, ninguna
        // rama coincidía y el wizard se quedaba para siempre en
        // "Conectando...". Ahora se pide el token y no se reintenta en
        // bucle: se reanuda desde el botón.
        if (res.status === 401) {
            showTokenStep('El token no es válido o falta. Escríbelo para entrar al panel.');
            return;
        }
        // 503 = el servidor no tiene API_TOKEN en el .env.
        if (res.status === 503) {
            showTokenStep('El servidor no tiene API_TOKEN configurado. Añádelo al archivo .env del servidor y reinicia el bot, luego pulsa Reintentar.', true);
            return;
        }

        const data = await res.json();

        const loading = document.getElementById('stepLoading');
        const qrStep = document.getElementById('stepQR');

        if (data.status === 'connected') {
            apiConnected = true;
            // La página cargó sin socket.io: recargar para tenerlo.
            if (typeof io !== 'function') { location.reload(); return; }
            if(wizard) wizard.classList.add('step-hidden');
            document.getElementById('mainApp').classList.add('visible');

            loadAll();
            await loadActivity();

            const defaultBtn = document.getElementById('defaultMenuBtn');
            nav('activity', defaultBtn);

            if (window.location.hash === '#agenda') {
                nav('agenda');
                history.replaceState(null, null, ' ');
            }
            else if (window.location.hash.startsWith('#activity')) {
                const hash = window.location.hash;
                nav('activity');
                if (hash.includes('chat=')) {
                    const phone = hash.split('chat=')[1];
                    setTimeout(() => openWaChat(phone), 200);
                }
                history.replaceState(null, null, ' ');
            }
        }
        else if (data.status === 'loading') {
            if(qrStep) qrStep.classList.add('step-hidden');
            if(loading) loading.classList.remove('step-hidden');
        }
        else if (data.qr) {
            if(loading) loading.classList.add('step-hidden');
            if(qrStep) qrStep.classList.remove('step-hidden');
            new QRious({element: document.getElementById('qrCanvas'), value: data.qr, size:200});
        }
    } catch(e){}

    if(wizard && !wizard.classList.contains('step-hidden')) {
        setTimeout(checkStatus, 3000);
    }
};

document.body.addEventListener('click', function() {
    if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        Notification.requestPermission();
    }
}, { once: true });

async function loadAll() {
    try { 
        flow = await API.getFlow(); 
        initFlow(flow, users); 
    } catch(e){}

    try { 
        const s = await API.getSettings(); 
        
        if(s.timezone) { document.getElementById('botTimezone').value = s.timezone; }
        if(typeof previewTimezone === 'function') previewTimezone();

        if(s.ai_config) {
            const cName = document.getElementById('configCompanyName');
            const cAdv = document.getElementById('configAdvisorName');
            const cDesc = document.getElementById('configCompanyDescription');
        
            if (cName) cName.value = s.ai_config.companyName || '';
            if (cAdv) cAdv.value = s.ai_config.advisorName || '';
            if (cDesc) cDesc.value = s.ai_config.behavior || '';
        }

        if(s.schedule) { 
            const act = document.getElementById('schedActive'); 
            if(act) act.checked = !!s.schedule.active;
        
            const msg = document.getElementById('schedMsg'); 
            if(msg) msg.value = s.schedule.offline_message || ''; 

            if (s.schedule.days) {
                Object.keys(s.schedule.days).forEach(d => {
                    const dayData = s.schedule.days[d];
                    const dayCheck = document.getElementById(`schDay${d}`);
                    const dayStart = document.getElementById(`schStart${d}`);
                    const dayEnd = document.getElementById(`schEnd${d}`);

                    if (dayCheck) dayCheck.checked = !!dayData.active;
                    if (dayStart && dayData.start) dayStart.value = dayData.start;
                    if (dayEnd && dayData.end) dayEnd.value = dayData.end;
                });
            }
        } 
        
        loadGlobalErrorsFromMemory(s); 
    } catch(e){ console.error("Error al cargar ajustes:", e); }
}

async function loadActivity() {
    try {
        const [usersData, contactsData] = await Promise.all([
            API.getUsers(),
            API.getContacts()
        ]);

        allContactsCache = contactsData;
        let mergedUsersMap = new Map();

        // Mapa LID -> telefono real. El backend lo expone en `lid` (en
        // /contacts y en /users) desde lid_map.json. Sin el, un cliente se
        // veia en dos chats: el registro LID y el del telefono real.
        // `u.phone` nunca contiene 'lid' (la API lo devuelve normalizado
        // a digitos), asi que `u.phone.includes('lid')` siempre era falso
        // y `lidPhone` siempre quedaba en null.
        const lidToPhone = new Map();
        // Las claves van limpias (getCleanPhone) para comparar; los valores
        // guardan el telefono completo, como lo dejaba contactInfo.phone.
        contactsData.forEach(c => { if (c.lid) lidToPhone.set(getCleanPhone(c.lid), c.phone); });
        usersData.forEach(u => { if (u.lid) lidToPhone.set(getCleanPhone(u.lid), u.phone); });

        usersData.forEach(u => {
            const uChatKey = getCleanPhone(u.phone);
            
            let contactInfo = contactsData.find(c => 
                getCleanPhone(c.phone) === uChatKey || 
                (c.lid && getCleanPhone(c.lid) === uChatKey)
            );
            
            let finalState = true;
            let savedName = u.history?.nombre || u.history?.cliente || u.history?.usuario || u.history?.name || u.phone;

            const mappedRealPhone = lidToPhone.get(uChatKey) || null;
            let realDbPhone = mappedRealPhone || (contactInfo ? contactInfo.phone : u.phone);
            let primaryKey = getCleanPhone(realDbPhone);
            // Esta fila es el lado LID si su propia clave no es el telefono real.
            const isLidRow = primaryKey !== uChatKey;

            if (contactInfo) {
                finalState = contactInfo.bot_enabled !== undefined ? contactInfo.bot_enabled : false;
                if(contactInfo.name && contactInfo.name !== 'Usuario Chat' && contactInfo.name !== u.phone) {
                    savedName = contactInfo.name;
                }
            } else if (u.bot_enabled !== undefined) {
                finalState = u.bot_enabled;
            }

            if (savedName === u.phone && u.pushName) savedName = u.pushName; 

            if (mergedUsersMap.has(primaryKey)) {
                let existing = mergedUsersMap.get(primaryKey);
                
                existing.messages = [...(existing.messages || []), ...(u.messages || [])];
                existing.messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                
                if (new Date(u.last_active) > new Date(existing.last_active)) {
                    existing.last_active = u.last_active;
                    existing.last_message = u.last_message;
                }
                existing.unreadCount = (existing.unreadCount || 0) + (u.unreadCount || 0);
                
                if (isLidRow) existing.lidPhone = u.phone;
                // Si la fila que llega trae el nombre guardado del contacto,
                // ese manda sobre el nombre que traia la fila LID.
                if (contactInfo && contactInfo.name && contactInfo.name !== 'Usuario Chat' && contactInfo.name !== u.phone) {
                    existing.savedName = savedName;
                }

                if (contactInfo && contactInfo.bot_enabled !== undefined) {
                    existing.bot_enabled = contactInfo.bot_enabled;
                }

            } else {
                mergedUsersMap.set(primaryKey, {
                    ...u,
                    bot_enabled: finalState,
                    savedName: savedName,
                    realDbPhone: realDbPhone,
                    lidPhone: isLidRow ? u.phone : null
                });
            }
        });

        users = Array.from(mergedUsersMap.values());

        filterChats(currentSearchQuery);
        updateFlowUsers(users); 

        if (currentChatPhone) {
            const updatedUser = users.find(u => getCleanPhone(u.phone) === getCleanPhone(currentChatPhone) || getCleanPhone(u.realDbPhone) === getCleanPhone(currentChatPhone));
            if(updatedUser) {
                const switchEl = document.getElementById('waBotSwitch');
                if(switchEl) switchEl.checked = updatedUser.bot_enabled;
                document.getElementById('waHeaderName').innerText = updatedUser.savedName;
            }
        }

    } catch(e){ console.error("Error cargando actividad:", e); }
}

function toggleMenu() { 
    const sidebar = document.getElementById('sidebar');
    const isOpening = !sidebar.classList.contains('active');
    sidebar.classList.toggle('active'); 
    document.getElementById('sidebarOverlay').classList.toggle('active'); 
    if (isOpening) pushNavigationLayer(); 
}

function nav(v, btn) {
    try {
        if(v !== 'activity' && typeof closeWaChat === 'function') closeWaChat();
    } catch(e) {}
    
    document.querySelectorAll('.view').forEach(e => e.classList.remove('active'));
    document.querySelectorAll('.menu-item').forEach(e => e.classList.remove('active'));
    
    const targetView = document.getElementById('view-'+v);
    if(targetView) targetView.classList.add('active');
    if(btn) btn.classList.add('active');
    
    document.getElementById('sidebar').classList.remove('active');
    document.getElementById('sidebarOverlay').classList.remove('active');

    if(v === 'activity') loadActivity();
    if(v === 'keywords') loadKeywords(); 
    
    if(v === 'agenda') {
        renderCalendar();        
        loadSchedulerConfig(Object.keys(flow)); 
    }

    const titles = { activity:'MONITOR', flow:'FLUJO', errors:'MANEJO DE ERRORES', agenda:'AGENDA', settings:'AJUSTES', keywords: 'RESPUESTAS RÁPIDAS', config: 'CONFIGURACIÓN' };
    const titleEl = document.getElementById('pageTitle');
    if(titleEl) titleEl.innerText = titles[v] || 'CRM';
}

function requestLogout() {
    document.getElementById('sidebar').classList.remove('active');
    document.getElementById('sidebarOverlay').classList.remove('active');
    document.getElementById('logoutModal').classList.add('active');
}
async function confirmLogout() {
    try {
        const res = await fetch(`${API_BASE}/api/logout`, { method: 'POST' });
        if(!res.ok) throw new Error("Fallo al cerrar sesión en el servidor");
        location.reload();
    } catch(e) {
        console.error(e);
        showToast("❌ Error al cerrar sesión");
    }
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
    return outputArray;
}

async function registerPush() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        try {
            const response = await fetch('/api/vapid-key');
            if(!response.ok) return;
            const { key } = await response.json();
            const registration = await navigator.serviceWorker.ready;
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(key)
            });
            await fetch('/api/subscribe', {
                method: 'POST',
                body: JSON.stringify(subscription),
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error) { console.error('Error Push', error); }
    }
}

let lastBackPress = 0;

window.addEventListener('popstate', function (event) {
    const activeModal = document.querySelector('.modal.active');
    if (activeModal) {
        activeModal.classList.remove('active');
        if (activeModal.id === 'editNameModal' && typeof closeEditNameModal === 'function') closeEditNameModal();
        return;
    }

    const mainChat = document.getElementById('waMainChat');
    if (window.innerWidth <= 768 && mainChat && mainChat.classList.contains('mobile-open')) {
        closeWaChat();
        return;
    }

    const sidebar = document.getElementById('sidebar');
    if (sidebar && sidebar.classList.contains('active')) {
        toggleMenu();
        return;
    }

    const now = Date.now();
    if (now - lastBackPress < 2000) {
        history.back(); 
        return;
    }

    lastBackPress = now;
    showToast("Desliza atrás de nuevo para salir");
    pushNavigationLayer(); 
});

let filterTimer;
function debounceFilterChats(val) {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => { filterChats(val); }, 300);
}

window.addEventListener('load', () => { pushNavigationLayer(); });

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('installAppBtn');
    if(btn) btn.style.display = 'flex';
});

function installPWA() {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choiceResult) => {
        if (choiceResult.outcome === 'accepted') document.getElementById('installAppBtn').style.display = 'none';
        deferredPrompt = null;
    });
}

window.addEventListener('hashchange', () => {
    if (window.location.hash === '#agenda') nav('agenda');
    if (window.location.hash === '#activity') nav('activity');
});

window.addEventListener('load', () => { setTimeout(registerPush, 2000); });

window.toggleMenu = toggleMenu;
window.nav = nav;
window.submitApiToken = submitApiToken;
window.requestLogout = requestLogout;
window.confirmLogout = confirmLogout;
window.installPWA = installPWA;
window.debounceFilterChats = debounceFilterChats;
window.exitSelectionMode = exitSelectionMode;
window.askDeleteSelectedChats = askDeleteSelectedChats;
window.closeWaChat = closeWaChat;
window.toggleCurrentBot = toggleCurrentBot;
window.handleInputTyping = handleInputTyping;
window.handleMainBtn = handleMainBtn;
window.uploadChatMedia = uploadChatMedia;
window.closeMediaPreview = closeMediaPreview;
window.sendPendingMedia = sendPendingMedia;
window.executeJump = executeJump;
window.askJump = askJump;
window.executeCrmAction = executeCrmAction;
window.toggleFlowDrawer = toggleFlowDrawer;
window.deleteSelectedChats = askDeleteSelectedChats;