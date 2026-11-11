import { getAppState, reloadActivity } from '../main.js';
import { handleInputTyping } from './chatInput.js';
import { addBubble } from './chatWindow.js';
import { showToast, pushNavigationLayer, validateImageFile } from '../utils.js';
import * as API from '../api.js';

let pendingMediaFile = null;

// ==========================================
// SELECCIÓN Y PREVISUALIZACIÓN DE ARCHIVOS
// ==========================================
export function uploadChatMedia(input) {
    const state = getAppState();
    
    if (!input.files || input.files.length === 0) return;
    if (!state.currentChatPhone) {
        showToast("⚠️ Selecciona un chat primero");
        input.value = '';
        return;
    }

    const file = input.files[0];
    const err = validateImageFile(file);
    if (err) {
        showToast(`⚠️ ${err}`);
        input.value = '';
        return;
    }
    pendingMediaFile = file;
    const reader = new FileReader();
    reader.onload = function(e) { showMediaPreviewModal(e.target.result); };
    reader.readAsDataURL(pendingMediaFile);
    input.value = ''; 
}
    
function showMediaPreviewModal(dataUrl) {
    pushNavigationLayer();
    const imgEl = document.getElementById('mediaPreviewImg');
    const captionEl = document.getElementById('mediaPreviewCaption');
    const inputEl = document.getElementById('waInput');
    const modalEl = document.getElementById('mediaPreviewModal');

    if (imgEl) imgEl.src = dataUrl;
    if (captionEl && inputEl) captionEl.value = inputEl.value; 
    
    if (modalEl) modalEl.classList.add('active'); 
    setTimeout(() => { if(captionEl) captionEl.focus(); }, 100);
}

export function closeMediaPreview() {
    pendingMediaFile = null;
    const modalEl = document.getElementById('mediaPreviewModal');
    if (modalEl) modalEl.classList.remove('active');
}

// ==========================================
// ENVÍO DE MULTIMEDIA AL SERVIDOR
// ==========================================
export async function sendPendingMedia() {
    const state = getAppState();
    
    if (!pendingMediaFile || !state.currentChatPhone) return;

    const captionEl = document.getElementById('mediaPreviewCaption');
    const captionText = captionEl ? captionEl.value.trim() : '';
    
    const formData = new FormData();
    formData.append('images', pendingMediaFile);

    // Burbuja optimista con la imagen local; el eco del socket la reemplaza
    // por la real (addBubble quita la optimista con el mismo texto).
    const fileToSend = pendingMediaFile;
    const localUrl = URL.createObjectURL(fileToSend);
    const optimisticEl = addBubble(captionText, true, null, new Date().toISOString(), localUrl, 1, 'tmp-media-' + Date.now());

    closeMediaPreview();
    showToast("⏳ Enviando imagen...");

    try {
        const resUpload = await fetch(`/api/upload`, { method: 'POST', body: formData });
        if(!resUpload.ok) throw new Error("Fallo en la subida al servidor");
        
        const dataUpload = await resUpload.json();

        if (dataUpload.urls && dataUpload.urls.length > 0) {
            const imageUrl = dataUpload.urls[0];
            
            await API.sendMessage(state.currentChatPhone, captionText, imageUrl);
            
            const mainInput = document.getElementById('waInput');
            if (mainInput) mainInput.value = '';
            if (captionEl) captionEl.value = ''; 
            
            handleInputTyping();
            // Refrescamos en silencio para que baje el mensaje con la foto
            setTimeout(reloadActivity, 500);
        } else {
            throw new Error("No se devolvió URL de imagen");
        }
    } catch (e) {
        if (optimisticEl) {
            const optImg = optimisticEl.querySelector('img');
            if (optImg && optImg.src && optImg.src.startsWith('blob:')) URL.revokeObjectURL(optImg.src);
            optimisticEl.remove();
        }
        console.error("Error en sendPendingMedia:", e);
        showToast("❌ Error al enviar la imagen");
    }
}