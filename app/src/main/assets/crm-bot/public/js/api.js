const API_BASE = '';

// 🔐 Token de la API (Fase 1: el backend exige x-api-token en TODAS las
// llamadas a /api, incluido GET /status). El token se guarda en
// localStorage la primera vez que se escribe en el panel; no va
// hardcodeado en el código.
const TOKEN_KEY = 'crm_api_token';
export const getApiToken = () => {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
};
export const setApiToken = (t) => {
    try { localStorage.setItem(TOKEN_KEY, (t || '').trim()); } catch (e) {}
};
export const hasApiToken = () => !!getApiToken();

// Todas las llamadas a /api llevan el token automáticamente, incluidas las
// que hacen otros módulos con fetch() directo (main.js, agenda.js,
// contacts.js, flow.js, keywords.js, settings.js, chat/...). Sin esto, el
// backend responde 401 y el panel se queda en el spinner de
// "Conectando...". Solo se toca /api del mismo origen; el resto de fetch
// (fuentes, sonidos, etc.) pasa intacto. Si un día el token deja de ser
// válido, se avisa con el evento 'crm:unauthorized' para que el panel
// vuelva a pedirlo.
if (typeof window !== 'undefined' && !window.__crmFetchWrapped) {
    window.__crmFetchWrapped = true;
    const origFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/api/')) {
            const token = getApiToken();
            if (token) {
                const headers = new Headers(init.headers || {});
                headers.set('x-api-token', token);
                init = { ...init, headers };
            }
        }
        return origFetch(input, init).then((res) => {
            if (res.status === 401 && url.includes('/api/')) {
                window.dispatchEvent(new CustomEvent('crm:unauthorized'));
            }
            return res;
        });
    };
}

// --- AYUDANTES INTERNOS ---
async function get(url) {
    try {
        // 🔥 FIX: Obligamos al navegador a pedir siempre la versión más nueva al servidor
        const res = await fetch(`${API_BASE}${url}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`Status ${res.status}: ${res.statusText}`);
        return await res.json();
    } catch (e) {
        console.error(`[API GET] Error en ${url}:`, e);
        throw e; 
    }
}

async function post(url, body = {}) {
    try {
        const res = await fetch(`${API_BASE}${url}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        
        if (!res.ok) throw new Error(`Status ${res.status}: ${res.statusText}`);
        
        try { 
            return await res.json(); 
        } catch (parseError) { 
            return { success: true }; 
        }
    } catch (e) {
        console.error(`[API POST] Error en ${url}:`, e);
        throw e;
    }
}

async function del(url) {
    try {
        const res = await fetch(`${API_BASE}${url}`, { method: 'DELETE' });
        
        if (!res.ok) throw new Error(`Status ${res.status}: ${res.statusText}`);
        
        try { 
            return await res.json(); 
        } catch (parseError) { 
            return { success: true }; 
        }
    } catch (e) {
        console.error(`[API DELETE] Error en ${url}:`, e);
        throw e;
    }
}

// ==========================================
// EXPORTACIÓN DE ENDPOINTS
// ==========================================

export const getStatus = () => get('/api/status');
export const getSettings = () => get('/api/settings'); 
export const getFlow = () => get('/api/flow');
export const saveFlowStep = (stepId, stepData) => post('/api/flow/step', { stepId, stepData });
export const deleteFlowStep = (stepId) => del(`/api/flow/step/${stepId}`);

export const getUsers = () => get('/api/users'); 
export const getContacts = () => get('/api/contacts'); 

export const sendMessage = (phone, text, mediaUrl = null) => post('/api/send-message', { phone, text, mediaUrl });
export const executeCrm = (phone, stepId) => post('/api/crm/execute', { phone, stepId });