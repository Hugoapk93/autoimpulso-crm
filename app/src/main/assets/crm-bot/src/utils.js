// ==========================================
// 1. UTILIDADES DE TELÉFONO
// ==========================================
const getCleanPhone = (phone) => {
    if (!phone) return '';
    return String(phone).replace(/@s\.whatsapp\.net|@lid/g, '');
};

const normalizePhone = (jidOrPhone) => {
    if (!jidOrPhone) return '';
    let clean = String(jidOrPhone).split('@')[0].replace(/\D/g, '');
    
    // Si viene con el formato internacional de México (52 o 521)
    if (clean.startsWith('52') && clean.length >= 12) {
        return '52' + clean.slice(clean.length === 13 ? 3 : 2);
    }
    // Si son solo los 10 dígitos locales
    if (clean.length === 10) return '52' + clean;
    return clean;
};

// ==========================================
// 2. UTILIDADES DE TEXTO
// ==========================================
const normalizeText = (str) => {
    if (!str) return "";
    return String(str).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Quitar acentos
        .replace(/[^a-z0-9 ]/g, "") // Solo alfanuméricos
        .trim()
        .replace(/\s+/g, ' '); // Espacios múltiples a uno solo
};

const collapseChars = (str) => {
    return str.replace(/(.)\1+/g, '$1');
};

const getEditDistance = (a, b) => {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    
    // Optimización de la matriz de Levenshtein (usando 2 filas en vez de NxM)
    let prevRow = Array.from({ length: a.length + 1 }, (_, i) => i);
    let currRow = new Array(a.length + 1);

    for (let i = 1; i <= b.length; i++) {
        currRow[0] = i;
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                currRow[j] = prevRow[j - 1];
            } else {
                currRow[j] = Math.min(
                    prevRow[j - 1] + 1, // Sustitución
                    currRow[j - 1] + 1, // Inserción
                    prevRow[j] + 1      // Eliminación
                );
            }
        }
        [prevRow, currRow] = [currRow, prevRow]; // Swap de filas
    }
    return prevRow[a.length];
};

const isSimilar = (input, keyword) => {
    if (!input || !keyword) return false;
    
    const cleanInput = normalizeText(input);
    const cleanKeyword = normalizeText(keyword);
    
    if (cleanInput === cleanKeyword) return true;
    if (collapseChars(cleanInput) === collapseChars(cleanKeyword)) return true;
    if (cleanKeyword.length > 4 && cleanInput.includes(cleanKeyword)) return true;
    
    const distance = getEditDistance(cleanInput, cleanKeyword);
    
    // Tolerancia dinámica basada en la longitud
    const maxErrors = cleanKeyword.length > 7 ? 2 : (cleanKeyword.length > 3 ? 1 : 0);
    
    return distance <= maxErrors;
};

// ==========================================
// 3. UTILIDADES DE FECHA
// ==========================================
const formatDate = (date) => {
    if (!(date instanceof Date) || isNaN(date)) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
};

module.exports = { 
    getCleanPhone, 
    normalizePhone,
    normalizeText, 
    isSimilar, 
    formatDate,
    getEditDistance
};