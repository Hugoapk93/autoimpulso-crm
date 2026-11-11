const { getSettings, getSystemTime } = require('../database');
const { getAvailableSlots, timeToMinutes } = require('./agendaService'); 
const { normalizeText, formatDate } = require('../utils'); 

// ==========================================
// 🧠 EXTRACCIÓN INTELIGENTE DE VARIABLES
// ==========================================

const smartExtract = (varName, rawText) => {
    let t = rawText.trim();
    
    if (varName === 'nombre') {
        t = t.replace(/^(hola(\s+a\s+todos)?)?\s*(me\s+llamo|mi\s+nombre\s+es|soy|yo\s+soy)\s+/i, '');
    } 
    else if (varName === 'fecha_nacimiento') {
        const dateMatch = t.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/);
        if (dateMatch) return dateMatch[0];
        
        t = t.replace(/^(pues\s+)?(naci\s+el|es\s+el|mi\s+fecha\s+es)\s+/i, '');
    }
    
    return t;
};

// ==========================================
// 📅 ANÁLISIS DE FECHA Y HORA (Core NLP)
// ==========================================

const extractDateTime = (text) => {
    let processedText = String(text).replace(/\b(\d{1,2})\.(\d{2})\b/g, '$1:$2');

    const response = { date: null, time: null };
    let strForTime = processedText.toLowerCase(); 
    const lower = normalizeText(processedText);

    const settings = getSettings();
    const tz = settings.timezone || "America/Matamoros"; 
    
    const sysTime = getSystemTime();
    const [sysYear, sysMonth, sysDay] = sysTime.dateString.split('-');
    const todayMx = new Date(sysYear, sysMonth - 1, sysDay);
    let targetDate = new Date(todayMx);

    // --- A. DETECCIÓN DE FECHA ---
    const monthMap = {
        'enero': 1, 'febrero': 2, 'marzo': 3, 'abril': 4,
        'mayo': 5, 'junio': 6, 'julio': 7, 'agosto': 8,
        'septiembre': 9, 'octubre': 10, 'noviembre': 11, 'diciembre': 12
    };

    const naturalDateRegex = /\b(\d{1,2})\s+(?:de\s+)?(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+(?:de|del)\s+(\d{2,4}))?\b/;
    const numericDateRegex = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/;

    const naturalMatch = lower.match(naturalDateRegex); 
    const numericMatch = strForTime.match(numericDateRegex);

    if (naturalMatch) {
        const day = parseInt(naturalMatch[1]);
        const month = monthMap[naturalMatch[2]];
        let year = naturalMatch[3] ? parseInt(naturalMatch[3]) : todayMx.getFullYear();
        if (year < 100) year += 2000;

        const tentativeDate = new Date(year, month - 1, day);
        // 🔥 FIX: Validar si la fecha existe realmente (prevenir 30 febrero)
        if (tentativeDate.getDate() === day && (tentativeDate.getMonth() + 1) === month) {
            if (!naturalMatch[3] && tentativeDate < todayMx) year++; 
            response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            strForTime = strForTime.replace(naturalDateRegex, ' ');
        }
    }
    else if (numericMatch) {
        const day = parseInt(numericMatch[1]);
        const month = parseInt(numericMatch[2]);
        let year = numericMatch[3] ? parseInt(numericMatch[3]) : todayMx.getFullYear();
        if (year < 100) year += 2000;

        const tentativeDate = new Date(year, month - 1, day);
        // 🔥 FIX: Validar si la fecha existe realmente (prevenir 30 febrero)
        if (tentativeDate.getDate() === day && (tentativeDate.getMonth() + 1) === month) {
            if (!numericMatch[3] && tentativeDate < todayMx) year++; 
            response.date = `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
            strForTime = strForTime.replace(numericDateRegex, ' ');
        }
    }
    else {
        let dayFound = false;
        const dias = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
        for (let i = 0; i < dias.length; i++) {
            if (lower.includes(dias[i])) {
                const currentDay = todayMx.getDay();
                let diff = i - currentDay;
                if (diff <= 0) diff += 7;
                if (diff === 7 && lower.includes('hoy')) diff = 0;

                targetDate.setDate(todayMx.getDate() + diff);
                response.date = formatDate(targetDate);
                dayFound = true;
                break;
            }
        }

        if (!dayFound) {
            if (lower.includes('pasado manana')) {
                targetDate.setDate(todayMx.getDate() + 2);
                response.date = formatDate(targetDate);
            }
            else if (lower.includes('hoy')) {
                response.date = formatDate(targetDate);
            }
            else if (lower.includes('manana')) {
                if (!lower.includes('en la manana') && 
                    !lower.includes('por la manana') && 
                    !lower.includes('de la manana') && 
                    !lower.includes('la manana')) {
                    targetDate.setDate(todayMx.getDate() + 1);
                    response.date = formatDate(targetDate);
                }
            }
        }
    }

    // La inferencia de AM/PM (abajo) usa targetDate.getDay() para mirar el
    // horario del día. Las ramas de fecha explícita ("17 de marzo",
    // "17/03") fijaban response.date SIN actualizar targetDate, así que
    // "el 17 de marzo a las 5" infería con el horario de HOY: un miércoles
    // de solo mañana devolvía las 17:00 (hora en la que está cerrado) en
    // vez de las 05:00. Las ramas de día relativo ("mañana", "el viernes")
    // sí actualizaban targetDate. Se sincroniza aquí para todas las ramas.
    if (response.date) {
        const [ry, rm, rd] = response.date.split('-').map(Number);
        targetDate = new Date(ry, rm - 1, rd, 12, 0, 0);
    }

    // --- B. DETECCIÓN DE HORA ---
    let h = null, m = '00';
    let isPM = false, isAM = false;

    const timeStr = strForTime.replace(/\./g, ''); 

    const colonMatch = timeStr.match(/\b([01]?[0-9]|2[0-3]):([0-5][0-9])(?:\s*(am|pm|hrs|horas))?\b/i);
    const ampmMatch = timeStr.match(/\b(1[0-2]|[1-9])\s*(am|pm)\b/i);
    const coloquialMatch = timeStr.match(/\b([01]?[0-9]|2[0-3])\s*(?:de la|en la|por la)\s*(manana|tarde|noche)\b/i);
    const aLasMatch = timeStr.match(/\b(?:a\s*las?|alas?|al|para\s*las?|tipo)\s*([01]?[0-9]|2[0-3])\b/i);
    const hrsMatch = timeStr.match(/\b([01]?[0-9]|2[0-3])\s*(hrs|horas)\b/i);

    const wordHours = {
        'una': 1, 'dos': 2, 'tres': 3, 'cuatro': 4, 'cinco': 5,
        'seis': 6, 'siete': 7, 'ocho': 8, 'nueve': 9, 'diez': 10,
        'once': 11, 'doce': 12, 'mediodia': 12, 'medio dia': 12
    };

    if (colonMatch) {
        h = parseInt(colonMatch[1]);
        m = colonMatch[2];
        if (colonMatch[3] && colonMatch[3].toLowerCase() === 'pm') isPM = true;
        if (colonMatch[3] && colonMatch[3].toLowerCase() === 'am') isAM = true;
    } else if (ampmMatch) {
        h = parseInt(ampmMatch[1]);
        if (ampmMatch[2].toLowerCase() === 'pm') isPM = true;
        if (ampmMatch[2].toLowerCase() === 'am') isAM = true;
    } else if (coloquialMatch) {
        h = parseInt(coloquialMatch[1]);
        const periodoStr = coloquialMatch[2].toLowerCase();
        if (periodoStr === 'tarde' || periodoStr === 'noche') isPM = true;
        if (periodoStr === 'manana') isAM = true;
    } else if (hrsMatch) {
        h = parseInt(hrsMatch[1]);
    } else if (aLasMatch) {
        h = parseInt(aLasMatch[1]);
    } else {
        // 🔥 FIX: Requerir prefijo contextual (a la, a las) para evitar falsos positivos con "una cita"
        for (const [word, num] of Object.entries(wordHours)) {
            // Regex: Busca la palabra solo si está precedida de contexto temporal,
            // si es "mediodia", o si viene con am/pm ("tres pm").
            // Sin esto, "tres pm" no daba hora, aunque "a las tres" sí.
            const strictWordMatch = new RegExp(`\\b(?:a\\s*las?|alas?|para\\s*las?)\\s*${word}\\b`, 'i');
            const mediodiaMatch = new RegExp(`\\b${word}\\b`, 'i');
            const ampmMatch = /\b(am|pm)\b/i.test(timeStr);

            if (strictWordMatch.test(timeStr) || (mediodiaMatch.test(timeStr) && (num === 12 || ampmMatch))) {
                h = num;
                if (/\b(pm|tarde|noche)\b/.test(timeStr)) isPM = true;
                if (/\b(am|manana|madrugada)\b/.test(timeStr)) isAM = true;
                break;
            }
        }
    }

    if (h !== null) {
        if (isPM && h < 12) h += 12;
        if (isAM && h === 12) h = 0;

        if (!isPM && !isAM && response.date) {
            const dayOfWeek = targetDate.getDay();
            const dayConfig = settings.schedule?.days?.[String(dayOfWeek)];
            
            if (dayConfig && dayConfig.active !== false && String(dayConfig.active) !== "false") {
                const toMins = (t) => { const [hx,mx] = t.split(':').map(Number); return (hx * 60) + mx; };
                const startMins = toMins(dayConfig.start || "09:00");
                const endMins = toMins(dayConfig.end || "19:00");
                
                const amMins = (h === 12 ? 0 : h) * 60 + parseInt(m);
                const pmMins = (h === 12 ? 12 : h + 12) * 60 + parseInt(m);
                
                const checkValid = (mins) => startMins < endMins 
                    ? (mins >= startMins && mins <= endMins) 
                    : (mins >= startMins || mins <= endMins); 
                    
                if (checkValid(pmMins) && !checkValid(amMins)) h = (h === 12) ? 12 : h + 12; 
                else if (checkValid(amMins) && !checkValid(pmMins)) h = (h === 12) ? 0 : h;       
                else if (h >= 1 && h <= 7) h += 12;
            } else {
                if (h >= 1 && h <= 7) h += 12;
            }
        } else if (!isPM && !isAM) {
            if (h >= 1 && h <= 7) h += 12;
        }

        response.time = `${String(h).padStart(2, '0')}:${m}`;
    } else {
        response.time = null; 
    }

    return response;
};

// ==========================================
// ⚙️ VALIDACIÓN DE INTERVALOS Y MENSAJES
// ==========================================

const isValidInterval = (timeStr, intervalMinutes) => {
    if (intervalMinutes === 1440) return true;
    const [h, m] = timeStr.split(':').map(Number);
    return m % intervalMinutes === 0;
};

const getIntervalErrorMessage = (timeStr, intervalMinutes) => {
    const [h] = timeStr.split(':').map(Number);
    const minText = intervalMinutes === 60 ? 'horas en punto' : `intervalos de ${intervalMinutes} minutos`;
    const ejemplo = intervalMinutes < 60 ? `ej. ${h}:00, ${h}:${String(intervalMinutes).padStart(2, '0')}` : `ej. ${h}:00`;
    return `⚠️ Por favor, elige una hora en ${minText} (${ejemplo}).`;
};

const buildAlternativesMessage = async (fecha, hora, intervalMinutes) => {
    const freeSlots = await getAvailableSlots(fecha);
    const requestedMins = timeToMinutes(hora);

    freeSlots.sort((a, b) => {
        return Math.abs(timeToMinutes(a) - requestedMins) - Math.abs(timeToMinutes(b) - requestedMins);
    });

    const top3 = freeSlots.slice(0, 3).sort();
    
    let txt = `❌ Uy, las *${hora}* ya se nos ocuparon.\n\n`;
    
    if (top3.length > 0) {
        txt += `💡 Pero tengo estos espacios libres muy cerca de esa hora:\n`;
        top3.forEach(h => txt += `👉 *${h}*\n`);
        txt += `\n¿Te sirve alguno de estos, o prefieres buscar en otro horario?`;
    } else {
        txt += `De hecho, ya tenemos todo lleno para este día. 😱\n¿Podemos revisar para mañana u otra fecha diferente?`;
    }

    return txt;
};

module.exports = {
    smartExtract,
    extractDateTime,
    isValidInterval,
    getIntervalErrorMessage,
    buildAlternativesMessage
};