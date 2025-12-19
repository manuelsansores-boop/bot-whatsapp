const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});
const PORT = process.env.PORT || 3000;
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;

app.use(express.json());
app.set('view engine', 'ejs');

// ESTADO
let isClientReady = false;
let messageQueue = [];
let isProcessingQueue = false;
let clientInitialized = false;
let mensajesEnRacha = 0;
let limiteRachaActual = 5; 

// MIDDLEWARE
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!MI_TOKEN_SECRETO || token !== MI_TOKEN_SECRETO) return res.status(403).json({ error: 'Acceso denegado' });
    next();
};

// CONFIGURACIÓN PUPPETEER BLINDADA PARA RENDER
const client = new Client({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    authStrategy: new LocalAuth({ clientId: "client-v3-final", dataPath: './data' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', 
            '--disable-gpu'
        ]
    },
    qrMaxRetries: 5
});

// UTILIDADES
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

const checkOfficeHours = () => {
    const now = moment().tz("America/Mexico_City");
    const hour = now.hour(); 
    return { isOpen: hour >= 8 && hour < 18, hour: hour, timeString: now.format('HH:mm') };
};

// PROCESADOR DE COLA
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady) return; 

    // 1. CHEQUEO HORARIO
    const officeStatus = checkOfficeHours();
    if (!officeStatus.isOpen) {
        if (officeStatus.hour >= 18) {
             console.log('🌙 CERRADO. Borrando cola.');
             messageQueue = []; 
             io.emit('status', '🌙 Oficina Cerrada. Cola vaciada.');
        } else {
             console.log('zzz Muy temprano.');
             setTimeout(processQueue, 600000); 
        }
        return;
    }

    // 2. PAUSAS LARGAS (ANTI-BAN)
    if (mensajesEnRacha >= limiteRachaActual) {
        const minutosPausa = getRandomDelay(10, 20); 
        console.log(`☕ PAUSA LARGA DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso de seguridad (${minutosPausa} min)`);
        mensajesEnRacha = 0;
        limiteRachaActual = getRandomDelay(3, 7); 
        setTimeout(() => { console.log('⚡ Volviendo...'); processQueue(); }, minutosPausa * 60 * 1000);
        return;
    }

    isProcessingQueue = true;
    const item = messageQueue[0];

    try {
        // FILTRO DE NÚMERO (TU REGLA)
        let cleanNumber = item.numero.replace(/\D/g, '');
        const esLongitudValida = (cleanNumber.length === 10) || (cleanNumber.length === 12 && cleanNumber.startsWith('52')) || (cleanNumber.length === 13 && cleanNumber.startsWith('521'));
        
        if (!esLongitudValida) throw new Error('Formato inválido (10 dígitos)');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';

        console.log(`⏳ Procesando ${item.numero}...`);
        
        // Simular escritura humana
        const typingDelay = getRandomDelay(4000, 8000);
        await new Promise(r => setTimeout(r, typingDelay));

        const isRegistered = await client.isRegisteredUser(finalNumber);

        if (isRegistered) {
            await client.sendMessage(finalNumber, item.mensaje);
            console.log(`✅ ENVIADO a ${item.numero}`);
            item.resolve({ success: true });
            mensajesEnRacha++; 
        } else {
            console.log(`⚠️ NO TIENE WHATSAPP: ${item.numero}`);
            item.resolve({ success: false, error: 'Número no registrado' });
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        item.resolve({ success: false, error: error.message });
        
        // KILL SWITCH: Si hay ban o error grave, matamos el proceso
        if(error.message.includes('Protocol') || error.message.includes('destroyed')) {
            console.log('💀 Error crítico. Reiniciando...');
            process.exit(1); 
        }
    } finally {
        messageQueue.shift(); 
        const shortPause = getRandomDelay(60000, 90000); 
        console.log(`⏱️ Esperando ${Math.round(shortPause/1000)}s...`);
        setTimeout(() => { isProcessingQueue = false; processQueue(); }, shortPause);
    }
};

// EVENTOS
client.on('qr', (qr) => {
    console.log('📸 NUEVO QR');
    io.emit('qr', qr);
    io.emit('status', '📸 ESCANEA EL QR AHORA');
});

client.on('ready', () => {
    console.log('🚀 CONEXIÓN EXITOSA');
    isClientReady = true;
    io.emit('status', '✅ BOT ACTIVO (Modo Seguro)');
    io.emit('connected', { name: client.info.pushname, number: client.info.wid.user });
    processQueue(); 
});

client.on('authenticated', () => {
    console.log('🔑 Autenticado...');
    io.emit('status', '🔑 Sesión encontrada, cargando...');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Error Auth:', msg);
    io.emit('status', '❌ Error de sesión. Dale a Resetear.');
});

client.on('disconnected', (reason) => {
    console.log(`💀 DESCONEXIÓN: ${reason}`);
    io.emit('status', '❌ Desconectado. Reiniciando...');
    isClientReady = false;
    if (clientInitialized) process.exit(0); 
});

// API
app.post('/iniciar-bot', authMiddleware, async (req, res) => {
    if (isClientReady) return res.json({ msg: 'Ya estaba encendido' });
    if (clientInitialized) return res.json({ msg: 'Ya se está iniciando...' });
    console.log('🟢 Iniciando motor...');
    clientInitialized = true;
    try {
        await client.initialize();
        res.json({ success: true, message: 'Iniciando... (Espera el QR)' });
    } catch (e) {
        console.error('❌ Error al inicializar:', e);
        clientInitialized = false;
        res.status(500).json({ error: e.message });
    }
});

app.post('/detener-bot', authMiddleware, async (req, res) => {
    console.log('🔴 Deteniendo...');
    try { await client.destroy(); } catch(e) {}
    process.exit(0); 
});

app.post('/reset-session', authMiddleware, async (req, res) => {
    console.log('☢️ BORRANDO SESIÓN...');
    try {
        try { await client.destroy(); } catch(e) {}
        const sessionPath = path.join(__dirname, 'data');
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('✅ Sesión borrada');
        clientInitialized = false;
        isClientReady = false;
        io.emit('status', '🗑️ Sesión borrada. Reiniciando...');
        res.json({ success: true, message: 'Sesión eliminada.' });
        setTimeout(() => process.exit(0), 1000);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/enviar', authMiddleware, (req, res) => {
    const { numero, mensaje } = req.body;
    
    // Si el bot está apagado, RECHAZAR mensaje
    if (!isClientReady) return res.status(503).json({ success: false, error: '⛔ BOT APAGADO.' });
    
    // Validación de 10 dígitos
    if (!numero || numero.length < 10) return res.status(400).json({ error: 'Número inválido' });
    
    // Validación de horario
    const office = checkOfficeHours();
    if (office.hour >= 18) return res.status(400).json({ error: 'Oficina cerrada' });

    messageQueue.push({ numero, mensaje, resolve: (d) => res.json(d) });
    console.log(`📥 Mensaje recibido. Cola: ${messageQueue.length}`);
    processQueue();
});

app.post('/limpiar-cola', authMiddleware, (req, res) => {
    messageQueue = [];
    res.json({ success: true });
});

app.get('/', (req, res) => res.render('index'));
app.get('/status', (req, res) => res.json({ ready: isClientReady, cola: messageQueue.length }));

server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR FINAL INICIADO EN PUERTO ${PORT}`);
});