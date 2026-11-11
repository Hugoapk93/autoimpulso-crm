// src/auth.js — token compartido para la API del panel (un solo operador).
//
// El panel web es de un solo usuario, así que no hay cuentas ni sesiones:
// todas las rutas de /api exigen el mismo token secreto, que vive solo en
// el .env del servidor (API_TOKEN). El frontend lo envía en cada llamada
// como header `x-api-token` o `Authorization: Bearer <token>`.
//
// Reglas:
// - Sin API_TOKEN configurado -> 503, nunca se deja la API abierta.
// - Token ausente o distinto -> 401, sin decir cuál es el esperado.
// - La comparación es en tiempo constante (timingSafeEqual) para no
//   filtrar el token por el tiempo de respuesta.
const crypto = require('crypto');

function getApiToken() {
    return process.env.API_TOKEN || process.env.ADMIN_TOKEN || '';
}

function extractToken(req) {
    const headers = (req && req.headers) || {};
    const auth = headers.authorization || '';
    if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        return auth.slice(7).trim();
    }
    return headers['x-api-token'] || '';
}

function tokensEqual(provided, expected) {
    const a = Buffer.from(String(provided));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

function requireApiToken(req, res, next) {
    const expected = getApiToken();
    if (!expected) {
        return res.status(503).json({
            error: 'API no configurada: falta API_TOKEN en el .env del servidor.'
        });
    }
    const provided = extractToken(req);
    if (!provided || !tokensEqual(provided, expected)) {
        return res.status(401).json({ error: 'No autorizado.' });
    }
    return next();
}

module.exports = { requireApiToken, getApiToken, extractToken };
