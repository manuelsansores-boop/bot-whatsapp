const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// --- CONFIGURACIÓN ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket', 'polling']
});
const PORT = process.env.PORT || 3000;
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;

app.use(express.json());
app.set('view engine', 'ejs');

// --- VARIABLES DE ESTADO Y COLA ---
let isClientReady = false;
let isClientConnected = false;
let messageQueue = [];
let isProcessingQueue = false;
let clientInitialized = false;
let isInitializing = false; 
let lastQRTime = null;
let qrRetryCount = 0;
const MAX_QR_RETRIES = 5;

// --- MIDDLEWARE DE SEGURIDAD ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!MI_TOKEN_SECRETO) return res.status(500).json({ error: 'Configura AUTH_TOKEN en Render' });
    if (token !== MI_TOKEN_SECRETO) return res.status(403).json({ error: 'Token inválido' });
    next();
};

// --- CONFIGURACIÓN DE PUPPETEER PARA RENDER ---
const puppeteerConfig = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions'
    ],
    timeout: 60000
};

// Solo agregar executablePath si estamos en Render
if (process.env.RENDER) {
    puppeteerConfig.executablePath = '/usr/bin/chromium-browser';
}

// --- CLIENTE WHATSAPP ---
const client = new Client({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    authStrategy: new LocalAuth({
        clientId: "sesion-v5-antibaneo", 
        dataPath: './data'
    }),
    puppeteer: puppeteerConfig,
    qrMaxRetries: MAX_QR_RETRIES
});

// --- FUNCIÓN DE VALIDACIÓN DE NÚMERO ---
const formatPhoneNumber = (numero) => {
    let cleaned = numero.replace(/\D/g, '');
    
    if (!cleaned.startsWith('52') && cleaned.length === 10) {
        cleaned = '52' + cleaned;
    }
    
    return cleaned + '@c.us';
};

// --- HELPER: GENERADOR DE TIEMPO ALEATORIO ---
const getRandomDelay = (min, max) => {
    return Math.floor(Math.random() * (max - min + 1) + min);
};

// --- SISTEMA DE COLA MEJORADO (CON ALEATORIEDAD) ---
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    if (!isClientReady || !isClientConnected) {
        console.log('⚠️ Cliente no está listo. Cola pausada. Total en cola:', messageQueue.length);
        return;
    }

    isProcessingQueue = true;
    const item = messageQueue[0];

    try {
        console.log(`⏳ Procesando mensaje ${messageQueue.length} restantes`);
        console.log(`   → Destinatario: ${item.numero}`);
        
        const formattedNumber = formatPhoneNumber(item.numero);
        
        // 🎲 ALEATORIEDAD 1: Simular tiempo de "escribiendo" o búsqueda (2 a 6 segundos)
        const typingDelay = getRandomDelay(2000, 6000);
        console.log(`⌨️ Simulando actividad humana (${typingDelay}ms)...`);
        await new Promise(resolve => setTimeout(resolve, typingDelay));
        
        const numberId = await client.getNumberId(formattedNumber);

        if (numberId && numberId._serialized) {
            await client.sendMessage(numberId._serialized, item.mensaje);
            console.log(`✅ Mensaje enviado exitosamente`);
            item.resolve({ success: true, message: 'Enviado correctamente' });
        } else {
            console.warn(`⚠️ Número sin WhatsApp: ${item.numero}`);
            item.resolve({ success: false, error: 'Número no registrado en WhatsApp' });
        }

    } catch (error) {
        console.error(`❌ Error al enviar:`, error.message);
        
        if (error.message.includes('startComms') || 
            error.message.includes('Evaluation failed') ||
            error.message.includes('Protocol error')) {
            
            console.log('🔄 Error crítico detectado. Cliente debe reiniciarse manualmente.');
            isClientConnected = false;
            isClientReady = false;
            
            // Rechazar todos los mensajes pendientes
            messageQueue.forEach(msg => {
                msg.resolve({ 
                    success: false, 
                    error: 'Cliente desconectado. Reinicia el servicio desde Render.' 
                });
            });
            messageQueue = [];
            
            item.resolve({ success: false, error: 'Cliente desconectado. Reinicia manualmente.' });
        } else {
            item.resolve({ success: false, error: error.message });
        }
    } finally {
        messageQueue.shift();
        
        // 🎲 ALEATORIEDAD 2: Tiempo de espera variable entre mensajes
        // Mínimo: 60 segundos | Máximo: 100 segundos
        const minTime = 60000;
        const maxTime = 100000;
        const randomWait = getRandomDelay(minTime, maxTime);
        
        console.log(`🎲 Intervalo aleatorio generado: ${Math.floor(randomWait/1000)}s`);
        console.log(`⏸️ Esperando antes del siguiente mensaje...`);
        
        setTimeout(() => {
            isProcessingQueue = false;
            processQueue();
        }, randomWait);
    }
};

// --- EVENTOS DEL CLIENTE ---
let qrGenerated = false;

client.on('qr', (qr) => {
    if (qrGenerated) {
        console.log('⏭️ QR ya fue generado, ignorando duplicado');
        return;
    }
    
    const now = Date.now();
    
    // Evitar spam de QRs
    if (lastQRTime && (now - lastQRTime) < 15000) {
        console.log('⏭️ QR generado muy rápido, ignorando...');
        return;
    }
    
    lastQRTime = now;
    qrRetryCount++;
    qrGenerated = true;
    
    console.log(`📸 QR generado (${qrRetryCount}/${MAX_QR_RETRIES})`);
    io.emit('qr', qr);
    io.emit('status', `Escanea el QR (intento ${qrRetryCount}/${MAX_QR_RETRIES})`);
    
    if (qrRetryCount >= MAX_QR_RETRIES) {
        console.log('⚠️ Máximo de intentos QR alcanzado');
        io.emit('status', '⛔ Límite alcanzado. Reinicia el servicio manualmente.');
    }
    
    // Reset después de 60 segundos (para el siguiente QR)
    setTimeout(() => {
        qrGenerated = false;
    }, 60000);
});

client.on('authenticated', () => {
    console.log('🔐 Autenticación exitosa');
    qrRetryCount = 0;
    qrGenerated = false;
    io.emit('status', 'Autenticado. Iniciando WhatsApp Web...');
});

client.on('loading_screen', (percent, message) => {
    if (percent % 25 === 0) { 
        console.log(`⏳ Cargando: ${percent}%`);
    }
    io.emit('status', `Cargando: ${percent}%`);
});

// 🔒 IMPORTANTE: Solo un evento 'ready'
let readyFired = false;

client.on('ready', async () => {
    if (readyFired) {
        console.log('⚠️ Evento "ready" ya se ejecutó, ignorando duplicado');
        return;
    }
    readyFired = true;
    
    console.log('🚀 WhatsApp Web listo!');
    console.log('⏱️ Esperando 45 segundos para estabilizar...');
    
    await new Promise(resolve => setTimeout(resolve, 45000));
    
    isClientReady = true;
    isClientConnected = true;
    
    const info = client.info;
    console.log(`✅ Conectado como: ${info.pushname || 'Usuario'}`);
    console.log(`📱 Número: ${info.wid.user}`);
    
    io.emit('status', `✅ Listo - ${info.pushname || 'Bot Activo'}`);
    io.emit('connected', { name: info.pushname, number: info.wid.user });
    
    if (messageQueue.length > 0) {
        console.log(`📨 Procesando ${messageQueue.length} mensajes pendientes...`);
        processQueue();
    }
});

client.on('auth_failure', (msg) => {
    console.error('❌ Fallo de autenticación:', msg);
    isClientReady = false;
    isClientConnected = false;
    readyFired = false;
    qrGenerated = false;
    io.emit('status', '❌ Error de autenticación. Reinicia el servicio.');
});

// 🔒 CRÍTICO: NO reiniciar automáticamente
client.on('disconnected', (reason) => {
    console.log('❌ Desconectado:', reason);
    isClientReady = false;
    isClientConnected = false;
    readyFired = false;
    qrGenerated = false;
    io.emit('status', '❌ Desconectado. REINICIA MANUALMENTE desde Render.');
    
    // Limpiar mensajes pendientes
    if (messageQueue.length > 0) {
        console.log(`🗑️ Limpiando ${messageQueue.length} mensajes pendientes`);
        messageQueue.forEach(msg => {
            msg.resolve({ success: false, error: 'Desconectado. Reinicia el servicio.' });
        });
        messageQueue = [];
    }
    
    // 🚫 NO REINICIAR: process.exit(1) forzará a Render a reiniciar el servicio
    console.log('🛑 El servicio debe reiniciarse manualmente para evitar loops.');
});

client.on('message', async (msg) => {
    if (msg.body === '!ping') {
        msg.reply('pong - Bot activo ✅');
    }
    if (msg.body === '!info') {
        msg.reply(`Cola: ${messageQueue.length} mensajes\nEstado: ${isClientReady ? 'Listo ✅' : 'No listo ❌'}`);
    }
});

// --- RUTAS API ---
app.get('/', (req, res) => {
    res.render('index');
});

app.get('/health', (req, res) => {
    res.json({
        status: 'running',
        whatsapp: {
            ready: isClientReady,
            connected: isClientConnected,
            initialized: clientInitialized
        },
        queue: {
            pending: messageQueue.length,
            processing: isProcessingQueue
        },
        uptime: process.uptime()
    });
});

app.get('/status', (req, res) => {
    res.json({
        ready: isClientReady,
        connected: isClientConnected,
        cola_pendiente: messageQueue.length,
        procesando: isProcessingQueue
    });
});

app.get('/cola', authMiddleware, (req, res) => {
    res.json({ 
        pendientes: messageQueue.length, 
        procesando: isProcessingQueue,
        cliente_listo: isClientReady,
        cliente_conectado: isClientConnected,
        lista_numeros: messageQueue.map(m => m.numero)
    });
});

app.post('/enviar', authMiddleware, async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ 
            success: false, 
            error: 'Faltan parámetros: numero y mensaje son requeridos' 
        });
    }

    if (!isClientReady || !isClientConnected) {
        return res.status(503).json({ 
            success: false, 
            error: 'Bot no está listo. Escanea el QR o espera la conexión.',
            ready: isClientReady,
            connected: isClientConnected
        });
    }

    // Limitar cola a 50 mensajes
    if (messageQueue.length >= 50) {
        return res.status(429).json({
            success: false,
            error: 'Cola llena (50 mensajes). Espera a que se procesen.'
        });
    }

    const promise = new Promise((resolve) => {
        messageQueue.push({ numero, mensaje, resolve });
        console.log(`📥 Nuevo mensaje en cola. Total: ${messageQueue.length}`);
        processQueue();
    });

    try {
        const resultado = await promise;
        res.json(resultado);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/limpiar-cola', authMiddleware, (req, res) => {
    const cantidadEliminada = messageQueue.length;
    
    messageQueue.forEach(msg => {
        msg.resolve({ success: false, error: 'Cola limpiada manualmente' });
    });
    
    messageQueue = [];
    isProcessingQueue = false;
    
    console.log(`🗑️ Cola limpiada: ${cantidadEliminada} mensajes eliminados`);
    
    res.json({ 
        success: true, 
        mensaje: `Se eliminaron ${cantidadEliminada} mensajes de la cola` 
    });
});

// --- INICIO ÚNICO ---
if (!clientInitialized && !isInitializing) {
    isInitializing = true;
    clientInitialized = true;
    
    console.log('🔄 Inicializando cliente WhatsApp...');
    console.log('📍 Usando sesión: sesion-v5-antibaneo');
    console.log('🌍 Entorno:', process.env.RENDER ? 'Render' : 'Local');
    
    client.initialize().then(() => {
        isInitializing = false;
        console.log('✅ Cliente inicializado correctamente');
    }).catch(err => {
        console.error('❌ Error crítico al inicializar:', err);
        isInitializing = false;
        clientInitialized = false;
        process.exit(1);
    });
}

// Manejo de señales para cierre limpio
process.on('SIGINT', async () => {
    console.log('\n🛑 Cerrando servidor...');
    await client.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Señal SIGTERM recibida...');
    await client.destroy();
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Excepción no capturada:', error);
    process.exit(1);
});

server.listen(PORT, () => {
    const isRender = !!process.env.RENDER;
    const publicUrl = isRender 
        ? (process.env.RENDER_EXTERNAL_URL || 'https://bot-whatsapp.onrender.com')
        : `http://localhost:${PORT}`;
    
    console.log('='.repeat(50));
    console.log(`✅ Servidor WhatsApp Bot iniciado`);
    console.log(`📡 Puerto: ${PORT}`);
    console.log(`🔐 Auth: ${MI_TOKEN_SECRETO ? 'Configurado ✅' : 'NO CONFIGURADO ❌'}`);
    console.log(`🌐 URL: ${publicUrl}`);
    console.log(`📍 Entorno: ${isRender ? '☁️ Render' : '💻 Local'}`);
    console.log('='.repeat(50));
});