const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 
const puppeteer = require('puppeteer'); 

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

// CONFIGURACIÓN PUPPETEER
const client = new Client({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    authStrategy: new LocalAuth({ clientId: "client-v3-final", dataPath: './data' }),
    // En tu archivo index.js, busca la parte de "puppeteer: {"
puppeteer: {
    headless: true,
    // ▼▼▼ AGREGA ESTA LÍNEA OBLIGATORIAMENTE ▼▼▼
    protocolTimeout: 300000, // Le damos 5 minutos de paciencia en lugar de 30 seg
    // ▲▲▲ FIN DEL AGREGADO ▲▲▲
    args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage', // Esto es vital en servidores Linux/Render
        '--disable-accelerated-2d-canvas', 
        '--no-first-run', 
        '--no-zygote',
        '--single-process', 
        '--disable-gpu',
        // RECOMENDACIÓN EXTRA: Limita la RAM que Node cree que tiene
        '--js-flags="--max-old-space-size=1024"' 
    ]
},
    qrMaxRetries: 5,
    ffmpegPath: ffmpegPath
});

// UTILIDADES
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

const checkOfficeHours = () => { return { isOpen: true }; };

// --- FUNCIÓN PARA GENERAR EL PDF (DENTRO DE LA COLA) ---
async function generarYEnviarPDF(item, client) {
    try {
        console.log(`📄 Generando PDF en cola para ${item.numero}...`);
        const { datos_ticket, foto_evidencia } = item.pdfData;

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

        const browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close(); 

        const b64 = Buffer.from(pdfBuffer).toString('base64');
        const media = new MessageMedia('application/pdf', b64, `Ticket-${datos_ticket.folio}.pdf`);
        
        let chatId = item.numero.replace(/\D/g, '');
        if (chatId.length === 10) chatId = '52' + chatId;
        chatId = chatId + '@c.us';
        
        // USAMOS EL MENSAJE DINÁMICO QUE VIENE DE LA LAMBDA
        const captionFinal = item.mensaje || "Su pedido ha sido entregado. Adjunto ticket y evidencia. 📄🏠";

        await client.sendMessage(chatId, media, { caption: captionFinal });
        console.log(`✅ PDF enviado a ${item.numero}`);
        return true;

    } catch (e) {
        console.error("❌ Error generando/enviando PDF:", e);
        return false;
    }
}

// --- PROCESADOR DE COLA MAESTRO ---
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady) return; 

    // ▼▼▼ AQUÍ ESTÁ LA PAUSA DE MINUTOS (10 a 20) ▼▼▼
    if (mensajesEnRacha >= limiteRachaActual) {
        const minutosPausa = getRandomDelay(10, 20); 
        console.log(`☕ PAUSA LARGA DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso de seguridad (${minutosPausa} min)`);
        mensajesEnRacha = 0;
        limiteRachaActual = getRandomDelay(3, 7); 
        setTimeout(() => { console.log('⚡ Volviendo...'); processQueue(); }, minutosPausa * 60 * 1000);
        return;
    }
    // ▲▲▲ FIN PAUSA MINUTOS ▲▲▲

    isProcessingQueue = true;
    const item = messageQueue[0];

    try {
        let cleanNumber = item.numero.replace(/\D/g, '');
        const esLongitudValida = (cleanNumber.length === 10) || (cleanNumber.length === 12 && cleanNumber.startsWith('52')) || (cleanNumber.length === 13 && cleanNumber.startsWith('521'));
        
        if (!esLongitudValida) throw new Error('Formato inválido');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';

        console.log(`⏳ Procesando ${item.numero}...`);
        
        // --- TIEMPO DE ESPERA "ESCRIBIENDO" (4 a 8 seg) ---
        const typingDelay = getRandomDelay(4000, 8000);
        await new Promise(r => setTimeout(r, typingDelay));

        const isRegistered = await client.isRegisteredUser(finalNumber);

        if (isRegistered) {
            // LÓGICA DE ENVÍO
            if (item.type === 'pdf') {
                await generarYEnviarPDF(item, client);
            } else {
                if (item.mediaUrl) {
                    try {
                        const media = await MessageMedia.fromUrl(item.mediaUrl, { 
                            unsafeMime: true,
                            reqOptions: { headers: { 'User-Agent': 'Mozilla/5.0...' } }
                        });
                        await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                        console.log(`✅ FOTO ENVIADA a ${item.numero}`);
                    } catch (imgError) {
                        console.error("⚠️ Error img:", imgError);
                        await client.sendMessage(finalNumber, item.mensaje + `\n\n(Link: ${item.mediaUrl})`);
                    }
                } else {
                    await client.sendMessage(finalNumber, item.mensaje);
                    console.log(`✅ TEXTO ENVIADO a ${item.numero}`);
                }
            }
            item.resolve({ success: true });
            mensajesEnRacha++; 
        } else {
            console.log(`⚠️ NO REGISTRADO: ${item.numero}`);
            item.resolve({ success: false, error: 'Número no registrado' });
        }
    } catch (error) {
        console.error('❌ Error:', error.message);
        item.resolve({ success: false, error: error.message });
        if(error.message && (error.message.includes('Protocol') || error.message.includes('destroyed'))) {
            process.exit(1); 
        }
    } finally {
        messageQueue.shift(); 
        
        // --- TIEMPO DE ESPERA POST-ENVÍO (60 a 90 seg) ---
        const shortPause = getRandomDelay(60000, 90000); 
        console.log(`⏱️ Esperando ${Math.round(shortPause/1000)}s...`);
        setTimeout(() => { isProcessingQueue = false; processQueue(); }, shortPause);
    }
};

// RUTA 1: ENVIAR SIMPLE
app.post('/enviar', authMiddleware, (req, res) => {
    const { numero, mensaje, media_url } = req.body;
    
    if (!isClientReady) return res.status(503).json({ success: false, error: '⛔ BOT APAGADO.' });
    if (!numero || numero.length < 10) return res.status(400).json({ error: 'Número inválido' });
    
    const office = checkOfficeHours();
    if (!office.isOpen) return res.status(400).json({ error: 'Oficina cerrada' });

    res.json({ success: true, message: 'Encolado', status: 'queued' });
    messageQueue.push({ 
        type: 'normal',
        numero, 
        mensaje, 
        mediaUrl: media_url, 
        resolve: () => {} 
    });
    processQueue();
});

// RUTA 2: ENVIAR TICKET PDF (ENCOLADOS)
app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    const { numero, datos_ticket, foto_evidencia, mensaje } = req.body; 

    if (!isClientReady) return res.status(503).json({ success: false, error: 'Bot no listo' });

    res.json({ success: true, message: 'PDF Encolado...' });

    messageQueue.push({
        type: 'pdf',
        numero,
        mensaje, 
        pdfData: { datos_ticket, foto_evidencia },
        resolve: () => {}
    });
    processQueue();
});

// APIs de Control
app.post('/iniciar-bot', authMiddleware, async (req, res) => {
    if (isClientReady) return res.json({ msg: 'Ya estaba encendido' });
    console.log('🟢 Iniciando motor...');
    clientInitialized = true;
    try { await client.initialize(); res.json({ success: true }); } 
    catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/detener-bot', authMiddleware, async (req, res) => {
    console.log('🔴 Deteniendo...');
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

// EVENTOS SOCKET
client.on('qr', (qr) => { console.log('📸 QR'); io.emit('qr', qr); io.emit('status', '📸 ESCANEA AHORA'); });
client.on('ready', () => { isClientReady = true; io.emit('status', '✅ BOT ACTIVO'); io.emit('connected', { name: client.info.pushname, number: client.info.wid.user }); processQueue(); });
client.on('authenticated', () => io.emit('status', '🔑 Cargando...'));
client.on('disconnected', () => { isClientReady = false; io.emit('status', '❌ Desconectado'); if (clientInitialized) process.exit(0); });

server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR FINAL INICIADO EN PUERTO ${PORT}`);
});