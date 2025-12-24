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

// --- VARIABLES DE ESTADO ---
let client = null; 
let activeSessionName = null; // 'chip-a' o 'chip-b'
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
const checkOfficeHours = () => { 
    const hora = moment().tz('America/Mexico_City').hour();
    // Solo permitir envíos de 8 AM a 6 PM (18:00)
    if (hora >= 8 && hora < 18) return { isOpen: true }; 
    return { isOpen: false }; 
};

// --- FUNCIÓN PARA DETERMINAR QUÉ CHIP TOCA ---
function getTurnoActual() {
    const hora = moment().tz('America/Mexico_City').hour();
    
    // LOGICA PING-PONG (Cambio cada 2 horas)
    // 08-09: Chip A
    // 10-11: Chip B
    // 12-13: Chip A
    // 14-15: Chip B
    // 16-17: Chip A
    // Resto: Fuera de horario (usamos A por defecto o cerramos)

    if (hora >= 8 && hora < 10) return 'chip-a';
    if (hora >= 10 && hora < 12) return 'chip-b';
    if (hora >= 12 && hora < 14) return 'chip-a';
    if (hora >= 14 && hora < 16) return 'chip-b';
    if (hora >= 16 && hora < 18) return 'chip-a';
    
    return 'chip-a'; // Default fuera de horario
}

// --- FUNCIÓN PARA INICIAR SESIÓN ---
// --- FUNCIÓN PARA INICIAR SESIÓN (CON ROMPE-CANDADOS) ---
async function startSession(sessionName) {
    if (client) {
        try { await client.destroy(); } catch(e) {}
        client = null;
        isClientReady = false;
    }

    activeSessionName = sessionName;
    console.log(`🔵 INICIANDO PERFIL: ${sessionName.toUpperCase()}`);
    io.emit('status', `⏳ Cargando Perfil: ${sessionName.toUpperCase()}...`);

    // ▼▼▼ NUEVO: ELIMINAR CANDADO FANTASMA (FIX CODE 21) ▼▼▼
    // Esto borra el archivo que hace creer a Chrome que ya está abierto
    try {
        const folderPath = `./data/session-client-${sessionName}`;
        const lockFile = path.join(folderPath, 'SingletonLock');
        if (fs.existsSync(lockFile)) {
            console.log(`🔓 CANDADO ENCONTRADO EN ${sessionName}. ELIMINANDO...`);
            fs.unlinkSync(lockFile); // <--- Aquí rompemos el candado
        }
    } catch (errLock) {
        console.error('⚠️ No se pudo eliminar el Lock (tal vez no existía), continuamos...');
    }
    // ▲▲▲ FIN DEL FIX ▲▲▲

    client = new Client({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        authStrategy: new LocalAuth({ 
            clientId: `client-${sessionName}`, 
            dataPath: './data' 
        }),
        puppeteer: {
            headless: true,
            protocolTimeout: 300000, 
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
                '--single-process', '--disable-gpu', '--js-flags="--max-old-space-size=1024"' 
            ]
        },
        qrMaxRetries: 5,
        ffmpegPath: ffmpegPath
    });

    client.on('qr', (qr) => { 
        console.log('📸 SE REQUIERE ESCANEO NUEVO'); 
        io.emit('qr', qr); 
        io.emit('status', `📸 ESCANEA AHORA (${sessionName.toUpperCase()})`); 
    });

    client.on('ready', () => { 
        isClientReady = true; 
        console.log(`✅ ${sessionName} LISTO Y CONECTADO`);
        io.emit('status', `✅ ACTIVO: ${sessionName.toUpperCase()}`); 
        io.emit('connected', { 
            name: client.info.pushname, 
            number: client.info.wid.user, 
            session: sessionName 
        }); 
        processQueue(); 
    });

    // AUTO-LIMPIEZA
    client.on('auth_failure', async () => {
        console.error('⛔ ERROR DE CREDENCIALES. Limpiando...');
        io.emit('status', '⛔ CREDENCIALES RECHAZADAS. Reiniciando...');
        const folderPath = `./data/session-client-${sessionName}`; 
        try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch(e) {}
        setTimeout(() => process.exit(1), 2000); 
    });

    client.on('disconnected', async (reason) => { 
        console.log('❌ Desconectado:', reason);
        isClientReady = false; 
        io.emit('status', '❌ Desconectado'); 
        if (reason === 'LOGOUT' || reason === 'NAVIGATION') {
             const folderPath = `./data/session-client-${sessionName}`;
             try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } catch(e){}
        }
        process.exit(1); 
    });

    try { await client.initialize(); } catch (e) { 
        console.error('❌ Error al inicializar:', e.message);
        // Si falla por el candado a pesar del fix, forzamos reinicio
        if (e.message.includes('Code: 21') || e.message.includes('SingletonLock')) {
             console.log('💀 El candado sigue molestando. Reiniciando proceso...');
             process.exit(1);
        }
    }
}

// --- GENERADOR PDF (TU CÓDIGO INTACTO) ---
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

        await clientInstance.sendMessage(chatId, media, { caption: captionFinal });
        console.log(`✅ PDF enviado a ${item.numero}`);
        return true;

    } catch (e) {
        console.error("❌ Error generando/enviando PDF:", e);
        return false;
    }
}

// --- PROCESADOR DE COLA (TU CÓDIGO INTACTO) ---
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady || !client) return; 

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
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';

        console.log(`⏳ Procesando ${item.numero}...`);
        await new Promise(r => setTimeout(r, getRandomDelay(4000, 8000)));

        const isRegistered = await client.isRegisteredUser(finalNumber);

        if (isRegistered) {
            if (item.type === 'pdf') {
                await generarYEnviarPDF(item, client);
            } else {
                if (item.mediaUrl) {
                    try {
                        const media = await MessageMedia.fromUrl(item.mediaUrl, { unsafeMime: true });
                        await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                    } catch (imgError) {
                        await client.sendMessage(finalNumber, item.mensaje + `\n\n(Link: ${item.mediaUrl})`);
                    }
                } else {
                    await client.sendMessage(finalNumber, item.mensaje);
                }
            }
            item.resolve({ success: true });
            mensajesEnRacha++; 
        } else {
            item.resolve({ success: false, error: 'No registrado' });
        }
    } catch (error) {
        console.error('❌ Error procesando cola:', error.message);
        item.resolve({ success: false, error: error.message });

        // ▼▼▼ BLOQUEO ANTI-ZOMBIE (MATAR AL INSTANTE) ▼▼▼
        // Si sale cualquiera de estos, matamos el proceso YA.
        const erroresFatales = [
            'Target closed',
            'detached Frame',
            'Protocol error',
            'Session closed',
            'browser has disconnected',
            'Evaluation failed'
        ];

        // Si el mensaje de error tiene alguna de esas frases...
        if (erroresFatales.some(frase => error.message.includes(frase))) {
            console.log('💀 ERROR CRÍTICO DETECTADO: El navegador murió. Reiniciando servidor AHORA...');
            process.exit(1); // <--- ESTO LO REINICIA AL PRIMER FALLO
        }
        // ▲▲▲ FIN BLINDAJE ▲▲▲
        
    } finally {
        messageQueue.shift(); 
        
        // Pausa normal entre mensajes (60 a 90 segundos)
        const shortPause = getRandomDelay(60000, 90000); 
        console.log(`⏱️ Esperando ${Math.round(shortPause/1000)}s...`);
        setTimeout(() => { isProcessingQueue = false; processQueue(); }, shortPause);
    }
};

// --- RUTAS API ---

// BOTONES MANUALES (SOLO PARA CONFIGURACIÓN O EMERGENCIAS)
app.post('/iniciar-chip-a', authMiddleware, (req, res) => { startSession('chip-a'); res.json({success:true}); });
app.post('/iniciar-chip-b', authMiddleware, (req, res) => { startSession('chip-b'); res.json({success:true}); });

app.post('/borrar-chip-a', authMiddleware, (req, res) => { 
    const p = './data/session-client-chip-a';
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    res.json({success:true}); 
    if(activeSessionName === 'chip-a') process.exit(0);
});
app.post('/borrar-chip-b', authMiddleware, (req, res) => { 
    const p = './data/session-client-chip-b';
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    res.json({success:true}); 
    if(activeSessionName === 'chip-b') process.exit(0);
});

// RUTAS DE ENVÍO
app.post('/enviar', authMiddleware, (req, res) => {
    if (!isClientReady) return res.status(503).json({ error: 'Bot dormido' });
    messageQueue.push({ type: 'normal', ...req.body, resolve: () => {} });
    processQueue();
    res.json({ success: true });
});
app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    if (!isClientReady) return res.status(503).json({ error: 'Bot dormido' });
    messageQueue.push({ type: 'pdf', ...req.body, pdfData: { datos_ticket: req.body.datos_ticket, foto_evidencia: req.body.foto_evidencia }, resolve: () => {} });
    processQueue();
    res.json({ success: true });
});

// Control General
app.post('/detener-bot', authMiddleware, async (req, res) => {
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

// --- ARRANQUE Y LÓGICA DE RELOJ (PING-PONG) ---
server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR PING-PONG LISTO EN PUERTO ${PORT}`);

    // 1. INICIO AUTOMÁTICO
    const turnoCorrecto = getTurnoActual();
    console.log(`🕒 HORA DETECTADA: ${moment().tz('America/Mexico_City').format('HH:mm')} -> TOCA ${turnoCorrecto.toUpperCase()}`);
    startSession(turnoCorrecto);

    // 2. CRONÓMETRO DE CAMBIO (Chequeo cada minuto)
    setInterval(() => {
        const turnoDeberSer = getTurnoActual();
        // Si el turno que debería ser NO es el que está activo...
        if (activeSessionName && activeSessionName !== turnoDeberSer) {
            console.log(`🔀 CAMBIO DE TURNO DETECTADO (${activeSessionName} -> ${turnoDeberSer}). REINICIANDO...`);
            process.exit(0); // Reinicio para cambiar de chip
        }
    }, 60000); 
});