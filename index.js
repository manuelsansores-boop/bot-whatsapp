const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// --- CONFIGURACIÓN ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;

app.use(express.json());
app.set('view engine', 'ejs');

// --- VARIABLES DE ESTADO Y COLA ---
let isClientReady = false;
let messageQueue = []; // Aquí se guardarán los mensajes antes de salir
let isProcessingQueue = false; // Semáforo para saber si estamos enviando

// --- MIDDLEWARE DE SEGURIDAD ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!MI_TOKEN_SECRETO) return res.status(500).json({ error: 'Configura AUTH_TOKEN en Render' });
    if (token !== MI_TOKEN_SECRETO) return res.status(403).json({ error: 'Token inválido' });
    next();
};

// --- CLIENTE WHATSAPP ---
const client = new Client({
    // Usamos el userAgent para parecer un navegador normal
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
    
    authStrategy: new LocalAuth({
        // ¡IMPORTANTE! Cambié el nombre a 'sesion-v3-limpia'.
        // Esto crea una carpeta nueva y evita el error de la sesión corrupta anterior.
        clientId: "sesion-v3-limpia", 
        dataPath: '/data'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Importante para ahorrar memoria en Render
            '--disable-gpu'
        ]
    }
});

// --- SISTEMA DE COLA (QUEUE) ---
// Esta función procesa los mensajes uno por uno para no saturar la memoria
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;

    isProcessingQueue = true;
    const item = messageQueue[0]; // Miramos el primer mensaje

    try {
        console.log(`⏳ Procesando mensaje para: ${item.numero}...`);
        
        // 1. Verificar si el usuario tiene WhatsApp (Soluciona error "No LID")
        // Formateamos el número para asegurar que termine en @c.us correctamente para la búsqueda
        const sanitizedNumber = item.numero.replace('@c.us', '') + '@c.us';
        
        // Preguntamos a WhatsApp si existe este ID
        const contact = await client.getNumberId(sanitizedNumber);

        if (contact) {
            // 2. Si existe, enviamos usando el ID serializado correcto
            await client.sendMessage(contact._serialized, item.mensaje);
            console.log(`✅ Enviado a ${item.numero}`);
            item.resolve({ success: true, message: 'Enviado correctamente' });
        } else {
            console.warn(`⚠️ El número ${item.numero} no está registrado en WhatsApp.`);
            item.resolve({ success: false, error: 'El número no tiene WhatsApp registrado' });
        }

    } catch (error) {
        console.error(`❌ Error enviando a ${item.numero}:`, error.message);
        // No fallamos la promesa, devolvemos success:false para que el cliente sepa
        item.resolve({ success: false, error: error.message });
    } finally {
        // 3. Limpieza y retardo
        messageQueue.shift(); // Sacamos el mensaje de la lista
        
        // Esperamos 5 SEGUNDOS antes del siguiente mensaje.
        // Esto es CRUCIAL para evitar que te bloqueen o se caiga el servidor.
        setTimeout(() => {
            isProcessingQueue = false;
            processQueue(); // Llamamos recursivamente para el siguiente
        }, 5000); 
    }
};

// --- EVENTOS DEL CLIENTE ---
client.on('qr', (qr) => {
    console.log('📸 Nuevo QR generado');
    io.emit('qr', qr);
    io.emit('status', 'Escanea el QR nuevo (Sesión reiniciada)');
});

client.on('ready', () => {
    console.log('🚀 WhatsApp listo!');
    isClientReady = true;
    io.emit('status', '✅ WhatsApp Conectado y Listo');
});

client.on('authenticated', () => {
    console.log('🔑 Autenticado correctamente');
    io.emit('status', 'Autenticado, cargando chats...');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Fallo de autenticación', msg);
    io.emit('status', 'Fallo de autenticación. Reiniciando...');
});

client.on('disconnected', (reason) => {
    console.log('❌ Desconectado:', reason);
    isClientReady = false;
    io.emit('status', '❌ Desconectado. El bot intentará reconectar...');
    client.initialize();
});

// Evento: Mensajes entrantes (opcional, para debug)
client.on('message', async (msg) => {
    if(msg.body === '!ping') {
        msg.reply('pong');
    }
});

// --- RUTAS API ---

app.get('/', (req, res) => {
    res.render('index');
});

// Ruta para ver estado de la cola (Utilidad nueva)
app.get('/cola', (req, res) => {
    res.json({ 
        pendientes: messageQueue.length, 
        procesando: isProcessingQueue 
    });
});

app.post('/enviar', authMiddleware, async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ success: false, error: 'Faltan datos' });
    }

    if (!isClientReady) {
        return res.status(503).json({ success: false, error: 'El bot no está listo todavía' });
    }

    // EN LUGAR DE ENVIAR DE GOLPE, AGREGAMOS A LA COLA
    // Creamos una promesa para responder al cliente HTTP cuando su turno pase
    new Promise((resolve, reject) => {
        messageQueue.push({ numero, mensaje, resolve, reject });
        processQueue(); // Intentamos arrancar la cola si está parada
    })
    .then((resultado) => {
        res.json(resultado);
    })
    .catch((err) => {
        res.status(500).json({ success: false, error: err.message });
    });
});

// --- INICIO ---
client.initialize();
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});