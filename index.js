const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 

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
    // User-Agent para evitar bloqueos de S3
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
    qrMaxRetries: 5,
    ffmpegPath: ffmpegPath // IMPORTANTE PARA IMÁGENES/STICKERS
});

// UTILIDADES
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// FIX HORARIO: Siempre abierto para pruebas
const checkOfficeHours = () => {
    const now = moment().tz("America/Mexico_City");
    const hour = now.hour(); 
    return { isOpen: true, hour: hour, timeString: now.format('HH:mm') };
};

// PROCESADOR DE COLA
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady) return; 

    // Pausa Anti-Ban
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
        let cleanNumber = item.numero.replace(/\D/g, '');
        const esLongitudValida = (cleanNumber.length === 10) || (cleanNumber.length === 12 && cleanNumber.startsWith('52')) || (cleanNumber.length === 13 && cleanNumber.startsWith('521'));
        
        if (!esLongitudValida) throw new Error('Formato inválido (10 dígitos)');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';

        console.log(`⏳ Procesando ${item.numero}...`);
        
        const typingDelay = getRandomDelay(4000, 8000);
        await new Promise(r => setTimeout(r, typingDelay));

        const isRegistered = await client.isRegisteredUser(finalNumber);

        if (isRegistered) {
            // Lógica con FOTO
            if (item.mediaUrl) {
                try {
                    console.log("📸 Detectada URL de imagen. Descargando...");
                    // User-Agent para que S3 no bloquee
                    const media = await MessageMedia.fromUrl(item.mediaUrl, { 
                        unsafeMime: true,
                        reqOptions: {
                            headers: { 
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
                            }
                        }
                    });

                    if (!media || !media.data) throw new Error("La imagen se descargó vacía.");
                    
                    await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                    console.log(`✅ FOTO ENVIADA a ${item.numero}`);

                } catch (imgError) {
                    console.error("⚠️ ERROR CON LA IMAGEN:", imgError); 
                    // Respaldo: Texto + Link
                    await client.sendMessage(finalNumber, item.mensaje + `\n\n(Ver imagen: ${item.mediaUrl})`);
                    console.log("✅ Texto de respaldo enviado.");
                }
            } else {
                // Solo Texto
                await client.sendMessage(finalNumber, item.mensaje);
                console.log(`✅ TEXTO ENVIADO a ${item.numero}`);
            }

            item.resolve({ success: true });
            mensajesEnRacha++; 
        } else {
            console.log(`⚠️ NO TIENE WHATSAPP: ${item.numero}`);
            item.resolve({ success: false, error: 'Número no registrado' });
        }
    } catch (error) {
        console.error('❌ Error general:', error.message);
        item.resolve({ success: false, error: error.message || 'Error desconocido' });
        
        if(error.message && (error.message.includes('Protocol') || error.message.includes('destroyed'))) {
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

// --- RUTA 1: ENVIAR MENSAJE/FOTO ---
app.post('/enviar', authMiddleware, (req, res) => {
    const { numero, mensaje, media_url } = req.body;
    
    if (!isClientReady) return res.status(503).json({ success: false, error: '⛔ BOT APAGADO.' });
    if (!numero || numero.length < 10) return res.status(400).json({ error: 'Número inválido' });
    
    // Respondemos OK de inmediato
    res.json({ success: true, message: 'Mensaje encolado.', status: 'queued' });

    messageQueue.push({ 
        numero, 
        mensaje, 
        mediaUrl: media_url, 
        resolve: (resultado) => { console.log(`[Reporte] ${numero}: ${resultado.success ? 'Enviado' : 'Falló'}`); }
    });

    console.log(`📥 Mensaje recibido. Cola: ${messageQueue.length}`);
    processQueue();
});

// --- RUTA 2: ENVIAR TICKET PDF (NUEVO) ---
app.post('/enviar-ticket-pdf', authMiddleware, async (req, res) => {
    const { numero, datos_ticket } = req.body; 

    if (!isClientReady) return res.status(503).json({ success: false, error: 'Bot no listo' });

    res.json({ success: true, message: 'Generando PDF...' });

    try {
        console.log(`📄 Generando PDF para ${numero}...`);

        // HTML del Ticket (Estilos Ferroláminas)
        const htmlContent = `
        <html>
            <head>
                <style>
                    body { font-family: 'Roboto', sans-serif; font-size: 14px; color: #333; margin: 0; padding: 20px; }
                    .ticket { width: 100%; max-width: 400px; margin: 0 auto; border: 1px solid #ddd; padding: 10px; }
                    .header, .footer { text-align: center; margin-bottom: 10px; border-bottom: 2px solid #000; padding-bottom: 10px; }
                    .header p, .footer p { margin: 2px 0; }
                    .bold { font-weight: bold; }
                    .big { font-size: 1.2em; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th, td { text-align: left; padding: 5px; border-bottom: 1px solid #eee; font-size: 12px; }
                    .totals { margin-top: 15px; text-align: right; }
                    .totals p { margin: 3px 0; }
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
                            <tr>
                                <th>Cant</th>
                                <th>Desc</th>
                                <th>Precio</th>
                                <th>Total</th>
                            </tr>
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

                    <div class="footer" style="margin-top: 20px; border:none;">
                        <p>GRACIAS POR SU COMPRA</p>
                        <p>www.ferrolaminas.com.mx</p>
                    </div>
                </div>
            </body>
        </html>`;

        // Generar PDF con Chrome
        const browser = client.puppeteer.browser; 
        const page = await browser.newPage();
        await page.setContent(htmlContent);
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await page.close();

        // Enviar
        const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), `Ticket-${datos_ticket.folio}.pdf`);
        let chatId = numero.includes('@c.us') ? numero : `${numero}@c.us`;
        await client.sendMessage(chatId, media, { caption: "Su comprobante de compra 📄" });
        console.log(`✅ PDF enviado a ${numero}`);

    } catch (e) {
        console.error("❌ Error generando PDF:", e);
    }
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