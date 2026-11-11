import { getCleanPhone, escapeHTML, formatSmartDate, showToast } from '../utils.js';
import { getAppState, setAllContactsCache, setCurrentSearchQuery } from '../main.js';
import { openWaChat, closeWaChat } from './chatWindow.js';
import * as API from '../api.js';

let isSelectionMode = false;
let selectedChats = [];
let longPressTimer;
let ignoreClick = false;
let renderListTimer = null;

export function smartRenderChats(phoneToUpdate = null) {
    const state = getAppState();
    
    if (state.currentSearchQuery || !phoneToUpdate) {
        clearTimeout(renderListTimer);
        renderListTimer = setTimeout(() => {
            requestAnimationFrame(() => { filterChats(state.currentSearchQuery); });
        }, 200);
        return;
    }

    const cleanPhone = getCleanPhone(phoneToUpdate);
    const chatRow = document.getElementById(`chat-row-${cleanPhone}`);
    const userMem = state.users.find(u => getCleanPhone(u.phone) === cleanPhone);

    if (chatRow && userMem) {
        const nameEl = chatRow.querySelector('.wa-name');
        const displayName = String(userMem.savedName || userMem.history?.nombre || userMem.phone || '?');
        if (nameEl) nameEl.innerText = displayName;

        const avatarEl = chatRow.querySelector('.wa-avatar');
        if (avatarEl && displayName) {
            const firstChild = avatarEl.childNodes[0];
            if (firstChild && firstChild.nodeType === Node.TEXT_NODE) {
                firstChild.textContent = displayName.charAt(0).toUpperCase();
            }
        }

        const timeContainer = chatRow.querySelector('.wa-time-container');
        if (timeContainer) {
            let stepBadge = userMem.current_step ? `<span class="chat-step-badge">[${escapeHTML(userMem.current_step)}]</span>` : '';
            timeContainer.innerHTML = `${stepBadge}<span class="wa-time-meta">${formatSmartDate(userMem.last_active)}</span>`;
        }

        const previewEl = chatRow.querySelector('.wa-msg-preview');
        if (previewEl) {
            const cleanText = String(userMem.last_message || '...').replace(/[\r\n]+/g, ' ');
            let unreadHtml = userMem.unreadCount > 0 ? `<span class="unread-badge" style="margin-left: 5px; flex-shrink: 0;">${userMem.unreadCount}</span>` : '';
            previewEl.innerHTML = `<span class="wa-msg-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-grow: 1;">${escapeHTML(cleanText)}</span>${unreadHtml}`;
        }
        
        const chatListContainer = document.getElementById('waChatList');
        if (chatListContainer && chatListContainer.firstChild !== chatRow) {
            chatListContainer.prepend(chatRow);
        }
    } else {
        filterChats(state.currentSearchQuery);
    }
}

export function renderChatList(list) {
    const c = document.getElementById('waChatList');
    if(!c) return; 
    c.innerHTML = '';
    
    const state = getAppState();

    list.sort((a, b) => {
        const timeA = a.last_active ? new Date(a.last_active).getTime() : 0;
        const timeB = b.last_active ? new Date(b.last_active).getTime() : 0;
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
    });

    list.forEach(u => {
        if(u.phone === 'TEST_SIMULADOR') return;
        
        const name = String(u.savedName || u.history?.nombre || u.history?.cliente || u.history?.usuario || u.phone || '?');
        const safeName = escapeHTML(name);
        const initial = name.charAt(0).toUpperCase();
        const safeInitial = escapeHTML(initial);
        
        const timeDisplay = formatSmartDate(u.last_active);
        
        const isSelected = selectedChats.includes(u.phone);
        const activeClass = (state.currentChatPhone === u.phone) ? 'active' : '';
        const selectedClass = isSelected ? 'selected' : '';
        const checkIcon = isSelected ? '<div class="chat-check-icon"><i class="fas fa-check"></i></div>' : '';
        
        const rawMsg = u.last_message || '...';
        const cleanMsg = rawMsg.replace(/[\r\n]+/g, ' ');
        const lastMsg = escapeHTML(cleanMsg);

        let unreadHtml = u.unreadCount > 0 ? `<span class="unread-badge" style="margin-left: 5px; flex-shrink: 0;">${u.unreadCount}</span>` : '';
        let stepBadge = u.current_step ? `<span class="chat-step-badge">[${escapeHTML(u.current_step)}]</span>` : '';

        const div = document.createElement('div');
        div.id = `chat-row-${getCleanPhone(u.phone)}`; 
        div.className = `wa-chat-item ${activeClass}${selectedClass}`;
        div.oncontextmenu = function(e) { e.preventDefault(); return false; }; 
        
        div.innerHTML = `
            <div class="wa-avatar" style="position:relative; overflow:visible;">
                ${safeInitial}${checkIcon}
            </div>
            
            <div class="wa-chat-info">
                <div class="wa-row-top">
                    <span class="wa-name" title="${safeName}">${safeName}</span>
                    <div class="wa-time-container" style="display:flex; align-items:center; gap: 5px;">
                        ${stepBadge}
                        <span class="wa-time-meta">${timeDisplay}</span>
                    </div>
                </div>
                
                <div class="wa-msg-preview" style="display: flex; align-items: center; justify-content: space-between; overflow: hidden; width: 100%;">
                    <span class="wa-msg-text" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex-grow: 1;">${lastMsg}</span>
                    ${unreadHtml}
                </div>
            </div>
        `;

        const startPress = (e) => {
            if (e.type === 'mousedown' && e.button !== 0) return;
            ignoreClick = false;
            longPressTimer = setTimeout(() => {
                ignoreClick = true;
                toggleSelection(u.phone);
                if (navigator.vibrate) navigator.vibrate(50);
            }, 600);
        };

        const cancelPress = () => clearTimeout(longPressTimer);

        const handleClick = (e) => {
            if (ignoreClick) { ignoreClick = false; return; }
            if (isSelectionMode) { toggleSelection(u.phone); } 
            else { openWaChat(u.phone); }
        };

        div.addEventListener('mousedown', startPress);
        div.addEventListener('touchstart', startPress, {passive: true});
        div.addEventListener('mouseup', cancelPress);
        div.addEventListener('mouseleave', cancelPress);
        div.addEventListener('touchend', cancelPress);
        div.addEventListener('touchmove', cancelPress);
        div.addEventListener('click', handleClick);

        c.appendChild(div);
    });
}

function toggleSelection(phone) {
    const state = getAppState();
    
    if (!isSelectionMode) {
        isSelectionMode = true;
        document.getElementById('waHeaderSearch').style.display = 'none';
        document.getElementById('waHeaderSelection').style.display = 'flex';
    }

    if (selectedChats.includes(phone)) {
        selectedChats = selectedChats.filter(p => p !== phone);
    } else {
        selectedChats.push(phone);
    }

    document.getElementById('waSelectionCount').innerText = selectedChats.length;

    if (selectedChats.length === 0) exitSelectionMode();
    else filterChats(state.currentSearchQuery);
}

export function exitSelectionMode() {
    const state = getAppState();
    isSelectionMode = false;
    selectedChats = [];
    document.getElementById('waHeaderSearch').style.display = 'block';
    document.getElementById('waHeaderSelection').style.display = 'none';
    filterChats(state.currentSearchQuery);
}

export function askDeleteSelectedChats() {
    if(selectedChats.length === 0) return;
    
    const count = selectedChats.length;
    const isSingle = count === 1;
    const title = isSingle ? "Eliminar Chat" : "Eliminar Chats";
    const msg = isSingle 
        ? "¿Estás seguro de que deseas eliminar este chat? Esta acción no se puede deshacer." 
        : `¿Estás seguro de que deseas eliminar estos ${count} chats? Esta acción no se puede deshacer.`;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.75); z-index:9999; display:flex; justify-content:center; align-items:center; opacity:0; transition: opacity 0.2s ease-in-out;';
    
    const modal = document.createElement('div');
    modal.style.cssText = 'background:var(--bg-panel, #202c33); color:#e9edef; padding:24px; border-radius:12px; width:90%; max-width:400px; box-shadow:0 15px 30px rgba(0,0,0,0.5); transform:scale(0.9); transition: transform 0.2s ease-in-out; font-family: inherit;';
    
    modal.innerHTML = `
        <h3 style="margin-top:0; margin-bottom:15px; color:#ef5350; display:flex; align-items:center; gap:10px; font-size:1.2rem;">
            <i class="fas fa-trash-alt"></i> ${title}
        </h3>
        <p style="color:#8696a0; line-height:1.5; font-size: 0.95rem; margin-bottom: 25px;">${msg}</p>
        <div id="modalButtons" style="display:flex; justify-content:flex-end; gap:15px;"></div>
    `;
    
    const btnCancel = document.createElement('button');
    btnCancel.innerText = "Cancelar";
    btnCancel.style.cssText = 'background:transparent; color:#00a884; border:1px solid rgba(0,168,132,0.3); padding:8px 16px; cursor:pointer; font-weight:600; border-radius:24px; transition: 0.2s;';
    
    const btnConfirm = document.createElement('button');
    btnConfirm.innerText = "Eliminar";
    btnConfirm.style.cssText = 'background:#ef5350; color:#fff; border:none; padding:8px 16px; cursor:pointer; font-weight:600; border-radius:24px; box-shadow: 0 4px 6px rgba(239, 83, 80, 0.2); transition: 0.2s;';
    
    const closeModal = () => {
        overlay.style.opacity = '0';
        modal.style.transform = 'scale(0.9)';
        setTimeout(() => document.body.removeChild(overlay), 200);
    };

    btnCancel.addEventListener('click', closeModal);
    btnConfirm.addEventListener('click', () => {
        closeModal();
        executeDeleteSelectedChats();
    });

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    modal.querySelector('#modalButtons').appendChild(btnCancel);
    modal.querySelector('#modalButtons').appendChild(btnConfirm);

    requestAnimationFrame(() => {
        overlay.style.opacity = '1';
        modal.style.transform = 'scale(1)';
    });
}

async function executeDeleteSelectedChats() {
    const state = getAppState();
    showToast(`⏳ Eliminando ${selectedChats.length} chats...`);
    
    try {
        for (const phone of selectedChats) {
             const res = await fetch(`/api/contacts/delete`, { 
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({phone: phone})
            });
            if(!res.ok) console.warn("Fallo al eliminar:", phone);
        }

        for (let i = state.users.length - 1; i >= 0; i--) {
            if (selectedChats.includes(state.users[i].phone)) {
                state.users.splice(i, 1);
            }
        }
        
        let newCache = state.allContactsCache.filter(u => !selectedChats.includes(u.phone));
        setAllContactsCache(newCache);

        if (selectedChats.includes(state.currentChatPhone)) closeWaChat();

        showToast(`✅ ${selectedChats.length} chats eliminados`);
        exitSelectionMode();
    } catch (e) {
        console.error("Error en executeDeleteSelectedChats:", e);
        showToast("❌ Error al eliminar los chats");
        exitSelectionMode();
    }
}

export function filterChats(q) {
    setCurrentSearchQuery(q);
    const state = getAppState();
    
    if(!q) {
        renderChatList(state.users);
    } else {
        const term = q.toLowerCase().trim();
        const f = state.users.filter(u => {
            const savedName = (u.savedName || '').toLowerCase();
            const phoneStr = (u.phone || '').toLowerCase();
            const stepStr = (u.current_step || '').toLowerCase();
            const lastMsg = (u.last_message || '').toLowerCase();
            // El nombre que el cliente dio en el chat vive en history y no
            // siempre coincide con savedName (que puede ser el teléfono).
            const histName = (u.history?.nombre || '').toLowerCase();
            const histCliente = (u.history?.cliente || '').toLowerCase();
            const histUsuario = (u.history?.usuario || '').toLowerCase();
            const dbPhone = (u.realDbPhone || '').toLowerCase();
            const lidPhone = (u.lidPhone || '').toLowerCase();
            return savedName.includes(term) || phoneStr.includes(term) || stepStr.includes(term) || lastMsg.includes(term)
                || histName.includes(term) || histCliente.includes(term) || histUsuario.includes(term)
                || dbPhone.includes(term) || lidPhone.includes(term);
        });
        renderChatList(f);
    }
}

// 🔥 REESCRITA: Manejo completo para LIDs, BD y teléfonos normales.
export function removeChatFromUI(phone) {
    const state = getAppState();
    const targetClean = getCleanPhone(phone);
    
    // 1. Filtrar buscando en todas las posibles identificaciones (phone, DB, y LID)
    for (let i = state.users.length - 1; i >= 0; i--) {
        const u = state.users[i];
        const uClean = getCleanPhone(u.phone);
        const uDbClean = u.realDbPhone ? getCleanPhone(u.realDbPhone) : null;
        const uLidClean = u.lidPhone ? getCleanPhone(u.lidPhone) : null;
        
        // Si cualquiera coincide con el que queremos borrar...
        if (uClean === targetClean || uDbClean === targetClean || uLidClean === targetClean) {
            
            // 🔥 Eliminar el contenedor HTML usando su ID exacto de creación (que usa uClean)
            const chatRow = document.getElementById(`chat-row-${uClean}`);
            if (chatRow) {
                chatRow.remove();
            }

            // Cerrar el chat visualmente si lo teníamos abierto en ese momento
            if (state.currentChatPhone) {
                const cClean = getCleanPhone(state.currentChatPhone);
                if (cClean === uClean || cClean === uDbClean || cClean === uLidClean) {
                    closeWaChat();
                }
            }

            // Eliminarlo de la memoria temporal de la lista
            state.users.splice(i, 1);
        }
    }
    
    // 2. Limpiar el caché profundo, también protegiendo por LIDs
    let newCache = state.allContactsCache.filter(u => {
        const uc = getCleanPhone(u.phone);
        const ul = u.lidPhone ? getCleanPhone(u.lidPhone) : (u.lid ? getCleanPhone(u.lid) : null);
        return uc !== targetClean && ul !== targetClean;
    });
    setAllContactsCache(newCache);

    // 3. Refrescar lista final por si hay un filtro de búsqueda activo
    filterChats(state.currentSearchQuery);
}