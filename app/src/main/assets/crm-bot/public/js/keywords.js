// js/keywords.js
import * as API from './api.js';
import { showToast, pushNavigationLayer, escapeHTML, validateImageFile } from './utils.js';

let currentKwMediaList = [];
let currentEditKwId = null;
let currentKwToDelete = null;
let rulesById = {}; // Reglas por id, para el modal de borrar y el de editar

export async function loadKeywords() {
    const container = document.getElementById('keywordsList');
    container.innerHTML = '<div style="text-align:center; padding:20px;"><i class="fas fa-spinner fa-spin"></i> Cargando...</div>';

    try {
        const res = await fetch('/api/keywords'); // Usamos ruta relativa
        if (!res.ok) throw new Error("No se pudieron cargar las keywords");
        
        const rules = await res.json();
        container.innerHTML = '';

        if (rules.length === 0) {
            container.innerHTML = `
                <div style="grid-column: 1/-1; text-align:center; padding:40px; color:var(--text-muted); border:1px dashed var(--border); border-radius:10px;">
                    <i class="fas fa-magic" style="font-size:2rem; margin-bottom:10px;"></i><br>
                    No hay reglas creadas.<br>Crea una para responder dudas frecuentes automáticamente.
                </div>`;
            return;
        }

        const pendientes = rules.filter(r => !r.answer || r.answer.trim() === '');
        const activas = rules.filter(r => r.answer && r.answer.trim() !== '');
        rulesById = {};
        rules.forEach(rr => { rulesById[rr.id] = rr; });
        let htmlBuffer = '';

        if (pendientes.length > 0) {
            htmlBuffer += `<h3 style="grid-column: 1/-1; color: var(--danger); margin-top: 10px;"><i class="fas fa-exclamation-circle"></i> Dudas por aprender (${pendientes.length})</h3>`;
            pendientes.forEach(r => {
                htmlBuffer += `
                <div class="kw-card kw-card-pending">
                    <div class="mb-10"><span class="kw-tag-danger">${escapeHTML(r.keywords)}</span></div>
                    <div class="kw-status-text">Sin respuesta asignada.</div>
                    <div class="kw-actions">
                        <button data-kw-edit="${escapeHTML(r.id)}" class="kw-action-btn edit"><i class="fas fa-pen"></i></button>
                        <button data-kw-del="${escapeHTML(r.id)}" class="kw-action-btn del"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
            });
        }

        if (activas.length > 0) {
            htmlBuffer += `<h3 style="grid-column: 1/-1; color: var(--text-main); margin-top: 20px;"><i class="fas fa-check-circle" style="color:var(--success)"></i> Respuestas Activas</h3>`;
            activas.forEach(r => {
                const tags = r.keywords.split(',').map(k => `<span class="kw-tag-active">${escapeHTML(k.trim())}</span>`).join('');
                const mediaBadge = (r.media && r.media.length > 0) ? `<div class="mt-10 text-primary info-text"><i class="fas fa-image"></i> ${r.media.length} imagen(es) adjunta(s)</div>` : '';

                htmlBuffer += `
                <div class="kw-card kw-card-active">
                    <div class="mb-10">${tags}</div>
                    <div class="kw-answer-text">${escapeHTML(r.answer)}</div>
                    ${mediaBadge}
                    <div class="kw-actions">
                        <button data-kw-edit="${escapeHTML(r.id)}" class="kw-action-btn edit"><i class="fas fa-pen"></i></button>
                        <button data-kw-del="${escapeHTML(r.id)}" class="kw-action-btn del"><i class="fas fa-trash"></i></button>
                    </div>
                </div>`;
            });
        }
        container.innerHTML = htmlBuffer;
        // Los botones ya no llevan los datos incrustados en onclick (una comilla
        // en el texto rompia el handler y permitia inyectar JS). Los datos viajan
        // por el objeto regla, no por el HTML.
        container.querySelectorAll('[data-kw-edit]').forEach(btn => {
            btn.addEventListener('click', () => {
                const r = rulesById[btn.dataset.kwEdit];
                if (!r) return;
                openKeywordModal(r.id, r.keywords, encodeURIComponent(r.answer || ''), encodeURIComponent(JSON.stringify(r.media || [])));
            });
        });
        container.querySelectorAll('[data-kw-del]').forEach(btn => {
            btn.addEventListener('click', () => askDeleteKeyword(btn.dataset.kwDel));
        });
    } catch (e) {
        console.error("Error al cargar keywords:", e);
        container.innerHTML = '<div style="text-align:center; padding:20px; color:var(--danger);">Error cargando reglas. Verifica la conexión.</div>';
    }
}

export function openKeywordModal(id = null, keywords = '', answerEncoded = '', mediaStrEncoded = 'W10=') {
    pushNavigationLayer();
    currentEditKwId = id;
    document.getElementById('kwInput').value = keywords;
    try { document.getElementById('kwAnswer').value = decodeURIComponent(answerEncoded); } catch(e){}
    try { currentKwMediaList = JSON.parse(decodeURIComponent(mediaStrEncoded)); } catch(e) { currentKwMediaList = []; }
    renderKwGallery();
    document.getElementById('keywordModal').classList.add('active');
}

export function renderKwGallery() {
    const c = document.getElementById('kwGallery');
    if (!c) return;
    c.innerHTML = '';
    currentKwMediaList.forEach((u, i) => {
        c.innerHTML += `
        <div class="kw-thumb-wrap">
            <img src="${escapeHTML(u)}" class="kw-thumb-img">
            <button onclick="removeKwMedia(${i})" class="kw-thumb-del"><i class="fas fa-times"></i></button>
        </div>`;
    });
}

function removeKwMedia(i) {
    currentKwMediaList.splice(i, 1);
    renderKwGallery();
}

export async function uploadKwImages(input) {
    if (!input.files || input.files.length === 0) return;
    const validFiles = [];
    for (let i = 0; i < input.files.length; i++) {
        const err = validateImageFile(input.files[i]);
        if (err) { showToast(`⚠️ ${err}`); continue; }
        validFiles.push(input.files[i]);
    }
    if (validFiles.length === 0) { input.value = ''; return; }
    const formData = new FormData();
    validFiles.forEach(f => formData.append('images', f));
    showToast("⏳ Subiendo imagen...");
    
    try {
        const res = await fetch('/api/upload', { method: 'POST', body: formData });
        if (!res.ok) throw new Error("Fallo al subir archivo");
        
        const data = await res.json();
        if (data.urls) {
            currentKwMediaList = currentKwMediaList.concat(data.urls);
            renderKwGallery();
            showToast("✅ Imagen lista");
        }
    } catch (e) { 
        console.error("Error al subir imagen de keyword:", e);
        showToast("❌ Error al subir"); 
    } finally {
        input.value = '';
    }
}

export async function saveKeywordRule() {
    const keywords = document.getElementById('kwInput').value.trim();
    const answer = document.getElementById('kwAnswer').value.trim();

    if (!keywords || !answer) {
        showToast("⚠️ Escribe las palabras clave y la respuesta");
        return;
    }
    
    const payload = { keywords, answer, media: currentKwMediaList };
    if (currentEditKwId) payload.id = currentEditKwId;

    try {
        const res = await fetch('/api/keywords', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error("Error del servidor al guardar regla");
        
        document.getElementById('keywordModal').classList.remove('active');
        showToast("✅ Regla guardada");
        loadKeywords(); 
    } catch (e) { 
        console.error("Error al guardar keyword:", e);
        showToast("❌ Error al guardar la regla"); 
    }
}

// ----------------------------------------------------
// ELIMINACIÓN SEGURA SIN BLOQUEAR LA PWA
// ----------------------------------------------------
export function askDeleteKeyword(id) {
    currentKwToDelete = id;
    const rule = rulesById[id];
    const labelEl = document.getElementById('delKeywordName');
    if (labelEl) labelEl.innerText = rule ? rule.keywords : id;
    pushNavigationLayer();
    document.getElementById('deleteKeywordModal').classList.add('active');
}

export async function executeDeleteKeyword() {
    if (!currentKwToDelete) return;
    document.getElementById('deleteKeywordModal').classList.remove('active');
    try {
        const res = await fetch(`/api/keywords/${currentKwToDelete}`, { method: 'DELETE' });
        if (!res.ok) throw new Error("Error al borrar en el servidor");
        
        loadKeywords();
        showToast("🗑️ Regla eliminada");
    } catch(e) { 
        console.error("Error borrando keyword:", e); 
        showToast("❌ No se pudo eliminar la regla");
    } finally {
        currentKwToDelete = null;
    }
}

// Exponer funciones al HTML global
window.openKeywordModal = openKeywordModal;
window.uploadKwImages = uploadKwImages;
window.saveKeywordRule = saveKeywordRule;
window.askDeleteKeyword = askDeleteKeyword;
window.executeDeleteKeyword = executeDeleteKeyword;
window.renderKwGallery = renderKwGallery;
window.removeKwMedia = removeKwMedia;