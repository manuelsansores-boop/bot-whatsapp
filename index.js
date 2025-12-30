const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 
const puppeteer = require('puppeteer'); 
const { execSync } = require('child_process');

// ▼▼▼ FIX INSTALACIÓN CHROME (MEJORADO: Busca la versión más reciente) ▼▼▼
let RUTA_CHROME_DETECTADA = null;
try {
    console.log("🛠️ Asegurando instalación de Chrome...");
    execSync("npx puppeteer browsers install chrome@stable", { stdio: 'inherit' });
    const cacheDir = path.join(process.cwd(), '.cache', 'chrome');
    if (fs.existsSync(cacheDir)) {
        // 🔥 CAMBIO 1: Ordenamos para agarrar siempre la versión MÁS NUEVA
        const carpetas = fs.readdirSync(cacheDir).sort().reverse(); 
        for (const carpeta of carpetas) {
            const posibleRuta = path.join(cacheDir, carpeta, 'chrome-linux64', 'chrome');
            if (fs.existsSync(posibleRuta)) {
                RUTA_CHROME_DETECTADA = posibleRuta;
                console.log(`✅ Chrome seleccionado (Versión más nueva): ${posibleRuta}`);
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
const PORT = process.env.PORT || 10000; // Render suele usar 10000
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;
const COLA_FILE = './data/cola.json'; // 📒 EL CUADERNO DE PERSISTENCIA

app.use(express.json());
app.set('view engine', 'ejs');

// --- VARIABLES DE ESTADO ---
let client = null; 
let activeSessionName = null; 
let isClientReady = false;
let messageQueue = [];
let isProcessingQueue = false;
let mensajesEnRacha = 0;
let isPaused = false; 

// Racha inicial: 5 a 9 mensajes (SOLICITUD USUARIO)
let limiteRachaActual = Math.floor(Math.random() * (9 - 5 + 1) + 5); 

// --- FUNCIONES DE PERSISTENCIA (EL "CUADERNO") ---
function saveQueue() {
    try {
        // Guardamos todo MENOS la función 'resolve' que no se puede escribir en JSON
        const cleanQueue = messageQueue.map(item => {
            const { resolve, ...data } = item; 
            return data;
        });
        if (!fs.existsSync('./data')) fs.mkdirSync('./data');
        fs.writeFileSync(COLA_FILE, JSON.stringify(cleanQueue, null, 2));
    } catch (e) {
        console.error("❌ Error guardando cola:", e);
    }
}

function loadQueue() {
    try {
        if (fs.existsSync(COLA_FILE)) {
            const data = fs.readFileSync(COLA_FILE, 'utf8');
            const rawQueue = JSON.parse(data);
            // Reconstruimos la cola agregando una función resolve vacía para que no truene el código
            messageQueue = rawQueue.map(item => ({
                ...item,
                resolve: () => {} // Función dummy
            }));
            console.log(`📒 COLA RECUPERADA: ${messageQueue.length} mensajes pendientes.`);
        }
    } catch (e) {
        console.error("❌ Error cargando cola:", e);
        messageQueue = [];
    }
}

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

// --- FUNCIÓN MAESTRA: INICIAR SESIÓN ---
// --- NUEVA FUNCIÓN AUXILIAR: Borrado Recursivo de Locks ---
function recursiveDeleteLocks(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const currentPath = path.join(dirPath, file);
            if (fs.lstatSync(currentPath).isDirectory()) {
                recursiveDeleteLocks(currentPath); // Bajar un nivel
            } else {
                // Si el archivo suena a bloqueo, lo borramos
                if (file.includes('Singleton') || file.includes('lockfile')) {
                    fs.unlinkSync(currentPath);
                    console.log(`🔓 Lock eliminado: ${file}`);
                }
            }
        }
    } catch (e) {
        console.error("⚠️ Error limpiando locks:", e.message);
    }
}

// --- FUNCIÓN MAESTRA: INICIAR SESIÓN (MODIFICADA) ---
async function startSession(sessionName, isManual = false) {
    if (client) { 
        try { await client.destroy(); } catch(e) {} 
        client = null; 
        isClientReady = false; 
    }
    
    // 1. MATAR PROCESOS ZOMBIE (Linux/Render)
    try {
        console.log("🔫 Asegurando que no haya Chromes zombies...");
        execSync("pkill -f chrome || true"); // El '|| true' evita error si no hay procesos
    } catch (e) { }

    isPaused = false; 
    mensajesEnRacha = 0;

    activeSessionName = sessionName;
    console.log(`🔵 INICIANDO: ${sessionName.toUpperCase()} (Stealth Mode)`);
    io.emit('status', `⏳ Cargando ${sessionName.toUpperCase()}...`);

    // 2. LIMPIEZA PROFUNDA DE LOCKS
    try {
        const folderPath = path.resolve(`./data/session-client-${sessionName}`);
        console.log(`🧹 Limpiando locks en: ${folderPath}`);
        recursiveDeleteLocks(folderPath);
    } catch (errLock) {
        console.error("Error en limpieza de locks:", errLock);
    }

    const puppeteerConfig = {
        headless: true,
        protocolTimeout: 300000,
        ignoreDefaultArgs: ['--enable-automation'], 
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', 
            '--no-first-run', 
            '--single-process', 
            '--disable-gpu',
            '--js-flags="--max-old-space-size=1024"',
            '--disable-blink-features=AutomationControlled', 
            '--disable-infobars',
            '--window-size=1920,1080',
            // Agregamos userDataDir explícito para asegurar control
            `--user-data-dir=./data/session-client-${sessionName}`,
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    };
    if (RUTA_CHROME_DETECTADA) puppeteerConfig.executablePath = RUTA_CHROME_DETECTADA;

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

    // ... (El resto de tus eventos client.on('qr'), 'ready', etc. siguen igual)
    client.on('qr', async (qr) => { 
        console.log(`📸 SE REQUIERE ESCANEO PARA ${sessionName.toUpperCase()}`);
        if (isManual) {
            console.log('(Modo Manual activado)'); 
        } else {
            console.log(`⚠️ ALERTA: ${sessionName} pidió QR en modo AUTO.`);
        }
        io.emit('qr', qr); 
        io.emit('status', `📸 SESIÓN CADUCADA: ESCANEA AHORA (${sessionName.toUpperCase()})`); 
    });

    client.on('ready', () => { 
        isClientReady = true; 
        console.log(`✅ ${sessionName} CONECTADO Y LISTO`);
        io.emit('status', `✅ ACTIVO: ${sessionName.toUpperCase()}`); 
        io.emit('connected', { 
            name: client.info.pushname, 
            number: client.info.wid.user, 
            session: sessionName 
        }); 
        processQueue(); 
    });

    client.on('auth_failure', () => {
        console.log('⛔ FALLO DE AUTENTICACIÓN');
        io.emit('status', '⛔ CREDENCIALES INVÁLIDAS');
        if (!isManual) borrarSesion(sessionName);
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
        if(e.message.includes('Target closed')) {
             console.log('🔄 Reiniciando por error de navegador en 5 segundos...');
             setTimeout(() => process.exit(1), 5000); 
        }
    }
}

// --- GENERADOR DE PDF ---
async function generarYEnviarPDF(item, clientInstance) {
    try {
        console.log(`📄 Generando PDF para ${item.numero}...`);
        const { datos_ticket, foto_evidencia } = item.pdfData;
        
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

// --- PROCESADOR DE COLA ---
const processQueue = async () => {
    if (isProcessingQueue || messageQueue.length === 0) return;
    if (isPaused) return; 

    if (!isClientReady || !client) return; 
    
    // RACHA DE 5 a 9 MENSAJES
    if (mensajesEnRacha >= limiteRachaActual) {
        isPaused = true; 
        // PAUSA DE 8 a 15 MINUTOS (SOLICITUD USUARIO)
        const minutosPausa = getRandomDelay(8, 15); 
        console.log(`☕ PAUSA "BAÑO/CAFÉ" DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso (${minutosPausa} min)`);
        
        setTimeout(() => { 
            console.log('⚡ Reanudando envíos...'); 
            isPaused = false; 
            mensajesEnRacha = 0; 
            limiteRachaActual = getRandomDelay(5, 9); // Nueva racha aleatoria
            processQueue(); 
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
        
        // Simula "escribiendo..." (4-8 segundos)
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
            if(item.resolve) item.resolve({ success: true });
            mensajesEnRacha++; 
            console.log(`✅ Mensaje enviado a ${item.numero} (Racha: ${mensajesEnRacha}/${limiteRachaActual})`);
        } else {
            if(item.resolve) item.resolve({ success: false, error: 'Número no registrado' });
            console.log(`⚠️ ${item.numero} no registrado`);
        }
    } catch (error) {
        console.error('❌ Error en cola:', error.message);
        if(item.resolve) item.resolve({ success: false, error: error.message });
        if (error.message.includes('Session closed')) {
            console.error('💀 SESIÓN MURIÓ. REINICIANDO SISTEMA...');
            process.exit(1); 
        }
    } finally {
        messageQueue.shift(); 
        saveQueue(); // 💾 ACTUALIZAR CUADERNO AL TERMINAR UNO
        
        // Pausa entre mensajes (45-90 segundos)
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
    if (!isClientReady) return res.status(503).json({ error: 'Bot no está listo' });
    if (!checkOfficeHours().isOpen) return res.status(400).json({ error: 'Fuera de horario laboral' });
    
    messageQueue.push({ type: 'normal', ...req.body, resolve: () => {} });
    saveQueue(); // 💾 GUARDAR EN CUADERNO
    processQueue();
    res.json({ success: true, message: 'Agregado a la cola', posicion_cola: messageQueue.length });
});

app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    if (!isClientReady) return res.status(503).json({ error: 'Bot no está listo' });
    if (!checkOfficeHours().isOpen) return res.status(400).json({ error: 'Fuera de horario laboral' });
    
    // VIP: UNSHIFT
    messageQueue.unshift({ 
        type: 'pdf', 
        ...req.body, 
        pdfData: { datos_ticket: req.body.datos_ticket, foto_evidencia: req.body.foto_evidencia }, 
        resolve: () => {} 
    });
    
    saveQueue(); // 💾 GUARDAR EN CUADERNO
    processQueue();
    res.json({ success: true, message: 'PDF VIP agregado', posicion_cola: 1 });
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
    saveQueue(); // 💾 LIMPIAR CUADERNO
    res.json({ success: true, message: `${cantidad} mensajes eliminados` }); 
});

// NUEVOS ENDPOINTS PARA GESTIÓN VISUAL
app.get('/cola-pendientes', authMiddleware, (req, res) => {
    // Devolvemos la cola limpia (sin funciones)
    const vistaCola = messageQueue.map((item, index) => ({
        index,
        numero: item.numero,
        tipo: item.type,
        folio: item.pdfData ? item.pdfData.datos_ticket.folio : 'N/A'
    }));
    res.json(vistaCola);
});

app.post('/borrar-item-cola', authMiddleware, (req, res) => {
    const { index } = req.body;
    if (index >= 0 && index < messageQueue.length) {
        messageQueue.splice(index, 1);
        saveQueue(); // 💾 ACTUALIZAR CUADERNO
        res.json({ success: true, message: 'Elemento eliminado de la cola' });
    } else {
        res.status(400).json({ error: 'Índice inválido' });
    }
});

app.get('/', (req, res) => res.render('index'));

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
        pausa_activa: isPaused 
    });
});

io.on('connection', (socket) => {
    console.log('🔌 Cliente WebSocket conectado');
    if(activeSessionName) {
        socket.emit('status', isClientReady 
            ? `✅ ACTIVO: ${activeSessionName.toUpperCase()}` 
            : `⏳ Cargando ${activeSessionName.toUpperCase()}...`
        );
    } else {
        socket.emit('status', '💤 Sistema en espera');
    }
});

server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR LISTO EN PUERTO ${PORT}`);
    loadQueue(); // 💾 RECUPERAR MEMORIA AL INICIAR

    const turno = getTurnoActual();
    console.log(`🕐 TURNO ACTUAL: ${turno.toUpperCase()}`);
    
    // Si la sesión existe, la intentamos iniciar.
    // Si falla el QR, el nuevo código de arriba (línea ~230) EVITARÁ que se reinicie el servidor.
    if (existeSesion(turno)) {
        startSession(turno, false);
    } else {
        io.emit('status', `⚠️ FALTA SESIÓN ${turno.toUpperCase()}. INICIE MANUALMENTE.`);
    }
    
    setInterval(() => {
        const turnoDebido = getTurnoActual();
        if (activeSessionName && activeSessionName !== turnoDebido) {
            if (existeSesion(turnoDebido)) {
                console.log(`🔄 CAMBIO DE TURNO A ${turnoDebido.toUpperCase()}. REINICIANDO...`);
                process.exit(0); 
            }
        }
    }, 60000); 
});