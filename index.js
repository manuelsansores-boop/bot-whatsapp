const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");

// --- 1. CONFIGURACIÓN DEL SERVIDOR WEB ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.set('view engine', 'ejs');

// *** VÁLVULA DE SEGURIDAD (NUEVO) ***
// Variable para saber si el bot está listo y evitar errores al enviar
let isClientReady = false;

// --- 2. SEGURIDAD: Middleware para el Token de la API ---
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;

const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!MI_TOKEN_SECRETO) {
        console.error("AUTH_TOKEN no está configurado en las variables de entorno.");
        return res.status(500).json({ success: false, error: 'Error de configuración del servidor.' });
    }
    if (token == null) {
        return res.status(401).json({ success: false, error: 'No se proveyó un token de autorización.' });
    }
    if (token !== MI_TOKEN_SECRETO) {
        return res.status(403).json({ success: false, error: 'El token proporcionado no es válido.' });
    }
    next();
};


const client = new Client({
    // 1. EL DISFRAZ (¡NUEVO IMPORTANTE!)
    // Esto hace creer a WhatsApp que eres una PC normal y evita el bloqueo "VERSION"
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36',
    
    authStrategy: new LocalAuth({
        clientId: "sesion-final-v3", // <--- CAMBIAMOS EL NOMBRE OTRA VEZ
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
            '--single-process',
            '--disable-gpu'
        ]
    },
     // *** CORRECCIÓN DE VERSIÓN (NUEVO) ***
    // Esto evita el error "reading getChat"
    /*webVersionCache: {
        type: "remote",
        remotePath:
            "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html",
    },
    */
});

// --- 4. LÓGICA DE EVENTOS DE WHATSAPP ---

// Evento para la conexión con la página web
io.on('connection', (socket) => {
    console.log('✅ Un usuario se ha conectado a la página web.');
    socket.emit('status', 'Iniciando WhatsApp...');
});

// Evento para generar el código QR
// Evento para generar el código QR
client.on('qr', (qr) => {
    // Creamos una fecha legible para que sepas si es viejo o nuevo
    const hora = new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' });
    console.log(`[${hora}] 📸 NUEVO CÓDIGO QR GENERADO. ¡Corre a escanear!`);
    
    io.emit('qr', qr);
    io.emit('status', `Código QR nuevo recibido a las ${hora}. ¡Escanea rápido!`);
});

// Evento cuando el cliente está listo
client.on('ready', () => {
    console.log('✅ WhatsApp conectado y listo para operar!');
    io.emit('status', '✅ ¡WhatsApp conectado y listo!');
    isClientReady = true; // <--- ACTIVAMOS LA VÁLVULA
});

// Evento de desconexión
client.on('disconnected', (reason) => {
    console.log('❌ WhatsApp fue desconectado:', reason);
    io.emit('status', '❌ WhatsApp desconectado. Intentando reconectar...');
    isClientReady = false; // <--- CERRAMOS LA VÁLVULA
    client.initialize();
});

// Evento para escuchar mensajes (de otros y tuyos)
client.on('message', async (msg) => {
    // --- Bloque de depuración: Imprime detalles de CADA mensaje detectado ---
    console.log('--- ¡NUEVO MENSAJE DETECTADO! ---');
    console.log('ID del Chat:', msg.from);
    console.log('Enviado por mí?:', msg.fromMe);
    console.log('Cuerpo del Mensaje:', msg.body);
    console.log('¿Es un grupo?:', msg.isGroup);
    console.log('---------------------------------');

    // Ignoramos solo los mensajes de estados para no procesarlos
    if (msg.isStatus) return;

    // LÓGICA PARA TUS PROPIOS MENSAJES (CONTROL REMOTO)
    if (msg.fromMe) {
        const textoEnviado = msg.body.toLowerCase();
        const chatDondeEscribiste = msg.to;

        if (textoEnviado === '!status') {
            await client.sendMessage(chatDondeEscribiste, '🤖✅ Bot conectado y funcionando.');
        }

        if (textoEnviado.startsWith('!decir ')) {
            const mensajeParaRepetir = msg.body.substring(7);
            await client.sendMessage(chatDondeEscribiste, mensajeParaRepetir);
        }
    
    // LÓGICA PARA MENSAJES RECIBIDOS DE OTRAS PERSONAS (CHATBOT)
    } else {
        const textoRecibido = msg.body.toLowerCase();
        const remitente = msg.from;
        
        if (textoRecibido === 'hola') {
            await client.sendMessage(remitente, '¡Hola! 👋 ¿en qué puedo ayudarte?');
        }

        if (textoRecibido === 'fecha') {
            const fechaActual = new Date().toLocaleString('es-MX', { timeZone: 'America/Mexico_City' });
            await client.sendMessage(remitente, `La fecha y hora actual es: ${fechaActual}`);
        }
    }
});

// Evento para saber el estado de entrega de los mensajes que envías
client.on('message_ack', (msg, ack) => {
    /* ACK STATUS: 1=ENVIADO, 2=ENTREGADO, 3=LEÍDO */
    if (ack == 3) {
        console.log(`MENSAJE a ${msg.to} fue LEÍDO.`);
    }
});

// --- 5. INICIAR EL CLIENTE DE WHATSAPP ---
client.initialize();

// --- 6. DEFINICIÓN DE RUTAS DE LA API ---

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

    // *** PROTECCIÓN (NUEVO) ***
    // Si el bot no está listo, rechazamos la petición para evitar que Render se caiga
    if (!isClientReady) {
        return res.status(503).json({ 
            success: false, 
            error: 'El bot aún se está iniciando o reconectando. Espera unos segundos.' 
        });
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

// --- 7. INICIAR SERVIDOR WEB ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});