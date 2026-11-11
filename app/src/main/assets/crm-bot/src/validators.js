const { getSettings } = require('./database'); // 🔥 Importación necesaria para leer las configuraciones

const basicClean = (str) => {
    if (!str) return "";
    return String(str).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
};

const isQuestion = (rawText) => {
    if (!rawText) return false;
    if (rawText.includes('?') || rawText.includes('¿')) return true;

    const clean = basicClean(rawText);
    const keywords = ['como', 'cuando', 'donde', 'por que', 'cual', 'cuanto', 'precio', 'costo', 'aceptan', 'tienen', 'requisito', 'duda'];
    const regex = new RegExp(`\\b(${keywords.join('|')})\\b`, 'i');
    return regex.test(clean);
};

// ==========================================
// 👤 NORMALIZACIÓN Y VALIDACIÓN DE NOMBRES
// ==========================================

const normalizeName = (text) => {
    if (!text) return '';
    const words = String(text).trim().toLowerCase().split(/\s+/);
    const stopWords = new Set(['de', 'del', 'la', 'las', 'los', 'y']); 
    
    return words.map((word, index) => {
        if (index > 0 && stopWords.has(word)) return word;
        return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(' ');
};

const isValidName = (text) => {
    if (!text) return false;
    const trimmed = text.trim();
    
    if (trimmed.length < 3 || trimmed.length > 60 || trimmed.split(' ').length > 6) return false;

    const nameRegex = /^[a-zA-ZáéíóúÁÉÍÓÚñÑ\s\-']+$/;
    return nameRegex.test(trimmed);
};

// ==========================================
// 📅 NORMALIZACIÓN Y VALIDACIÓN DE FECHAS
// ==========================================

const normalizeDate = (text) => {
    if (!text) return text;
    let str = String(text).toLowerCase().trim();

    const months = {
        'enero': '01', 'febrero': '02', 'marzo': '03', 'abril': '04',
        'mayo': '05', 'junio': '06', 'julio': '07', 'agosto': '08',
        'septiembre': '09', 'octubre': '10', 'noviembre': '11', 'diciembre': '12'
    };

    for (const [mName, mNum] of Object.entries(months)) {
        if (str.includes(mName)) {
            str = str.replace(new RegExp(`\\b${mName}\\b`, 'g'), mNum);
        }
    }

    const parts = str.match(/\d+/g);
    if (!parts || parts.length < 3) return text; 

    let day = parts[0].padStart(2, '0');
    let month = parts[1].padStart(2, '0');
    let yearStr = parts[2];

    if (yearStr.length === 2) {
        const y = parseInt(yearStr, 10);
        const currentYear2Digits = new Date().getFullYear() % 100;
        yearStr = y > currentYear2Digits ? `19${yearStr}` : `20${yearStr}`;
    } else if (yearStr.length !== 4) {
        return text; 
    }

    return `${day}/${month}/${yearStr}`;
};

const isValidBirthDate = (text) => {
    if (!text) return false;

    const clean = String(text).replace(/[^0-9]/g, '');
    if (clean.length !== 8) return false;

    const day = parseInt(clean.substring(0, 2), 10);
    const month = parseInt(clean.substring(2, 4), 10);
    const year = parseInt(clean.substring(4, 8), 10);
    const currentYear = new Date().getFullYear();

    if (year < 1900 || year > currentYear) return false;
    if (month < 1 || month > 12) return false;
    if (day < 1 || day > 31) return false;

    const dateObj = new Date(year, month - 1, day);
    
    const isValidCalendarDate = (
        dateObj.getFullYear() === year &&
        dateObj.getMonth() === month - 1 &&
        dateObj.getDate() === day
    );

    return isValidCalendarDate;
};


// ==========================================
// 📋 DICCIONARIO CENTRAL DE VARIABLES
// ==========================================
const VARIABLE_RULES = {
    // Nombres
    'nombre': {
        normalize: normalizeName,
        validate: isValidName,
        errorCategory: 'name'
    },
    
    // Fechas (Manejamos los dos nombres posibles)
    'fecha_nacimiento': {
        normalize: normalizeDate,
        validate: isValidBirthDate,
        errorCategory: 'date'
    },
    'nacimiento': { 
        normalize: normalizeDate,
        validate: isValidBirthDate,
        errorCategory: 'date'
    },
    
    // Correos Electrónicos
    'correo': {
        normalize: (val) => String(val).toLowerCase().trim(),
        validate: (val) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val),
        errorCategory: 'email'
    },
    
    // Validaciones exclusivas para México (CURP y RFC)
    'curp': {
        normalize: (val) => String(val).toUpperCase().replace(/[^A-Z0-9]/g, ''),
        validate: (val) => /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/.test(val),
        errorCategory: 'curp'
    },
    'rfc': {
        normalize: (val) => String(val).toUpperCase().replace(/[^A-Z0-9Ñ&]/g, ''),
        validate: (val) => /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/.test(val),
        errorCategory: 'rfc'
    },
    
    // Teléfonos a 10 dígitos (Formato MX)
    'telefono': {
        normalize: (val) => String(val).replace(/[^0-9]/g, ''),
        validate: (val) => val.length === 10,
        errorCategory: 'phone'
    },
    
    // Código Postal
    'codigo_postal': {
        normalize: (val) => String(val).replace(/[^0-9]/g, ''),
        validate: (val) => val.length === 5,
        errorCategory: 'zip'
    },
    
    // Producto del Catálogo
    'producto_interes': {
        normalize: (val) => val, 
        validate: () => true,
        errorCategory: null
    }
};

const processVariable = (varName, rawValue) => {
    const rule = VARIABLE_RULES[varName.toLowerCase()];
    if (!rule) return { value: rawValue, isValid: true, errorCategory: null };

    const normalizedValue = rule.normalize ? rule.normalize(rawValue) : rawValue;
    const isValid = rule.validate ? rule.validate(normalizedValue) : true;

    return { 
        value: normalizedValue, 
        isValid: isValid, 
        errorCategory: rule.errorCategory 
    };
};

// ==========================================
// 📝 MOTOR DE PLANTILLAS Y VARIABLES DE SALIDA
// ==========================================
const replaceDynamicVariables = (text, userData = {}, timezone = "America/Matamoros") => {
    if (!text) return text;
    let result = text;

    // 1. Variable Estática de Tiempo: {{saludo}}
    const hour = new Date(new Date().toLocaleString("en-US", {timeZone: timezone})).getHours();
    const saludo = hour >= 5 && hour < 12 ? 'Buenos días' : (hour >= 12 && hour < 19 ? 'Buenas tardes' : 'Buenas noches');
    result = result.replace(/{{saludo}}/gi, saludo);

    // 2. Variables Dinámicas del Historial del Usuario (Los datos reales del cliente)
    if (userData.history) {
        Object.keys(userData.history).forEach(key => {
            let val = userData.history[key] || '';

            // Humanización automática de Fechas
            if (key === 'fecha' && /^\d{4}-\d{2}-\d{2}$/.test(val)) {
                const [y, m, d] = val.split('-');
                const targetDate = new Date(y, m - 1, d);
                const now = new Date(new Date().toLocaleString("en-US", {timeZone: timezone}));
                const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                
                const diffDays = Math.round((targetDate - today) / (1000 * 60 * 60 * 24));
                const dias = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
                const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
                
                const diaName = dias[targetDate.getDay()];
                const mesName = meses[targetDate.getMonth()];
                const numDia = parseInt(d, 10);
                
                if (diffDays === 0) val = `hoy ${diaName}`;
                else if (diffDays === 1) val = `mañana ${diaName}`;
                else if (diffDays > 1 && diffDays <= 7) val = `el próximo ${diaName} ${numDia} de ${mesName}`;
                else val = `el ${diaName} ${numDia} de ${mesName}`;
            }

            // Reemplazo normal: {{nombre}}, {{correo}}, etc.
            result = result.replace(new RegExp(`{{${key}}}`, 'gi'), val);
            
            // Reemplazo de primera palabra: {{nombre_primer}}, {{fecha_primer}}
            result = result.replace(new RegExp(`{{${key}_primer}}`, 'gi'), val.split(' ')[0]);
        });
    }

    // 3. Variables del Negocio y Configuraciones Globales
    const settings = getSettings();
    if (settings && settings.customVars) {
        Object.keys(settings.customVars).forEach(key => {
            // 🔥 SOLUCIÓN AQUÍ: Si es una variable reservada por el sistema (nombre, fecha_nacimiento, etc), 
            // la saltamos por completo para evitar que borre los datos del cliente.
            if (settings.customVars[key].system) return;

            const val = settings.customVars[key].value || '';
            result = result.replace(new RegExp(`{{${key}}}`, 'gi'), val);
        });
    }

    return result;
};

// ==========================================
// 🎯 EVALUADOR DE FRASES EXACTAS CON COMODÍN (*)
// ==========================================
const matchWildcardPhrase = (expectedPhrase, receivedText) => {
    const expectedStr = String(expectedPhrase || '').trim();
    const receivedStr = String(receivedText || '').trim();
    
    if (!expectedStr) return { match: false, extractedData: null };

    const regexString = expectedStr
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') 
        .replace(/\*/g, '(.*)'); 

    const regex = new RegExp('^\\s*' + regexString + '\\s*$', 'i');
    const matchData = receivedStr.match(regex);

    if (matchData) {
        return {
            match: true,
            extractedData: matchData[1] ? matchData[1].trim() : null
        };
    }

    return { match: false, extractedData: null };
};

module.exports = { 
    basicClean, 
    isQuestion, 
    normalizeName, 
    normalizeDate, 
    isValidName, 
    isValidBirthDate,
    processVariable,
    replaceDynamicVariables,
    matchWildcardPhrase
};