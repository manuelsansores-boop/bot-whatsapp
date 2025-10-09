const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
app.use(express.json());

// Crear cliente de WhatsApp.
// Esta es la versión simple que guarda la sesión en una carpeta temporal que Render crea y borra.
const client = new Client({
    authStrategy: new LocalAuth(),
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

// Generar código QR
client.on('qr', (qr) => {
    console.log('--------------------------------------------------');
    console.log('¡NUEVO CÓDIGO! Escanea con tu celular o haz clic en el enlace:');
    
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr)}`;
    
    console.log(qrImageUrl);
    console.log('--------------------------------------------------');

    qrcode.generate(qr, { small: true });
});

// WhatsApp listo
client.on('ready', () => {
    console.log('✅ WhatsApp conectado y listo!');
});

// Inicializar WhatsApp
client.initialize();

// API para recibir peticiones de envío
app.post('/enviar', async (req, res) => {
    const { numero, mensaje } = req.body;

    if (!numero || !mensaje) {
        return res.status(400).json({ success: false, error: 'El número y el mensaje son obligatorios.' });
    }
    
    try {
        const chatId = `${numero}@c.us`;
        await client.sendMessage(chatId, mensaje);
        console.log(`✅ Mensaje enviado a ${numero}`);
        res.json({ success: true, message: 'Mensaje enviado' });
    } catch (error) {
        console.error('❌ Error al enviar mensaje:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ruta de Health Check para que Render sepa que la app está viva
app.get('/', (req, res) => {
    res.status(200).json({ status: 'ok', message: 'WhatsApp API is running' });
});

// Levantar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});