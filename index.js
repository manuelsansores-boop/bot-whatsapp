const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// --- CONFIGURACIÓN DEL SERVIDOR WEB ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.set('view engine', 'ejs'); // Usaremos EJS para renderizar la página HTML

// --- SEGURIDAD: Middleware para el Token ---
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    // El formato del header es "Bearer TOKEN"
    const token = authHeader && authHeader.split(' ')[1];

    if (!MI_TOKEN_SECRETO) {
        // Si no se configuró un token en el servidor, se deniega por seguridad.
        console.error("AUTH_TOKEN no está configurado en las variables de entorno.");
        return res.status(500).json({ success: false, error: 'Error de configuración del servidor.' });
    }

    if (token == null) {
        return res.status(401).json({ success: false, error: 'No se proveyó un token de autorización.' });
    }

    if (token !== MI_TOKEN_SECRETO) {
        return res.status(403).json({ success: false, error: 'El token proporcionado no es válido.' });
    }
    
    // Si el token es correcto, la petición continúa.
    next();
};


// --- CONFIGURACIÓN DE WHATSAPP-WEB.JS ---
// Usamos el path del Disco Persistente de Render para guardar la sesión
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: '/data' // ¡Esta es la clave para la persistencia!
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
            '--single-process',
            '--disable-gpu'
        ]
    }
});


// --- LÓGICA DE LA APLICACIÓN Y COMUNICACIÓN WEB ---

// 1. Cuando un navegador se conecta a nuestra página web
io.on('connection', (socket) => {
    console.log('✅ Un usuario se ha conectado a la página web.');
    socket.emit('status', 'Iniciando WhatsApp...'); // Informa al nuevo usuario

    socket.on('disconnect', () => {
        console.log('❌ Un usuario se ha desconectado de la página web.');
    });
});

// 2. Eventos del cliente de WhatsApp
client.on('qr', (qr) => {
    console.log('--------------------------------------------------');
    console.log('¡NUEVO CÓDIGO QR! Escanea desde la página web.');
    console.log('--------------------------------------------------');
    io.emit('qr', qr); // Envía el código QR a la página web
    io.emit('status', 'Código QR recibido. Por favor, escanea.');
});

client.on('ready', () => {
    console.log('✅ WhatsApp conectado y listo para operar!');
    io.emit('status', '✅ ¡WhatsApp conectado y listo!'); // Informa a la web que está listo
});

client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp fue desconectado:', reason);
    io.emit('status', '❌ WhatsApp desconectado. Intentando reconectar...');
    client.initialize(); // Intenta reinicializar para obtener un nuevo QR si es necesario
});

// Iniciar el cliente de WhatsApp
client.initialize();


// --- DEFINICIÓN DE RUTAS (ENDPOINTS) ---

// Ruta principal para mostrar la interfaz gráfica
app.get('/', (req, res) => {
    res.render('index');
});

// Ruta para enviar mensajes (protegida por el token)
app.post('/enviar', authMiddleware, async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ success: false, error: 'El número y el mensaje son obligatorios.' });
    }
    
    try {
        const chatId = `${numero}@c.us`;
        await client.sendMessage(chatId, mensaje);
        console.log(`✅ Mensaje enviado a ${numero}`);
        res.json({ success: true, message: 'Mensaje enviado correctamente.' });
    } catch (error) {
        console.error('❌ Error al enviar mensaje:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


// --- INICIAR SERVIDOR ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});