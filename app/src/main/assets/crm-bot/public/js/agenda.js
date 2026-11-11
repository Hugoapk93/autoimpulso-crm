import * as API from './api.js';
import { showToast, pushNavigationLayer, escapeHTML } from './utils.js';

let currentRefDate = new Date();
let apptToDelete = null;

// Helper para calcular el número de semana
function getWeekNumber(date, startDay) {
    const d = new Date(date.getTime());
    if (startDay === 1) { // Inicio en Lunes (ISO 8601)
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay()||7));
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(),0,1));
        return Math.ceil((((d - yearStart) / 86400000) + 1)/7);
    } else { // Inicio en Domingo (US Standard)
        const firstDayOfYear = new Date(d.getFullYear(), 0, 1);
        const pastDaysOfYear = (d - firstDayOfYear) / 86400000;
        return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
    }
}

export function toggleCalendarSettings() {
    const panel = document.getElementById('calendarSettingsPanel');
    if (!panel) return;
    panel.style.display = panel.style.display === 'none' || panel.style.display === '' ? 'block' : 'none';
}

export function updateCalendarConfig() {
    const startDay = document.getElementById('calStartDay').value;
    const showWeekNum = document.getElementById('calWeekNumbers').checked;
    
    // Guardamos en el navegador para que recuerde tus preferencias
    localStorage.setItem('calStartDay', startDay);
    localStorage.setItem('calWeekNumbers', showWeekNum);
    
    renderCalendar();
}

export async function renderCalendar() {
    const now = currentRefDate, m = now.getMonth(), y = now.getFullYear();
    document.getElementById('monthDisplay').innerText = `${["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"][m]} ${y}`;
    
    const headerEl = document.getElementById('calendarDaysHeader');
    const gridEl = document.getElementById('calendarDays');

    // Recuperar preferencias
    const startDayPref = parseInt(localStorage.getItem('calStartDay') || '0');
    const showWeekNumbers = localStorage.getItem('calWeekNumbers') === 'true';

    // Sincronizar la UI con las preferencias por si se carga la página fresca
    const selectStart = document.getElementById('calStartDay');
    const checkWeek = document.getElementById('calWeekNumbers');
    if(selectStart) selectStart.value = startDayPref;
    if(checkWeek) checkWeek.checked = showWeekNumbers;

    // 1. Dibujar Cabeceras (Días de la semana) y ajustar Grid
    const daysArr = startDayPref === 1 ? ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'] : ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    let headerHtml = showWeekNumbers ? '<div style="text-align:center; color:var(--primary); font-size:0.85rem; padding: 5px 0;">#</div>' : '';
    daysArr.forEach(d => { 
        headerHtml += `<div style="text-align:center; padding: 5px 0;">${d}</div>`; 
    });
    
    if (headerEl) {
        headerEl.innerHTML = headerHtml;
        headerEl.style.gridTemplateColumns = showWeekNumbers ? '32px repeat(7, 1fr)' : 'repeat(7, 1fr)';
    }
    if (gridEl) {
        gridEl.style.gridTemplateColumns = showWeekNumbers ? '32px repeat(7, 1fr)' : 'repeat(7, 1fr)';
    }

    // 2. Obtener citas del servidor
    let appts = {};
    try { 
        const res = await fetch('/api/agenda');
        if (res.ok) appts = await res.json();
    } catch(e) {
        console.error("Error en renderCalendar (fetch agenda):", e);
    }

    // 3. Calcular rellenado y días
    const firstDayIndex = new Date(y, m, 1).getDay();
    let padding = startDayPref === 1 ? (firstDayIndex === 0 ? 6 : firstDayIndex - 1) : firstDayIndex;
    const daysInMonth = new Date(y, m+1, 0).getDate();
    const totalCells = Math.ceil((padding + daysInMonth) / 7) * 7;

    // 4. Dibujar Calendario
    let htmlBuffer = ''; 
    for(let i = 0; i < totalCells; i++) {
        // Al inicio de cada fila (semana), inyectar el número de semana si está activo
        if (i % 7 === 0 && showWeekNumbers) {
            let dayToMeasure = i - padding + 1;
            if (dayToMeasure < 1) dayToMeasure = 1;
            if (dayToMeasure > daysInMonth) dayToMeasure = daysInMonth;
            
            const dMeasure = new Date(y, m, dayToMeasure);
            const weekNum = getWeekNumber(dMeasure, startDayPref);
            
            htmlBuffer += `<div style="display:flex; align-items:center; justify-content:center; font-size:0.65rem; color:var(--primary); font-weight:bold; background: rgba(168, 85, 247, 0.08); border-radius:6px; opacity:0.8; height: 100%;">S${weekNum}</div>`;
        }

        const currentDay = i - padding + 1;
        if (currentDay > 0 && currentDay <= daysInMonth) {
            const k = `${y}-${(m+1).toString().padStart(2,'0')}-${currentDay.toString().padStart(2,'0')}`;
            const count = (appts[k]||[]).length;
            const isToday = new Date().toDateString() === new Date(y,m,currentDay).toDateString();
            htmlBuffer += `<div class="day ${isToday?'today':''}" onclick="openDayModal('${k}')">${currentDay} ${count?`<span class="day-indicator">${count}</span>`:''}</div>`;
        } else {
            // Celdas vacías (padding)
            htmlBuffer += `<div></div>`;
        }
    }
    
    if (gridEl) {
        gridEl.innerHTML = htmlBuffer; 
    }
}

export function changeMonth(d) { 
    currentRefDate.setMonth(currentRefDate.getMonth()+d); 
    renderCalendar(); 
}

export async function openDayModal(date) {
    pushNavigationLayer();
    document.getElementById('modalDateTitle').innerText = date;
    const list = document.getElementById('modalApptList');
    list.innerHTML = 'Cargando...';
    document.getElementById('evtOldTime').dataset.date = date;
    document.getElementById('dayModal').classList.add('active');

    try {
        const res = await fetch('/api/agenda');
        if (!res.ok) throw new Error("Respuesta no OK del servidor");
        
        const all = await res.json();
        const appts = all[date] || [];
        let htmlBuffer = appts.length ? '' : '<div style="text-align:center; padding:20px; color:#666;">Sin citas</div>';

        appts.sort((a,b)=>a.time.localeCompare(b.time)).forEach(c => {
            htmlBuffer += `
            <div style="background:var(--bg-input); padding:10px; margin-bottom:5px; border-radius:8px; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <b>${escapeHTML(c.time)}</b> ${escapeHTML(c.name)} <br>
                    <small style="color:var(--text-muted);">${escapeHTML(c.phone)}</small>
                </div>
                <button class="appt-del-btn" data-date="${escapeHTML(date)}" data-time="${escapeHTML(c.time)}" style="color:var(--danger); background:none; border:none; cursor:pointer; padding:5px;">
                    <i class="fas fa-trash"></i>
                </button>
            </div>`;
        });
        list.innerHTML = htmlBuffer;
        list.querySelectorAll('.appt-del-btn').forEach(btn => {
            btn.addEventListener('click', () => askDeleteAppt(btn.dataset.date, btn.dataset.time));
        });
    } catch (e) {
        console.error("Error en openDayModal:", e);
        list.innerHTML = '<div style="text-align:center; padding:20px; color:var(--danger);">Error al cargar las citas</div>';
    }
}

export function askDeleteAppt(date, time) {
    apptToDelete = { date, time };
    document.getElementById('delApptTimeLbl').innerText = time;
    document.getElementById('deleteApptModal').classList.add('active');
}

export async function executeDeleteAppt() {
    if(!apptToDelete) return;
    
    try {
        const res = await fetch('/api/agenda/delete', { 
            method:'POST', 
            headers:{'Content-Type':'application/json'}, 
            body:JSON.stringify(apptToDelete) 
        });
        
        if (!res.ok) throw new Error("Fallo al eliminar cita en el servidor");

        let data = {};
        try { data = await res.json(); } catch (e) { /* sin cuerpo JSON */ }

        // El backend devuelve 200 + {success:false} cuando no habia nada que
        // borrar. Antes se mostraba "Cita eliminada" aunque no se borro nada.
        if (data.success === false) {
            const date = apptToDelete.date;
            apptToDelete = null;
            document.getElementById('deleteApptModal').classList.remove('active');
            openDayModal(date);
            renderCalendar();
            showToast('⚠️ Esa cita ya no existía');
            return;
        }

        document.getElementById('deleteApptModal').classList.remove('active');
        openDayModal(apptToDelete.date);
        renderCalendar();
        showToast('🗑️ Cita eliminada');
    } catch (e) {
        console.error("Error en executeDeleteAppt:", e);
        showToast('❌ Error al eliminar la cita');
    }
}

export async function saveEvent() {
    const d = {
        date: document.getElementById('evtOldTime').dataset.date,
        time: document.getElementById('evtTime').value,
        name: document.getElementById('evtName').value,
        phone: document.getElementById('evtPhone').value,
        note: document.getElementById('evtNote').value
    };
    
    if(!d.time || !d.name) {
        showToast("⚠️ Faltan datos obligatorios (Hora y Nombre)");
        return;
    }

    try {
        const res = await fetch('/api/agenda/book', { 
            method:'POST', 
            headers:{'Content-Type':'application/json'}, 
            body:JSON.stringify(d) 
        });
        
        let data = {};
        try { data = await res.json(); } catch (e) { /* sin cuerpo JSON */ }

        // El backend devuelve 200 + {success:false, message} cuando el hueco
        // esta ocupado, la fecha ya paso o esta fuera de horario. Antes solo
        // se miraba res.ok y se mostraba exito aunque no se guardo nada.
        // En ese caso el formulario se queda abierto y con los datos.
        if (!res.ok || data.success === false) {
            const msg = data.message || data.error || 'Fallo al guardar cita en el servidor';
            showToast('❌ ' + escapeHTML(msg));
            return;
        }

        document.getElementById('eventForm').style.display='none';
        document.getElementById('btnAddEvent').style.display='block';
        
        // Limpiar el formulario
        document.getElementById('evtTime').value = '';
        document.getElementById('evtName').value = '';
        document.getElementById('evtPhone').value = '';
        document.getElementById('evtNote').value = '';

        openDayModal(d.date);
        renderCalendar();
        showToast('✅ Cita agendada con éxito');
    } catch (e) {
        console.error("Error en saveEvent:", e);
        showToast('❌ Error al agendar la cita');
    }
}

export function toggleSchedulerUI() {
    const isActive = document.getElementById('schActive').checked;
    const configDiv = document.getElementById('schedulerConfig');
    const statusText = document.getElementById('schedStatusText');

    if (isActive) {
        configDiv.style.display = 'block';
        statusText.innerText = 'Activado · Se ejecutará diariamente';
        statusText.style.color = 'var(--success)';
    } else {
        configDiv.style.display = 'none';
        statusText.innerText = 'Desactivado';
        statusText.style.color = 'var(--text-muted)';
    }
}

export async function loadSchedulerConfig(flowKeys) {
    try {
        const select = document.getElementById('schStepSelect');
        select.innerHTML = '<option value="">-- Selecciona un paso --</option>';
        
        // 1. Poblamos el desplegable con las llaves disponibles
        if (Array.isArray(flowKeys)) {
            flowKeys.sort().forEach(stepKey => {
                const opt = document.createElement('option');
                opt.value = stepKey;
                opt.innerText = stepKey;
                select.appendChild(opt);
            });
        }

        // 2. Recuperamos la configuración desde la BD
        const res = await fetch('/api/settings', { cache: 'no-store' });
        if (res.ok) {
            const settings = await res.json();
            if (settings.scheduler) {
                // Validación robusta por si se guardó como string "true"
                document.getElementById('schActive').checked = settings.scheduler.active === true || String(settings.scheduler.active) === "true";
                document.getElementById('schTime').value = settings.scheduler.time || "09:00";
                
                if (settings.scheduler.target_step) {
                    // 🔥 FIX: Si el paso guardado ya no existe en el flujo actual (porque le cambiaste el nombre),
                    // lo inyectamos visualmente en rojo para que no se pierda la selección en la interfaz y te avise.
                    if (!Array.from(select.options).some(opt => opt.value === settings.scheduler.target_step)) {
                        const opt = document.createElement('option');
                        opt.value = settings.scheduler.target_step;
                        opt.innerText = `${settings.scheduler.target_step} (⚠️ No existe en el flujo)`;
                        opt.style.color = "red";
                        select.appendChild(opt);
                    }
                    select.value = settings.scheduler.target_step;
                }
            }
        }
        toggleSchedulerUI();
    } catch (e) { 
        console.error("Error en loadSchedulerConfig:", e); 
    }
}

export async function saveSchedulerConfig() {
    const active = document.getElementById('schActive').checked;
    const time = document.getElementById('schTime').value;
    const targetStep = document.getElementById('schStepSelect').value;

    if (active && (!time || !targetStep)) {
        showToast("⚠️ Faltan configurar parámetros del recordatorio");
        return;
    }
    
    try {
        // 🔥 FIX: 1. OBTENER CONFIGURACIÓN ACTUAL PRIMERO
        // Esto evita que sobreescribamos la variable 'last_run' y forcemos al bot a duplicar recordatorios.
        const currentRes = await fetch('/api/settings');
        let currentSettings = {};
        if (currentRes.ok) {
            currentSettings = await currentRes.json();
        }

        const existingScheduler = currentSettings.scheduler || {};

        // 2. CONSTRUIR PAYLOAD SEGURO (Fusionando datos)
        const payload = { 
            scheduler: { 
                ...existingScheduler, // Mantiene intacto el last_run y otros metadatos
                active: active, 
                time: time, 
                target_step: targetStep 
            } 
        };

        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) throw new Error("Fallo al guardar config en el servidor");
        showToast("💾 Configuración de recordatorios guardada");
    } catch (e) { 
        console.error("Error en saveSchedulerConfig:", e);
        showToast("❌ Error al guardar la configuración"); 
    }
}

// Exponer al HTML
window.changeMonth = changeMonth;
window.openDayModal = openDayModal;
window.askDeleteAppt = askDeleteAppt;
window.executeDeleteAppt = executeDeleteAppt;
window.saveEvent = saveEvent;
window.toggleSchedulerUI = toggleSchedulerUI;
window.saveSchedulerConfig = saveSchedulerConfig;
window.toggleCalendarSettings = toggleCalendarSettings;
window.updateCalendarConfig = updateCalendarConfig;