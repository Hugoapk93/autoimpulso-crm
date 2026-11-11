import * as API from './api.js';
import { showToast, pushNavigationLayer, escapeHTML, validateImageFile } from './utils.js';

let flow = {};
let users = [];
let flowPath = [];
let isFlowFlatView = false;
let currentMediaList = [];

// Para interpolar texto dentro de un onclick="...('...')" sin que una
// comilla o una barra rompa el handler ni permita inyectar JS.
function escJS(s) {
    return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
// Para una URL dentro de url('...') en CSS: sin comillas ni barras.
function escCssUrl(u) {
    return String(u ?? '').replace(/['"\\]/g, '');
}

export function initFlow(flowData, usersData) {
    flow = flowData;
    users = usersData;
    renderFlowList();
    updateStepsDatalist();
}

export function updateFlowUsers(usersData) {
    users = usersData;
    renderFlowList();
}

export function getLinearFlowSequence() {
    const steps = Object.keys(flow);
    if(steps.length === 0) return [];
    
    let seq = [];
    let curr = 'BIENVENIDA'; 
    if(!flow[curr]) curr = steps[0]; 

    let safety = 0;
    while(curr && flow[curr] && safety < 100) {
        if(!seq.includes(curr)) seq.push(curr);
        let next = flow[curr].next_step;
        if(!next && flow[curr].options && flow[curr].options.length > 0) {
            next = flow[curr].options[0].next_step;
        }
        if(seq.includes(next)) break; 
        curr = next;
        safety++;
    }

    steps.forEach(s => {
        if(!seq.includes(s)) seq.push(s);
    });
    return seq;
}

function updateStepsDatalist() {
    let dl = document.getElementById('stepsList');
    if (!dl) {
        dl = document.createElement('datalist');
        dl.id = 'stepsList';
        document.body.appendChild(dl);
    }
    let opts = '';
    Object.keys(flow).sort().forEach(k => opts += `<option value="${escapeHTML(k)}">`);
    dl.innerHTML = opts;
}

function toggleFlowView() {
    isFlowFlatView = !isFlowFlatView;
    flowPath = [];
    renderFlowList();
}

function renderFlowList() {
    const navContainer = document.getElementById('breadcrumbNav');
    const listContainer = document.getElementById('stepsListContainer');
    const btnToggle = document.getElementById('btnToggleFlowView');
    
    if(!navContainer || !listContainer) return; 

    // 🔥 FIX: Convertimos el contenedor en un Grid Simétrico
    // Esto hará que las tarjetas se acomoden lado a lado y midan exactamente lo mismo de alto
    listContainer.style.display = 'grid';
    listContainer.style.gridTemplateColumns = 'repeat(auto-fill, minmax(280px, 1fr))';
    listContainer.style.gap = '15px';
    listContainer.style.alignItems = 'stretch';

    if (btnToggle) {
        btnToggle.innerHTML = `<i class="fas ${isFlowFlatView ? 'fa-sitemap' : 'fa-list'}"></i> ${isFlowFlatView ? 'Por Niveles' : 'Ver Todos'}`;
    }

    let navHtml = `<div style="display:flex; align-items:center; gap:8px; overflow-x:auto; padding-bottom:2px; flex:1; scrollbar-width: none;">`;
    
    if (isFlowFlatView) {
        navHtml += `<span style="font-weight:bold; color:var(--primary);"><i class="fas fa-layer-group"></i> Vista: Todos los pasos</span>`;
    } else if (flowPath.length > 0) {
        navHtml += `
            <button onclick="jumpToStep(${flowPath.length - 2})" class="admin-btn" style="border-radius:50%; width:32px; height:32px; display:flex; align-items:center; justify-content:center; padding:0; flex-shrink:0; background: var(--bg-input); border: 1px solid var(--border-glass); box-shadow: 0 2px 5px rgba(0,0,0,0.05);">
                <i class="fas fa-arrow-left"></i>
            </button>
            <span onclick="resetFlowNav()" style="cursor:pointer; color: var(--text-muted); font-weight: 500;">Inicio</span>`;
        
        flowPath.forEach((step, index) => {
            const isLast = index === flowPath.length - 1;
            navHtml += `<i class="fas fa-chevron-right" style="font-size:0.7rem; opacity:0.4; color: var(--text-muted);"></i> 
                        <span onclick="${isLast ? '' : `jumpToStep(${index})`}" style="${isLast ? 'font-weight:bold; color:var(--text-main);' : 'cursor:pointer; color: var(--text-muted); font-weight: 500;'}">${escapeHTML(step)}</span>`;
        });
    } else {
        navHtml += `<span style="font-weight:bold; color: var(--text-main);"><i class="fas fa-home"></i> Menú Principal</span>`;
    }
    navHtml += `</div>`;
    navContainer.innerHTML = navHtml;

    let htmlBuffer = '';
    let stepsToShow = [];
    
    if (isFlowFlatView) {
        stepsToShow = Object.keys(flow).sort();
    } else {
        if (flowPath.length === 0) {
            stepsToShow = findFlowRoots(); 
            if(stepsToShow.length === 0 && Object.keys(flow).length > 0) {
                stepsToShow = [Object.keys(flow).sort()[0]];
            }
        } else {
            const currentStep = flowPath[flowPath.length - 1];
            stepsToShow = [currentStep];
        }
    }

    stepsToShow.forEach(k => {
        const step = flow[k];
        if(!step) return;

        let typeClass = 'type-message';
        let icon = '<i class="fas fa-comment-alt"></i>';
        if(step.type === 'menu') { typeClass = 'type-menu'; icon = '<i class="fas fa-list-ul"></i>'; }
        else if(step.type === 'input') { typeClass = 'type-input'; icon = '<i class="fas fa-pen-alt"></i>'; }
        else if(step.type === 'filtro') { typeClass = 'type-filtro'; icon = '<i class="fas fa-user-shield"></i>'; }
        else if(step.type === 'cita') { typeClass = 'type-cita'; icon = '<i class="far fa-calendar-check"></i>'; }
        else if(step.type === 'fin_bot') { typeClass = 'type-fin'; icon = '<i class="fas fa-flag-checkered"></i>'; }
        else if(step.type === 'espera_catalogo') { typeClass = 'type-input'; icon = '<i class="fas fa-stopwatch"></i>'; } 

        const userCount = users.filter(u => u.current_step === k).length;
        const badgeHtml = userCount > 0 ? `<div class="user-badge" style="background: var(--primary-gradient); color: white; padding: 2px 8px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; display:flex; align-items:center; gap:4px; margin-left: auto;"><i class="fas fa-user" style="font-size: 0.7rem;"></i> ${userCount}</div>` : '';

        let chipsHtml = '';
        
        // Estética UI respetando las variables del Tema
        if(step.options && step.options.length > 0) {
            step.options.forEach(opt => {
                chipsHtml += `
                <div class="flow-chip" onclick="event.stopPropagation(); enterStep('${escJS(opt.next_step)}')" style="padding: 10px 14px; border-radius: 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom:0;">
                    <span style="font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHTML(opt.label)}</span> 
                    <i class="fas fa-arrow-right" style="opacity: 0.5; font-size: 0.75rem; flex-shrink: 0;"></i>
                </div>`;
            });
        }
        else if (step.next_step) {
            chipsHtml = `
            <div class="flow-chip" onclick="event.stopPropagation(); enterStep('${escJS(step.next_step)}')" style="padding: 10px 14px; border-radius: 8px; background: rgba(22, 163, 74, 0.1); border: 1px solid rgba(22, 163, 74, 0.2); color: var(--primary); display: flex; align-items: center; justify-content: space-between;">
                <span style="font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">Siguiente: ${escapeHTML(step.next_step)}</span> 
                <i class="fas fa-arrow-right" style="opacity: 0.8; font-size: 0.75rem;"></i>
            </div>`;
        } else {
             chipsHtml = `<div style="text-align:center; padding: 6px; opacity:0.5; font-size:0.85rem; width: 100%; font-weight: 500; letter-spacing: 0.5px;">🏁 FIN DEL FLUJO</div>`;
        }

        const cleanText = escapeHTML((step.message || '').trim()) || '<span style="font-style:italic; opacity:0.5">(Sin texto configurado)</span>';

        // Estructura de Tarjeta Limpia y Flexbox estricto
        htmlBuffer += `
        <div class="flow-step-card ${typeClass}" style="margin-bottom: 0; height: 100%; display: flex; flex-direction: column;">
            
            <div class="card-header" onclick="edit('${escJS(k)}')" style="display: flex; gap: 10px; align-items: center; flex-shrink: 0; border-bottom: 1px solid var(--border-glass);">
                <div style="display: flex; align-items: center; gap: 12px; flex: 1; overflow: hidden;">
                    <span style="font-size: 1.15rem; opacity: 0.85; display: flex; align-items: center; justify-content: center; width: 24px;">${icon}</span>
                    <strong style="font-size: 1.05rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; letter-spacing: 0.3px;">${escapeHTML(k)}</strong>
                    ${badgeHtml}
                </div>
                <i class="fas fa-pen" style="font-size: 0.8rem; opacity: 0.4; flex-shrink: 0;"></i>
            </div>
            
            <div class="card-body" onclick="edit('${escJS(k)}')" style="flex-grow: 1; display: flex; flex-direction: column; gap: 12px; white-space: normal; padding: 15px;">
                <div style="display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-overflow: ellipsis; font-size: 0.95rem;">
                    ${cleanText}
                </div>
                ${step.media && step.media.length > 0 ? `
                    <div class="thumb-row" style="display: flex; gap: 8px; margin-top: auto; overflow-x: auto; padding-bottom: 4px; scrollbar-width: none;">
                        ${step.media.map(u => `<div style="background-image:url('${escCssUrl(u)}'); background-size: cover; background-position: center; width: 45px; height: 45px; border-radius: 8px; border: 1px solid var(--border-glass); flex-shrink: 0;"></div>`).join('')}
                    </div>` : ''}
            </div>

            <div class="card-footer" style="flex-shrink: 0; padding: 12px 15px; display: flex; flex-direction: column; gap: 8px; background: rgba(0,0,0,0.02); border-top: 1px solid var(--border-glass);">
                ${chipsHtml}
            </div>
            
        </div>`;
    });

    listContainer.innerHTML = htmlBuffer;
}

function enterStep(stepId) { flowPath.push(stepId); renderFlowList(); }
function resetFlowNav() { flowPath = []; renderFlowList(); }
function jumpToStep(index) { flowPath = flowPath.slice(0, index + 1); renderFlowList(); }

function getChildrenSteps(parentId) {
    const parent = flow[parentId];
    if (!parent) return [];
    let kids = [];
    if (parent.next_step && flow[parent.next_step]) kids.push(parent.next_step);
    if (parent.options && Array.isArray(parent.options)) {
        parent.options.forEach(opt => {
            if (opt.next_step && flow[opt.next_step] && !kids.includes(opt.next_step)) {
                kids.push(opt.next_step);
            }
        });
    }
    return kids;
}

function findFlowRoots() {
    const allSteps = Object.keys(flow);
    if(allSteps.length === 0) return [];
    const targetedSteps = new Set();
    allSteps.forEach(k => {
        const s = flow[k];
        if (s.next_step) targetedSteps.add(s.next_step);
        if (s.options) s.options.forEach(o => { if(o.next_step) targetedSteps.add(o.next_step); });
    });
    return allSteps.filter(s => !targetedSteps.has(s));
}

function edit(id) {
    const d = flow[id]; 
    const inputId = document.getElementById('stId');
    inputId.value = id; 
    inputId.dataset.oldId = id; 
    document.getElementById('stType').value = d.type;
    document.getElementById('stMsg').value = d.message || '';

    currentMediaList = d.media || [];
    renderGallery(); 
    renderFields(); 

    document.getElementById('editorModal').classList.add('active');
}

function renderGallery() {
    const c = document.getElementById('galleryContainer'); 
    c.innerHTML = '';
    currentMediaList.forEach((u, i) => {
        c.innerHTML += `
        <div class="thumb-wrap">
            <img src="${escapeHTML(u)}">
            <button onclick="removeStepMedia(${i})" class="del-thumb"><i class="fas fa-times"></i></button>
        </div>`;
    });
}

function removeStepMedia(i) {
    currentMediaList.splice(i, 1);
    renderGallery();
}

document.addEventListener("DOMContentLoaded", () => {
    const opt = document.querySelector("#stType option[value='espera_catalogo']");
    if(opt) {
        opt.innerHTML = '&#xf017; Mensaje con Espera';
    }
});

function renderFields() {
    const type = document.getElementById('stType').value;
    const id = document.getElementById('stId').value;
    const d = flow[id] || {};
    const c = document.getElementById('dynFields');
    const wrapMsg = document.getElementById('wrapper-msg');
    
    wrapMsg.style.display = type === 'cita' ? 'none' : 'block'; 

    let html = '';

    if(type === 'menu' || type === 'filtro') {
        html += `<label>Opciones (Botones)</label><div id="optsList">`;
        (d.options||[]).forEach(o => {
            html += `<div style="display:flex; gap:5px; margin-bottom:5px;">
                <input class="o-lbl" value="${escapeHTML(o.label)}" placeholder="Texto Botón">
                <input class="o-nxt" list="stepsList" value="${escapeHTML(o.next_step||'')}" placeholder="Destino" style="font-weight:bold; color:var(--primary);">
                <button onclick="this.parentElement.remove()" style="color:var(--danger); background:none; border:none;">✕</button>
            </div>`;
        });
        html += `</div><button class="admin-btn" onclick="addOptRow()">+ Opción</button>`;
        if(type==='menu') html += `<label style="margin-top:10px">Keywords</label><input id="stKw" value="${escapeHTML((d.keywords||[]).join(', '))}">`;
        if(type==='filtro') html += `<label style="margin-top:10px">Admin Tel</label><input id="stAdm" value="${escapeHTML(d.admin_number||'')}">`;

    } else if (type === 'input') {
        html += `<label>Variable a Guardar</label><input id="stVar" value="${escapeHTML(d.save_var||'')}">`;
        html += `<label>Siguiente Paso Automático</label><input id="stNext" list="stepsList" value="${escapeHTML(d.next_step||'')}" placeholder="Escribe para crear nuevo...">`;

    } else if (type === 'espera_catalogo') {
        html += `
        <div style="background:var(--bg-input); padding:15px; border-radius:8px; border:1px solid var(--border); margin-bottom:15px;">
            <h4 style="margin-top:0; margin-bottom:15px; color:var(--text-main);"><i class="fas fa-stopwatch" style="color:var(--primary);"></i> Configuración de Espera</h4>
            
            <label>Frase EXACTA que debe enviar el cliente para avanzar</label>
            <textarea id="stKwCat" rows="3" class="clean-textarea" placeholder="Ej: Sí, quiero confirmar mi pedido.">${escapeHTML(d.exact_phrase || '')}</textarea>
            
            <label class="mt-15 block">Mensaje de error (Si el cliente escribe otra cosa)</label>
            <textarea id="stErrCat" rows="3" class="clean-textarea" placeholder="⚠️ Por favor, responde con la frase exacta para continuar.">${escapeHTML(d.error_message || '')}</textarea>
        </div>
        <label>Siguiente Paso (Al recibir la frase correcta)</label>
        <input id="stNext" list="stepsList" value="${escapeHTML(d.next_step||'')}">`;

    } else if (type === 'cita') {
        html += `
        <div style="background:var(--bg-input); padding:15px; border-radius:8px; border:1px solid var(--border); margin-bottom:15px;">
            <h4 style="margin-top:0; margin-bottom:15px; color:var(--text-main);"><i class="far fa-calendar-alt" style="color:var(--primary);"></i> Configuración del Agendador</h4>
            <label>Pregunta para el Día</label>
            <input type="text" id="stCitaDate" value="${escapeHTML(d.msg_date || '¿Qué día te gustaría agendar?')}">
            <label>Pregunta para la Hora</label>
            <input type="text" id="stCitaTime" value="${escapeHTML(d.msg_time || '¿A qué hora te queda mejor?')}">
            <label>Duración de cada turno</label>
            <select id="stCitaInterval" style="margin-bottom:0;">
                <option value="15" ${d.interval == '15' ? 'selected' : ''}>Cada 15 minutos</option>
                <option value="30" ${d.interval == '30' || !d.interval ? 'selected' : ''}>Cada 30 minutos</option>
                <option value="60" ${d.interval == '60' ? 'selected' : ''}>Cada 1 hora</option>
                <option value="1440" ${d.interval == '1440' ? 'selected' : ''}>Todo el día</option>
            </select>
        </div>
        <label>Siguiente Paso (Al terminar de agendar)</label>
        <input id="stNext" list="stepsList" value="${escapeHTML(d.next_step||'')}">`;

    } else {
        html += `<label>Siguiente Paso Automático</label><input id="stNext" list="stepsList" value="${escapeHTML(d.next_step||'')}">`;
    }
    c.innerHTML = html;
}

function addOptRow() { 
    document.getElementById('optsList').insertAdjacentHTML('beforeend', 
        `<div style="display:flex; gap:5px; margin-bottom:5px;">
            <input class="o-lbl" placeholder="Botón">
            <input class="o-nxt" list="stepsList" placeholder="Destino (Nuevo)">
            <button onclick="this.parentElement.remove()" style="color:var(--danger); background:none; border:none;">✕</button>
        </div>`
    ); 
}

function normalizeStepId(id) {
    if (!id) return '';
    return String(id)
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^A-Z0-9_]/g, '');
}

function createNewStepPrompt() {
    pushNavigationLayer();
    document.getElementById('newStepNameInput').value = '';
    document.getElementById('stepNameModal').classList.add('active');
    setTimeout(() => document.getElementById('newStepNameInput').focus(), 100);
}

function confirmCreateStep() {
    const n = normalizeStepId(document.getElementById('newStepNameInput').value);
    
    if(!n) {
        showToast("⚠️ El nombre del paso es requerido");
        return;
    }
    if(flow[n]) {
        showToast("⚠️ Ya existe un paso con ese nombre");
        return;
    }
    
    document.getElementById('newStepNameInput').value = n;
    flow[n] = {type:'message'};
    renderFlowList();
    updateStepsDatalist(); 
    
    document.getElementById('stepNameModal').classList.remove('active');
    edit(n);
}

async function saveStep() {
    const inputId = document.getElementById('stId');
    const oldId = inputId.dataset.oldId || inputId.value; 
    const newId = normalizeStepId(inputId.value);         

    if (!newId) {
        showToast("⚠️ El nombre del paso no puede estar vacío");
        return;
    }
    if (oldId !== newId && flow[newId]) {
        showToast("⚠️ Ya existe una tarjeta con el nombre: " + newId);
        return;
    }

    const type = document.getElementById('stType').value;
    const data = { 
        type, 
        message: document.getElementById('stMsg').value, 
        media: currentMediaList 
    };

    let stepsToCreate = [];

    if(document.getElementById('stNext')) {
        const val = normalizeStepId(document.getElementById('stNext').value); 
        if(val) {
            data.next_step = val;
            if(!flow[val] && val !== newId) stepsToCreate.push(val);
        }
    }

    if(document.getElementById('optsList')) {
        data.options = [];
        document.querySelectorAll('#optsList div').forEach(row => {
            const l = row.querySelector('.o-lbl').value;
            const n = normalizeStepId(row.querySelector('.o-nxt').value); 
            if(l && n) {
                data.options.push({label:l, trigger:l, next_step:n});
                if(!flow[n] && n !== newId) stepsToCreate.push(n);
            }
        });
    }

    if(document.getElementById('stVar')) data.save_var = document.getElementById('stVar').value;
    if(document.getElementById('stKw')) data.keywords = document.getElementById('stKw').value.split(',').map(s=>s.trim());
    if(document.getElementById('stAdm')) data.admin_number = document.getElementById('stAdm').value;

    if (type === 'cita') {
        data.msg_date = document.getElementById('stCitaDate') ? document.getElementById('stCitaDate').value : '';
        data.msg_time = document.getElementById('stCitaTime') ? document.getElementById('stCitaTime').value : '';
        data.interval = document.getElementById('stCitaInterval') ? document.getElementById('stCitaInterval').value : '30';
    }

    if (type === 'espera_catalogo') {
        data.exact_phrase = document.getElementById('stKwCat') ? document.getElementById('stKwCat').value.trim() : '';
        data.error_message = document.getElementById('stErrCat') ? document.getElementById('stErrCat').value.trim() : '';
    }

    try {
        if(stepsToCreate.length > 0) {
            stepsToCreate = [...new Set(stepsToCreate)];
            for (const newStepName of stepsToCreate) {
                if(!flow[newStepName]) {
                    const placeholderData = { type: 'message', message: '🚧 Paso creado automáticamente. Edítame.' };
                    await API.saveFlowStep(newStepName, placeholderData);
                    flow[newStepName] = placeholderData;
                }
            }
        }

        let affectedSteps = [];
        if (oldId !== newId) {
            for (const key in flow) {
                let changed = false;
                const step = flow[key];

                if (step.next_step === oldId) { step.next_step = newId; changed = true; }
                if (step.fallback_step === oldId) { step.fallback_step = newId; changed = true; }
                if (step.options) {
                    step.options.forEach(opt => {
                        if (opt.next_step === oldId) { opt.next_step = newId; changed = true; }
                    });
                }
                if (changed && key !== oldId) affectedSteps.push(key);
            }

            let usersToUpdate = false;
            users.forEach(u => {
                if (u.current_step === oldId) {
                    u.current_step = newId; 
                    usersToUpdate = true;
                    
                    const phoneToUpdate = u.realDbPhone || u.phone;
                    fetch('/api/contacts/update', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone: phoneToUpdate, current_step: newId })
                    }).catch(() => {});
                }
            });

            if (usersToUpdate && typeof window.debounceFilterChats === 'function') {
                const searchBox = document.querySelector('#waHeaderSearch input');
                window.debounceFilterChats(searchBox ? searchBox.value : '');
            }
        }

        await API.saveFlowStep(newId, data); 
        flow[newId] = data; 

        if (oldId !== newId) {
            await API.deleteFlowStep(oldId); 
            delete flow[oldId];

            for (const afKey of affectedSteps) {
                await API.saveFlowStep(afKey, flow[afKey]);
            }
        }

        renderFlowList(); 
        updateStepsDatalist(); 
        document.getElementById('editorModal').classList.remove('active');
        showToast("✅ Paso guardado" + (oldId !== newId ? " y rutas actualizadas" : ""));
    } catch (e) {
        console.error("Error al guardar paso de flujo:", e);
        showToast("❌ Error al guardar. Verifica tu conexión.");
    }
}

async function delStep() {
    const idToDelete = document.getElementById('stId').dataset.oldId || document.getElementById('stId').value;

    // BIENVENIDA es el inicio del flujo: borrarla lo rompe todo.
    if (idToDelete === 'BIENVENIDA') {
        showToast("⚠️ BIENVENIDA es el inicio del flujo y no se puede eliminar");
        return;
    }

    const usersOnStep = users.filter(u => u.current_step === idToDelete);
    const inbound = [];
    for (const key in flow) {
        if (key === idToDelete) continue;
        const step = flow[key];
        if (step.next_step === idToDelete || step.fallback_step === idToDelete) inbound.push(key);
        if (step.options) step.options.forEach(o => { if (o.next_step === idToDelete) inbound.push(key); });
    }
    const uniqueInbound = [...new Set(inbound)];

    // Sin clientes ni tarjetas apuntando, se borra directo como antes.
    if (usersOnStep.length === 0 && uniqueInbound.length === 0) {
        await executeDelStep();
        return;
    }

    const nameEl = document.getElementById('delStepName');
    if (nameEl) nameEl.innerText = idToDelete;
    const detailEl = document.getElementById('delStepDetail');
    if (detailEl) {
        const parts = [];
        if (usersOnStep.length > 0) parts.push(`${usersOnStep.length} cliente(s) están en este paso y se quedarán sin paso`);
        if (uniqueInbound.length > 0) parts.push(`${uniqueInbound.length} tarjeta(s) apuntan aquí: ${uniqueInbound.join(', ')}`);
        parts.push('Las tarjetas que apuntaban aquí pasarán al siguiente paso de este, o quedarán sin destino si no tenía');
        detailEl.innerText = parts.join('. ');
    }
    pushNavigationLayer();
    document.getElementById('deleteStepModal').classList.add('active');
}

async function executeDelStep() {
    const idToDelete = document.getElementById('stId').dataset.oldId || document.getElementById('stId').value;
    document.getElementById('deleteStepModal').classList.remove('active');
    const deletedStep = flow[idToDelete];
    const nextOfDeleted = (deletedStep && deletedStep.next_step) || '';
    try {
        // Reapuntar las tarjetas que iban a este paso hacia el siguiente
        // del eliminado (o sin destino), para no dejar rutas rotas.
        const affected = [];
        for (const key in flow) {
            if (key === idToDelete) continue;
            const step = flow[key];
            let changed = false;
            if (step.next_step === idToDelete) { step.next_step = nextOfDeleted; changed = true; }
            if (step.fallback_step === idToDelete) { step.fallback_step = nextOfDeleted; changed = true; }
            if (step.options) step.options.forEach(o => { if (o.next_step === idToDelete) { o.next_step = nextOfDeleted; changed = true; } });
            if (changed) affected.push(key);
        }
        for (const key of affected) await API.saveFlowStep(key, flow[key]);
        await API.deleteFlowStep(idToDelete);
        delete flow[idToDelete];
        renderFlowList();
        updateStepsDatalist();
        document.getElementById('editorModal').classList.remove('active');
        showToast("🗑️ Paso eliminado");
    } catch (e) {
        console.error("Error al eliminar paso:", e);
        showToast("❌ Error al eliminar paso");
    }
}

async function uploadImages(input) {
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
        const res = await fetch(`/api/upload`, { method: 'POST', body: formData });
        if (!res.ok) throw new Error("Fallo en el servidor al subir la imagen");
        
        const data = await res.json();
        if (data.urls) {
            currentMediaList = currentMediaList.concat(data.urls);
            renderGallery();
            showToast("✅ Imagen guardada con éxito");
        }
    } catch (e) {
        console.error("Error al subir:", e);
        showToast("❌ Error al subir la imagen");
    } finally {
        input.value = ''; 
    }
}

window.toggleFlowView = toggleFlowView;
window.resetFlowNav = resetFlowNav;
window.jumpToStep = jumpToStep;
window.enterStep = enterStep;
window.edit = edit;
window.addOptRow = addOptRow;
window.saveStep = saveStep;
window.createNewStepPrompt = createNewStepPrompt;
window.confirmCreateStep = confirmCreateStep;
window.delStep = delStep;
window.executeDelStep = executeDelStep;
window.uploadImages = uploadImages;
window.renderGallery = renderGallery;
window.renderFields = renderFields;
window.removeStepMedia = removeStepMedia;
// Alias: el HTML viejo llamaba openStepModal(), que no existia.
// Asi un index.html sin actualizar tambien abre el modal de nuevo paso.
window.openStepModal = createNewStepPrompt;