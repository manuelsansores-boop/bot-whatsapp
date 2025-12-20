const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer'); // Necesario para generar el PDF

// ▼▼▼ FIX FFMPEG ▼▼▼
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;
// ▲▲▲ FIN FIX ▲▲▲

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

// CONFIGURACIÓN CLIENTE WHATSAPP
const client = new Client({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    authStrategy: new LocalAuth({ clientId: "client-v3-final", dataPath: './data' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
            '--single-process', '--disable-gpu'
        ]
    },
    qrMaxRetries: 5,
    ffmpegPath: ffmpegPath
});

// UTILIDADES
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// SIN HORARIOS (24/7 ACTIVO)
const checkOfficeHours = () => { return { isOpen: true }; };

// PROCESADOR DE COLA
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady) return; 

    // Pausa Anti-Ban
    if (mensajesEnRacha >= limiteRachaActual) {
        const minutosPausa = getRandomDelay(2, 5);
        console.log(`☕ PAUSA ${minutosPausa} MIN...`);
        io.emit('status', `☕ Descanso (${minutosPausa} min)`);
        mensajesEnRacha = 0;
        limiteRachaActual = getRandomDelay(3, 7); 
        setTimeout(() => { processQueue(); }, minutosPausa * 60 * 1000);
        return;
    }

    isProcessingQueue = true;
    const item = messageQueue[0];

    try {
        let cleanNumber = item.numero.replace(/\D/g, '');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';

        console.log(`⏳ Procesando ${item.numero}...`);
        await new Promise(r => setTimeout(r, 2000));

        const isRegistered = await client.isRegisteredUser(finalNumber);

        if (isRegistered) {
            if (item.mediaUrl) {
                // FOTO O DOCUMENTO
                try {
                    const media = await MessageMedia.fromUrl(item.mediaUrl, { unsafeMime: true });
                    await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                    console.log(`✅ MEDIA ENVIADA a ${item.numero}`);
                } catch (imgError) {
                    console.error("⚠️ Error media:", imgError);
                    await client.sendMessage(finalNumber, item.mensaje + `\n\n(Ver: ${item.mediaUrl})`);
                }
            } else {
                // TEXTO
                await client.sendMessage(finalNumber, item.mensaje);
                console.log(`✅ TEXTO ENVIADO a ${item.numero}`);
            }
            item.resolve({ success: true });
            mensajesEnRacha++; 
        } else {
            console.log(`⚠️ NO REGISTRADO: ${item.numero}`);
            item.resolve({ success: false, error: 'No registrado' });
        }
    } catch (error) {
        console.error('❌ Error envío:', error.message);
        item.resolve({ success: false, error: error.message });
        if(error.message && (error.message.includes('Protocol') || error.message.includes('destroyed'))) process.exit(1); 
    } finally {
        messageQueue.shift(); 
        setTimeout(() => { isProcessingQueue = false; processQueue(); }, 2000);
    }
};

// RUTA 1: ENVIAR SIMPLE
app.post('/enviar', authMiddleware, (req, res) => {
    const { numero, mensaje, media_url } = req.body;
    if (!isClientReady) return res.status(503).json({ error: 'Bot Apagado' });
    res.json({ success: true, message: 'Encolado' });
    messageQueue.push({ numero, mensaje, mediaUrl: media_url, resolve: () => {} });
    processQueue();
});

// ▼▼▼ RUTA 2: ENVIAR TICKET PDF (ARREGLADA) ▼▼▼
app.post('/enviar-ticket-pdf', authMiddleware, async (req, res) => {
    const { numero, datos_ticket, foto_evidencia } = req.body; 
    if (!isClientReady) return res.status(503).json({ error: 'Bot no listo' });

    res.json({ success: true, message: 'Generando PDF...' });

    try {
        console.log(`📄 Generando PDF para ${numero}...`);

        const htmlContent = `
        <html>
            <head>
                <style>
                    body { font-family: 'Arial', sans-serif; font-size: 12px; color: #000; padding: 20px; }
                    .ticket { width: 100%; max-width: 400px; margin: 0 auto; border: 1px solid #999; padding: 10px; }
                    .header, .footer { text-align: center; margin-bottom: 10px; border-bottom: 2px solid #000; padding-bottom: 10px; }
                    .header p, .footer p { margin: 2px 0; }
                    .bold { font-weight: bold; }
                    .big { font-size: 1.2em; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { text-align: left; padding: 5px; border-bottom: 1px solid #ccc; font-size: 11px; }
                    .totals { margin-top: 15px; text-align: right; }
                    .totals p { margin: 3px 0; }
                    .evidencia { margin-top: 20px; text-align: center; border-top: 2px dashed #000; padding-top: 10px; }
                    .evidencia img { max-width: 100%; height: auto; margin-top: 5px; }
                </style>
            </head>
            <body>
                <div class="ticket">
                    <div class="header">
                        <p class="bold big">FERROLÁMINAS RICHAUD SA DE CV</p>
                        <p>FRI90092879A</p>
                        <p>Sucursal: ${datos_ticket.sucursal || 'Matriz'}</p>
                        <p>Fecha: ${datos_ticket.fecha}</p>
                        <p class="bold big">Ticket: ${datos_ticket.folio}</p>
                    </div>
                    <div>
                        <p><span class="bold">Cliente:</span> ${datos_ticket.cliente}</p>
                        <p><span class="bold">Dirección:</span> ${datos_ticket.direccion}</p>
                    </div>
                    <div style="text-align:center; margin: 10px 0; font-weight:bold;">DETALLE DE COMPRA</div>
                    <table>
                        <thead>
                            <tr><th>Cant</th><th>Desc</th><th>Precio</th><th>Total</th></tr>
                        </thead>
                        <tbody>
                            ${datos_ticket.productos.map(p => `
                                <tr>
                                    <td>${p.cantidad} ${p.unidad}</td>
                                    <td>${p.descripcion}</td>
                                    <td>$${parseFloat(p.precio).toFixed(2)}</td>
                                    <td>$${(p.cantidad * p.precio).toFixed(2)}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                    <div class="totals">
                        <p>Subtotal: $${datos_ticket.subtotal}</p>
                        <p>Impuestos: $${datos_ticket.impuestos}</p>
                        <p class="bold big">TOTAL: $${datos_ticket.total}</p>
                    </div>
                    ${foto_evidencia ? `
                    <div class="evidencia">
                        <p class="bold">📸 EVIDENCIA DE ENTREGA</p>
                        <img src="${foto_evidencia}" />
                    </div>` : ''}
                    <div class="footer" style="margin-top: 20px; border:none;">
                        <p>GRACIAS POR SU COMPRA</p>
                        <p>www.ferrolaminas.com.mx</p>
                    </div>
                </div>
            </body>
        </html>`;

        // 1. LANZAMOS NAVEGADOR INDEPENDIENTE PARA EL PDF
        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close(); 

        // 2. CONVERSIÓN SEGURA A BASE64 (ARREGLA EL ERROR ATOB)
        const b64 = Buffer.from(pdfBuffer).toString('base64');
        const media = new MessageMedia('application/pdf', b64, `Ticket-${datos_ticket.folio}.pdf`);
        
        let chatId = numero.replace(/\D/g, '');
        if (chatId.length === 10) chatId = '52' + chatId;
        chatId = chatId + '@c.us';
        
        await client.sendMessage(chatId, media, { caption: "Su pedido ha sido entregado. Adjunto ticket y evidencia. 📄🏠" });
        console.log(`✅ PDF enviado a ${numero}`);

    } catch (e) {
        console.error("❌ Error PDF:", e);
    }
});

// APIs CONTROL
app.post('/iniciar-bot', authMiddleware, async (req, res) => {
    if (isClientReady) return res.json({ msg: 'Encendido' });
    clientInitialized = true;
    try { await client.initialize(); res.json({ success: true }); } 
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/detener-bot', authMiddleware, async (req, res) => {
    try { await client.destroy(); } catch(e) {}
    process.exit(0); 
});

app.post('/reset-session', authMiddleware, async (req, res) => {
    try {
        try { await client.destroy(); } catch(e) {}
        if (fs.existsSync('./data')) fs.rmSync('./data', { recursive: true, force: true });
        res.json({ success: true });
        setTimeout(() => process.exit(0), 1000);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/limpiar-cola', authMiddleware, (req, res) => { messageQueue = []; res.json({ success: true }); });
app.get('/', (req, res) => res.render('index'));
app.get('/status', (req, res) => res.json({ ready: isClientReady, cola: messageQueue.length }));

// SOCKETS
client.on('qr', (qr) => { io.emit('qr', qr); io.emit('status', '📸 ESCANEA AHORA'); });
client.on('ready', () => { isClientReady = true; io.emit('status', '✅ BOT ACTIVO'); processQueue(); });
client.on('authenticated', () => io.emit('status', '🔑 Cargando...'));
client.on('disconnected', () => { isClientReady = false; io.emit('status', '❌ Desconectado'); if (clientInitialized) process.exit(0); });

server.listen(PORT, () => { console.log(`🛡️ SERVIDOR EN PUERTO ${PORT}`); });