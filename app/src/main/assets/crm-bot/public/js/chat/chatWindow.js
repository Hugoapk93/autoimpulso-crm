import { getCleanPhone, escapeHTML, showToast, pushNavigationLayer } from '../utils.js';
import { getAppState, setAllContactsCache, reloadActivity, setCurrentChatPhone } from '../main.js';
import { filterChats } from './chatList.js';
import { handleInputTyping } from './chatInput.js';
import { getLinearFlowSequence } from '../flow.js';
import * as API from '../api.js';

let pendingJumpStep = null;
let pendingCrmAction = null;

export function openWaChat(phone, isRefresh = false) {
    setCurrentChatPhone(phone); 
    const state = getAppState();
    const targetKey = getCleanPhone(phone);
    const u = state.users.find(x => getCleanPhone(x.phone) === targetKey);
    if (!u) return;

    u.unreadCount = 0;

    const displayName = u.savedName || u.history?.cliente || u.history?.usuario || u.phone;

    // Campos nuevos del espejo para cada mensaje del historial.
    const extraFor = (m) => ({ type: m.type, quoted: m.quoted ? { ...m.quoted, by: m.quoted.fromMe ? 'Tú' : displayName } : null, deleted: !!m.deleted });
    document.getElementById('waHeaderName').innerText = displayName;
    document.getElementById('waHeaderPhone').innerText = u.phone; 
    document.getElementById('waHeaderAvatar').innerText = displayName[0].toUpperCase();

    const switchEl = document.getElementById('waBotSwitch');
    if (switchEl) switchEl.checked = u.bot_enabled; 

    const box = document.getElementById('waMsgContainer');
    const msgs = u.messages || [];

    if (!isRefresh) {
        pushNavigationLayer(); 
        box.innerHTML = '';
        document.getElementById('waInputArea').style.display = 'flex';
        if(msgs.length === 0) {
            box.innerHTML = `<div style="text-align:center; padding:40px; color:var(--text-muted);">
                <i class="fas fa-comment-slash" style="font-size:2rem; margin-bottom:10px;"></i><br>Sin historial reciente.</div>`;
        } else {
            // Pasamos m.id y m.reaction para pintar las reacciones de inmediato
            msgs.forEach(m => addBubble(m.text, m.fromMe, m.stepId, m.timestamp, m.mediaUrl, 3, m.id, m.reaction, extraFor(m)));
            setTimeout(() => box.scrollTop = box.scrollHeight, 50);
        }
        if(window.innerWidth <= 768) {
            const mainChat = document.getElementById('waMainChat');
            if(mainChat) mainChat.classList.add('mobile-open');
        }
    } else {
        const domCount = box.querySelectorAll('.wa-bubble').length;
        const dbCount = msgs.length;
        if (dbCount > domCount) {
            const newMsgs = msgs.slice(domCount);
            newMsgs.forEach(m => addBubble(m.text, m.fromMe, m.stepId, m.timestamp, m.mediaUrl, 3, m.id, m.reaction, extraFor(m)));
            if(box.scrollTop + box.clientHeight >= box.scrollHeight - 100) box.scrollTop = box.scrollHeight;
        }
    }

    renderQuickReplies(phone);
    filterChats(state.currentSearchQuery);
}

// Botones de respuesta rápida del paso filtro: se dibujan según el paso
// actual del cliente (u.current_step). Antes solo se dibujaban al entrar
// al chat (openWaChat); cuando el flujo llegaba a un filtro en vivo, los
// botones no aparecían hasta salir y volver a entrar. Ahora es una
// función aparte y se llama también cuando cambia el paso por socket.
export function renderQuickReplies(phone) {
    const qrContainer = document.getElementById('waQuickReplies');
    if (!qrContainer) return;
    qrContainer.innerHTML = '';
    qrContainer.style.display = 'none';
    const state = getAppState();
    const targetKey = getCleanPhone(phone);
    const u = state.users.find(x => getCleanPhone(x.phone) === targetKey);
    if (!u) return;
    const currentStepId = u.current_step;
    if (currentStepId && state.flow[currentStepId]) {
        const stepData = state.flow[currentStepId];
        if (stepData.type === 'filtro' && stepData.options && stepData.options.length > 0) {
            qrContainer.style.display = 'flex';
            stepData.options.forEach(opt => {
                const btn = document.createElement('button');
                btn.className = 'quick-btn';
                btn.innerText = opt.label;
                btn.onclick = () => {
                    const clientName = document.getElementById('waHeaderName').innerText;
                    askCrmAction(phone, opt.next_step, opt.label, clientName);
                };
                qrContainer.appendChild(btn);
            });
        }
    }
}

export function closeWaChat() {
    try {
        const mainChat = document.getElementById('waMainChat');
        if (mainChat) mainChat.classList.remove('mobile-open');
        setCurrentChatPhone(null);
        filterChats(getAppState().currentSearchQuery);
    } catch (e) {}
}

// ==========================================
// RENDERIZADO DE BURBUJAS (CON REACCIONES)
// ==========================================
export function addBubble(text, isMe, stepId, timestamp, mediaUrl = null, status = 3, msgId = '', reaction = null, extra = {}) {
    const box = document.getElementById('waMsgContainer');
    if (!box) return;
    const canClick = (isMe && stepId);
    const isDeleted = !!(extra && extra.deleted);
    const msgType = (extra && extra.type) || (mediaUrl && mediaUrl.endsWith('.webp') ? 'sticker' : null);
    const quoted = extra && extra.quoted;

    let timeStr = '';
    if (timestamp) {
        const dateObj = new Date(timestamp);
        timeStr = dateObj.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit', hour12: false});
    }

    let safeText = text ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;") : '';
    
    if (mediaUrl && (safeText === '🎵 Audio' || safeText === '👾 Sticker' || safeText === '🎥 Video' || safeText === '📷 Imagen')) {
        safeText = '';
    }

    safeText = safeText.replace(/```([\s\S]*?)```/g, '<code style="font-family: Consolas, monospace; background: rgba(128,128,128,0.15); padding: 2px 5px; border-radius: 4px;">$1</code>');
    safeText = safeText.replace(/\*([^\*\n]+)\*/g, '<strong>$1</strong>');
    safeText = safeText.replace(/_([^\_\n]+)_/g, '<em>$1</em>');
    safeText = safeText.replace(/~([^~\n]+)~/g, '<del>$1</del>');
    safeText = safeText.replace(/(^|\n)([-*])\s+(.*)/g, '$1• $3');
    safeText = safeText.replace(/\n/g, '<br>');

    // Mensaje eliminado: solo queda el placeholder, sin media ni cita.
    if (isDeleted) safeText = '<em style="color:#8696a0;">🚫 Este mensaje fue eliminado</em>';

    const safeStepId = stepId ? String(stepId).replace(/'/g, "\\'") : '';
    const safeMsgId = msgId ? `id="msg-${msgId}"` : '';
    // Texto crudo escapado para comparar la burbuja optimista con su eco.
    const attrText = String(text || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const isOptimistic = typeof msgId === 'string' && msgId.startsWith('tmp-');

    // Cita: el cuadrito del mensaje al que responde, como en WhatsApp.
    let quoteHtml = '';
    if (quoted && quoted.text && !isDeleted) {
        const qText = String(quoted.text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        const qBy = String(quoted.by || (quoted.fromMe ? 'Tú' : 'Cliente')).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
        quoteHtml = `<div class="quote-block"><div class="quote-by">${qBy}</div><div class="quote-text">${qText}</div></div>`;
    }

    let mediaHtml = '';
    if (mediaUrl && !isDeleted) {
        const marginB = safeText ? 'margin-bottom: 5px;' : '';
        if (mediaUrl.endsWith('.webp')) {
            mediaHtml = `<div style="${marginB}"><img src="${mediaUrl}" style="width: 140px; height: 140px; object-fit: contain; background: transparent; border-radius: 0;"></div>`;
        } else if (mediaUrl.endsWith('.ogg') || mediaUrl.endsWith('.mp3') || mediaUrl.endsWith('.opus')) {
            mediaHtml = `<div style="${marginB}"><audio controls style="max-width: 230px; height: 45px; outline: none; border-radius: 20px;"><source src="${mediaUrl}" type="audio/ogg">Tu navegador no soporta audio.</audio></div>`;
        } else if (mediaUrl.endsWith('.mp4')) {
            mediaHtml = `<div style="${marginB}"><video controls style="width: 100%; border-radius: 6px;"><source src="${mediaUrl}" type="video/mp4"></video></div>`;
        } else {
            mediaHtml = `<div style="${marginB}"><img src="${mediaUrl}" class="bubble-media-img" onclick="window.open('${mediaUrl}', '_blank')" style="border-radius: 6px; width: 100%; cursor: pointer;"></div>`;
        }
    }

    let ticksHtml = '';
    if (isMe && !isDeleted) {
        let color = status >= 3 ? '#53bdeb' : '#999';
        let icon = status >= 2 ? 'fa-check-double' : 'fa-check';
        ticksHtml = `<span style="color: ${color}; margin-left: 4px; font-size: 0.70rem;"><i class="fas ${icon}"></i></span>`;
    }

    // 🔥 FIX: Contenedor flotante para alojar la reacción visualmente
    let reactionBadgeHtml = (reaction && !isDeleted) ? `<span class="reaction-badge">${reaction}</span>` : '';
    const reactionHtml = `<div class="reaction-container" style="position:absolute; bottom:-12px; right:15px; display:flex; gap:2px; z-index:10;">${reactionBadgeHtml}</div>`;

    // El sticker va sin fondo de burbuja, como en WhatsApp.
    const stickerStyle = msgType === 'sticker' ? 'background:transparent; border:none; box-shadow:none; padding:0;' : '';

    // Incorporamos el msgId al div principal y lo hacemos position relative para anclar la reacción
    const html = `<div ${safeMsgId} class="wa-bubble ${isMe ? 'out' : 'in'} ${canClick ? 'clickable' : ''}${isOptimistic ? ' optimistic' : ''}"${isOptimistic ? ` data-text="${attrText}" data-media="${mediaUrl ? '1' : '0'}"` : ''} ${canClick ? `onclick="askJump('${safeStepId}')"` : ''} title="${canClick ? 'Click para restaurar' : ''}" style="position:relative; margin-bottom: 12px; ${stickerStyle}">
        ${quoteHtml}
        ${mediaHtml}
        ${safeText ? `<div class="wa-bubble-text" style="line-height: 1.4;">${safeText}</div>` : ''}
        <div style="display: flex; justify-content: flex-end; align-items: center; margin-top: 2px; opacity: 0.85;">
            <span class="wa-time" style="font-size: 0.70rem;">${timeStr}</span>
            ${ticksHtml}
        </div>
        ${reactionHtml}
    </div>`;

    // Si llega el eco real de un mensaje que ya se mostró al enviar (mismo
    // texto y mismo tipo de contenido), se quita la burbuja optimista para
    // no duplicar. El eco trae el id real; la optimista llevaba un id tmp-.
    if (!isOptimistic && msgId) {
        const opt = Array.from(box.querySelectorAll('.wa-bubble.optimistic'))
            .find(el => el.dataset.text === attrText && el.dataset.media === (mediaUrl ? '1' : '0'));
        if (opt) {
            const optImg = opt.querySelector('img');
            if (optImg && optImg.src && optImg.src.startsWith('blob:')) URL.revokeObjectURL(optImg.src);
            opt.remove();
        }
    }

    const isNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 150;
    box.insertAdjacentHTML('beforeend', html);

    if (isNearBottom || isMe) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    return box.lastElementChild;
}

export async function toggleCurrentBot(val) {
    const state = getAppState();
    const switchEl = document.getElementById('waBotSwitch');
    if (!state.currentChatPhone) return;

    const targetKey = getCleanPhone(state.currentChatPhone);
    let u = state.users.find(x => getCleanPhone(x.phone) === targetKey);

    if (!u) {
        u = { phone: state.currentChatPhone, bot_enabled: !val };
        state.users.push(u); 
    }

    const phoneToSend = u.realDbPhone || u.phone || state.currentChatPhone;
    const currentName = u.savedName || u.history?.nombre || phoneToSend;

    try {
        const response = await fetch(`/api/contacts/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: phoneToSend, name: currentName, enable: val, bot_enabled: val })
        });

        if (!response.ok) throw new Error("Respuesta de red incorrecta");
        const data = await response.json().catch(() => ({})); 

        if (data.success || response.ok) {
            showToast(val ? '🤖 Bot Activado' : '⏸️ Bot Pausado');
            u.bot_enabled = val;

            try {
                if (Array.isArray(state.allContactsCache)) {
                    let cachedContact = state.allContactsCache.find(c => getCleanPhone(c.phone) === targetKey);
                    if (cachedContact) {
                        cachedContact.bot_enabled = val;
                    } else {
                        state.allContactsCache.push({ phone: phoneToSend, name: currentName, bot_enabled: val });
                    }
                }
                filterChats(state.currentSearchQuery);
            } catch (renderError) { console.log(renderError); }
            
        } else { throw new Error("Error server JSON"); }
    } catch (e) {
        console.error("Error al actualizar estado del bot:", e);
        showToast("❌ Error actualizando el bot");
        if (switchEl) switchEl.checked = !val;
        u.bot_enabled = !val;
    }
}

export function askJump(step) {
    const state = getAppState();
    if(!state.currentChatPhone) return;
    pendingJumpStep = step;
    document.getElementById('jumpTargetStep').innerText = step;
    document.getElementById('jumpModal').classList.add('active');
}

export async function executeJump() {
    const state = getAppState();
    if(!pendingJumpStep || !state.currentChatPhone) return;
    document.getElementById('jumpModal').classList.remove('active');
    showToast("🔄 Procesando salto...");

    const qrContainer = document.getElementById('waQuickReplies');
    if (qrContainer) { qrContainer.innerHTML = ''; qrContainer.style.display = 'none'; }

    const botSwitch = document.getElementById('waBotSwitch');
    if (botSwitch && !botSwitch.checked) {
        botSwitch.checked = true;
        toggleCurrentBot(true);
    }

    try {
        await API.executeCrm(state.currentChatPhone, pendingJumpStep);
        reloadActivity();
    } catch (e) { 
        showToast("❌ Error de red: No se pudo mover al usuario"); 
    }
}

export function askCrmAction(phone, step, label, clientName) {
    pendingCrmAction = { phone, step };
    document.getElementById('actLabel').innerText = label;
    document.getElementById('actClient').innerText = clientName;
    document.getElementById('actionConfirmModal').classList.add('active');
}

export async function executeCrmAction() {
    if(!pendingCrmAction) return;
    document.getElementById('actionConfirmModal').classList.remove('active');
    showToast("🔄 Procesando acción...");

    const qrContainer = document.getElementById('waQuickReplies');
    if (qrContainer) { qrContainer.innerHTML = ''; qrContainer.style.display = 'none'; }

    try {
        await API.executeCrm(pendingCrmAction.phone, pendingCrmAction.step);
        pendingCrmAction = null;
        setTimeout(reloadActivity, 500);
    } catch (e) { showToast("❌ Error al ejecutar acción"); }
}

export function toggleFlowDrawer() {
    const drawer = document.getElementById('waFlowDrawer');
    if(drawer.classList.contains('open')) drawer.classList.remove('open');
    else { renderFlowDrawerContent(); drawer.classList.add('open'); }
}

function renderFlowDrawerContent() {
    const state = getAppState();
    if(!state.currentChatPhone) return;
    const user = state.users.find(u => getCleanPhone(u.phone) === getCleanPhone(state.currentChatPhone));
    const currentStep = user ? user.current_step : '';
    const sequence = getLinearFlowSequence(); 
    const drawer = document.getElementById('waFlowDrawer');
    
    drawer.innerHTML = '';
    
    let currentIndex = sequence.indexOf(currentStep);
    if(currentIndex === -1) currentIndex = -1;

    sequence.forEach((stepId, index) => {
        let statusClass = 'future';
        let icon = '<i class="far fa-circle"></i>';

        if (stepId === currentStep) { statusClass = 'current'; icon = '<i class="fas fa-dot-circle"></i>'; } 
        else if (index < currentIndex && currentIndex !== -1) { statusClass = 'past'; icon = '<i class="fas fa-check-circle"></i>'; }

        const div = document.createElement('div');
        div.className = `flow-item-row ${statusClass}`;
        div.onclick = () => injectStepCommand(stepId);
        div.innerHTML = `<span>${icon} ${stepId}</span><i class="fas fa-reply" style="opacity:0.5; font-size:0.8rem;"></i>`;
        drawer.appendChild(div);
    });

    setTimeout(() => {
        const currentEl = drawer.querySelector('.current');
        if(currentEl) currentEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 100);
}

function injectStepCommand(stepId) {
    const drawer = document.getElementById('waFlowDrawer');
    if (drawer && drawer.classList.contains('open')) toggleFlowDrawer(); 
    const inp = document.getElementById('waInput');
    if (inp) { inp.value = ''; handleInputTyping(); }
    askJump(stepId);
}