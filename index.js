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

// --- VARIABLES DE ESTADO (MODIFICADO PARA MULTI-SESIÓN) ---
let client = null; // Ahora es una variable, no una constante, para poder cambiarla
let activeSessionName = null; // 'morning' o 'afternoon'
let isClientReady = false;
let messageQueue = [];
let isProcessingQueue = false;
let mensajesEnRacha = 0;
let limiteRachaActual = 5; 

// MIDDLEWARE
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!MI_TOKEN_SECRETO || token !== MI_TOKEN_SECRETO) return res.status(403).json({ error: 'Acceso denegado' });
    next();
};

// UTILIDADES
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);
const checkOfficeHours = () => { return { isOpen: true }; };

// --- FUNCIÓN PRINCIPAL: INICIAR SESIÓN (DINÁMICA) ---
async function startSession(sessionName) {
    // Si ya hay un cliente corriendo, lo matamos primero para evitar choques
    if (client) {
        try { await client.destroy(); } catch(e) {}
        client = null;
        isClientReady = false;
    }

    activeSessionName = sessionName;
    console.log(`🔵 INICIANDO MODO: ${sessionName.toUpperCase()}`);
    io.emit('status', `⏳ Cargando Turno: ${sessionName.toUpperCase()}...`);

    // CONFIGURACIÓN PUPPETEER (TUS AJUSTES EXACTOS)
    client = new Client({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        // AQUÍ ESTÁ LA MAGIA: El clientId cambia según el turno (client-morning o client-afternoon)
        authStrategy: new LocalAuth({ 
            clientId: `client-${sessionName}`, 
            dataPath: './data' 
        }),
        puppeteer: {
            headless: true,
            protocolTimeout: 300000, // Tus 5 minutos de paciencia
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', 
                '--no-first-run', 
                '--no-zygote',
                '--single-process', 
                '--disable-gpu',
                '--js-flags="--max-old-space-size=1024"' 
            ]
        },
        qrMaxRetries: 5,
        ffmpegPath: ffmpegPath
    });

    // --- EVENTOS DEL CLIENTE ---
    client.on('qr', (qr) => { 
        console.log('📸 SE REQUIERE ESCANEO NUEVO'); 
        io.emit('qr', qr); 
        io.emit('status', `📸 ESCANEA AHORA (${sessionName.toUpperCase()})`); 
    });

    client.on('ready', () => { 
        isClientReady = true; 
        console.log(`✅ Cliente ${sessionName} LISTO Y CONECTADO`);
        io.emit('status', `✅ ACTIVO: ${sessionName.toUpperCase()}`); 
        io.emit('connected', { 
            name: client.info.pushname, 
            number: client.info.wid.user, 
            session: sessionName 
        }); 
        processQueue(); // Arranca la cola si había pendientes
    });

    client.on('authenticated', () => io.emit('status', '🔑 Llaves aceptadas...'));

    // AUTO-LIMPIEZA: Si fallan las credenciales (Baneo o cambio de sesión manual en el cel)
    client.on('auth_failure', async (msg) => {
        console.error('⛔ CREDENCIALES INVÁLIDAS (Posible Baneo o Cierre de Sesión). Limpiando...');
        io.emit('status', '⛔ ERROR DE CREDENCIALES. Reiniciando...');
        
        // Borramos la carpeta corrupta automáticamente
        const folderPath = `./data/session-client-${sessionName}`; 
        try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch(e) {}
        
        // Reiniciamos para pedir QR nuevo
        setTimeout(() => process.exit(1), 2000); 
    });

    client.on('disconnected', async (reason) => { 
        console.log('❌ Desconectado:', reason);
        isClientReady = false; 
        io.emit('status', '❌ Desconectado'); 
        
        // Si tú cerraste sesión manualmente, limpiamos el disco
        if (reason === 'LOGOUT' || reason === 'NAVIGATION') {
             console.log('🧹 Limpiando sesión por Logout manual...');
             const folderPath = `./data/session-client-${sessionName}`;
             try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch(e){}
        }
        
        // Reinicio automático para recuperar conexión
        process.exit(1); 
    });

    try { await client.initialize(); } catch (e) { console.error(e); process.exit(1); }
}

// --- TU FUNCIÓN ORIGINAL PARA GENERAR EL PDF ---
async function generarYEnviarPDF(item, clientInstance) {
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
        
        const captionFinal = item.mensaje || "Su pedido ha sido entregado. Adjunto ticket y evidencia. 📄🏠";

        // Usamos clientInstance porque 'client' ahora es dinámico
        await clientInstance.sendMessage(chatId, media, { caption: captionFinal });
        console.log(`✅ PDF enviado a ${item.numero}`);
        return true;

    } catch (e) {
        console.error("❌ Error generando/enviando PDF:", e);
        return false;
    }
}

// --- TU PROCESADOR DE COLA MAESTRO (CON AJUSTES DE MEMORIA) ---
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady || !client) return; 

    // ▼▼▼ TU LÓGICA DE PAUSA (INTACTA) ▼▼▼
    if (mensajesEnRacha >= limiteRachaActual) {
        const minutosPausa = getRandomDelay(10, 20); 
        console.log(`☕ PAUSA LARGA DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso de seguridad (${minutosPausa} min)`);
        mensajesEnRacha = 0;
        limiteRachaActual = getRandomDelay(3, 7); 
        setTimeout(() => { console.log('⚡ Volviendo...'); processQueue(); }, minutosPausa * 60 * 1000);
        return;
    }
    // ▲▲▲ FIN PAUSA ▲▲▲

    isProcessingQueue = true;
    const item = messageQueue[0];

    try {
        let cleanNumber = item.numero.replace(/\D/g, '');
        const esLongitudValida = (cleanNumber.length === 10) || (cleanNumber.length === 12 && cleanNumber.startsWith('52')) || (cleanNumber.length === 13 && cleanNumber.startsWith('521'));
        
        if (!esLongitudValida) throw new Error('Formato inválido');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';

        console.log(`⏳ Procesando ${item.numero}...`);
        
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
        
        // --- DETECCIÓN DE CRASH DE MEMORIA (TU LÓGICA) ---
        if (error.message && (
            error.message.includes('Protocol') || 
            error.message.includes('destroyed') || 
            error.message.includes('timed out')
        )) {
            console.log('💀 Error crítico (Memoria/Navegador). Reiniciando...');
            process.exit(1); 
        }
    } finally {
        messageQueue.shift(); 
        const shortPause = getRandomDelay(60000, 90000); 
        console.log(`⏱️ Esperando ${Math.round(shortPause/1000)}s...`);
        setTimeout(() => { isProcessingQueue = false; processQueue(); }, shortPause);
    }
};

// --- RUTAS API (NUEVAS Y VIEJAS) ---

// 1. SELECTOR DE TURNO MANUAL (PARA FORZAR SI QUIERES)
app.post('/iniciar-manana', authMiddleware, async (req, res) => {
    if (activeSessionName === 'morning' && isClientReady) return res.json({ msg: 'Turno Mañana ya activo' });
    startSession('morning');
    res.json({ success: true, message: 'Iniciando Turno Mañana...' });
});

app.post('/iniciar-tarde', authMiddleware, async (req, res) => {
    if (activeSessionName === 'afternoon' && isClientReady) return res.json({ msg: 'Turno Tarde ya activo' });
    startSession('afternoon');
    res.json({ success: true, message: 'Iniciando Turno Tarde...' });
});

// 2. BORRAR SESIONES (BOTONES ROJOS DE EMERGENCIA)
app.post('/borrar-manana', authMiddleware, async (req, res) => {
    if (activeSessionName === 'morning') await client.destroy();
    const p = './data/session-client-morning'; 
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    res.json({ success: true, message: '🗑 Sesión Mañana ELIMINADA' });
    if (activeSessionName === 'morning') setTimeout(() => process.exit(0), 1000);
});

app.post('/borrar-tarde', authMiddleware, async (req, res) => {
    if (activeSessionName === 'afternoon') await client.destroy();
    const p = './data/session-client-afternoon';
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    res.json({ success: true, message: '🗑 Sesión Tarde ELIMINADA' });
    if (activeSessionName === 'afternoon') setTimeout(() => process.exit(0), 1000);
});

// 3. RUTAS DE ENVÍO (LAS QUE USA TU LAMBDA)
app.post('/enviar', authMiddleware, (req, res) => {
    const { numero, mensaje, media_url } = req.body;
    
    if (!isClientReady || !client) return res.status(503).json({ success: false, error: '⛔ NINGÚN TURNO ACTIVO.' });
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

app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    const { numero, datos_ticket, foto_evidencia, mensaje } = req.body; 

    if (!isClientReady || !client) return res.status(503).json({ success: false, error: 'Bot no listo' });

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

// APIs de Control Extra
app.post('/detener-bot', authMiddleware, async (req, res) => {
    console.log('🔴 Deteniendo...');
    try { await client.destroy(); } catch(e) {}
    process.exit(0); 
});
app.post('/limpiar-cola', authMiddleware, (req, res) => { messageQueue = []; res.json({ success: true }); });
app.get('/', (req, res) => res.render('index'));
app.get('/status', (req, res) => res.json({ ready: isClientReady, cola: messageQueue.length, session: activeSessionName }));

// EVENTOS SOCKET
io.on('connection', (socket) => {
    if(activeSessionName) socket.emit('status', isClientReady ? `✅ ACTIVO: ${activeSessionName.toUpperCase()}` : `⏳ Cargando ${activeSessionName}...`);
    else socket.emit('status', '💤 Iniciando sistema...');
});

// --- ARRANQUE DEL SERVIDOR Y LÓGICA AUTOMÁTICA ---
server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR FINAL INICIADO EN PUERTO ${PORT}`);

    // ▼▼▼ AQUÍ ESTÁ LA MAGIA AUTOMÁTICA (RELOJ) ▼▼▼
    const hora = moment().tz('America/Mexico_City').hour();
    console.log(`🕒 HORA DETECTADA (CDMX): ${hora}:00`);

    if (hora >= 8 && hora < 12) {
        console.log('🌞 ES DE MAÑANA -> CARGANDO SESIÓN MAÑANA');
        startSession('morning');
    } else {
        console.log('🌙 ES TARDE/NOCHE -> CARGANDO SESIÓN TARDE');
        startSession('afternoon');
    }

    // ▼▼▼ CRONÓMETRO PARA EL CAMBIO DE TURNO (12:00 PM) ▼▼▼
    setInterval(() => {
        const h = moment().tz('America/Mexico_City').hour();
        const m = moment().tz('America/Mexico_City').minute();
        // Si son las 12:00 PM en punto y estoy en la sesión de la mañana...
        if (h === 12 && m === 0 && activeSessionName === 'morning') {
            console.log('🕛 HORA DEL CAMBIO DE TURNO. REINICIANDO...');
            process.exit(0); // Esto mata al bot, Render lo prende, y al prender cargará la tarde.
        }
    }, 60000); // Revisa cada minuto
});