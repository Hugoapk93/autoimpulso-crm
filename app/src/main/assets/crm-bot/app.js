// 🔥 Sobrescribir la consola para incluir Fecha y Hora local
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

const getTimestamp = () => {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Matamoros" }));
    const d = String(now.getDate()).padStart(2, '0');
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const y = now.getFullYear();
    let h = now.getHours();
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12; 
    
    return `[${d}/${m}/${y} ${String(h).padStart(2, '0')}:${min}:${sec} ${ampm}]`;
};

console.log = (...args) => originalLog(getTimestamp(), ...args);
console.warn = (...args) => originalWarn(getTimestamp(), ...args);
console.error = (...args) => originalError(getTimestamp(), ...args);

// ==========================================
// INICIO DE LA APLICACIÓN
// ==========================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const botEvents = require('./src/events');

// 🛠️ Importamos utilidades y BD
require('./src/utils'); 
const { initializeDB } = require('./src/database');
const apiRoutes = require('./src/api'); 

// 🔥 Importamos la nueva Clase Singleton de WhatsApp y el Servicio de Notificaciones
const waService = require('./src/whatsapp'); 
const { initializePushNotifications, sendPushNotification } = require('./src/services/pushService'); 

const bootstrap = () => {
    // 📂 Configurar carpetas necesarias de forma segura
    const uploadDir = path.join(__dirname, 'public/uploads');
    const dataDir = path.join(__dirname, 'data');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    // 🗄️ Arrancar base de datos
    initializeDB(); 

    // 🌐 Inicializar Express y Servidor HTTP
    const app = express();
    const server = http.createServer(app);
    
    // 🔌 Inicializar WebSockets
    const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
    
    // 🔥 Inyección de Dependencias: Guardamos 'io' en Express para que api.js lo pueda usar
    app.set('io', io);

    // 🛡️ Middlewares
    app.use(cors());
    app.use(express.json());
    app.use(express.static('public'));

    // 🚀 Rutas de la API
    app.use('/api', apiRoutes); 

    // 🔔 Inicializar Notificaciones Push (nunca tumba el arranque:
    // si faltan las VAPID, pushService avisa y sigue sin push).
    try { initializePushNotifications(); } catch (e) {
        console.error('⚠️ Push no disponible, el bot sigue sin notificaciones push:', e.message);
    }

    // ==========================================
    // 🔌 GESTIÓN DE EVENTOS DE INTERFAZ WEB (UI)
    // ==========================================
    io.on('connection', (socket) => {
        console.log(`🔌 Panel Web conectado: ${socket.id}`);
        socket.on('disconnect', () => console.log(`❌ Panel Web desconectado: ${socket.id}`));
    });

    // ==========================================
    // 🧠 ORQUESTACIÓN: WHATSAPP -> INTERFAZ WEB
    // ==========================================
    waService.on('qr', (qrCode) => {
        io.emit('qr', { qr: qrCode });
    });

    waService.on('status', (status) => {
        io.emit('status', { status });
    });

    waService.on('chat_deleted', (data) => {
        // El chat se borró en el teléfono: quitarlo de la lista del panel.
        io.emit('chat_deleted', data);
    });

    waService.on('new_message_ui', (data) => {
        // Enviar mensaje al panel CRM en tiempo real
        io.emit('message', data);
        
        // Notificar en el escritorio del asesor si el mensaje es de un cliente
        if (!data.fromMe) {
            sendPushNotification("Nuevo Mensaje", `Mensaje recibido de ${data.phone}`, "/#activity");
        }
    });

    // ==========================================
    // 🌉 PUENTE: EVENTOS INTERNOS -> FRONTEND
    // ==========================================
    // 1. Enviar mensajes del Simulador al Panel Web
    botEvents.on('message_ui', (data) => {
        io.emit('message', data);
    });

    // 2. Enviar notificaciones push (ej. cuando el negocio está cerrado)
    botEvents.on('push_notification', (data) => {
        sendPushNotification(data.title, data.body, data.url);
    });

    // ==========================================
    // 🛑 CICLO DE VIDA DEL SERVIDOR
    // ==========================================
    let isShuttingDownApp = false; // Evita que Ctrl+C se dispare varias veces

    const gracefulShutdown = async (signal) => {
        if (isShuttingDownApp) return;
        isShuttingDownApp = true;

        console.log(`\n🛑 Señal ${signal} recibida. Cerrando bot de forma segura...`);
        
        try {
            waService.isShuttingDown = true; 
            
            if (waService.sock) {
                waService.sock.end(undefined); 
            }

            // 1. Cerramos las conexiones WebSockets activas (el panel web)
            if (io) io.close();

            // 2. Failsafe: Si tarda más de 2 segundos en cerrar, lo matamos a la fuerza
            const killTimer = setTimeout(() => {
                console.log('⚠️ Cierre forzado por tiempo límite.');
                process.exit(0);
            }, 2000);

            server.close(() => {
                clearTimeout(killTimer);
                console.log('✅ Servidor HTTP cerrado correctamente.');
                process.exit(0);
            });
        } catch (error) {
            console.error('❌ Error durante el apagado:', error);
            process.exit(1);
        }
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    // 🛡️ Manejo de Errores Globales: un error no capturado ya NO mata el
    // proceso entero (antes: process.exit(1) en el primer error, y caían
    // el bot y el panel para todos). Se registra como crítico y el proceso
    // sigue: Express y Baileys sobreviven a la mayoría de estos errores, y
    // el socket se recupera solo con su reconexión. Para caídas reales
    // (sin memoria, etc.), conviene correr el bot con un process manager
    // (pm2 o systemd) que lo reinicie. El apagado intencional
    // (gracefulShutdown) sí sigue saliendo con process.exit.
    process.on('uncaughtException', (err) => {
        console.error('🔥 ERROR NO CAPTURADO (el proceso sigue):', err);
    });

    process.on('unhandledRejection', (reason) => {
        console.error('⚠️ PROMESA RECHAZADA SIN MANEJAR (el proceso sigue):', reason);
    });

    // 🚀 Arrancar Todo
    // Puerto dinámico: se intenta el PORT del .env (3000 por defecto) y si
    // está ocupado (otra instancia del bot u otro proceso en el teléfono),
    // el sistema asigna uno libre. El puerto real queda en .port para que
    // la app lo lea y abra el panel ahí.
    // OJO: el callback va con server.once('listening') y NO como argumento
    // de listen(): si el primer intento falla, Node no quita ese callback y
    // al reintentar se dispararía dos veces (doble waService.connect()).
    const PORT_FILE = path.join(__dirname, '.port');
    const preferredPort = Number(process.env.PORT) || 3000;
    let fellBack = false;
    server.once('listening', () => {
        const actualPort = server.address().port;
        fs.writeFileSync(PORT_FILE, String(actualPort));
        console.log(`🚀 Torre de Control Local + Sockets en puerto: ${actualPort}`);

        // 🔥 Arrancamos WhatsApp usando el Singleton
        waService.connect();
    });
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && !fellBack) {
            fellBack = true;
            console.warn(`⚠️ Puerto ${preferredPort} ocupado, buscando uno libre...`);
            server.listen(0);
        } else {
            throw err;
        }
    });
    server.listen(preferredPort);
};

bootstrap();