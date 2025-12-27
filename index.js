const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 
const puppeteer = require('puppeteer'); 
const { execSync } = require('child_process');

// ▼▼▼ FIX SUPREMO: INSTALAR Y ENCONTRAR CHROME AUTOMÁTICAMENTE ▼▼▼
let RUTA_CHROME_DETECTADA = null;

try {
    console.log("🛠️ Asegurando instalación de Chrome...");
    execSync("npx puppeteer browsers install chrome@stable", { stdio: 'inherit' });
    
    const cacheDir = path.join(process.cwd(), '.cache', 'chrome');
    if (fs.existsSync(cacheDir)) {
        const carpetas = fs.readdirSync(cacheDir);
        for (const carpeta of carpetas) {
            const posibleRuta = path.join(cacheDir, carpeta, 'chrome-linux64', 'chrome');
            if (fs.existsSync(posibleRuta)) {
                RUTA_CHROME_DETECTADA = posibleRuta;
                console.log(`✅ Chrome encontrado manualmente en: ${RUTA_CHROME_DETECTADA}`);
                break;
            }
        }
    }
} catch (error) {
    console.error("⚠️ Alerta en instalación de Chrome:", error.message);
}
// ▲▲▲ FIN DEL FIX ▲▲▲

// ▼▼▼ FIX FFMPEG ▼▼▼
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;

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
let activeSessionName = null; 
let isClientReady = false;
let messageQueue = [];
let isProcessingQueue = false;
let mensajesEnRacha = 0;
let limiteRachaActual = 5; 
let modoRescateActivo = false; // Indica si estamos cubriendo un turno ajeno

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
    if (hora >= 8 && hora < 18) return { isOpen: true }; 
    return { isOpen: false }; 
};

// --- DETERMINAR TURNO ---
function getTurnoActual() {
    const hora = moment().tz('America/Mexico_City').hour();
    if (hora >= 8 && hora < 10) return 'chip-a';
    if (hora >= 10 && hora < 12) return 'chip-b';
    if (hora >= 12 && hora < 14) return 'chip-a';
    if (hora >= 14 && hora < 16) return 'chip-b';
    if (hora >= 16 && hora < 18) return 'chip-a';
    return 'chip-a'; 
}

// --- VERIFICAR SI EXISTE CARPETA ---
function existeSesion(sessionName) {
    const folderPath = `./data/session-client-${sessionName}`;
    return fs.existsSync(folderPath);
}

// --- BORRAR CARPETA ---
function borrarSesion(sessionName) {
    const folderPath = `./data/session-client-${sessionName}`;
    try {
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`🗑️ Carpeta ${sessionName} eliminada por corrupción.`);
        }
    } catch (e) { console.error(`Error borrando ${sessionName}:`, e); }
}

// --- FUNCIÓN MAESTRA: INICIAR SESIÓN ---
// isManual = TRUE (Lo iniciaste con botón, debe mostrar QR si falla)
// isManual = FALSE (Lo inició el reloj, si falla debe activar RESCATE)
async function startSession(sessionName, isManual = false) {
    if (client) {
        try { await client.destroy(); } catch(e) {}
        client = null;
        isClientReady = false;
    }

    activeSessionName = sessionName;
    console.log(`🔵 INICIANDO PERFIL: ${sessionName.toUpperCase()} (Modo: ${isManual ? 'MANUAL' : 'AUTO'})`);
    io.emit('status', `⏳ Cargando ${sessionName.toUpperCase()}...`);

    // Fix Lock
    try {
        const folderPath = `./data/session-client-${sessionName}`;
        const lockFile = path.join(folderPath, 'SingletonLock');
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch (errLock) {}

    const puppeteerConfig = {
        headless: true,
        protocolTimeout: 300000, 
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
            '--single-process', '--disable-gpu', '--js-flags="--max-old-space-size=1024"' 
        ]
    };

    if (RUTA_CHROME_DETECTADA) puppeteerConfig.executablePath = RUTA_CHROME_DETECTADA;

    client = new Client({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        authStrategy: new LocalAuth({ clientId: `client-${sessionName}`, dataPath: './data' }),
        puppeteer: puppeteerConfig,
        qrMaxRetries: isManual ? 5 : 0, // SI ES AUTO, 0 REINTENTOS (Falla rápido)
        ffmpegPath: ffmpegPath
    });

    // ▼▼▼ LÓGICA DE RESCATE EN QR ▼▼▼
    client.on('qr', async (qr) => { 
        if (isManual) {
            // SI ES MANUAL: Muestra el QR para escanear
            console.log('📸 SE REQUIERE ESCANEO NUEVO (Modo Manual)'); 
            io.emit('qr', qr); 
            io.emit('status', `📸 ESCANEA AHORA (${sessionName.toUpperCase()})`); 
        } else {
            // SI ES AUTO: ¡ALERTA! La sesión está podrida.
            console.log(`⚠️ ALERTA: ${sessionName} pidió QR en modo AUTO. La sesión no sirve.`);
            
            // 1. Matar cliente actual
            try { await client.destroy(); } catch(e){}
            client = null;

            // 2. Borrar carpeta corrupta
            borrarSesion(sessionName);

            // 3. ACTIVAR EL OTRO CHIP (RESCATE)
            const chipRescate = (sessionName === 'chip-a') ? 'chip-b' : 'chip-a';
            
            // Evitar bucle infinito (si ya estamos en rescate y falla también el otro)
            if (modoRescateActivo) {
                console.log('💀 AMBOS CHIPS FALLARON. APAGANDO SISTEMA.');
                io.emit('status', '💀 ERROR CRÍTICO: AMBOS CHIPS SIN SESIÓN.');
                return; // Se queda muerto
            }

            console.log(`🚑 ACTIVANDO PROTOCOLO DE RESCATE: INTENTANDO ${chipRescate.toUpperCase()}`);
            modoRescateActivo = true; // Marcamos que estamos en emergencia
            
            // Intentamos arrancar el otro chip en modo AUTO (para que también cheque si sirve)
            if (existeSesion(chipRescate)) {
                startSession(chipRescate, false);
            } else {
                console.log(`❌ NO HAY CHIP DE RESPALDO (${chipRescate}). SISTEMA DETENIDO.`);
                io.emit('status', '⚠️ SISTEMA DETENIDO: FALTAN AMBAS SESIONES.');
            }
        }
    });

    client.on('ready', () => { 
        isClientReady = true; 
        modoRescateActivo = false; // Si conecta, quitamos la bandera de emergencia
        console.log(`✅ ${sessionName} LISTO Y CONECTADO`);
        io.emit('status', `✅ ACTIVO: ${sessionName.toUpperCase()}`); 
        io.emit('connected', { name: client.info.pushname, number: client.info.wid.user, session: sessionName }); 
        processQueue(); 
    });

    client.on('auth_failure', () => {
        console.log('⛔ FALLO DE AUTH.');
        if (!isManual) borrarSesion(sessionName); // Si falla auth en auto, borramos
        io.emit('status', '⛔ CREDENCIALES INVÁLIDAS');
        // El reinicio lo manejará el proceso manual o el rescate
    });

    client.on('disconnected', (reason) => { 
        console.log('❌ Desconectado:', reason);
        isClientReady = false; 
        io.emit('status', '❌ Desconectado'); 
        if (reason === 'LOGOUT') borrarSesion(sessionName);
    });

    try { 
        await client.initialize(); 
    } catch (e) { 
        console.error('❌ Error al inicializar:', e.message);
        if (e.message.includes('Code: 21') || e.message.includes('SingletonLock')) {
             borrarSesion(sessionName);
             process.exit(1); // Reiniciar contenedor si es error de Chrome
        }
    }
}

// --- GENERADOR PDF ---
async function generarYEnviarPDF(item, clientInstance) {
    try {
        console.log(`📄 Generando PDF en cola para ${item.numero}...`);
        const { datos_ticket, foto_evidencia } = item.pdfData;
        
        // --- PLANTILLA HTML (Misma de siempre) ---
        const htmlContent = `<html><head><style>body{font-family:Arial,sans-serif;font-size:12px;padding:20px}.ticket{width:100%;max-width:400px;margin:0 auto;border:1px solid #999;padding:10px}.header,.footer{text-align:center;margin-bottom:10px;border-bottom:2px solid #000;padding-bottom:10px}.bold{font-weight:bold}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:5px;border-bottom:1px solid #ccc;font-size:11px}.totals{margin-top:15px;text-align:right}.evidencia{margin-top:20px;text-align:center;border-top:2px dashed #000;padding-top:10px}img{max-width:100%}</style></head><body><div class="ticket"><div class="header"><p class="bold" style="font-size:1.2em">FERROLÁMINAS RICHAUD SA DE CV</p><p>FRI90092879A</p><p>Sucursal: ${datos_ticket.sucursal || 'Matriz'}</p><p>Fecha: ${datos_ticket.fecha}</p><p class="bold" style="font-size:1.2em">Ticket: ${datos_ticket.folio}</p></div><div><p><span class="bold">Cliente:</span> ${datos_ticket.cliente}</p><p><span class="bold">Dirección:</span> ${datos_ticket.direccion}</p></div><div style="text-align:center;margin:10px 0;font-weight:bold">DETALLE DE COMPRA</div><table><thead><tr><th>Cant</th><th>Desc</th><th>Precio</th><th>Total</th></tr></thead><tbody>${datos_ticket.productos.map(p => `<tr><td>${p.cantidad} ${p.unidad}</td><td>${p.descripcion}</td><td>$${parseFloat(p.precio).toFixed(2)}</td><td>$${(p.cantidad*p.precio).toFixed(2)}</td></tr>`).join('')}</tbody></table><div class="totals"><p>Subtotal: $${datos_ticket.subtotal}</p><p>Impuestos: $${datos_ticket.impuestos}</p><p class="bold" style="font-size:1.2em">TOTAL: $${datos_ticket.total}</p></div>${foto_evidencia ? `<div class="evidencia"><p class="bold">📸 EVIDENCIA DE ENTREGA</p><img src="${foto_evidencia}"/></div>`:''}</div></body></html>`;

        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        await browser.close(); 

        const b64 = Buffer.from(pdfBuffer).toString('base64');
        const media = new MessageMedia('application/pdf', b64, `Ticket-${datos_ticket.folio}.pdf`);
        
        let chatId = item.numero.replace(/\D/g, '');
        if (chatId.length === 10) chatId = '52' + chatId;
        chatId = chatId + '@c.us';
        
        await clientInstance.sendMessage(chatId, media, { caption: item.mensaje || "Su pedido ha sido entregado. Adjunto ticket y evidencia. 📄🏠" });
        console.log(`✅ PDF enviado a ${item.numero}`);
        return true;
    } catch (e) {
        console.error("❌ Error PDF:", e.message);
        return false;
    }
}

// --- PROCESADOR DE COLA ---
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (!isClientReady || !client) return; 

    if (mensajesEnRacha >= limiteRachaActual) {
        const minutosPausa = getRandomDelay(10, 20); 
        console.log(`☕ PAUSA LARGA DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso (${minutosPausa} min)`);
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
            if (item.type === 'pdf') await generarYEnviarPDF(item, client);
            else {
                if (item.mediaUrl) {
                    const media = await MessageMedia.fromUrl(item.mediaUrl, { unsafeMime: true });
                    await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                } else await client.sendMessage(finalNumber, item.mensaje);
            }
            item.resolve({ success: true });
            mensajesEnRacha++; 
        } else item.resolve({ success: false, error: 'No registrado' });
    } catch (error) {
        console.error('❌ Error cola:', error.message);
        item.resolve({ success: false, error: error.message });
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) process.exit(1); 
    } finally {
        messageQueue.shift(); 
        const shortPause = getRandomDelay(60000, 90000); 
        console.log(`⏱️ Esperando ${Math.round(shortPause/1000)}s...`);
        setTimeout(() => { isProcessingQueue = false; processQueue(); }, shortPause);
    }
};

// --- RUTAS API ---
// AQUÍ ESTÁ LA CLAVE: Al picar botón, pasamos TRUE (Manual)
app.post('/iniciar-chip-a', authMiddleware, (req, res) => { startSession('chip-a', true); res.json({success:true}); });
app.post('/iniciar-chip-b', authMiddleware, (req, res) => { startSession('chip-b', true); res.json({success:true}); });

app.post('/borrar-chip-a', authMiddleware, (req, res) => { borrarSesion('chip-a'); res.json({success:true}); });
app.post('/borrar-chip-b', authMiddleware, (req, res) => { borrarSesion('chip-b'); res.json({success:true}); });

app.post('/enviar', authMiddleware, (req, res) => {
    if (!isClientReady) return res.status(503).json({ error: 'Bot dormido' });
    if (!checkOfficeHours().isOpen) return res.status(400).json({ error: 'Oficina cerrada' });
    messageQueue.push({ type: 'normal', ...req.body, resolve: () => {} });
    processQueue();
    res.json({ success: true });
});

app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    if (!isClientReady) return res.status(503).json({ error: 'Bot dormido' });
    if (!checkOfficeHours().isOpen) return res.status(400).json({ error: 'Oficina cerrada' });
    messageQueue.push({ type: 'pdf', ...req.body, pdfData: { datos_ticket: req.body.datos_ticket, foto_evidencia: req.body.foto_evidencia }, resolve: () => {} });
    processQueue();
    res.json({ success: true });
});

app.post('/detener-bot', authMiddleware, async (req, res) => { try { await client.destroy(); } catch(e) {} process.exit(0); });
app.post('/limpiar-cola', authMiddleware, (req, res) => { messageQueue = []; res.json({ success: true }); });
app.get('/', (req, res) => res.render('index'));
app.get('/status', (req, res) => res.json({ ready: isClientReady, cola: messageQueue.length, session: activeSessionName }));

io.on('connection', (socket) => {
    if(activeSessionName) socket.emit('status', isClientReady ? `✅ ACTIVO: ${activeSessionName.toUpperCase()}` : `⏳ Cargando ${activeSessionName}...`);
    else socket.emit('status', '💤 Sistema en espera');
});

// --- ARRANQUE AUTOMÁTICO INTELIGENTE ---
server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR LISTO EN PUERTO ${PORT}`);

    const turno = getTurnoActual();
    console.log(`🕒 TOCA: ${turno.toUpperCase()}`);
    
    // INICIO AUTOMÁTICO (isManual = FALSE)
    // Si la carpeta existe, intentamos entrar. Si falla, el código de arriba activará el RESCATE.
    if (existeSesion(turno)) {
        console.log(`📂 Carpeta detectada. Intentando arrancar ${turno}...`);
        startSession(turno, false);
    } else {
        console.log(`⚠️ No hay sesión para ${turno}. Esperando inicio manual.`);
        io.emit('status', `⚠️ FALTA SESIÓN ${turno.toUpperCase()}. INICIE MANUALMENTE.`);
    }

    // SUPERVISOR DE TURNO (CADA MINUTO)
    setInterval(() => {
        const turnoDebido = getTurnoActual();
        if (activeSessionName && activeSessionName !== turnoDebido && !modoRescateActivo) {
            // Solo cambiamos si existe la carpeta del nuevo turno
            if (existeSesion(turnoDebido)) {
                console.log(`🔀 CAMBIO DE TURNO A ${turnoDebido}. REINICIANDO...`);
                process.exit(0);
            }
        }
    }, 60000); 
});