const { getKeywords } = require('./database');
const Fuse = require('fuse.js');

// ==========================================
// ⚙️ CONFIGURACIÓN DEL MOTOR DE BÚSQUEDA
// ==========================================
const MATCH_THRESHOLD = 0.5; // 50% de coincidencia exacta requerida
const FUZZY_THRESHOLD = 0.35; // Nivel de tolerancia para errores ortográficos

// Diccionario de exclusión (Stop Words)
const STOP_WORDS = new Set([
    'el','la','los','las','un','una','unos','unas',
    'de','del','para','por','con','en','a','su','mis','tu','te','me','se',
    'es','esta','son','como','si','no','o','y','que','podria','saber','ocupo',
    'quisiera','quiero','hola','buenos','dias','tardes','noches'
]);

// Expresión regular mejorada: Busca en CUALQUIER PARTE de la oración, no solo al inicio
const QUESTION_REGEX = /\b(que|como|cuando|donde|por\s?que|cual|cuanto|tiene|puedo|hay|ocupo\s?saber|checan|informacion|info|sabes|podria)\b/i;

// ==========================================
// 🛠️ UTILIDADES DE TEXTO
// ==========================================
const cleanText = (text) => {
    return String(text)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") 
        .trim();
};

const extractTokens = (cleanStr) => {
    return cleanStr
        .replace(/[^\w\s]/gi, '') 
        .split(/\s+/)
        .filter(w => !STOP_WORDS.has(w) && w.length > 2); 
};

const isMenuSelection = (cleanStr) => {
    return /^[#\.\-\(\*]*\d+[\.\-\)\*]*$/.test(cleanStr) || /^opcion\s*\d+$/.test(cleanStr);
};

const isQuestion = (rawText, cleanStr) => {
    return rawText.includes('?') || rawText.includes('¿') || QUESTION_REGEX.test(cleanStr);
};

// ==========================================
// 🚀 MOTOR PRINCIPAL DE BÚSQUEDA
// ==========================================
const findKeywordMatch = async (incomingText) => {
    if (!incomingText) return null;

    const textRawClean = cleanText(incomingText);

    // 1. Filtrar selecciones de menú para que pasen directo a flow.js
    if (isMenuSelection(textRawClean)) return null;

    // 2. Verificar si hay intención de pregunta
    if (!isQuestion(incomingText, textRawClean)) return null;

    // 3. Obtener base de datos en memoria (0ms de latencia)
    const keywordsDB = getKeywords(); 
    const validFAQs = keywordsDB.filter(rule => rule.answer && rule.answer.trim() !== '');

    // 🔥 FIX: Si no hay reglas, devolvemos null para que el bot se quede callado
    if (validFAQs.length === 0) return null;

    const userTokens = extractTokens(textRawClean);
    if (userTokens.length === 0) return null;

    // =========================================================================
    // 🧠 MOTOR 1: Jaccard Index (Coincidencia de Tokens)
    // =========================================================================
    let bestMatch = null;
    let highestScore = 0;

    for (const faq of validFAQs) {
        const faqTokens = extractTokens(cleanText(faq.keywords));
        if (faqTokens.length === 0) continue;

        const matches = userTokens.filter(token => faqTokens.some(ft => ft.includes(token) || token.includes(ft)));
        const score = matches.length / faqTokens.length; 

        if (score > highestScore) {
            highestScore = score;
            bestMatch = faq;
        }
    }

    if (highestScore >= MATCH_THRESHOLD) {
        console.log(`🧠 [FAQ] Match Analítico (Score: ${Math.round(highestScore*100)}%) | ID: ${bestMatch.id}`);
        return bestMatch;
    }

    // =========================================================================
    // ⚡ MOTOR 2: Fuse.js (Búsqueda Difusa / Caza-errores)
    // =========================================================================
    const fuse = new Fuse(validFAQs, {
        includeScore: true,
        threshold: FUZZY_THRESHOLD,
        ignoreLocation: true,
        keys: ['keywords']
    });

    const fuzzyResults = fuse.search(textRawClean);

    if (fuzzyResults.length > 0 && fuzzyResults[0].score <= FUZZY_THRESHOLD) {
        console.log(`⚡ [FAQ] Match Difuso (Score: ${fuzzyResults[0].score.toFixed(2)}) | ID: ${fuzzyResults[0].item.id}`);
        return fuzzyResults[0].item;
    }

    // =========================================================================
    // ❌ FRACASO: Es pregunta pero no existe en la base de datos
    // =========================================================================
    // 🔥 FIX: Devolvemos null en lugar de activar el fallback. El bot guardará la duda y guardará silencio.
    console.log(`⚠️ [FAQ] Pregunta no reconocida. Ignorando silenciosamente.`);
    return null; 
};

module.exports = { findKeywordMatch };