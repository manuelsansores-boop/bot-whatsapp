const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 
const puppeteer = require('puppeteer'); 
const { execSync } = require('child_process');

// ▼▼▼ FIX INSTALACIÓN CHROME (NO TOCAR) ▼▼▼
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
                console.log(`✅ Chrome encontrado en: ${posibleRuta}`);
                break;
            }
        }
    }
} catch (error) { 
    console.error("⚠️ Alerta Chrome:", error.message); 
}

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
// Nueva variable para bloquear la cola "de verdad" durante descansos
let isPaused = false; 
// Racha inicial aleatoria (entre 3 y 7 mensajes antes de descansar)
let limiteRachaActual = Math.floor(Math.random() * (7 - 3 + 1) + 3); 

// --- MIDDLEWARE DE AUTENTICACIÓN ---
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!MI_TOKEN_SECRETO || token !== MI_TOKEN_SECRETO) {
        return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
};

// --- UTILIDADES ---
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

const checkOfficeHours = () => { 
    const hora = moment().tz('America/Mexico_City').hour();
    // Horario Laboral Seguro: 8 AM a 8 PM
    return (hora >= 8 && hora < 20) ? { isOpen: true } : { isOpen: false }; 
};

function getTurnoActual() {
    const hora = moment().tz('America/Mexico_City').hour();
    // Turnos de 2 horas (Ping-Pong Simple)
    if (hora >= 8 && hora < 10) return 'chip-a';
    if (hora >= 10 && hora < 12) return 'chip-b';
    if (hora >= 12 && hora < 14) return 'chip-a';
    if (hora >= 14 && hora < 16) return 'chip-b';
    if (hora >= 16 && hora < 18) return 'chip-a';
    if (hora >= 18 && hora < 20) return 'chip-b';
    return 'chip-a'; 
}

function getFolderInfo(sessionName) {
    const folderPath = `./data/session-client-${sessionName}`;
    if (!fs.existsSync(folderPath)) return { exists: false, size: 0, date: 'N/A' };
    try {
        const stats = fs.statSync(folderPath);
        return { 
            exists: true, 
            date: moment(stats.mtime).tz('America/Mexico_City').format('DD/MM HH:mm') 
        };
    } catch(e) { 
        return { exists: false }; 
    }
}

function existeSesion(sessionName) { 
    return fs.existsSync(`./data/session-client-${sessionName}`); 
}

function borrarSesion(sessionName) {
    const folderPath = `./data/session-client-${sessionName}`;
    try { 
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`🗑️ Carpeta ${sessionName} eliminada por corrupción.`);
        }
    } catch (e) { 
        console.error(`Error borrando ${sessionName}:`, e); 
    }
}

// --- FUNCIÓN MAESTRA: INICIAR SESIÓN (CON STEALTH, SIN HEARTBEAT) ---
async function startSession(sessionName, isManual = false) {
    // Limpiar sesión anterior
    if (client) { 
        try { await client.destroy(); } catch(e) {} 
        client = null; 
        isClientReady = false; 
    }
    
    // Resetear estados críticos al iniciar nueva sesión
    isPaused = false; 
    mensajesEnRacha = 0;

    activeSessionName = sessionName;
    console.log(`🔵 INICIANDO: ${sessionName.toUpperCase()} (Stealth Mode)`);
    io.emit('status', `⏳ Cargando ${sessionName.toUpperCase()}...`);

    // Fix Lock (eliminar archivo de bloqueo si existe)
    try {
        const folderPath = `./data/session-client-${sessionName}`;
        const lockFile = path.join(folderPath, 'SingletonLock');
        if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
    } catch (errLock) {}

    // ▼▼▼ CONFIGURACIÓN CAMUFLAJE (OBLIGATORIO PARA NO SER DETECTADO) ▼▼▼
    const puppeteerConfig = {
        headless: true,
        protocolTimeout: 300000,
        ignoreDefaultArgs: ['--enable-automation'], // Quita el letrero "Chrome es controlado por software"
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', 
            '--no-first-run', 
            '--single-process', 
            '--disable-gpu',
            '--js-flags="--max-old-space-size=1024"',
            // Flags de Camuflaje para parecer humano:
            '--disable-blink-features=AutomationControlled', 
            '--disable-infobars',
            '--window-size=1920,1080',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    };
    if (RUTA_CHROME_DETECTADA) puppeteerConfig.executablePath = RUTA_CHROME_DETECTADA;
    // ▲▲▲ FIN CONFIGURACIÓN CAMUFLAJE ▲▲▲

    client = new Client({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        authStrategy: new LocalAuth({ 
            clientId: `client-${sessionName}`, 
            dataPath: './data' 
        }),
        puppeteer: puppeteerConfig,
        qrMaxRetries: isManual ? 5 : 0, 
        ffmpegPath: ffmpegPath
    });

    // --- EVENTO: QR CODE ---
    client.on('qr', async (qr) => { 
        if (isManual) {
            console.log('📸 SE REQUIERE ESCANEO NUEVO (Modo Manual)'); 
            io.emit('qr', qr); 
            io.emit('status', `📸 ESCANEA AHORA (${sessionName.toUpperCase()})`); 
        } else {
            console.log(`⚠️ ALERTA: ${sessionName} pidió QR en modo AUTO. La sesión no sirve.`);
            try { await client.destroy(); } catch(e){}
            client = null;
            borrarSesion(sessionName);
            
            // SIN RESCATE AUTOMÁTICO - Para evitar que te maten el segundo chip
            console.log('🛑 SISTEMA DETENIDO POR SEGURIDAD. Revise manualmente.');
            io.emit('status', '🛑 DETENIDO: SESIÓN CADUCADA. REINICIE MANUALMENTE.');
            process.exit(1); 
        }
    });

    // --- EVENTO: LISTO Y CONECTADO ---
    client.on('ready', () => { 
        isClientReady = true; 
        console.log(`✅ ${sessionName} CONECTADO Y LISTO`);
        io.emit('status', `✅ ACTIVO: ${sessionName.toUpperCase()}`); 
        io.emit('connected', { 
            name: client.info.pushname, 
            number: client.info.wid.user, 
            session: sessionName 
        }); 
        
        // SIN HEARTBEAT - Solo procesamos la cola cuando llegan mensajes
        processQueue(); 
    });

    // --- EVENTO: FALLO DE AUTENTICACIÓN ---
    client.on('auth_failure', () => {
        console.log('⛔ FALLO DE AUTENTICACIÓN');
        io.emit('status', '⛔ CREDENCIALES INVÁLIDAS');
        if (!isManual) borrarSesion(sessionName);
    });

    // --- EVENTO: DESCONEXIÓN ---
    client.on('disconnected', (reason) => { 
        console.log('❌ Desconectado:', reason);
        isClientReady = false; 
        io.emit('status', '❌ Desconectado'); 
        if (reason === 'LOGOUT') borrarSesion(sessionName);
    });

    // --- INICIALIZAR CLIENTE ---
    try { 
        await client.initialize(); 
    } catch (e) { 
        console.error('❌ Error al inicializar:', e.message);
        if (e.message.includes('Code: 21') || e.message.includes('SingletonLock')) {
            borrarSesion(sessionName);
            process.exit(1); 
        }
    }
}

// --- GENERADOR DE PDF CON TICKET Y EVIDENCIA ---
async function generarYEnviarPDF(item, clientInstance) {
    try {
        console.log(`📄 Generando PDF para ${item.numero}...`);
        const { datos_ticket, foto_evidencia } = item.pdfData;
        
        // HTML COMPLETO DEL TICKET
        const htmlContent = `<html><head><style>body{font-family:Arial,sans-serif;font-size:12px;padding:20px}.ticket{width:100%;max-width:400px;margin:0 auto;border:1px solid #999;padding:10px}.header,.footer{text-align:center;margin-bottom:10px;border-bottom:2px solid #000;padding-bottom:10px}.bold{font-weight:bold}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:5px;border-bottom:1px solid #ccc;font-size:11px}.totals{margin-top:15px;text-align:right}.evidencia{margin-top:20px;text-align:center;border-top:2px dashed #000;padding-top:10px}img{max-width:100%}</style></head><body><div class="ticket"><div class="header"><p class="bold" style="font-size:1.2em">FERROLÁMINAS RICHAUD SA DE CV</p><p>FRI90092879A</p><p>Sucursal: ${datos_ticket.sucursal || 'Matriz'}</p><p>Fecha: ${datos_ticket.fecha}</p><p class="bold" style="font-size:1.2em">Ticket: ${datos_ticket.folio}</p></div><div><p><span class="bold">Cliente:</span> ${datos_ticket.cliente}</p><p><span class="bold">Dirección:</span> ${datos_ticket.direccion}</p></div><div style="text-align:center;margin:10px 0;font-weight:bold">DETALLE DE COMPRA</div><table><thead><tr><th>Cant</th><th>Desc</th><th>Precio</th><th>Total</th></tr></thead><tbody>${datos_ticket.productos.map(p => `<tr><td>${p.cantidad} ${p.unidad}</td><td>${p.descripcion}</td><td>$${parseFloat(p.precio).toFixed(2)}</td><td>$${(p.cantidad*p.precio).toFixed(2)}</td></tr>`).join('')}</tbody></table><div class="totals"><p>Subtotal: $${datos_ticket.subtotal}</p><p>Impuestos: $${datos_ticket.impuestos}</p><p class="bold" style="font-size:1.2em">TOTAL: $${datos_ticket.total}</p></div>${foto_evidencia ? `<div class="evidencia"><p class="bold">📸 EVIDENCIA DE ENTREGA</p><img src="${foto_evidencia}"/></div>`:''}</div></body></html>`;

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
        
        await clientInstance.sendMessage(chatId, media, { 
            caption: item.mensaje || "Su pedido ha sido entregado. Adjunto ticket y evidencia. 📄🏠" 
        });
        console.log(`✅ PDF enviado exitosamente a ${item.numero}`);
        return true;
    } catch (e) {
        console.error("❌ Error generando/enviando PDF:", e.message);
        return false;
    }
}

// --- PROCESADOR DE COLA CON RACHAS ALEATORIAS ---
const processQueue = async () => {
    // CONDICIÓN CRÍTICA 1: Si ya estamos procesando o no hay mensajes, salir.
    if (isProcessingQueue || messageQueue.length === 0) return;
    
    // CONDICIÓN CRÍTICA 2 (NUEVA): Si estamos en PAUSA, salir inmediatamente.
    // Esto evita que una petición API despierte al bot durante su descanso.
    if (isPaused) return; 

    if (!isClientReady || !client) return; 
    
    // Sistema de rachas variables: Descansa después de X mensajes (aleatorio)
    if (mensajesEnRacha >= limiteRachaActual) {
        isPaused = true; // ACTIVAR CANDADO
        const minutosPausa = getRandomDelay(10, 25); 
        console.log(`☕ PAUSA LARGA DE ${minutosPausa} MINUTOS (Simulando comportamiento humano)...`);
        io.emit('status', `☕ Descanso (${minutosPausa} min)`);
        
        setTimeout(() => { 
            console.log('⚡ Reanudando envíos...'); 
            isPaused = false; // QUITAR CANDADO
            mensajesEnRacha = 0; // REINICIAR CONTADOR
            limiteRachaActual = getRandomDelay(3, 8); // Nueva meta aleatoria
            processQueue(); // VOLVER AL TRABAJO
        }, minutosPausa * 60 * 1000);
        return;
    }
    
    isProcessingQueue = true;
    const item = messageQueue[0];
    
    try {
        let cleanNumber = item.numero.replace(/\D/g, '');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';
        
        console.log(`⏳ Procesando ${item.numero}...`);
        
        // ✅ CRÍTICO: Simula "escribiendo..." (4-8 segundos)
        await new Promise(r => setTimeout(r, getRandomDelay(4000, 8000)));
        
        const isRegistered = await client.isRegisteredUser(finalNumber);
        if (isRegistered) {
            if (item.type === 'pdf') {
                await generarYEnviarPDF(item, client);
            } else {
                if (item.mediaUrl) {
                    const media = await MessageMedia.fromUrl(item.mediaUrl, { unsafeMime: true });
                    await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                } else {
                    await client.sendMessage(finalNumber, item.mensaje);
                }
            }
            item.resolve({ success: true });
            mensajesEnRacha++; 
            console.log(`✅ Mensaje enviado a ${item.numero} (Racha: ${mensajesEnRacha}/${limiteRachaActual})`);
        } else {
            item.resolve({ success: false, error: 'Número no registrado en WhatsApp' });
            console.log(`⚠️ ${item.numero} no está registrado en WhatsApp`);
        }
    } catch (error) {
        console.error('❌ Error en cola:', error.message);
        item.resolve({ success: false, error: error.message });
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            console.error('💀 SESIÓN MURIÓ. REINICIANDO SISTEMA...');
            process.exit(1); 
        }
    } finally {
        messageQueue.shift(); 
        // Pausa entre mensajes (45-90 segundos) - Simulando escritura humana variable
        const shortPause = getRandomDelay(45000, 90000); 
        console.log(`⏱️ Esperando ${Math.round(shortPause/1000)}s antes del próximo mensaje...`);
        setTimeout(() => { 
            isProcessingQueue = false; 
            processQueue(); 
        }, shortPause);
    }
};

// --- RUTAS API ---
app.post('/iniciar-chip-a', authMiddleware, (req, res) => { 
    startSession('chip-a', true); 
    res.json({ success: true, message: 'Iniciando chip-a en modo manual' }); 
});

app.post('/iniciar-chip-b', authMiddleware, (req, res) => { 
    startSession('chip-b', true); 
    res.json({ success: true, message: 'Iniciando chip-b en modo manual' }); 
});

app.post('/borrar-chip-a', authMiddleware, (req, res) => { 
    borrarSesion('chip-a'); 
    res.json({ success: true, message: 'Sesión chip-a eliminada' }); 
});

app.post('/borrar-chip-b', authMiddleware, (req, res) => { 
    borrarSesion('chip-b'); 
    res.json({ success: true, message: 'Sesión chip-b eliminada' }); 
});

app.post('/enviar', authMiddleware, (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({ error: 'Bot no está listo o conectado' });
    }
    // ✅ CRÍTICO: Validación de horario laboral
    if (!checkOfficeHours().isOpen) {
        return res.status(400).json({ error: 'Fuera de horario laboral (8am-8pm)' });
    }
    
    // MENSAJES NORMALES: Se forman al final de la cola
    messageQueue.push({ 
        type: 'normal', 
        ...req.body, 
        resolve: () => {} 
    });
    processQueue();
    res.json({ 
        success: true, 
        message: 'Mensaje agregado a la cola',
        posicion_cola: messageQueue.length 
    });
});

app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    if (!isClientReady) {
        return res.status(503).json({ error: 'Bot no está listo o conectado' });
    }
    // ✅ CRÍTICO: Validación de horario laboral
    if (!checkOfficeHours().isOpen) {
        return res.status(400).json({ error: 'Fuera de horario laboral (8am-8pm)' });
    }
    
    // 🔥 CAMBIO VIP: USAMOS UNSHIFT EN LUGAR DE PUSH 🔥
    // Esto coloca el Ticket PDF al principio de la cola para que sea el siguiente en salir
    // respetando siempre los tiempos de espera del bot.
    messageQueue.unshift({ 
        type: 'pdf', 
        ...req.body, 
        pdfData: { 
            datos_ticket: req.body.datos_ticket, 
            foto_evidencia: req.body.foto_evidencia 
        }, 
        resolve: () => {} 
    });
    
    processQueue();
    res.json({ 
        success: true, 
        message: 'PDF agregado con PRIORIDAD VIP a la cola',
        posicion_cola: 1 
    });
});

app.post('/detener-bot', authMiddleware, async (req, res) => { 
    console.log('🛑 DETENIENDO SISTEMA...');
    try { await client.destroy(); } catch(e) {} 
    res.json({ success: true, message: 'Sistema detenido' });
    process.exit(0); 
});

app.post('/limpiar-cola', authMiddleware, (req, res) => { 
    const cantidad = messageQueue.length;
    messageQueue = []; 
    res.json({ success: true, message: `${cantidad} mensajes eliminados de la cola` }); 
});

app.get('/', (req, res) => res.render('index'));

// --- API STATUS ---
app.get('/status', (req, res) => {
    const infoA = getFolderInfo('chip-a');
    const infoB = getFolderInfo('chip-b');
    res.json({ 
        ready: isClientReady, 
        cola: messageQueue.length, 
        session: activeSessionName,
        rescate: false, 
        horario_laboral: checkOfficeHours().isOpen,
        infoA,
        infoB,
        racha_actual: mensajesEnRacha,
        limite_racha: limiteRachaActual,
        pausa_activa: isPaused // Dato útil para debug
    });
});

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    console.log('🔌 Cliente conectado via WebSocket');
    if(activeSessionName) {
        socket.emit('status', isClientReady 
            ? `✅ ACTIVO: ${activeSessionName.toUpperCase()}` 
            : `⏳ Cargando ${activeSessionName.toUpperCase()}...`
        );
    } else {
        socket.emit('status', '💤 Sistema en espera de inicio manual');
    }
});

// --- ARRANQUE AUTOMÁTICO DEL SERVIDOR ---
server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR LISTO EN PUERTO ${PORT}`);
    console.log(`🔐 Token de seguridad: ${MI_TOKEN_SECRETO ? 'CONFIGURADO ✅' : 'NO CONFIGURADO ⚠️'}`);

    const turno = getTurnoActual();
    console.log(`🕐 TURNO ACTUAL: ${turno.toUpperCase()}`);
    
    if (existeSesion(turno)) {
        console.log(`📂 Carpeta de sesión detectada. Intentando arrancar ${turno}...`);
        startSession(turno, false);
    } else {
        console.log(`⚠️ No hay sesión guardada para ${turno}. Esperando inicio manual.`);
        io.emit('status', `⚠️ FALTA SESIÓN ${turno.toUpperCase()}. INICIE MANUALMENTE.`);
    }
    
    // Check automático de cambio de turno cada minuto
    setInterval(() => {
        const turnoDebido = getTurnoActual();
        if (activeSessionName && activeSessionName !== turnoDebido) {
            if (existeSesion(turnoDebido)) {
                console.log(`🔄 CAMBIO DE TURNO A ${turnoDebido.toUpperCase()}. REINICIANDO...`);
                process.exit(0); // PM2 o similar lo reiniciará automáticamente
            }
        }
    }, 60000); // Cada 60 segundos
});