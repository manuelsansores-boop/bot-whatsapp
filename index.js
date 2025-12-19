const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); // RECUERDA: npm install moment-timezone

// --- CONFIGURACIÓN ---
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

// --- ESTADO DEL SISTEMA ---
let isClientReady = false;
let messageQueue = [];
let isProcessingQueue = false;

// VARIABLES ANTI-BANEO (Lotes)
let mensajesEnRacha = 0;
let limiteRachaActual = 5; 

// --- MIDDLEWARE ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!MI_TOKEN_SECRETO || token !== MI_TOKEN_SECRETO) return res.status(403).json({ error: 'Acceso denegado' });
    next();
};

// --- CONFIGURACIÓN PUPPETEER ---
const client = new Client({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    authStrategy: new LocalAuth({ clientId: "client-safe-v3", dataPath: './data' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    },
    qrMaxRetries: 2
});

// --- UTILIDADES ---
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// 🛡️ [SEGURIDAD] CHECK DE HORARIO (MÉXICO)
const checkOfficeHours = () => {
    const now = moment().tz("America/Mexico_City");
    const hour = now.hour(); 
    return {
        isOpen: hour >= 8 && hour < 18, // Abierto de 8:00 AM a 5:59 PM
        hour: hour,
        timeString: now.format('HH:mm')
    };
};

// --- PROCESADOR MAESTRO ---
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady) return; // Si no está listo, no hacemos nada

    // 1. REVISIÓN DE HORARIO
    const officeStatus = checkOfficeHours();
    if (!officeStatus.isOpen) {
        if (officeStatus.hour >= 18) {
             console.log('🌙 CERRADO (Más de las 6 PM). Borrando cola.');
             messageQueue = []; // Vaciamos cola
             io.emit('status', '🌙 Oficina Cerrada. Cola vaciada.');
        } else {
             console.log('zzz Muy temprano. Reintentando en 10 min.');
             setTimeout(processQueue, 600000); 
        }
        return;
    }

    // 2. REVISIÓN DE RACHA (DESCANSOS LARGOS)
    if (mensajesEnRacha >= limiteRachaActual) {
        const minutosPausa = getRandomDelay(10, 20); 
        console.log(`☕ PAUSA LARGA DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso de seguridad (${minutosPausa} min)`);
        
        mensajesEnRacha = 0;
        limiteRachaActual = getRandomDelay(3, 7); // Próxima racha aleatoria
        
        setTimeout(() => {
            console.log('⚡ Volviendo al trabajo...');
            processQueue();
        }, minutosPausa * 60 * 1000);
        return;
    }

    isProcessingQueue = true;
    const item = messageQueue[0];

    try {
        // --- AQUÍ ESTÁ TU NUEVA REGLA DE LONGITUD ---
        // Limpiamos el número (quitamos guiones, espacios, paréntesis)
        let cleanNumber = item.numero.replace(/\D/g, '');

        // 🛡️ REGLA: Si no tiene 10 dígitos (ej: 5512345678) 
        // ni 12 dígitos empezando por 52 (ej: 5215512345678), LO DESCARTAMOS.
        const esLongitudValida = (cleanNumber.length === 10) || (cleanNumber.length === 12 && cleanNumber.startsWith('52')) || (cleanNumber.length === 13 && cleanNumber.startsWith('521'));
        
        if (!esLongitudValida) {
            console.log(`🚫 NÚMERO IGNORADO (Formato inválido): ${item.numero}`);
            throw new Error('Formato inválido (debe ser 10 dígitos MX)');
        }

        // Formatear correctamente para WhatsApp (agregar 52 si falta)
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';

        console.log(`⏳ Procesando ${item.numero}...`);

        // 3. TIEMPO DE "ESCRIBIENDO" (HUMANIZACIÓN)
        const typingDelay = getRandomDelay(4000, 8000); // 4 a 8 segundos
        await new Promise(r => setTimeout(r, typingDelay));

        // 4. VERIFICAR SI EXISTE EN WHATSAPP (LID CHECK)
        // Esto evita enviar mensajes a números fijos o inexistentes
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

        // SI HAY ERROR CRÍTICO (BANEO O DESCONEXIÓN), MATAR EL PROCESO
        if(error.message.includes('Protocol') || error.message.includes('destroyed')) {
            process.exit(1); 
        }
    } finally {
        messageQueue.shift(); // Sacar de la cola
        
        // 5. PAUSA ENTRE MENSAJES (MÍNIMO 1 MINUTO)
        const shortPause = getRandomDelay(60000, 90000); 
        console.log(`⏱️ Esperando ${Math.round(shortPause/1000)}s...`);
        
        setTimeout(() => {
            isProcessingQueue = false;
            processQueue();
        }, shortPause);
    }
};

// --- EVENTOS DEL CLIENTE ---

client.on('qr', (qr) => {
    console.log('📸 NUEVO QR GENERADO');
    io.emit('qr', qr);
    io.emit('status', '📸 ESCANEA EL QR AHORA');
});

client.on('ready', () => {
    console.log('🚀 CONEXIÓN EXITOSA');
    isClientReady = true;
    io.emit('status', '✅ BOT ACTIVO (Modo Seguro)');
    io.emit('connected', { name: client.info.pushname, number: client.info.wid.user });
    processQueue(); // Arrancar cola si hay pendientes
});

// SI SE DESCONECTA, SE MUERE EL PROCESO (PARA EVITAR BUCLES ZOMBIES)
client.on('disconnected', (reason) => {
    console.log(`💀 DESCONEXIÓN DETECTADA: ${reason}`);
    io.emit('status', '❌ Desconectado. Reiniciando servidor...');
    process.exit(0); // Muerte súbita para reinicio limpio
});

// --- API DE CONTROL ---

app.post('/iniciar-bot', authMiddleware, async (req, res) => {
    if (isClientReady) return res.json({ msg: 'Ya estaba encendido' });
    console.log('🟢 Iniciando motor...');
    client.initialize().catch(e => process.exit(1)); // Si falla al arrancar, reiniciar
    res.json({ success: true, message: 'Iniciando...' });
});

app.post('/detener-bot', authMiddleware, async (req, res) => {
    console.log('🔴 Deteniendo motor...');
    try { await client.destroy(); } catch(e) {}
    process.exit(0); // Apagado total
});

app.post('/enviar', authMiddleware, (req, res) => {
    const { numero, mensaje } = req.body;

    // 🔒 1. CANDADO DE SEGURIDAD (NUEVO)
    // Si tú no le has dado a "ENCENDER" en el panel, RECHAZA la petición.
    // Así evitas que se llene la cola mientras duermes.
    if (!isClientReady) {
        return res.status(503).json({ 
            success: false, 
            error: '⛔ EL BOT ESTÁ APAGADO. Enciéndelo primero desde el panel.' 
        });
    }

    // 2. Tu filtro de longitud (Tu idea de los 10 dígitos)
    if (!numero || numero.length < 10) {
        return res.status(400).json({ error: 'Número inválido o muy corto' });
    }
    
    // 3. Check de Horario
    const office = checkOfficeHours();
    if (office.hour >= 18) {
        return res.status(400).json({ error: 'Oficina cerrada (6 PM)' });
    }

    // Si pasa los filtros, recién ahí entra a la cola
    messageQueue.push({ numero, mensaje, resolve: (d) => res.json(d) });
    console.log(`📥 Mensaje recibido. Cola: ${messageQueue.length}`);
    processQueue();
});

app.post('/limpiar-cola', authMiddleware, (req, res) => {
    messageQueue = [];
    res.json({ success: true });
});

// RUTAS BASE
app.get('/', (req, res) => res.render('index'));
app.get('/status', (req, res) => res.json({ ready: isClientReady, cola: messageQueue.length }));

server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR SEGURO INICIADO EN PUERTO ${PORT}`);
});