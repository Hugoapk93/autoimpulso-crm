import * as API from './api.js';
import { showToast, pushNavigationLayer, getCleanPhone, escapeHTML } from './utils.js';
import { getAppState, reloadActivity, refreshChats, closeChat, setAllContactsCache } from './main.js';

const API_BASE = '';
let phoneToDelete = null;

export function editCurrentContactManual() {
    const { currentChatPhone, users, flow } = getAppState();
    if (!currentChatPhone) return;
    pushNavigationLayer();

    const nameEl = document.getElementById('waHeaderName');
    document.getElementById('editNameInput').value = nameEl && nameEl.innerText !== 'Desconocido' ? nameEl.innerText : '';

    const phoneClean = currentChatPhone.replace(/@s\.whatsapp\.net|@lid/g, '');
    
    if (phoneClean.startsWith('52') && phoneClean.length === 12) {
        document.getElementById('countryCodeSelect').value = '52';
        document.getElementById('editPhoneInput').value = phoneClean.slice(2);
    } else if (phoneClean.startsWith('521') && phoneClean.length === 13) {
        document.getElementById('countryCodeSelect').value = '52';
        document.getElementById('editPhoneInput').value = phoneClean.slice(3);
    } else if (phoneClean.startsWith('1') && phoneClean.length === 11) {
        document.getElementById('countryCodeSelect').value = '1';
        document.getElementById('editPhoneInput').value = phoneClean.slice(1);
    } else {
        document.getElementById('editPhoneInput').value = phoneClean;
    }

    const dynContainer = document.getElementById('dynamicVarsContainer');
    const userObj = users.find(u => getCleanPhone(u.phone) === getCleanPhone(currentChatPhone));
    const history = (userObj && userObj.history) ? userObj.history : {};
    
    const allVars = new Set();
    
    // 1. Agregamos las variables del sistema explícitamente (incluyendo la nueva)
    const systemVars = ['producto_interes', 'correo', 'curp', 'rfc', 'telefono', 'codigo_postal', 'fecha_nacimiento'];
    systemVars.forEach(v => allVars.add(v));
    
    // 2. Agregamos las que ya tiene el usuario
    Object.keys(history).forEach(k => allVars.add(k));
    
    // 3. Agregamos las que vienen de los pasos 'input' en el flujo
    if (typeof flow !== 'undefined') {
        Object.values(flow).forEach(step => {
            if (step.save_var) allVars.add(step.save_var.trim()); 
        });
    }

    let htmlVars = '<div class="kw-upload-wrap"><h4 class="dyn-var-header"><i class="fas fa-database"></i> Variables del Flujo</h4>';
    let hasVars = false;
    
    // Variables a ignorar en la UI (ya que se manejan en otros lados)
    const ignoredVars = new Set(['nombre', 'cliente', 'usuario', 'name', 'step', 'last_step']);
    
    // 🔥 FIX: Ordenamiento inteligente (Llenas primero, Vacías después, Desempate alfabético)
    const sortedVars = Array.from(allVars)
        .filter(key => !ignoredVars.has(key))
        .sort((a, b) => {
            const valA = history[a] !== undefined ? String(history[a]).trim() : '';
            const valB = history[b] !== undefined ? String(history[b]).trim() : '';
            
            const hasDataA = valA !== '';
            const hasDataB = valB !== '';

            if (hasDataA && !hasDataB) return -1; // A sube
            if (!hasDataA && hasDataB) return 1;  // B sube
            
            // Si ambas tienen datos o ambas están vacías, orden alfabético
            return a.localeCompare(b);
        });
    
    sortedVars.forEach(key => {
        hasVars = true;
        const val = history[key] !== undefined ? history[key] : '';
        const emptyLabel = val === '' ? '<span class="dyn-var-empty">(Vacía)</span>' : '';

        htmlVars += `
            <div class="form-group text-left mb-10">
                <label class="dyn-var-label">${key} ${emptyLabel}</label>
                <input type="text" class="edit-contact-input dyn-var-input" data-key="${key}" value="${escapeHTML(val)}" placeholder="Sin asignar...">
            </div>
        `;
    });

    if(!hasVars) {
        htmlVars += '<div class="empty-state-text" style="padding:10px;">No hay variables configuradas en tu flujo.</div>';
    }

    htmlVars += '</div>'; 
    dynContainer.innerHTML = htmlVars;

    document.getElementById('editNameModal').classList.add('active');
    setTimeout(() => document.getElementById('editNameInput').focus(), 100);
}

export function closeEditNameModal() {
    document.getElementById('editNameModal').classList.remove('active');
}

export async function confirmEditName() {
    const { currentChatPhone, users, currentSearchQuery } = getAppState();
    const newName = document.getElementById('editNameInput').value.trim();
    let phoneInputValue = document.getElementById('editPhoneInput').value.trim();
    const oldPhone = currentChatPhone; 

    if (!newName || !currentChatPhone) {
        showToast("⚠️ El nombre no puede estar vacío");
        return;
    }

    showToast("⏳ Guardando...");

    const prefix = document.getElementById('countryCodeSelect').value;
    const oldPhoneClean = oldPhone.replace(/@s\.whatsapp\.net|@lid/g, '');
    let finalNewPhone = phoneInputValue;

    if (phoneInputValue !== oldPhoneClean && phoneInputValue !== '') {
        phoneInputValue = phoneInputValue.replace(/\D/g, '');
        
        if (phoneInputValue.length > 12) {
            finalNewPhone = phoneInputValue;
        } else if (phoneInputValue.length === 10) {
            finalNewPhone = (prefix === '52' ? '521' : prefix) + phoneInputValue;
        } else if (!phoneInputValue.startsWith(prefix)) {
            finalNewPhone = prefix + phoneInputValue;
        } else {
            finalNewPhone = phoneInputValue;
        }
    } else {
        finalNewPhone = oldPhoneClean;
    }

    const botSwitch = document.getElementById('waBotSwitch');
    const isBotEnabled = botSwitch ? botSwitch.checked : true;

    const dynamicVars = {};
    document.querySelectorAll('.dyn-var-input').forEach(input => {
        // Solo enviamos las variables que tienen algún valor para no saturar la base de datos con vacíos
        if (input.value.trim() !== '') {
            dynamicVars[input.dataset.key] = input.value.trim();
        }
    });

    try {
        const res = await fetch(`${API_BASE}/api/contacts/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ phone: oldPhone, name: newName, enable: isBotEnabled, bot_enabled: isBotEnabled, historyVars: dynamicVars })
        });
        
        let data = {};
        try { data = await res.json(); } catch(e) {}

        if (!res.ok || data.success === false) {
            throw new Error(data.error || "Fallo HTTP al actualizar el contacto");
        }

        // El backend compara los números normalizados (52 y 521 son el
        // mismo número), pero aquí se comparaban las cadenas tal cual:
        // escribir 525512345678 cuando el contacto tiene 5215512345678
        // llamaba a link-lid y el backend devolvía 400 "son el mismo".
        // getCleanPhone deja los 10 dígitos de ambos lados, así que la
        // comparación ya es la misma que hace el servidor.
        if (finalNewPhone && getCleanPhone(finalNewPhone) !== getCleanPhone(oldPhoneClean)) {
            try {
                const resLink = await fetch(`${API_BASE}/api/contacts/link-lid`, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ lidPhone: oldPhone, realPhone: finalNewPhone })
                });
                
                let linkData = {};
                try { linkData = await resLink.json(); } catch (e) {}

                if (!resLink.ok || linkData.success === false) throw new Error(linkData.message || linkData.error || "Fallo al vincular LID con número real");
                
                showToast("🔗 Contacto fusionado con número real");
                closeChat(); 
                setTimeout(() => reloadActivity(), 500);
            } catch (e) {
                console.error("Error al vincular número:", e);
                showToast(e.message && e.message.includes('son el mismo')
                    ? "⚠️ Ese número es el mismo que ya tiene el contacto"
                    : "❌ Error al vincular número");
            }
        } else {
            const nameEl = document.getElementById('waHeaderName');
            if (nameEl) nameEl.innerText = newName;
            
            const u = users.find(x => getCleanPhone(x.phone) === getCleanPhone(currentChatPhone));
            if(u) {
                u.savedName = newName; 
                u.bot_enabled = isBotEnabled; 
                if(!u.history) u.history = {};
                u.history.nombre = newName;
                Object.keys(dynamicVars).forEach(k => u.history[k] = dynamicVars[k]);
            }
            refreshChats(currentSearchQuery);
            showToast("✅ Perfil actualizado");
        }
    } catch (error) {
        console.error("Error guardando perfil del contacto:", error);
        // Antes, un fallo de red mostraba "✅ Perfil actualizado" aunque
        // nada se guardo. Un error es un error: se avisa como tal y no se
        // recarga la lista con datos viejos.
        showToast("❌ Error al guardar los cambios");
    } finally {
        closeEditNameModal();
    }
}

export function openContactModal() {
    pushNavigationLayer();
    document.getElementById('modalTitleContact').innerText = "Nuevo Contacto";
    document.getElementById('newContName').value = '';
    document.getElementById('newContPhone').value = '';
    document.getElementById('newContPhone').disabled = false;
    document.getElementById('newContPhone').style.opacity = "1";
    document.getElementById('newContEnable').checked = true;
    document.getElementById('contactModal').classList.add('active');
}

export async function saveNewContact() {
    const name = document.getElementById('newContName').value.trim();
    const phone = document.getElementById('newContPhone').value.trim();
    const enable = document.getElementById('newContEnable').checked;

    if (!phone) {
        showToast("⚠️ El teléfono es obligatorio");
        return;
    }
    if (phone.replace(/\D/g, '').length < 10) {
        showToast("⚠️ Escribe un teléfono válido (mínimo 10 dígitos)");
        return;
    }

    // No existe POST /api/contacts/add en el backend: crear es actualizar.
    // /contacts/update hace upsert (crea el usuario si no existe) y
    // addManualContact crea la entrada del panel.
    try {
        const res = await fetch(`${API_BASE}/api/contacts/update`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ name, phone, enable, bot_enabled: enable })
        });

        let data = {};
        try { data = await res.json(); } catch (e) {}

        if (!res.ok || data.success === false) throw new Error(data.message || data.error || "Fallo al guardar el nuevo contacto");

        document.getElementById('contactModal').classList.remove('active');
        showToast('✅ Contacto creado');
        reloadActivity();
    } catch (error) {
        console.error("Error en saveNewContact:", error);
        showToast("❌ Error al guardar el contacto");
    }
}

export function askDelete(phone, name) {
    phoneToDelete = phone;
    document.getElementById('delContactName').innerText = name || phone;
    document.getElementById('deleteConfirmModal').classList.add('active');
}

export async function executeDelete() {
    if(!phoneToDelete) return;
    const { allContactsCache } = getAppState();
    
    try {
        const res = await fetch(`${API_BASE}/api/contacts/delete`, { 
            method:'POST', 
            headers:{'Content-Type':'application/json'}, 
            body:JSON.stringify({phone: phoneToDelete}) 
        });
        
        if (!res.ok) throw new Error("Fallo al eliminar el contacto del servidor");
        
        setAllContactsCache(allContactsCache.filter(u => u.phone !== phoneToDelete));
        document.getElementById('deleteConfirmModal').classList.remove('active');
        reloadActivity(); 
        showToast('🗑️ Contacto eliminado');
    } catch (error) {
        console.error("Error en executeDelete:", error);
        showToast("❌ Error al eliminar el contacto");
    }
}

// Exposiciones globales para el HTML
window.editCurrentContactManual = editCurrentContactManual;
window.closeEditNameModal = closeEditNameModal;
window.confirmEditName = confirmEditName;
window.openContactModal = openContactModal;
window.saveNewContact = saveNewContact;
window.askDelete = askDelete;
window.executeDelete = executeDelete;