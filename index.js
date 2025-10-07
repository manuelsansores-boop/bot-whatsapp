const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

const app = express();
app.use(express.json());

// Crear cliente de WhatsApp
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox']
    }
});

// Generar código QR
// Generar código QR
client.on('qr', (qr) => {
    console.log('--------------------------------------------------');
    console.log('¡NUEVO CÓDIGO! Haz clic en el siguiente enlace RÁPIDAMENTE:');
    
    // Generamos un enlace a una imagen del QR usando una API
    const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qr)}`;
    
    console.log(qrImageUrl);
    console.log('--------------------------------------------------');
    console.log('Se abrirá una imagen en tu navegador. Escanéala con tu celular.');

    // También intentamos dibujarlo en la consola, no estorba.
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
    
    try {
        const chatId = `${numero}@c.us`;
        await client.sendMessage(chatId, mensaje);
        console.log(`✅ Mensaje enviado a ${numero}`);
        res.json({ success: true, mensaje: 'Mensaje enviado' });
    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Levantar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
});