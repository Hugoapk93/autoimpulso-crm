import * as API from './api.js';
import { showToast } from './utils.js';

const API_BASE = '';
let tzPreviewInterval = null;

export async function saveSettings() {
    const days = [1, 2, 3, 4, 5, 6, 0];
    const weeklySchedule = {};
    let isAnyDayActive = false; 

    days.forEach(d => {
        const dayActive = document.getElementById(`schDay${d}`) ? document.getElementById(`schDay${d}`).checked : false;
        if(dayActive) isAnyDayActive = true;

        const dayStart = document.getElementById(`schStart${d}`) ? document.getElementById(`schStart${d}`).value : '';
        const dayEnd = document.getElementById(`schEnd${d}`) ? document.getElementById(`schEnd${d}`).value : '';
        const dayMsg = document.getElementById(`schMsg${d}`) ? document.getElementById(`schMsg${d}`).value.trim() : '';
        
        weeklySchedule[d] = { active: dayActive, start: dayStart, end: dayEnd, offline_message: dayMsg };
    });

    const customVars = {};
    
    // 1. Recopilar datos del Panel de Negocio
    const bizName = document.getElementById('bizNameInput') ? document.getElementById('bizNameInput').value : '';
    const bizAdvisor = document.getElementById('bizAdvisorInput') ? document.getElementById('bizAdvisorInput').value : '';
    const bizAddress = document.getElementById('bizAddressInput') ? document.getElementById('bizAddressInput').value : '';

    customVars['negocio'] = { value: bizName, desc: window.BUSINESS_VARIABLES['negocio'], system: false };
    customVars['asesor'] = { value: bizAdvisor, desc: window.BUSINESS_VARIABLES['asesor'], system: false };
    customVars['ubicacion'] = { value: bizAddress, desc: window.BUSINESS_VARIABLES['ubicacion'], system: false };

    // 2. Generar automáticamente el texto de los horarios activos
    let scheduleTextSummary = [];
    const dayNames = { 1: 'Lunes', 2: 'Martes', 3: 'Miércoles', 4: 'Jueves', 5: 'Viernes', 6: 'Sábado', 0: 'Domingo' };
    
    days.forEach(d => {
        const check = document.getElementById(`schDay${d}`);
        if (check && check.checked) {
            const start = document.getElementById(`schStart${d}`)?.value || '09:00';
            const end = document.getElementById(`schEnd${d}`)?.value || '18:00';
            scheduleTextSummary.push(`${dayNames[d]}: ${start} a ${end}`);
        }
    });

    customVars['horario'] = { 
        value: scheduleTextSummary.length > 0 ? scheduleTextSummary.join(', ') : 'Horario no especificado', 
        desc: window.BUSINESS_VARIABLES['horario'], 
        system: false 
    };

    // 3. Recopilar el resto de las variables del DOM
    document.querySelectorAll('#customVarsContainer .var-row').forEach(row => {
        const key = row.querySelector('.var-key').value;
        const desc = row.querySelector('.var-desc').value;
        const valInput = row.querySelector('.var-val');
        const val = valInput ? valInput.value : "";
        
        // Saltamos las del negocio/horario porque ya las guardamos arriba manualmente
        if (window.BUSINESS_VARIABLES && window.BUSINESS_VARIABLES.hasOwnProperty(key)) return;

        // Proteger las del sistema
        if (window.SYSTEM_VARIABLES && window.SYSTEM_VARIABLES.hasOwnProperty(key)) {
            customVars[key] = { value: "", desc: window.SYSTEM_VARIABLES[key], system: true };
        } else {
            customVars[key] = { value: val, desc: desc, system: false };
        }
    });

    const payload = {
        schedule: { active: isAnyDayActive, offline_message: "", days: weeklySchedule },
        customVars: customVars 
    };

    // 🔥 NUEVO: Actualizar la interfaz de variables dinámicas al instante sin recargar
    document.querySelectorAll('#customVarsContainer .var-row').forEach(row => {
        const keyInput = row.querySelector('.var-key');
        if (!keyInput) return;
        const key = keyInput.value;
        
        // Si es una variable de negocio o de horario, actualizamos su valor visual en tiempo real
        if (['negocio', 'asesor', 'ubicacion', 'horario'].includes(key)) {
            const valInput = row.querySelector('.var-val');
            if (valInput) {
                valInput.value = customVars[key].value;
            }
        }
    });

    try {
        const res = await fetch(`${API_BASE}/api/settings`, { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify(payload) 
        });
        
        if (!res.ok) throw new Error("Fallo al guardar settings");
        showToast('💾 Configuración guardada');
    } catch(e) { 
        console.error("Error en saveSettings:", e);
        showToast('❌ Error al guardar la configuración'); 
    }
}

// --- CARGAR HORARIOS DESDE LA BD ---
export function loadScheduleFromMemory(settings) {
    if (!settings || !settings.schedule || !settings.schedule.days) return;
    
    [1, 2, 3, 4, 5, 6, 0].forEach(d => {
        const dayData = settings.schedule.days[d];
        if (dayData) {
            const check = document.getElementById('schDay' + d);
            const start = document.getElementById('schStart' + d);
            const end = document.getElementById('schEnd' + d);
            const msg = document.getElementById('schMsg' + d);
            
            // Poner los valores desde la BD
            if (check) check.checked = dayData.active;
            if (start && dayData.start) start.value = dayData.start;
            if (end && dayData.end) end.value = dayData.end;
            if (msg && dayData.offline_message !== undefined) msg.value = dayData.offline_message;
            
            // Actualizar la interfaz visual
            window.updateDaySummary(d);
            if (check) window.toggleDayColor(d, check);
        }
    });
}

// --- GESTOR DE VARIABLES DINÁMICAS ---

// Diccionario central de variables automáticas del sistema
window.SYSTEM_VARIABLES = {
    "saludo": "Saludo dinámico según la hora (Ej: Buenos días / Buenas tardes).",
    "nombre_primer": "El primer nombre del cliente (ideal para un trato más cercano).",
    "nombre": "El nombre completo y validado del cliente.",
    "telefono": "Número de teléfono validado a 10 dígitos.",
    "correo": "Correo electrónico validado del cliente.",
    "fecha_nacimiento": "Fecha de nacimiento en formato limpio (DD/MM/AAAA).",
    "curp": "Clave Única de Registro de Población (CURP) validada.",
    "rfc": "Registro Federal de Contribuyentes (RFC) validado.",
    "codigo_postal": "Código Postal validado a 5 dígitos.",
    "producto_interes": "El producto, servicio u opción del catálogo que el cliente eligió."
};

// Nuevas variables integradas desde los Paneles de Configuración
window.BUSINESS_VARIABLES = {
    "negocio": "Nombre de tu empresa o negocio.",
    "asesor": "Nombre del asesor que atiende.",
    "ubicacion": "Dirección o sucursal del negocio.",
    "horario": "Resumen automático de los días y horas de atención configurados."
};

window.createVarRowUI = function(key, value, desc) {
    const container = document.getElementById('customVarsContainer');
    if(!container) return;
    
    const isSystem = window.SYSTEM_VARIABLES.hasOwnProperty(key);
    const isBusiness = window.BUSINESS_VARIABLES.hasOwnProperty(key);
    
    if (isSystem) desc = window.SYSTEM_VARIABLES[key];
    if (isBusiness) desc = window.BUSINESS_VARIABLES[key];
    
    const div = document.createElement('div');
    div.className = 'var-row mb-15';
    div.style = 'background: var(--bg-secondary); border-radius: 8px; border: 1px solid var(--border-glass); padding: 15px; position: relative;';
    
    // Configurar la etiqueta (Badge) y botón de eliminar
    let badgeHtml = `<button onclick="this.parentElement.parentElement.remove(); saveSettings()" style="background:transparent; border:none; color:var(--danger); font-size:1.2rem; cursor:pointer;" title="Eliminar variable"><i class="fas fa-trash"></i></button>`;
    if (isSystem) badgeHtml = '<span style="background: rgba(59, 130, 246, 0.15); color: #3b82f6; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: bold;"><i class="fas fa-robot"></i> Sistema</span>';
    if (isBusiness) badgeHtml = '<span style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; padding: 4px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: bold;"><i class="fas fa-store"></i> Negocio</span>';

    // Configurar el campo de Valor
    let valHtml = '';
    if (isSystem) {
        valHtml = `<div style="display:flex; align-items:center; gap:8px; margin-top:5px;"><i class="fas fa-magic text-primary" style="opacity: 0.7;"></i><p style="font-size: 0.85rem; color: var(--text-muted); margin: 0; line-height:1.3;">El bot reemplazará <b>{{${key}}}</b> automáticamente.</p></div>`;
    } else if (isBusiness) {
        let hintText = key === 'horario' ? '(Ve a Horarios de Atención para editarlo)' : '(Ve a Información del Negocio para editarlo)';
        valHtml = `<label class="input-label" style="font-size: 0.8rem;">Valor actual ${hintText}</label><input type="text" class="var-val full-width" value="${value}" readonly style="background: rgba(0,0,0,0.4); border: 1px dashed var(--border-glass); padding: 10px; border-radius: 6px; color: var(--text-muted); cursor:not-allowed;">`;
    } else {
        valHtml = `<label class="input-label" style="font-size: 0.8rem;">Valor de la variable</label><input type="text" class="var-val full-width" value="${value}" placeholder="Ej: ¡Hola! Buen día" style="background: var(--bg-main); border: 1px solid var(--primary); padding: 10px; border-radius: 6px; color: var(--text-main); font-weight: 500;" onchange="saveSettings()">`;
    }

    div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
            <span style="font-weight:bold; color:var(--primary); font-size: 1.1rem; user-select: all;">{{${key}}}</span>
            ${badgeHtml}
        </div>
        <input type="hidden" class="var-key" value="${key}">
        <label class="input-label" style="font-size: 0.8rem;">¿Para qué sirve?</label>
        <input type="text" class="var-desc full-width" style="margin-bottom: 12px; background: rgba(0,0,0,0.2); border: 1px solid var(--border-glass); padding: 10px; border-radius: 6px; color: var(--text-main);" value="${desc}" ${ (isSystem || isBusiness) ? 'readonly' : 'placeholder="Ej: Se usa para el final del chat" onchange="saveSettings()"'} >
        ${valHtml}
    `;
    container.appendChild(div);
}

window.addCustomVarRow = function() {
    let key = prompt("Nombre de la nueva variable\n(Ejemplo: precio_moto, descuento, despedida):");
    if(!key) return;
    
    const cleanKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if(!cleanKey) return showToast("❌ Nombre inválido. Usa solo letras y números.");
    if(window.SYSTEM_VARIABLES.hasOwnProperty(cleanKey)) return showToast("⚠️ Esa es una variable reservada por el sistema.");
    if(window.BUSINESS_VARIABLES.hasOwnProperty(cleanKey)) return showToast("⚠️ Esa variable se configura desde los paneles de ajustes.");
    
    const existing = document.querySelectorAll('.var-key');
    for(let el of existing) { if(el.value === cleanKey) return showToast("⚠️ Esa variable ya existe."); }

    createVarRowUI(cleanKey, "", "Variable personalizada");
    saveSettings();
    showToast("✅ Variable creada");
}

export function loadCustomVarsFromMemory(settings) {
    const container = document.getElementById('customVarsContainer');
    if(!container) return;
    container.innerHTML = '';
    
    let vars = settings.customVars || {};

    // Repoblar inputs en la pestaña "Información del Negocio"
    if (document.getElementById('bizNameInput')) document.getElementById('bizNameInput').value = vars['negocio']?.value || '';
    if (document.getElementById('bizAdvisorInput')) document.getElementById('bizAdvisorInput').value = vars['asesor']?.value || '';
    if (document.getElementById('bizAddressInput')) document.getElementById('bizAddressInput').value = vars['ubicacion']?.value || '';

    // 1. Cargar las Variables de Sistema
    for (const [sysKey, sysDesc] of Object.entries(window.SYSTEM_VARIABLES)) {
        createVarRowUI(sysKey, "", sysDesc);
    }
    // 2. Cargar las Variables del Negocio
    for (const [bizKey, bizDesc] of Object.entries(window.BUSINESS_VARIABLES)) {
        createVarRowUI(bizKey, vars[bizKey]?.value || "", bizDesc);
    }
    // 3. Cargar las Variables Personalizadas
    for(const [key, data] of Object.entries(vars)) {
        if (!window.SYSTEM_VARIABLES.hasOwnProperty(key) && !window.BUSINESS_VARIABLES.hasOwnProperty(key)) {
            createVarRowUI(key, data.value, data.desc);
        }
    }
}

// --- LÓGICA DEL NUEVO MODAL DE HORARIOS ---

window.openScheduleModal = function(dayId, dayName) {
    document.getElementById('currentEditDay').value = dayId;
    document.getElementById('scheduleModalTitle').innerHTML = `<i class="far fa-calendar-alt text-primary"></i> Configurar ${dayName}`;
    
    document.getElementById('modalSchStart').value = document.getElementById('schStart' + dayId).value || '09:00';
    document.getElementById('modalSchEnd').value = document.getElementById('schEnd' + dayId).value || '18:00';
    document.getElementById('modalSchMsg').value = document.getElementById('schMsg' + dayId).value || '';
    
    document.getElementById('scheduleModal').classList.add('active');
}

window.closeScheduleModal = function() {
    document.getElementById('scheduleModal').classList.remove('active');
}

// Horario de Lunes pendiente de replicar, a la espera de confirmación.
let pendingCloneSchedule = null;

function applyDaySchedule(dayId, start, end, msg) {
    document.getElementById('schStart' + dayId).value = start;
    document.getElementById('schEnd' + dayId).value = end;
    document.getElementById('schMsg' + dayId).value = msg;
    window.updateDaySummary(dayId);
}

window.saveDaySchedule = function() {
    const dayId = parseInt(document.getElementById('currentEditDay').value);
    const start = document.getElementById('modalSchStart').value;
    const end = document.getElementById('modalSchEnd').value;
    const msg = document.getElementById('modalSchMsg').value;

    applyDaySchedule(dayId, start, end, msg);
    closeScheduleModal();

    // Lunes replicaba su horario a toda la semana sin preguntar y sin
    // avisar, borrando lo que tuvieran los demás días. Ahora se pregunta.
    if (dayId === 1) {
        pendingCloneSchedule = { start, end, msg };
        document.getElementById('cloneScheduleModal').classList.add('active');
        return;
    }

    saveSettings();
};

window.confirmCloneSchedule = function(replicate) {
    document.getElementById('cloneScheduleModal').classList.remove('active');
    if (replicate && pendingCloneSchedule) {
        const { start, end, msg } = pendingCloneSchedule;
        [2, 3, 4, 5, 6, 0].forEach(d => {
            document.getElementById('schStart' + d).value = start;
            document.getElementById('schEnd' + d).value = end;
            if (msg) document.getElementById('schMsg' + d).value = msg;
            window.updateDaySummary(d);
        });
        showToast("📅 Horario de Lunes replicado a toda la semana");
    }
    pendingCloneSchedule = null;
    saveSettings();
}

window.updateDaySummary = function(dayId) {
    const start = document.getElementById('schStart' + dayId).value;
    const end = document.getElementById('schEnd' + dayId).value;
    const msg = document.getElementById('schMsg' + dayId).value;
    const summary = document.getElementById('daySummary' + dayId);
    
    if(summary) {
        let texto = `${start} - ${end}`;
        if(msg) texto += ` <span style="color:var(--primary); font-size:0.75rem; margin-left:5px;"><i class="fas fa-comment-dots"></i></span>`;
        summary.innerHTML = texto;
    }
}

window.toggleDayColor = function(dayId, checkboxElement) {
    const nameEl = document.getElementById('dayName' + dayId);
    const summaryEl = document.getElementById('daySummary' + dayId);
    if (nameEl) {
        if (checkboxElement.checked) {
            nameEl.style.color = '';
            if(summaryEl) summaryEl.style.opacity = '0.7';
        } else {
            nameEl.style.color = '#ef4444'; 
            if(summaryEl) summaryEl.style.opacity = '0.3';
        }
    }
}

// --- RESTO DEL CÓDIGO ---

export function toggleDarkMode(isDark) {
    const dmText = document.getElementById('darkModeStatusText');
    if (isDark) {
        document.body.setAttribute('data-theme', 'dark');
        localStorage.setItem('darkMode', 'true');
        if(dmText) dmText.innerText = "Encendido";
    } else {
        document.body.removeAttribute('data-theme');
        localStorage.setItem('darkMode', 'false');
        if(dmText) dmText.innerText = "Apagado";
    }
}

export async function saveTimezone() {
    const tzEl = document.getElementById('botTimezone');
    if (!tzEl) return;
    const tz = tzEl.value;
    try {
        const res = await fetch(`${API_BASE}/api/settings`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ timezone: tz }) });
        if (!res.ok) throw new Error("Fallo al actualizar zona horaria");
        showToast('✅ Zona horaria actualizada');
    } catch(e) { console.error("Error en saveTimezone:", e); showToast('❌ Error al guardar'); }
}

export function stopPreviewTimezone() {
    if (tzPreviewInterval) { clearInterval(tzPreviewInterval); tzPreviewInterval = null; }
}

// El reloj de la zona horaria solo corre con la vista de Ajustes abierta:
// se arranca al entrar y se para al salir, en vez de reescribir el DOM cada
// segundo durante toda la sesión (antes el intervalo no se limpiaba nunca).
let tzPreviewObserver = null;
function watchSettingsView() {
    if (typeof MutationObserver === 'undefined') return;
    const view = document.getElementById('view-config');
    if (!view || tzPreviewObserver) return;
    tzPreviewObserver = new MutationObserver(() => {
        if (view.classList.contains('active')) previewTimezone();
        else stopPreviewTimezone();
    });
    tzPreviewObserver.observe(view, { attributes: true, attributeFilter: ['class'] });
}

export function previewTimezone() {
    const tzEl = document.getElementById('botTimezone');
    const previewEl = document.getElementById('tzPreview');
    if(!previewEl || !tzEl) return;
    const tz = tzEl.value;

    if(tzPreviewInterval) clearInterval(tzPreviewInterval);

    const updateClock = () => {
        if (!document.contains(previewEl)) { stopPreviewTimezone(); return; }
        try {
            const now = new Date();
            const formatted = new Intl.DateTimeFormat('es-MX', {
                timeZone: tz,
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
            }).format(now);
            const finalStr = formatted.charAt(0).toUpperCase() + formatted.slice(1);
            previewEl.innerHTML = `<i class="far fa-clock"></i> ${finalStr}`;
        } catch(e) { previewEl.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Zona horaria no soportada'; }
    };
    updateClock();
    // Solo se deja el intervalo corriendo si la vista de Ajustes está
    // visible; si no, el observador lo arranca al entrar a Ajustes.
    const settingsView = document.getElementById('view-config');
    if (!settingsView || settingsView.classList.contains('active')) {
        tzPreviewInterval = setInterval(updateClock, 1000);
    } else {
        tzPreviewInterval = null;
    }
    watchSettingsView();
}

export function loadGlobalErrorsFromMemory(settings) {
    if (!settings || !settings.globalErrors) return;
    try {
        const ge = settings.globalErrors;
        const activeSwitch = document.getElementById('errActiveSwitch');
        if (activeSwitch) activeSwitch.checked = ge.active !== false; 

        if (ge.menu) {
            document.getElementById('menuErrTries').value = ge.menu.tries || '3';
            document.getElementById('menuErrFallback').value = ge.menu.fallback || '';
            document.getElementById('globErrMsgMenu1').value = ge.menu.err1 || '';
            document.getElementById('globErrMsgMenu2').value = ge.menu.err2 || '';
            document.getElementById('globErrMsgMenu3').value = ge.menu.err3 || '';
        }
        if (ge.name) {
            document.getElementById('nameErrTries').value = ge.name.tries || '3';
            document.getElementById('nameErrFallback').value = ge.name.fallback || '';
            document.getElementById('globErrMsgName1').value = ge.name.err1 || '';
            document.getElementById('globErrMsgName2').value = ge.name.err2 || '';
            document.getElementById('globErrMsgName3').value = ge.name.err3 || '';
        }
        if (ge.date) {
            document.getElementById('dateErrTries').value = ge.date.tries || '3';
            document.getElementById('dateErrFallback').value = ge.date.fallback || '';
            document.getElementById('globErrMsgDate1').value = ge.date.err1 || '';
            document.getElementById('globErrMsgDate2').value = ge.date.err2 || '';
            document.getElementById('globErrMsgDate3').value = ge.date.err3 || '';
        }
        if (ge.media) {
            document.getElementById('globErrAudio').value = ge.media.audio || '';
            document.getElementById('globErrImage').value = ge.media.image || '';
        }
    } catch (e) { console.error("No se pudieron cargar los errores globales", e); }
}

export async function saveGlobalErrors() {
    try {
        const globalErrors = {
            active: document.getElementById('errActiveSwitch').checked,
            menu: {
                tries: parseInt(document.getElementById('menuErrTries').value) || 3,
                fallback: document.getElementById('menuErrFallback').value.trim().toUpperCase(),
                err1: document.getElementById('globErrMsgMenu1').value.trim(),
                err2: document.getElementById('globErrMsgMenu2').value.trim(),
                err3: document.getElementById('globErrMsgMenu3').value.trim()
            },
            name: {
                tries: parseInt(document.getElementById('nameErrTries').value) || 3,
                fallback: document.getElementById('nameErrFallback').value.trim().toUpperCase(),
                err1: document.getElementById('globErrMsgName1').value.trim(),
                err2: document.getElementById('globErrMsgName2').value.trim(),
                err3: document.getElementById('globErrMsgName3').value.trim()
            },
            date: {
                tries: parseInt(document.getElementById('dateErrTries').value) || 3,
                fallback: document.getElementById('dateErrFallback').value.trim().toUpperCase(),
                err1: document.getElementById('globErrMsgDate1').value.trim(),
                err2: document.getElementById('globErrMsgDate2').value.trim(),
                err3: document.getElementById('globErrMsgDate3').value.trim()
            },
            media: {
                audio: document.getElementById('globErrAudio').value.trim(),
                image: document.getElementById('globErrImage').value.trim()
            }
        };

        const response = await fetch(`${API_BASE}/api/settings`, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ globalErrors: globalErrors }) });
        if (!response.ok) throw new Error("Error del servidor al guardar Errores");
        showToast('💾 Errores guardados'); 
    } catch (e) { console.error("Error guardando Errores Globales:", e); showToast('❌ Error interno al guardar'); }
}

export function switchErrTab(tab) {
    ['menu', 'name', 'date', 'media'].forEach(t => {
        const btn = document.getElementById('tabErrBtn-' + t);
        const content = document.getElementById('tabErrContent-' + t);
        if(btn) btn.classList.remove('active');
        if(content) content.style.display = 'none';
    });
    const activeBtn = document.getElementById('tabErrBtn-' + tab);
    const activeContent = document.getElementById('tabErrContent-' + tab);
    if(activeBtn) activeBtn.classList.add('active');
    if(activeContent) activeContent.style.display = 'block';
}

// --- SISTEMA DE NAVEGACIÓN DE CONFIGURACIÓN TIPO NATIVO ---

let currentActivePanel = 'settingsMenu';

window.openSettingsPanel = function(panelId, title) {
    const mainPanel = document.getElementById('settingsMenu');
    const targetPanel = document.getElementById(panelId);
    const backBtn = document.getElementById('settingsBackBtn');
    const titleText = document.getElementById('settingsMainTitle');

    if (!mainPanel || !targetPanel) return;

    // Deslizar el menú principal a la izquierda
    mainPanel.style.transform = 'translateX(-100%)';
    
    // Deslizar el nuevo panel hacia la vista central
    targetPanel.style.transform = 'translateX(-100%)';
    
    // Actualizar el Header
    if (backBtn) backBtn.style.display = 'block';
    if (titleText) titleText.innerText = title;

    currentActivePanel = panelId;
}

window.closeSettingsPanel = function() {
    const mainPanel = document.getElementById('settingsMenu');
    const activePanel = document.getElementById(currentActivePanel);
    const backBtn = document.getElementById('settingsBackBtn');
    const titleText = document.getElementById('settingsMainTitle');

    if (!mainPanel || !activePanel) return;

    // Regresar el panel activo a la derecha
    activePanel.style.transform = 'translateX(0)';
    
    // Regresar el menú principal al centro
    mainPanel.style.transform = 'translateX(0)';
    
    // Restaurar el Header
    if (backBtn) backBtn.style.display = 'none';
    if (titleText) titleText.innerText = 'Configuración';

    currentActivePanel = 'settingsMenu';
}

// --- Respaldo y Restauración (Ajustes → panel-respaldo) ---
// La descarga y la subida van a /api/backup/*; el token se añade solo
// por el envoltorio de fetch en api.js. Tras restaurar, se recarga la
// página para que el panel lea los datos restaurados.
function setBackupStatus(msg, kind) {
    const el = document.getElementById('backupStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'backup-status' + (kind ? ' ' + kind : '');
}
window.downloadBackup = async function() {
    setBackupStatus('Creando respaldo…');
    try {
        const res = await fetch('/api/backup/download', { cache: 'no-store' });
        if (!res.ok) throw new Error('El servidor no pudo crear el respaldo.');
        const blob = await res.blob();
        let name = 'autoimpulso-respaldo.crmbackup';
        const cd = res.headers.get('Content-Disposition') || '';
        const m = cd.match(/filename="?([^";]+)"?/);
        if (m) name = m[1];
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        setBackupStatus('Respaldo descargado: ' + name, 'ok');
        showToast('Respaldo descargado');
    } catch (e) {
        console.error('[Respaldo] Error al descargar:', e);
        setBackupStatus('No se pudo descargar el respaldo.', 'err');
        showToast('No se pudo descargar el respaldo');
    }
};
window.restoreBackup = async function(input) {
    const file = input && input.files && input.files[0];
    if (input) input.value = '';
    if (!file) return;
    setBackupStatus('Cargando respaldo…');
    try {
        const form = new FormData();
        form.append('backup', file);
        const res = await fetch('/api/backup/restore', { method: 'POST', body: form });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'Respaldo inválido.');
        setBackupStatus(`Respaldo cargado: ${data.restored} archivo(s). Recargando…`, 'ok');
        showToast('Respaldo cargado');
        setTimeout(() => location.reload(), 1500);
    } catch (e) {
        console.error('[Respaldo] Error al cargar:', e);
        setBackupStatus(e.message || 'No se pudo cargar el respaldo.', 'err');
        showToast('No se pudo cargar el respaldo');
    }
};

document.addEventListener('DOMContentLoaded', async () => {
    // 1. Cargar Modo Oscuro
    if (localStorage.getItem('darkMode') === 'true' || localStorage.getItem('theme') === 'dark') {
        const dmSwitch = document.getElementById('darkModeSwitch');
        if (dmSwitch) dmSwitch.checked = true;
        document.body.setAttribute('data-theme', 'dark');
        // Sin clase .dark-mode: el tema va solo por data-theme, que es lo que usa styles.css.
        const dmText = document.getElementById('darkModeStatusText');
        if (dmText) dmText.innerText = "Encendido";
    }

    // 2. Extraer configuraciones y repoblar la UI
    try {
        const res = await fetch(`${API_BASE}/api/settings`);
        const data = await res.json();
        const dataFinal = data.settings ? data.settings : data;
        
        if(dataFinal) {
            loadCustomVarsFromMemory(dataFinal);
            loadScheduleFromMemory(dataFinal); 
        }
    } catch(e) { 
        console.error("No se pudo pre-cargar settings", e); 
    }
});

// Exposiciones globales
window.saveSettings = saveSettings;
window.toggleDarkMode = toggleDarkMode;
window.saveTimezone = saveTimezone;
window.previewTimezone = previewTimezone;
window.saveGlobalErrors = saveGlobalErrors;
window.switchErrTab = switchErrTab;