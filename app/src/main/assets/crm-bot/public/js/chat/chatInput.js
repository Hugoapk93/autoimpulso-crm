import { getAppState, reloadActivity } from '../main.js';
import { addBubble } from './chatWindow.js';
import { showToast } from '../utils.js';
import * as API from '../api.js';

export function handleInputTyping() {
    const inp = document.getElementById('waInput');
    const iconsToHide = document.querySelectorAll('.hide-on-type');
    const btn = document.getElementById('waMainBtn');
    if (!inp || !btn) return;

    if (inp.value.length > 0) {
        iconsToHide.forEach(el => el.style.display = 'none');
        btn.classList.add('is-send');
        btn.innerHTML = `<svg id="waMainIcon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" style="transform: translateX(2px);"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"></path></svg>`;
    } else {
        iconsToHide.forEach(el => el.style.display = 'inline-block');
        btn.classList.remove('is-send');
        btn.innerHTML = `<i class="fas fa-microphone" id="waMainIcon"></i>`;
    }
}

export async function sendWaMsg() {
    const state = getAppState();
    const currentChatPhone = state.currentChatPhone;
    
    const inp = document.getElementById('waInput');
    const txt = inp.value.trim();
    if (!txt || !currentChatPhone) return;

    inp.value = '';
    handleInputTyping();
    const drawer = document.getElementById('waFlowDrawer');
    if (drawer) drawer.classList.remove('open'); 

    // Interceptor para Forzar Pasos del CRM
    if (txt.startsWith('>> ')) {
        const targetStep = txt.replace('>> ', '').trim();
        addBubble(`🔄 <i>Forzando paso: ${targetStep}</i>`, true);

        const qrContainer = document.getElementById('waQuickReplies');
        if (qrContainer) { qrContainer.innerHTML = ''; qrContainer.style.display = 'none'; }

        const botSwitch = document.getElementById('waBotSwitch');
        if (botSwitch && !botSwitch.checked) {
            botSwitch.checked = true;
            if (window.toggleCurrentBot) window.toggleCurrentBot(true);
        }

        try {
            await API.executeCrm(currentChatPhone, targetStep);
            setTimeout(reloadActivity, 500);
        } catch (e) { showToast("❌ Error al cambiar paso"); }
        return; 
    }

    // Envío Normal: la burbuja aparece al instante (optimista) y el eco del
    // socket la reemplaza por la real (addBubble quita la optimista con el
    // mismo texto). Si el envío falla, se quita y se avisa.
    const tempId = 'tmp-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    const optimisticEl = addBubble(txt, true, null, new Date().toISOString(), null, 1, tempId);
    try {
        await API.sendMessage(currentChatPhone, txt);
    } catch (e) {
        if (optimisticEl) optimisticEl.remove();
        console.error("Error al enviar texto:", e);
        showToast("❌ Error enviando mensaje");
    }
}

export function handleMainBtn() {
    const btn = document.getElementById('waMainBtn');
    if (btn && btn.classList.contains('is-send')) {
        sendWaMsg(); 
    } else {
        showToast("🎤 Grabación de voz no disponible"); 
    }
}

// Escuchar la tecla Enter
window.addEventListener('DOMContentLoaded', () => {
    const inp = document.getElementById('waInput');
    if (inp) {
        inp.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendWaMsg();
            }
        });
    }
});