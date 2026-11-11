// public/js/utils.js

export function getCleanPhone(ph) {
    if (!ph) return '';
    const str = String(ph).replace(/\D/g, '');
    if (str.length > 14) return str;
    if (str.length >= 10) return str.slice(-10);
    return str;
}

export function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

export function formatSmartDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return ''; 

    const now = new Date();
    const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffTime = today.getTime() - msgDate.getTime();
    const diffDays = Math.round(diffTime / (1000 * 3600 * 24));

    if (diffDays === 0) { return date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }); } 
    else if (diffDays === 1) { return 'Ayer'; } 
    else if (diffDays > 1 && diffDays < 7) {
        const dias = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        return dias[date.getDay()];
    } else { return date.toLocaleDateString('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
}

export function showToast(m) {
    const c = document.getElementById('toast-container');
    if (!c) return;
    // Antes el timeout borraba c.lastChild, que podía ser un toast más nuevo
    // llegado después. Ahora cada toast borra su propio elemento.
    const toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.innerHTML = m;
    c.appendChild(toastEl);
    // Máximo 4 a la vez: si llegan más, se descarta el más viejo.
    while (c.children.length > 4) c.removeChild(c.firstChild);
    setTimeout(() => toastEl.remove(), 3000);
}

// Límite para imágenes subidas desde el panel (chat, flujo, keywords).
// El servidor no limita el tamaño y una foto de 50 MB se leía entera en
// memoria para la vista previa antes de subirla.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export function validateImageFile(file) {
    if (!file) return 'No se eligió ningún archivo';
    if (!file.type || !file.type.startsWith('image/')) return 'Solo se permiten imágenes';
    if (file.size > MAX_IMAGE_BYTES) return `La imagen pesa ${(file.size / 1048576).toFixed(1)} MB, el máximo es 10 MB`;
    return null;
}

export function pushNavigationLayer() {
    history.pushState({ layer: true }, '');
}