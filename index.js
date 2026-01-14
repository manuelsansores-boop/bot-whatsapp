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
const PORT = process.env.PORT || 10000; 
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;
const COLA_FILE = './data/cola.json'; 

app.use(express.json());
app.set('view engine', 'ejs');

// --- VARIABLES DE ESTADO --- 
let client = null; 
let activeSessionName = null; 
let isClientReady = false;

// --- NUEVA ESTRUCTURA DE CUBETAS (RATIO 3:2) ---
let pdfQueue = [];
let normalQueue = [];
let pdfEnCiclo = 0;    
let normalEnCiclo = 0; 

let isProcessingQueue = false;
let mensajesEnRacha = 0;
let isPaused = false; 

// Racha inicial: 5 a 9 mensajes (SOLICITUD USUARIO) 
let limiteRachaActual = Math.floor(Math.random() * (9 - 5 + 1) + 5); 

// --- FUNCIONES DE PERSISTENCIA (EL "CUADERNO" ACTUALIZADO) --- 
function saveQueue() {
    try {
        const cleanPdf = pdfQueue.map(item => {
            const { resolve, ...data } = item; 
            return data;
        });
        const cleanNormal = normalQueue.map(item => {
            const { resolve, ...data } = item; 
            return data;
        });

        const backup = {
            pdfQueue: cleanPdf,
            normalQueue: cleanNormal,
            pdfEnCiclo,
            normalEnCiclo
        };

        if (!fs.existsSync('./data')) fs.mkdirSync('./data');
        fs.writeFileSync(COLA_FILE, JSON.stringify(backup, null, 2));
    } catch (e) {
        console.error("❌ Error guardando cuaderno:", e);
    }
}

function loadQueue() {
    try {
        if (fs.existsSync(COLA_FILE)) {
            const data = fs.readFileSync(COLA_FILE, 'utf8');
            const backup = JSON.parse(data);
            
            pdfQueue = (backup.pdfQueue || []).map(item => ({ ...item, resolve: () => {} }));
            normalQueue = (backup.normalQueue || []).map(item => ({ ...item, resolve: () => {} }));
            pdfEnCiclo = backup.pdfEnCiclo || 0;
            normalEnCiclo = backup.normalEnCiclo || 0;

            console.log(`📒 MEMORIA RECUPERADA: ${pdfQueue.length} PDFs y ${normalQueue.length} Normales.`);
        }
    } catch (e) {
        console.error("❌ Error cargando cuaderno:", e);
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
    return (hora >= 8 && hora < 18) ? { isOpen: true } : { isOpen: false }; 
};

function getTurnoActual() {
    const hora = moment().tz('America/Mexico_City').hour();
    // Turnos de 2 horas (Chip A: 8-10, 12-14, 16-18)
    if ((hora >= 8 && hora < 10) || (hora >= 12 && hora < 14) || (hora >= 16 && hora < 18)) return 'chip-a';
    return 'chip-b'; 
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
            console.log(`🗑️ Carpeta ${sessionName} eliminada.`);
        }
    } catch (e) { 
        console.error(`Error borrando ${sessionName}:`, e); 
    }
}

function recursiveDeleteLocks(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const currentPath = path.join(dirPath, file);
            if (fs.lstatSync(currentPath).isDirectory()) {
                recursiveDeleteLocks(currentPath);
            } else {
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

// --- FUNCIÓN MAESTRA: INICIAR SESIÓN --- 
async function startSession(sessionName, isManual = false) {
    let abortandoPorFaltaDeQR = false; 

    if (client) { 
        try { await client.destroy(); } catch(e) {} 
        client = null; 
        isClientReady = false; 
    }
    
    try {
        console.log("🔫 Asegurando que no haya Chromes zombies...");
        execSync("pkill -f chrome || true");
    } catch (e) { }

    isPaused = false; 
    mensajesEnRacha = 0;
    activeSessionName = sessionName;
    console.log(`🔵 INICIANDO: ${sessionName.toUpperCase()} (Stealth Mode)`);
    io.emit('status', `⏳ Cargando ${sessionName.toUpperCase()}...`);

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

    client.on('qr', async (qr) => { 
        if (!isManual) {
            console.log(`⛔ ${sessionName} requirió QR en modo AUTO. Deteniendo...`);
            io.emit('status', `⚠️ SESIÓN ${sessionName.toUpperCase()} CADUCADA. REQUIERE INICIO MANUAL.`);
            abortandoPorFaltaDeQR = true; 
            try { await client.destroy(); } catch(e) {}
            client = null;
            isClientReady = false;
            return;
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

    client.on('auth_failure', async () => {
        io.emit('status', '⛔ CREDENCIALES INVÁLIDAS');
        try { await client.destroy(); } catch(e) {}
        client = null;
        if (!isManual) borrarSesion(sessionName);
    });

    client.on('disconnected', (reason) => { 
        isClientReady = false; 
        io.emit('status', '❌ Desconectado'); 
        if (reason === 'LOGOUT') borrarSesion(sessionName);
    });

    try { 
        await client.initialize(); 
    } catch (e) { 
        if (abortandoPorFaltaDeQR) return;
        if(e.message.includes('Target closed')) setTimeout(() => process.exit(1), 5000); 
    }
}

// --- GENERADOR DE PDF --- 
async function generarYEnviarPDF(item, clientInstance) {
    try {
        console.log(`📄 Generando PDF para ${item.numero}...`);
        const { datos_ticket, foto_evidencia } = item.pdfData;
        
        const htmlContent = `
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                body{font-family:Arial,sans-serif;font-size:12px;padding:20px}
                .ticket{width:100%;max-width:400px;margin:0 auto;border:1px solid #999;padding:10px}
                .header,.footer{text-align:center;margin-bottom:10px;border-bottom:2px solid #000;padding-bottom:10px}
                .bold{font-weight:bold}
                table{width:100%;border-collapse:collapse;margin-top:10px}
                th,td{text-align:left;padding:5px;border-bottom:1px solid #ccc;font-size:11px}
                .totals{margin-top:15px;text-align:right}
                .evidencia{margin-top:20px;text-align:center;border-top:2px dashed #000;padding-top:10px}
                img{max-width:100%;height:auto}
            </style>
        </head>
        <body>
            <div class="ticket">
                <div class="header">
                    <p class="bold" style="font-size:1.2em">FERROLÁMINAS RICHAUD SA DE CV</p>
                    <p>FRI90092879A</p>
                    <p>Sucursal: ${datos_ticket.sucursal || 'Matriz'}</p>
                    <p>Fecha: ${datos_ticket.fecha}</p>
                    <p class="bold" style="font-size:1.2em">Ticket: ${datos_ticket.folio}</p>
                </div>
                <div>
                    <p><span class="bold">Cliente:</span> ${datos_ticket.cliente}</p>
                    <p><span class="bold">Dirección:</span> ${datos_ticket.direccion}</p>
                </div>
                <div style="text-align:center;margin:10px 0;font-weight:bold">DETALLE DE COMPRA</div>
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
                                <td>$${(p.cantidad*p.precio).toFixed(2)}</td>
                            </tr>`).join('')}
                    </tbody>
                </table>
                <div class="totals">
                    <p>Subtotal: $${datos_ticket.subtotal}</p>
                    <p>Impuestos: $${datos_ticket.impuestos}</p>
                    <p class="bold" style="font-size:1.2em">TOTAL: $${datos_ticket.total}</p>
                </div>
                ${foto_evidencia ? `<div class="evidencia"><p class="bold">📸 EVIDENCIA DE ENTREGA</p><img src="${foto_evidencia}" onerror="this.style.display='none'"/></div>`:''}
            </div>
        </body>
        </html>`;

        // ▼▼▼ CONFIGURACIÓN MEJORADA DE PUPPETEER ▼▼▼
        const browserConfig = { 
            headless: true, 
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-web-security' // Permite cargar imágenes externas
            ],
            timeout: 30000
        };
        
        // Usa el Chrome detectado (si existe)
        if (RUTA_CHROME_DETECTADA) {
            browserConfig.executablePath = RUTA_CHROME_DETECTADA;
        }

        const browser = await puppeteer.launch(browserConfig);
        const page = await browser.newPage();

        // Carga el HTML
        await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: 15000 });

        // Si hay foto, espera que cargue (máximo 8 segundos)
        if (foto_evidencia) {
            try {
                await page.waitForFunction(() => {
                    const img = document.querySelector('.evidencia img');
                    return img && (img.complete || img.style.display === 'none');
                }, { timeout: 8000 }); 
            } catch (e) {
                console.log("⚠️ Foto no cargó. Generando PDF sin ella...");
            }
        }

        // Genera el PDF
        const pdfBuffer = await page.pdf({ 
            format: 'A4', 
            printBackground: true,
            margin: { top: '20px', bottom: '20px' }
        });
        await browser.close();

        // ▼▼▼ FIX CRÍTICO: CREA MessageMedia CORRECTAMENTE ▼▼▼
        const media = new MessageMedia(
            'application/pdf', 
            pdfBuffer.toString('base64'), 
            `Ticket-${datos_ticket.folio}.pdf`
        );
        
        // Limpia el número
        let chatId = item.numero.replace(/\D/g, '');
        if (chatId.length === 10) chatId = '52' + chatId;
        chatId = chatId + '@c.us';
        
        // ▼▼▼ ENVÍO CON MANEJO DE ERRORES ▼▼▼
        await clientInstance.sendMessage(chatId, media, { 
            caption: item.mensaje || "Su pedido ha sido entregado. Adjunto ticket y evidencia. 📄🏠"
        });
        
        console.log(`✅ PDF enviado exitosamente a ${item.numero}`);
        return true;

    } catch (e) {
        console.error("❌ Error completo PDF:", e);
        
        // ▼▼▼ FALLBACK: ENVÍA MENSAJE DE TEXTO ▼▼▼
        try {
            let chatId = item.numero.replace(/\D/g, '');
            if (chatId.length === 10) chatId = '52' + chatId;
            
            await clientInstance.sendMessage(chatId + '@c.us', 
                `⚠️ No se pudo generar el PDF del ticket ${item.pdfData.datos_ticket.folio}. Por favor contacte soporte.`
            );
        } catch(fallbackError) {
            console.error("❌ Fallo también el mensaje de texto:", fallbackError);
        }
        
        return false;
    }
}

// --- PROCESADOR DE COLA (LÓGICA MEJORADA 3:2) --- 
const processQueue = async () => {
    if (isProcessingQueue || (pdfQueue.length === 0 && normalQueue.length === 0)) return;
    if (isPaused || !isClientReady || !client) return; 

    if (mensajesEnRacha >= limiteRachaActual) {
        isPaused = true; 
        const minutosPausa = getRandomDelay(8, 15); 
        console.log(`☕ PAUSA "BAÑO/CAFÉ" DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso (${minutosPausa} min)`);
        
        setTimeout(() => { 
            isPaused = false; 
            mensajesEnRacha = 0; 
            limiteRachaActual = getRandomDelay(5, 9);
            processQueue(); 
        }, minutosPausa * 60000);
        return;
    }
    
    isProcessingQueue = true;

    // --- DECISOR DE RATIO 3:2 ---
    let item = null;
    let tipoSeleccionado = '';

    if (pdfQueue.length > 0 && pdfEnCiclo < 3) {
        item = pdfQueue[0];
        tipoSeleccionado = 'pdf';
    } 
    else if (normalQueue.length > 0 && normalEnCiclo < 2) {
        item = normalQueue[0];
        tipoSeleccionado = 'normal';
    }
    else {
        if (pdfQueue.length > 0) {
            item = pdfQueue[0];
            tipoSeleccionado = 'pdf';
            if (normalQueue.length === 0) { pdfEnCiclo = 0; normalEnCiclo = 0; }
        } else if (normalQueue.length > 0) {
            item = normalQueue[0];
            tipoSeleccionado = 'normal';
            if (pdfQueue.length === 0) { pdfEnCiclo = 0; normalEnCiclo = 0; }
        }
    }

   if (!item) { isProcessingQueue = false; return; }

    // ▼▼▼ NUEVO CÓDIGO: SI TIENE BASURA (COMO /), LO BORRA Y SIGUE ▼▼▼
    if (/[^\d\s\+\-\(\)]/.test(item.numero)) {
        console.log(`🗑️ ELIMINADO POR FORMATO MALO: ${item.numero}`);
        
        // Lo saca de la cola
        if (tipoSeleccionado === 'pdf') pdfQueue.shift();
        else normalQueue.shift();

        saveQueue();
        isProcessingQueue = false;
        processQueue(); // Pasa al siguiente inmediatamente
        return;
    }
    // ▲▲▲ FIN NUEVO CÓDIGO ▲▲▲

    try {
        let cleanNumber = item.numero.replace(/\D/g, '');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';
        
        console.log(`⏳ Procesando ${item.numero} (${tipoSeleccionado})...`);
        // Simula "escribiendo..." (4-8 segundos)
        await new Promise(r => setTimeout(r, getRandomDelay(4000, 8000)));
        
        const isRegistered = await client.isRegisteredUser(finalNumber);
        if (isRegistered) {
            if (tipoSeleccionado === 'pdf') {
                await generarYEnviarPDF(item, client);
                pdfEnCiclo++;
            } else {
                if (item.mediaUrl) {
                    const media = await MessageMedia.fromUrl(item.mediaUrl, { unsafeMime: true });
                    await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                } else {
                    await client.sendMessage(finalNumber, item.mensaje);
                }
                normalEnCiclo++;
            }
            mensajesEnRacha++; 
            
            if (pdfEnCiclo >= 3 && normalEnCiclo >= 2) {
                pdfEnCiclo = 0;
                normalEnCiclo = 0;
            }

            console.log(`✅ Enviado (Racha: ${mensajesEnRacha}/${limiteRachaActual}) (Ciclo: P:${pdfEnCiclo} N:${normalEnCiclo})`);
        }
    } catch (error) {
        console.error('❌ Error envío:', error.message);
        if (error.message.includes('Session closed')) process.exit(1); 
    } finally {
        if (tipoSeleccionado === 'pdf') pdfQueue.shift(); 
        else normalQueue.shift();

        saveQueue(); 
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
    res.json({ success: true, message: 'Iniciando chip-a manual' }); 
});

app.post('/iniciar-chip-b', authMiddleware, (req, res) => { 
    startSession('chip-b', true); 
    res.json({ success: true, message: 'Iniciando chip-b manual' }); 
});

app.post('/enviar', authMiddleware, (req, res) => {
    if (!checkOfficeHours().isOpen) return res.status(400).json({ error: 'Fuera de horario laboral' });
    normalQueue.push({ type: 'normal', ...req.body, resolve: () => {} });
    saveQueue(); 
    processQueue();
    res.json({ success: true, posicion: normalQueue.length });
});

app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    if (!checkOfficeHours().isOpen) return res.status(400).json({ error: 'Fuera de horario laboral' });
    pdfQueue.push({ 
        type: 'pdf', 
        ...req.body, 
        pdfData: { datos_ticket: req.body.datos_ticket, foto_evidencia: req.body.foto_evidencia }, 
        resolve: () => {} 
    });
    saveQueue(); 
    processQueue();
    res.json({ success: true, posicion: pdfQueue.length });
});

app.get('/cola-pendientes', authMiddleware, (req, res) => {
    const vistaPdf = pdfQueue.map((item, i) => ({ 
        index: i, 
        tipo: 'pdf', 
        numero: item.numero,
        folio: item.pdfData?.datos_ticket?.folio || 'N/A'
    }));
    const vistaNormal = normalQueue.map((item, i) => ({ 
        index: i + pdfQueue.length, 
        tipo: 'normal', 
        numero: item.numero,
        folio: 'Aviso Salida'
    }));
    res.json([...vistaPdf, ...vistaNormal]);
});

app.post('/borrar-item-cola', authMiddleware, (req, res) => {
    const { index } = req.body;
    if (index < pdfQueue.length) {
        pdfQueue.splice(index, 1);
    } else {
        normalQueue.splice(index - pdfQueue.length, 1);
    }
    saveQueue();
    res.json({ success: true, message: 'Elemento eliminado' });
});

app.post('/limpiar-cola', authMiddleware, (req, res) => { 
    pdfQueue = []; normalQueue = []; pdfEnCiclo = 0; normalEnCiclo = 0;
    saveQueue(); 
    res.json({ success: true, message: 'Colas vaciadas' }); 
});

app.post('/detener-bot', authMiddleware, async (req, res) => { 
    try { await client.destroy(); } catch(e) {}
    process.exit(0); 
});

app.get('/status', (req, res) => {
    res.json({ 
        ready: isClientReady, 
        cola_total: pdfQueue.length + normalQueue.length, 
        pdfs: pdfQueue.length,
        normales: normalQueue.length,
        ciclo: `P:${pdfEnCiclo}/3 N:${normalEnCiclo}/2`,
        racha: `${mensajesEnRacha}/${limiteRachaActual}`,
        session: activeSessionName,
        pausa: isPaused 
    });
});

app.get('/', (req, res) => res.render('index'));

io.on('connection', (socket) => {
    if(activeSessionName) {
        socket.emit('status', isClientReady 
            ? `✅ ACTIVO: ${activeSessionName.toUpperCase()}` 
            : `⏳ Cargando ${activeSessionName.toUpperCase()}...`
        );
    }
});

server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR LISTO EN PUERTO ${PORT}`);
    loadQueue(); 
    const turno = getTurnoActual();
    if (existeSesion(turno)) startSession(turno, false);
    
    setInterval(() => {
        const turnoDebido = getTurnoActual();
        if (activeSessionName && activeSessionName !== turnoDebido) process.exit(0); 
    }, 60000); 
});