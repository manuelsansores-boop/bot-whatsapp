const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 
const puppeteer = require('puppeteer'); 
const { execSync } = require('child_process');

console.log('🚀 [INICIO] Script iniciado - timestamp:', new Date().toISOString());

// ▼▼▼ FIX INSTALACIÓN CHROME (MEJORADO: Busca la versión más reciente) ▼▼▼ 
let RUTA_CHROME_DETECTADA = null;
try {
    console.log("🛠️ [CHROME-1] Asegurando instalación de Chrome...");
    execSync("npx puppeteer browsers install chrome@stable", { stdio: 'inherit' });
    console.log("✅ [CHROME-2] Comando de instalación ejecutado");
    
    const cacheDir = path.join(process.cwd(), '.cache', 'chrome');
    console.log(`📁 [CHROME-3] Verificando directorio cache: ${cacheDir}`);
    
    if (fs.existsSync(cacheDir)) {
        console.log(`✅ [CHROME-4] Directorio cache existe`);
        const carpetas = fs.readdirSync(cacheDir).sort().reverse(); 
        console.log(`📂 [CHROME-5] Carpetas encontradas: ${carpetas.join(', ')}`);
        
        for (const carpeta of carpetas) {
            const posibleRuta = path.join(cacheDir, carpeta, 'chrome-linux64', 'chrome');
            console.log(`🔍 [CHROME-6] Verificando ruta: ${posibleRuta}`);
            
            if (fs.existsSync(posibleRuta)) {
                RUTA_CHROME_DETECTADA = posibleRuta;
                console.log(`✅ [CHROME-7] Chrome seleccionado (Versión más nueva): ${posibleRuta}`);
                break;
            } else {
                console.log(`❌ [CHROME-8] No existe: ${posibleRuta}`);
            }
        }
    } else {
        console.log(`⚠️ [CHROME-9] Directorio cache NO existe: ${cacheDir}`);
    }
    
    if (!RUTA_CHROME_DETECTADA) {
        console.log('⚠️ [CHROME-10] No se detectó Chrome, usando default de Puppeteer');
    }
} catch (error) { 
    console.error("❌ [CHROME-ERROR] Error en instalación Chrome:", error.message);
    console.error("📜 [CHROME-ERROR] Stack:", error.stack); 
}

console.log('🔧 [FFMPEG-1] Configurando FFMPEG...');
const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;
console.log(`✅ [FFMPEG-2] FFMPEG path: ${ffmpegPath}`);

// --- CARGA DE ASSETS DEL TICKET (logo + banners laterales) ---
// Se leen UNA sola vez al arrancar y se guardan como data URI base64.
// Si falta alguna imagen, queda en null y el ticket simplemente la omite (no rompe).
function cargarAssetTicket(nombreArchivo) {
    try {
        const ruta = path.join(__dirname, 'assets', 'ticket', nombreArchivo);
        if (fs.existsSync(ruta)) {
            const b64 = fs.readFileSync(ruta).toString('base64');
            console.log(`✅ [ASSET] ${nombreArchivo} cargado (${Math.round(b64.length / 1024)} KB base64)`);
            return `data:image/png;base64,${b64}`;
        }
        console.log(`⚠️ [ASSET] No se encontró ${nombreArchivo} en assets/ticket/`);
        return null;
    } catch (e) {
        console.error(`❌ [ASSET] Error cargando ${nombreArchivo}:`, e.message);
        return null;
    }
}
const ASSET_LOGO        = cargarAssetTicket('logo.png');
const ASSET_BANNER_IZQ  = cargarAssetTicket('banner-izquierdo.png');
const ASSET_BANNER_DER  = cargarAssetTicket('banner-derecho.png');

console.log('🌐 [EXPRESS-1] Creando servidor Express...');
const app = express();
const server = http.createServer(app);
console.log('✅ [EXPRESS-2] Servidor HTTP creado');

console.log('🔌 [SOCKET-1] Inicializando Socket.IO...');
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['websocket', 'polling']
});
console.log('✅ [SOCKET-2] Socket.IO configurado');

const PORT = process.env.PORT || 10000; 
const MI_TOKEN_SECRETO = process.env.AUTH_TOKEN;
const COLA_FILE = './data/cola.json'; 

console.log(`⚙️ [CONFIG] Puerto: ${PORT}`);
console.log(`🔐 [CONFIG] Token existe: ${!!MI_TOKEN_SECRETO}`);

console.log('📦 [MIDDLEWARE-1] Configurando middleware...');
app.use(express.json());
app.set('view engine', 'ejs');
console.log('✅ [MIDDLEWARE-2] Middleware configurado');

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

console.log('✅ [VARS] Variables globales inicializadas');

// --- FUNCIONES DE PERSISTENCIA (EL "CUADERNO" ACTUALIZADO) --- 
function saveQueue() {
    try {
        console.log(`💾 [SAVE-1] Guardando cola: ${pdfQueue.length} PDFs, ${normalQueue.length} Normales`);
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

        if (!fs.existsSync('./data')) {
            console.log('📁 [SAVE-2] Creando directorio ./data');
            fs.mkdirSync('./data');
        }
        
        fs.writeFileSync(COLA_FILE, JSON.stringify(backup, null, 2));
        console.log('✅ [SAVE-3] Cola guardada exitosamente');
    } catch (e) {
        console.error("❌ [SAVE-ERROR] Error guardando cuaderno:", e);
    }
}

function loadQueue() {
    try {
        console.log(`🔍 [LOAD-1] Buscando cola guardada: ${COLA_FILE}`);
        if (fs.existsSync(COLA_FILE)) {
            console.log('✅ [LOAD-2] Archivo de cola encontrado');
            const data = fs.readFileSync(COLA_FILE, 'utf8');
            const backup = JSON.parse(data);
            
            pdfQueue = (backup.pdfQueue || []).map(item => ({ ...item, resolve: () => {} }));
            normalQueue = (backup.normalQueue || []).map(item => ({ ...item, resolve: () => {} }));
            pdfEnCiclo = backup.pdfEnCiclo || 0;
            normalEnCiclo = backup.normalEnCiclo || 0;

            console.log(`📒 [LOAD-3] MEMORIA RECUPERADA: ${pdfQueue.length} PDFs y ${normalQueue.length} Normales.`);
        } else {
            console.log('ℹ️ [LOAD-2] No hay cola guardada anterior');
        }
    } catch (e) {
        console.error("❌ [LOAD-ERROR] Error cargando cuaderno:", e);
    }
}

// --- MIDDLEWARE DE AUTENTICACIÓN --- 
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!MI_TOKEN_SECRETO || token !== MI_TOKEN_SECRETO) {
        console.log(`⛔ [AUTH] Acceso denegado desde ${req.ip}`);
        return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
};

// --- UTILIDADES ---
const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

// Formatea un valor (número o string) como dinero: 4296.46 -> "$4,296.46"
const fmtMoney = (v) => {
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')) || 0;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const checkOfficeHours = () => {
    const hora = moment().tz('America/Mexico_City').hour();
    // ⚠️ EXTENDIDO TEMPORALMENTE HASTA 21H PARA PRUEBA DE RECONEXIÓN CHIP A
    return (hora >= 8 && hora < 21) ? { isOpen: true } : { isOpen: false };
};

function getTurnoActual() {
    const hora = moment().tz('America/Mexico_City').hour();
    // Chip B: 10-13, 14-16, 18-19
    if ((hora >= 10 && hora < 13) || (hora >= 14 && hora < 16) || (hora >= 18 && hora < 19)) return 'chip-b';
    // Chip A: 8-10, 13-14, 16-18, 19-21 (ventana de prueba de reconexión), y resto
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
    const exists = fs.existsSync(`./data/session-client-${sessionName}`);
    console.log(`🔍 [SESSION-CHECK] Sesión ${sessionName} existe: ${exists}`);
    return exists;
}

function borrarSesion(sessionName) {
    const folderPath = `./data/session-client-${sessionName}`;
    try { 
        console.log(`🗑️ [DELETE-1] Intentando borrar: ${folderPath}`);
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`✅ [DELETE-2] Carpeta ${sessionName} eliminada.`);
        }
    } catch (e) { 
        console.error(`❌ [DELETE-ERROR] Error borrando ${sessionName}:`, e); 
    }
}

function recursiveDeleteLocks(dirPath) {
    if (!fs.existsSync(dirPath)) {
        console.log(`ℹ️ [LOCK-1] Directorio no existe: ${dirPath}`);
        return;
    }
    try {
        console.log(`🧹 [LOCK-2] Limpiando locks en: ${dirPath}`);
        const files = fs.readdirSync(dirPath);
        let locksEliminados = 0;
        
        for (const file of files) {
            const currentPath = path.join(dirPath, file);
            if (fs.lstatSync(currentPath).isDirectory()) {
                recursiveDeleteLocks(currentPath);
            } else {
                if (file.includes('Singleton') || file.includes('lockfile')) {
                    fs.unlinkSync(currentPath);
                    console.log(`🔓 [LOCK-3] Lock eliminado: ${file}`);
                    locksEliminados++;
                }
            }
        }
        console.log(`✅ [LOCK-4] Limpieza completada: ${locksEliminados} locks eliminados`);
    } catch (e) {
        console.error("❌ [LOCK-ERROR] Error limpiando locks:", e.message);
    }
}

// --- FUNCIÓN MAESTRA: INICIAR SESIÓN ---
async function startSession(sessionName, isManual = false) {
    console.log(`\n🔵 [SESSION-START-1] ========== INICIANDO SESIÓN: ${sessionName.toUpperCase()} ==========`);
    console.log(`🔵 [SESSION-START-2] Modo: ${isManual ? 'MANUAL' : 'AUTO'}`);
    console.log(`🔵 [SESSION-START-3] Timestamp: ${new Date().toISOString()}`);
    const mem0 = process.memoryUsage();
    console.log(`📊 [SESSION-START-4] RAM inicial: heap ${Math.round(mem0.heapUsed/1024/1024)}/${Math.round(mem0.heapTotal/1024/1024)}MB, RSS ${Math.round(mem0.rss/1024/1024)}MB`);

    let abortandoPorFaltaDeQR = false;
    // Variables para monitor de QR
    let qrEscaneoTime = null;
    let qrMonitorInterval = null;
    let qrContador = 0;
    let autenticadoRecibido = false; 

    if (client) { 
        console.log('⚠️ [SESSION-4] Cliente existente detectado, destruyendo...');
        try { 
            await client.destroy(); 
            console.log('✅ [SESSION-5] Cliente anterior destruido');
        } catch(e) {
            console.log('⚠️ [SESSION-6] Error destruyendo cliente:', e.message);
        } 
        client = null; 
        isClientReady = false; 
    }
    
    try {
        console.log("🔫 [CHROME-KILL-1] Asegurando que no haya Chromes zombies...");
        execSync("pkill -f chrome || true");
        console.log("✅ [CHROME-KILL-2] Proceso de limpieza completado");
    } catch (e) { 
        console.log("ℹ️ [CHROME-KILL-3] No hay procesos Chrome para matar");
    }

    isPaused = false; 
    mensajesEnRacha = 0;
    activeSessionName = sessionName;
    console.log(`✅ [SESSION-7] Variables de estado reseteadas`);
    
    io.emit('status', `⏳ Cargando ${sessionName.toUpperCase()}...`);

    try {
        const folderPath = path.resolve(`./data/session-client-${sessionName}`);
        console.log(`🧹 [SESSION-8] Limpiando locks en: ${folderPath}`);
        recursiveDeleteLocks(folderPath);
    } catch (errLock) {
        console.error("❌ [SESSION-ERROR-1] Error en limpieza de locks:", errLock);
    }

    console.log('⚙️ [PUPPETEER-1] Configurando Puppeteer...');
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
    
    if (RUTA_CHROME_DETECTADA) {
        puppeteerConfig.executablePath = RUTA_CHROME_DETECTADA;
        console.log(`✅ [PUPPETEER-2] Usando Chrome detectado: ${RUTA_CHROME_DETECTADA}`);
    } else {
        console.log(`ℹ️ [PUPPETEER-2] Usando Chrome default de Puppeteer`);
    }

    console.log('📱 [WHATSAPP-1] Creando cliente WhatsApp...');
    client = new Client({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        authStrategy: new LocalAuth({ 
            clientId: `client-${sessionName}`, 
            dataPath: './data' 
        }),
        puppeteer: puppeteerConfig,
        qrMaxRetries: isManual ? 5 : 0, 
        ffmpegPath: ffmpegPath,
        
    });
    console.log('✅ [WHATSAPP-2] Cliente WhatsApp creado');

    console.log('🎧 [EVENTS-1] Registrando event handlers...');
    
    client.on('qr', async (qr) => {
        qrContador++;
        const tsQR = new Date().toISOString();
        console.log(`\n📸 ========== [QR-EVENTO #${qrContador}] ==========`);
        console.log(`📸 [QR-1] QR #${qrContador} recibido para ${sessionName} | ${tsQR}`);
        console.log(`📸 [QR-2] Longitud código QR: ${qr.length} caracteres`);
        console.log(`📸 [QR-3] isManual: ${isManual} | qrMaxRetries configurado: ${isManual ? 5 : 0}`);
        const memQR = process.memoryUsage();
        console.log(`📊 [QR-4] RAM al recibir QR: heap ${Math.round(memQR.heapUsed/1024/1024)}/${Math.round(memQR.heapTotal/1024/1024)}MB, RSS ${Math.round(memQR.rss/1024/1024)}MB`);

        // Limpia monitor anterior si venía de un QR previo
        if (qrMonitorInterval) {
            console.log(`🧹 [QR-5] Limpiando monitor del QR anterior`);
            clearInterval(qrMonitorInterval);
            qrMonitorInterval = null;
        }

        if (!isManual) {
            console.log(`⛔ [QR-6] ${sessionName} requirió QR en modo AUTO. Deteniendo...`);
            io.emit('status', `⚠️ SESIÓN ${sessionName.toUpperCase()} CADUCADA. REQUIERE INICIO MANUAL.`);
            abortandoPorFaltaDeQR = true;
            try {
                await client.destroy();
                console.log('✅ [QR-7] Cliente destruido por falta de QR en modo AUTO');
            } catch(e) {
                console.log('⚠️ [QR-8] Error destruyendo cliente en modo AUTO:', e.message);
            }
            client = null;
            isClientReady = false;
            return;
        }

        console.log(`📤 [QR-9] Emitiendo QR #${qrContador} al panel web...`);
        io.emit('qr', qr);
        io.emit('status', `📸 ESCANEA EL QR AHORA (${sessionName.toUpperCase()}) - intento #${qrContador}`);
        console.log(`✅ [QR-10] QR emitido al panel. Esperando que el teléfono escanee...`);
        console.log(`📸 ================================================\n`);

        // --- MONITOR POST-QR: detecta si el teléfono escaneó pero el servidor no recibió "authenticated" ---
        qrEscaneoTime = Date.now();
        autenticadoRecibido = false;
        let segundosEspera = 0;

        qrMonitorInterval = setInterval(() => {
            segundosEspera += 10;
            const memMon = process.memoryUsage();
            const estadoCliente = client ? 'existe' : 'NULL';

            if (autenticadoRecibido) {
                console.log(`✅ [QR-MONITOR] Autenticación confirmada, deteniendo monitor`);
                clearInterval(qrMonitorInterval);
                qrMonitorInterval = null;
                return;
            }

            console.log(`⏳ [QR-MONITOR] +${segundosEspera}s esperando 'authenticated' | cliente: ${estadoCliente} | autenticado: ${autenticadoRecibido} | RAM heap: ${Math.round(memMon.heapUsed/1024/1024)}MB RSS: ${Math.round(memMon.rss/1024/1024)}MB`);

            if (segundosEspera === 60) {
                console.log(`⚠️ [QR-MONITOR] 60s sin autenticación después del QR #${qrContador}`);
                console.log(`⚠️ [QR-MONITOR] Si el teléfono dice "Iniciando sesión" y no avanza, posibles causas:`);
                console.log(`   → 1. Red lenta/inestable entre WhatsApp servers y este servidor`);
                console.log(`   → 2. Chrome/Puppeteer colgado internamente`);
                console.log(`   → 3. Sesión anterior corrupta en ./data/session-client-${sessionName}`);
                console.log(`   → 4. El evento 'authenticated' de whatsapp-web.js no está disparando`);
                io.emit('status', `⚠️ 60s sin respuesta del servidor tras escaneo (${sessionName.toUpperCase()})`);
            }

            if (segundosEspera >= 120) {
                console.log(`🚨 [QR-MONITOR] ========== TIMEOUT 120s ==========`);
                console.log(`🚨 [QR-MONITOR] El teléfono escaneó pero el servidor NUNCA recibió 'authenticated'`);
                console.log(`🚨 [QR-MONITOR] Sesión: ${sessionName} | QR #${qrContador}`);
                const memTO = process.memoryUsage();
                console.log(`🚨 [QR-MONITOR] RAM final: heap ${Math.round(memTO.heapUsed/1024/1024)}/${Math.round(memTO.heapTotal/1024/1024)}MB, RSS ${Math.round(memTO.rss/1024/1024)}MB`);
                console.log(`🚨 [QR-MONITOR] Recomendación: borrar memoria de ${sessionName.toUpperCase()} y reintentar`);
                io.emit('status', `🚨 TIMEOUT: Escaneo no se completó en 120s. Borra la memoria y reintenta.`);
                clearInterval(qrMonitorInterval);
                qrMonitorInterval = null;
            }
        }, 10000);
    });

    client.on('ready', () => {
        isClientReady = true;
        // Limpiar monitor de QR si aún corría
        if (qrMonitorInterval) {
            clearInterval(qrMonitorInterval);
            qrMonitorInterval = null;
        }
        const tiempoDesdeQR = qrEscaneoTime ? Math.round((Date.now() - qrEscaneoTime) / 1000) : 'N/A';
        console.log(`\n✅✅✅ [READY-1] ========== ${sessionName.toUpperCase()} CONECTADO Y LISTO ✅✅✅`);
        console.log(`📱 [READY-2] Nombre: ${client.info.pushname}`);
        console.log(`📱 [READY-3] Número: ${client.info.wid.user}`);
        console.log(`📱 [READY-4] Plataforma: ${client.info.platform || 'desconocida'}`);
        console.log(`⏱️ [READY-5] Tiempo total desde escaneo QR hasta READY: ${tiempoDesdeQR}s`);
        const memR = process.memoryUsage();
        console.log(`📊 [READY-6] RAM al estar listo: heap ${Math.round(memR.heapUsed/1024/1024)}/${Math.round(memR.heapTotal/1024/1024)}MB, RSS ${Math.round(memR.rss/1024/1024)}MB`);

        io.emit('status', `✅ ACTIVO: ${sessionName.toUpperCase()}`);
        io.emit('connected', {
            name: client.info.pushname,
            number: client.info.wid.user,
            session: sessionName
        });

        console.log('🚀 [READY-7] Iniciando procesamiento de cola...');
        processQueue();
    });

    client.on('auth_failure', async (msg) => {
        const tiempoDesdeQR = qrEscaneoTime ? Math.round((Date.now() - qrEscaneoTime) / 1000) : 'N/A';
        console.error(`\n❌ [AUTH-FAILURE-1] ========== FALLO DE AUTENTICACIÓN ==========`);
        console.error(`❌ [AUTH-FAILURE-2] Sesión: ${sessionName} | isManual: ${isManual}`);
        console.error(`❌ [AUTH-FAILURE-3] Mensaje recibido: ${JSON.stringify(msg)}`);
        console.error(`❌ [AUTH-FAILURE-4] Tiempo desde último QR: ${tiempoDesdeQR}s`);
        console.error(`❌ [AUTH-FAILURE-5] Timestamp: ${new Date().toISOString()}`);
        console.error(`❌ [AUTH-FAILURE-6] Esto puede pasar cuando:`);
        console.error(`   → La sesión guardada está corrupta o caducada`);
        console.error(`   → El teléfono cerró sesión de WhatsApp Web`);
        console.error(`   → Credenciales de la cuenta inválidas`);
        io.emit('status', '⛔ FALLO DE AUTENTICACIÓN - ver logs');
        if (qrMonitorInterval) { clearInterval(qrMonitorInterval); qrMonitorInterval = null; }
        try {
            await client.destroy();
            console.log('✅ [AUTH-FAILURE-7] Cliente destruido tras fallo');
        } catch(e) {
            console.log('⚠️ [AUTH-FAILURE-8] Error destruyendo:', e.message);
        }
        client = null;
        if (!isManual) {
            console.log('🗑️ [AUTH-FAILURE-9] Borrando sesión por auth failure en modo AUTO');
            borrarSesion(sessionName);
        }
    });

    client.on('disconnected', (reason) => {
        isClientReady = false;
        console.log(`\n❌ [DISCONNECTED-1] ========== DESCONEXIÓN ==========`);
        console.log(`❌ [DISCONNECTED-2] Razón: "${reason}" | Sesión: ${sessionName}`);
        console.log(`❌ [DISCONNECTED-3] Timestamp: ${new Date().toISOString()}`);
        console.log(`❌ [DISCONNECTED-4] isManual: ${isManual} | isClientReady era: ${isClientReady}`);
        io.emit('status', `❌ Desconectado (${reason})`);
        if (qrMonitorInterval) {
            clearInterval(qrMonitorInterval);
            qrMonitorInterval = null;
            console.log('🧹 [DISCONNECTED-5] Monitor de QR limpiado');
        }
        if (reason === 'LOGOUT') {
            console.log('🗑️ [DISCONNECTED-6] Borrando sesión por LOGOUT');
            borrarSesion(sessionName);
        }
    });

    client.on('loading_screen', (percent, message) => {
        console.log(`⏳ [LOADING-${String(percent).padStart(3,'0')}] ${percent}% - "${message}" | ${new Date().toISOString()}`);
        io.emit('status', `⏳ Cargando WhatsApp ${percent}% - ${message} (${sessionName.toUpperCase()})`);
    });

    client.on('authenticated', () => {
        autenticadoRecibido = true;
        const tiempoDesdeQR = qrEscaneoTime ? Math.round((Date.now() - qrEscaneoTime) / 1000) : 'N/A';
        console.log(`\n🔐 [AUTHENTICATED-1] ========== AUTENTICACIÓN EXITOSA ==========`);
        console.log(`🔐 [AUTHENTICATED-2] Sesión: ${sessionName}`);
        console.log(`🔐 [AUTHENTICATED-3] Tiempo desde escaneo QR: ${tiempoDesdeQR}s`);
        console.log(`🔐 [AUTHENTICATED-4] Timestamp: ${new Date().toISOString()}`);
        console.log(`🔐 [AUTHENTICATED-5] Ahora WhatsApp cargará la pantalla (evento 'loading_screen') y luego 'ready'`);
        const memA = process.memoryUsage();
        console.log(`📊 [AUTHENTICATED-6] RAM: heap ${Math.round(memA.heapUsed/1024/1024)}/${Math.round(memA.heapTotal/1024/1024)}MB, RSS ${Math.round(memA.rss/1024/1024)}MB`);
        io.emit('status', `🔐 Autenticado! Cargando WhatsApp Web... (${sessionName.toUpperCase()})`);
    });

    client.on('change_state', (state) => {
        console.log(`🔄 [STATE-CHANGE] Estado de conexión → "${state}" | ${new Date().toISOString()}`);
        io.emit('status', `🔄 Estado interno: ${state} (${sessionName.toUpperCase()})`);
    });
    
    console.log('✅ [EVENTS-2] Event handlers registrados');

    try { 
        console.log('🚀 [INITIALIZE-1] Llamando client.initialize()...');
        await client.initialize(); 
        console.log('✅ [INITIALIZE-2] client.initialize() completado');
    } catch (e) { 
        console.error('❌ [INITIALIZE-ERROR] Error en initialize:', e.message);
        console.error('📜 [INITIALIZE-ERROR] Stack:', e.stack);
        
        if (abortandoPorFaltaDeQR) {
            console.log('ℹ️ [INITIALIZE-3] Abortado por falta de QR - no reiniciar');
            return;
        }
        
        if(e.message.includes('Target closed')) {
            console.log('⚠️ [INITIALIZE-4] Target closed - reiniciando en 5 segundos...');
            setTimeout(() => process.exit(1), 5000); 
        }
    }
    
    console.log(`🏁 [SESSION-END] Función startSession completada para ${sessionName}\n`);
}

// --- GENERADOR DE PDF --- 
async function generarYEnviarPDF(item, clientInstance) {
    try {
        console.log(`📄 [PDF-1] Generando PDF para ${item.numero}...`);
        const { datos_ticket, foto_evidencia } = item.pdfData;
        
        // Fecha en formato DD/MM/YY (si se puede parsear), si no, tal cual viene.
        const _mFecha = moment(datos_ticket.fecha, ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD', moment.ISO_8601], true);
        const fechaFmt = _mFecha.isValid() ? _mFecha.format('DD/MM/YY') : (datos_ticket.fecha || '');

        const filasProductos = (datos_ticket.productos || []).map(p => `
            <tr>
                <td class="c-cant">${p.cantidad} ${p.unidad || ''}</td>
                <td class="c-desc">${p.descripcion || ''}</td>
                <td class="c-num">${fmtMoney(p.precio)}</td>
                <td class="c-num">${fmtMoney((parseFloat(p.cantidad) || 0) * (parseFloat(p.precio) || 0))}</td>
            </tr>`).join('');

        // Iconitos (inline SVG, no requieren archivos)
        const ICON_WA = `<svg width="12" height="12" viewBox="0 0 24 24" fill="#25D366"><path d="M12 2a10 10 0 0 0-8.6 15l-1.4 5 5.1-1.3A10 10 0 1 0 12 2zm4.4 12c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1-.6.8-.7 1-.3.2-.5.1a6.5 6.5 0 0 1-1.9-1.2 7.2 7.2 0 0 1-1.3-1.7c-.1-.2 0-.4.1-.5l.4-.4.2-.3v-.4c0-.1-.5-1.3-.7-1.7s-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11 11 0 0 0 4.2 3.7c1 .4 1.7.6 2.3.5.6-.1 1.4-.6 1.6-1.1s.2-1 .1-1.1z"/></svg>`;
        const ICON_FB = `<svg width="12" height="12" viewBox="0 0 24 24" fill="#1877F2"><path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.8 3.7-3.8 1.1 0 2.2.2 2.2.2v2.4h-1.2c-1.2 0-1.6.8-1.6 1.5V12h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 22 12z"/></svg>`;
        const ICON_IG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#E1306C" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1.2" fill="#E1306C" stroke="none"/></svg>`;

        const htmlContent = `
        <!DOCTYPE html>
        <html><head><meta charset="utf-8"><style>
            * { margin:0; padding:0; box-sizing:border-box; }
            @page { size: A4; margin: 0; }
            body { font-family: Arial, Helvetica, sans-serif; color:#222; -webkit-print-color-adjust:exact; }
            .page { display:flex; width:210mm; min-height:297mm; background:#fff; }
            .side { width:46mm; flex-shrink:0; }
            .side img { width:100%; display:block; }
            .center { flex:1; padding:7mm 6mm; }
            .topbar { display:flex; justify-content:space-between; align-items:center; font-size:8px; color:#8a8a8a; margin-bottom:8px; }
            .topbar .ic { display:inline-flex; vertical-align:middle; align-items:center; }
            .topbar svg { vertical-align:middle; margin:0 3px; }
            .phone { color:#25D366; font-weight:bold; font-size:11px; margin-left:2px; }
            .logo-wrap { text-align:center; margin:4px 0 6px; }
            .logo-wrap img { width:62%; max-width:230px; }
            .empresa { text-align:center; font-weight:bold; font-size:11px; line-height:1.35; }
            .rfc { text-align:center; font-weight:bold; font-size:10px; margin-bottom:6px; }
            .sucursal { text-align:center; margin:6px 0 12px; }
            .sucursal span { display:inline-block; border:1.5px solid #222; border-radius:14px; padding:4px 16px; font-weight:bold; font-size:11px; }
            .meta { display:flex; justify-content:space-between; font-size:10px; margin-bottom:8px; }
            .meta .lbl { color:#e2231a; font-weight:bold; }
            .datos { font-size:11px; line-height:1.6; margin-bottom:8px; }
            .detalle-tit { text-align:center; font-weight:bold; font-size:12px; margin:10px 0 6px; }
            table { width:100%; border-collapse:collapse; }
            thead th { color:#e2231a; font-weight:bold; font-size:10px; text-align:left; border-bottom:1.5px solid #ddd; padding:5px 4px; }
            thead th.c-num { text-align:right; }
            tbody td { font-size:10px; padding:6px 4px; border-bottom:1px solid #eee; vertical-align:top; }
            .c-num { text-align:right; white-space:nowrap; }
            .c-cant { white-space:nowrap; }
            .totals { margin-top:12px; text-align:right; font-size:11px; line-height:1.9; }
            .totals .total { font-weight:bold; font-size:15px; margin-top:4px; }
            .evidencia { margin-top:22px; border-top:1.5px solid #222; padding-top:10px; text-align:center; }
            .evidencia .et { font-weight:bold; font-size:12px; letter-spacing:0.5px; }
            .evidencia img { max-width:80%; margin-top:10px; border-radius:4px; }
        </style></head>
        <body>
          <div class="page">
            ${ASSET_BANNER_IZQ ? `<div class="side"><img src="${ASSET_BANNER_IZQ}"></div>` : ''}
            <div class="center">
                <div class="topbar">
                    <span class="ic">Contáctanos al: ${ICON_WA}<span class="phone">981 118 1870</span></span>
                    <span class="ic">Síguenos en Redes sociales ${ICON_IG} ${ICON_FB}</span>
                </div>
                <div class="logo-wrap">${ASSET_LOGO ? `<img src="${ASSET_LOGO}">` : '<h2 style="color:#e2231a;font-style:italic">Ferroláminas</h2>'}</div>
                <div class="empresa">Ferroláminas Richaud S.A. de C.V.</div>
                <div class="rfc">FRI90092879A</div>
                <div class="sucursal"><span>SUCURSAL: ${(datos_ticket.sucursal || 'MATRIZ').toUpperCase()}</span></div>
                <div class="meta">
                    <span><span class="lbl">FECHA:</span> ${fechaFmt}</span>
                    <span><span class="lbl">TICKET:</span> ${datos_ticket.folio}</span>
                </div>
                <div class="datos">
                    <div><b>Cliente:</b> ${datos_ticket.cliente}</div>
                    <div><b>Dirección:</b> ${datos_ticket.direccion}</div>
                </div>
                <div class="detalle-tit">DETALLE DE COMPRA</div>
                <table>
                    <thead><tr><th>Cant.</th><th>Desc.</th><th class="c-num">Precio</th><th class="c-num">Total</th></tr></thead>
                    <tbody>${filasProductos}</tbody>
                </table>
                <div class="totals">
                    <div>Subtotal: ${fmtMoney(datos_ticket.subtotal)}</div>
                    <div>Impuestos: ${fmtMoney(datos_ticket.impuestos)}</div>
                    <div class="total">TOTAL: ${fmtMoney(datos_ticket.total)}</div>
                </div>
                <div class="evidencia">
                    <div class="et">EVIDENCIA DE ENTREGA</div>
                    ${foto_evidencia ? `<img src="${foto_evidencia}"/>` : ''}
                </div>
            </div>
            ${ASSET_BANNER_DER ? `<div class="side"><img src="${ASSET_BANNER_DER}"></div>` : ''}
          </div>
        </body></html>`;

        console.log('🌐 [PDF-2] Lanzando navegador para PDF...');
        const browser = await puppeteer.launch({ 
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--single-process',
                '--disable-gpu',
                '--js-flags="--max-old-space-size=512"'
            ],
            executablePath: RUTA_CHROME_DETECTADA || undefined 
        });
        console.log('✅ [PDF-3] Navegador lanzado');
        
        const page = await browser.newPage();
        console.log('✅ [PDF-4] Página creada');

        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
        console.log('✅ [PDF-5] HTML cargado');

        if (foto_evidencia) {
            console.log('📸 [PDF-6] Esperando carga de imagen...');
            try {
                await page.waitForFunction(() => {
                    const img = document.querySelector('.evidencia img');
                    return img && img.complete && img.naturalHeight > 0;
                }, { timeout: 10000 }); 
                console.log('✅ [PDF-7] Imagen cargada');
            } catch (e) {
                console.log("⚠️ [PDF-8] Timeout imagen - continuando sin ella");
            }
        }

        console.log('📄 [PDF-9] Generando PDF...');
        const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
        console.log('✅ [PDF-10] PDF generado');
        
        await browser.close();
        console.log('✅ [PDF-11] Navegador cerrado');

        const b64 = Buffer.from(pdfBuffer).toString('base64');
        const media = new MessageMedia('application/pdf', b64, `Ticket-${datos_ticket.folio}.pdf`);
        
        let chatId = item.numero.replace(/\D/g, '');
        if (chatId.length === 10) chatId = '52' + chatId;
        
        console.log(`📤 [PDF-12] Enviando PDF a ${chatId}...`);
        await clientInstance.sendMessage(chatId + '@c.us', media, { 
            caption: item.mensaje || "Su pedido ha sido entregado. Adjunto ticket y evidencia. 📄🏠" 
        });
        console.log(`✅ [PDF-13] PDF enviado exitosamente a ${item.numero}`);
        return true;
    } catch (e) {
        console.error("❌ [PDF-ERROR] Error PDF:", e.message);
        console.error("📜 [PDF-ERROR] Stack:", e.stack);
        return false;
    }
}

// --- PROCESADOR DE COLA (LÓGICA MEJORADA 3:2) --- 
const processQueue = async () => {
    console.log(`\n🔄 [QUEUE-1] processQueue() llamado - Processing: ${isProcessingQueue}, PDFs: ${pdfQueue.length}, Normales: ${normalQueue.length}`);
    
    if (isProcessingQueue || (pdfQueue.length === 0 && normalQueue.length === 0)) {
        console.log(`ℹ️ [QUEUE-2] Saliendo - isProcessing: ${isProcessingQueue}, colas vacías: ${pdfQueue.length === 0 && normalQueue.length === 0}`);
        return;
    }
    
    if (isPaused || !isClientReady || !client) {
        console.log(`⏸️ [QUEUE-3] Pausado o no listo - isPaused: ${isPaused}, isReady: ${isClientReady}, hasClient: ${!!client}`);
        return; 
    }

    if (mensajesEnRacha >= limiteRachaActual) {
        isPaused = true; 
        const minutosPausa = getRandomDelay(8, 15); 
        console.log(`☕ [PAUSE-1] PAUSA "BAÑO/CAFÉ" DE ${minutosPausa} MINUTOS...`);
        io.emit('status', `☕ Descanso (${minutosPausa} min)`);
        
        setTimeout(() => { 
            console.log('✅ [PAUSE-2] Fin de pausa, reanudando...');
            isPaused = false; 
            mensajesEnRacha = 0; 
            limiteRachaActual = getRandomDelay(5, 9);
            processQueue(); 
        }, minutosPausa * 60000);
        return;
    }
    
    isProcessingQueue = true;
    console.log('✅ [QUEUE-4] Iniciando procesamiento');

    // --- DECISOR DE RATIO 3:2 ---
    let item = null;
    let tipoSeleccionado = '';

    if (pdfQueue.length > 0 && pdfEnCiclo < 3) {
        item = pdfQueue[0];
        tipoSeleccionado = 'pdf';
        console.log(`📄 [QUEUE-5] Seleccionado PDF (ciclo: ${pdfEnCiclo}/3)`);
    } 
    else if (normalQueue.length > 0 && normalEnCiclo < 2) {
        item = normalQueue[0];
        tipoSeleccionado = 'normal';
        console.log(`💬 [QUEUE-5] Seleccionado Normal (ciclo: ${normalEnCiclo}/2)`);
    }
    else {
        if (pdfQueue.length > 0) {
            item = pdfQueue[0];
            tipoSeleccionado = 'pdf';
            if (normalQueue.length === 0) { pdfEnCiclo = 0; normalEnCiclo = 0; }
            console.log('📄 [QUEUE-5] Seleccionado PDF (reset ciclo)');
        } else if (normalQueue.length > 0) {
            item = normalQueue[0];
            tipoSeleccionado = 'normal';
            if (pdfQueue.length === 0) { pdfEnCiclo = 0; normalEnCiclo = 0; }
            console.log('💬 [QUEUE-5] Seleccionado Normal (reset ciclo)');
        }
    }

   if (!item) { 
       console.log('⚠️ [QUEUE-6] No hay items para procesar');
       isProcessingQueue = false; 
       return; 
   }

    console.log(`📋 [QUEUE-7] Item seleccionado: ${item.numero} (${tipoSeleccionado})`);

    // Validación de formato
    if (/[^\d\s\+\-\(\)]/.test(item.numero)) {
        console.log(`🗑️ [QUEUE-8] ELIMINADO POR FORMATO MALO: ${item.numero}`);
        
        if (tipoSeleccionado === 'pdf') pdfQueue.shift();
        else normalQueue.shift();

        saveQueue();
        isProcessingQueue = false;
        processQueue();
        return;
    }

    try {
        let cleanNumber = item.numero.replace(/\D/g, '');
        if (cleanNumber.length === 10) cleanNumber = '52' + cleanNumber;
        const finalNumber = cleanNumber + '@c.us';
        
        console.log(`⏳ [SEND-1] Procesando ${item.numero} -> ${finalNumber} (${tipoSeleccionado})...`);
        
        // Simula "escribiendo..."
        const typingDelay = getRandomDelay(4000, 8000);
        console.log(`⌨️ [SEND-2] Simulando escritura por ${typingDelay}ms...`);
        await new Promise(r => setTimeout(r, typingDelay));
        
        console.log(`🔍 [SEND-3] Verificando si ${finalNumber} está registrado...`);
        const isRegistered = await client.isRegisteredUser(finalNumber);
        console.log(`✅ [SEND-4] Registro verificado: ${isRegistered}`);
        
        if (isRegistered) {
            if (tipoSeleccionado === 'pdf') {
                console.log('📄 [SEND-5] Generando y enviando PDF...');
                await generarYEnviarPDF(item, client);
                pdfEnCiclo++;
            } else {
                if (item.mediaUrl) {
                    console.log(`🖼️ [SEND-5] Descargando media desde: ${item.mediaUrl}`);
                    const media = await MessageMedia.fromUrl(item.mediaUrl, { unsafeMime: true });
                    console.log('📤 [SEND-6] Enviando mensaje con media...');
                    await client.sendMessage(finalNumber, media, { caption: item.mensaje });
                } else {
                    console.log('📤 [SEND-5] Enviando mensaje de texto...');
                    await client.sendMessage(finalNumber, item.mensaje);
                }
                normalEnCiclo++;
            }
            mensajesEnRacha++; 
            
            if (pdfEnCiclo >= 3 && normalEnCiclo >= 2) {
                console.log('🔄 [SEND-7] Reseteando contadores de ciclo');
                pdfEnCiclo = 0;
                normalEnCiclo = 0;
            }

            console.log(`✅ [SEND-8] Enviado (Racha: ${mensajesEnRacha}/${limiteRachaActual}) (Ciclo: P:${pdfEnCiclo} N:${normalEnCiclo})`);
        } else {
            console.log(`⚠️ [SEND-9] Número no registrado: ${finalNumber}`);
        }
    } catch (error) {
        console.error('❌ [SEND-ERROR] Error envío:', error.message);
        console.error('📜 [SEND-ERROR] Stack:', error.stack);
        
        if (error.message.includes('Session closed')) {
            console.log('🔴 [SEND-ERROR] Sesión cerrada - terminando proceso');
            process.exit(1); 
        }
    } finally {
        console.log(`🧹 [CLEANUP-1] Removiendo item de cola (tipo: ${tipoSeleccionado})`);
        if (tipoSeleccionado === 'pdf') pdfQueue.shift(); 
        else normalQueue.shift();

        saveQueue(); 
        
        const shortPause = getRandomDelay(45000, 90000); 
        console.log(`⏱️ [CLEANUP-2] Esperando ${Math.round(shortPause/1000)}s antes del próximo mensaje...`);
        
        setTimeout(() => { 
            console.log('✅ [CLEANUP-3] Timeout completado, liberando procesamiento');
            isProcessingQueue = false; 
            processQueue(); 
        }, shortPause);
    }
};

// --- RUTAS API --- 
console.log('🛣️ [ROUTES-1] Configurando rutas...');

app.post('/iniciar-chip-a', authMiddleware, (req, res) => { 
    console.log('🔵 [ROUTE] POST /iniciar-chip-a');
    startSession('chip-a', true); 
    res.json({ success: true, message: 'Iniciando chip-a manual' }); 
});

app.post('/iniciar-chip-b', authMiddleware, (req, res) => { 
    console.log('🟢 [ROUTE] POST /iniciar-chip-b');
    startSession('chip-b', true); 
    res.json({ success: true, message: 'Iniciando chip-b manual' }); 
});

app.post('/enviar', authMiddleware, (req, res) => {
    console.log('📨 [ROUTE] POST /enviar');
    if (!checkOfficeHours().isOpen) {
        console.log('⏰ [ROUTE] Fuera de horario');
        return res.status(400).json({ error: 'Fuera de horario laboral' });
    }
    normalQueue.push({ type: 'normal', ...req.body, resolve: () => {} });
    saveQueue(); 
    processQueue();
    res.json({ success: true, posicion: normalQueue.length });
});

app.post('/enviar-ticket-pdf', authMiddleware, (req, res) => {
    console.log('📄 [ROUTE] POST /enviar-ticket-pdf');
    if (!checkOfficeHours().isOpen) {
        console.log('⏰ [ROUTE] Fuera de horario');
        return res.status(400).json({ error: 'Fuera de horario laboral' });
    }
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

// --- RUTA DE PRUEBA: genera y envía el ticket AL INSTANTE ---
// Ignora el horario laboral y NO usa la cola: sirve solo para probar el diseño.
// Recibe el MISMO payload que /enviar-ticket-pdf (numero, mensaje, foto_evidencia, datos_ticket).
app.post('/probar-ticket', authMiddleware, async (req, res) => {
    console.log('🧪 [ROUTE] POST /probar-ticket (PRUEBA - ignora horario y cola)');

    if (!isClientReady || !client) {
        console.log('⚠️ [PRUEBA] Cliente no está conectado, no se puede enviar la prueba');
        return res.status(503).json({ error: 'El bot no está conectado a WhatsApp en este momento.' });
    }

    if (!req.body || !req.body.numero || !req.body.datos_ticket) {
        return res.status(400).json({ error: 'Faltan datos: se requieren "numero" y "datos_ticket".' });
    }

    const item = {
        type: 'pdf',
        numero: req.body.numero,
        mensaje: req.body.mensaje,
        pdfData: {
            datos_ticket: req.body.datos_ticket,
            foto_evidencia: req.body.foto_evidencia
        }
    };

    try {
        console.log(`🧪 [PRUEBA] Generando y enviando ticket de prueba INMEDIATO a ${item.numero}...`);
        const ok = await generarYEnviarPDF(item, client);
        if (ok) {
            console.log(`✅ [PRUEBA] Ticket de prueba enviado a ${item.numero}`);
            return res.json({ success: true, message: `Ticket de prueba enviado a ${item.numero}` });
        }
        console.log('❌ [PRUEBA] generarYEnviarPDF devolvió false');
        return res.status(500).json({ error: 'Falló la generación/envío del PDF de prueba (ver logs).' });
    } catch (e) {
        console.error('❌ [PRUEBA] Error:', e.message);
        return res.status(500).json({ error: e.message });
    }
});

app.get('/cola-pendientes', authMiddleware, (req, res) => {
    console.log('📋 [ROUTE] GET /cola-pendientes');
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
    console.log('🗑️ [ROUTE] POST /borrar-item-cola');
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
    console.log('🧹 [ROUTE] POST /limpiar-cola');
    pdfQueue = []; 
    normalQueue = []; 
    pdfEnCiclo = 0; 
    normalEnCiclo = 0;
    saveQueue(); 
    res.json({ success: true, message: 'Colas vaciadas' }); 
});

app.post('/detener-bot', authMiddleware, async (req, res) => { 
    console.log('🛑 [ROUTE] POST /detener-bot');
    try { await client.destroy(); } catch(e) {}
    process.exit(0); 
});

app.get('/status', (req, res) => {
    console.log('📊 [ROUTE] GET /status');
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

app.get('/', (req, res) => {
    console.log('🏠 [ROUTE] GET /');
    res.render('index');
});

// Health check para Render
app.get('/health', (req, res) => {
    console.log('💚 [ROUTE] GET /health - Health check');
    res.status(200).json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        ready: isClientReady,
        session: activeSessionName 
    });
});

console.log('✅ [ROUTES-2] Rutas configuradas');

console.log('🔌 [SOCKET-3] Configurando Socket.IO connection handler...');
io.on('connection', (socket) => {
    console.log('🔗 [SOCKET-CONNECTION] Nuevo cliente conectado:', socket.id);
    
    if(activeSessionName) {
        const statusMsg = isClientReady 
            ? `✅ ACTIVO: ${activeSessionName.toUpperCase()}` 
            : `⏳ Cargando ${activeSessionName.toUpperCase()}...`;
        console.log(`📤 [SOCKET-EMIT] Enviando status: ${statusMsg}`);
        socket.emit('status', statusMsg);
    }
    
    socket.on('disconnect', () => {
        console.log('👋 [SOCKET-DISCONNECT] Cliente desconectado:', socket.id);
    });
});
console.log('✅ [SOCKET-4] Socket.IO configurado completamente');

console.log('\n🚀 [SERVER-START-1] Iniciando servidor HTTP...');
console.log(`🌐 [SERVER-START-2] Puerto configurado: ${PORT}`);

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🎉🎉🎉 [SERVER-READY] ========================================`);
    console.log(`🛡️ [SERVER-READY] SERVIDOR LISTO EN PUERTO ${PORT}`);
    console.log(`🌐 [SERVER-READY] Escuchando en 0.0.0.0:${PORT}`);
    console.log(`⏰ [SERVER-READY] Timestamp: ${new Date().toISOString()}`);
    console.log(`🎉🎉🎉 [SERVER-READY] ========================================\n`);
    
    console.log('💾 [INIT-1] Cargando cola guardada...');
    loadQueue(); 
    
    const turno = getTurnoActual();
    console.log(`🎯 [INIT-2] Turno actual calculado: ${turno}`);
    
    if (existeSesion(turno)) {
        console.log(`✅ [INIT-3] Sesión existe, iniciando automáticamente: ${turno}`);
        startSession(turno, false);
    } else {
        console.log(`ℹ️ [INIT-3] No hay sesión guardada para ${turno}`);
    }
    
    console.log('⏰ [INIT-4] Configurando verificador de turnos (cada 60s)...');
    setInterval(() => {
        const turnoDebido = getTurnoActual();
        console.log(`🔍 [TURNO-CHECK] Verificando turno - Actual: ${activeSessionName}, Debido: ${turnoDebido}`);

        if (activeSessionName && activeSessionName !== turnoDebido) {
            console.log(`🔄 [TURNO-CHANGE] Cambio de turno detectado - reiniciando proceso`);
            process.exit(0);
        }
    }, 60000);

    console.log('💓 [INIT-5] Configurando heartbeat de RAM (cada 30s)...');
    setInterval(() => {
        const mem = process.memoryUsage();
        console.log(`💓 [HEARTBEAT] RAM: heap ${Math.round(mem.heapUsed/1024/1024)}/${Math.round(mem.heapTotal/1024/1024)}MB | RSS ${Math.round(mem.rss/1024/1024)}MB | session: ${activeSessionName || 'NINGUNA'} | ready: ${isClientReady} | pausado: ${isPaused} | cola: ${pdfQueue.length}PDF + ${normalQueue.length}Normal`);
    }, 30000);

    console.log('✅ [INIT-6] Inicialización completa\n');
});

// --- CAPTURA DE ERRORES GLOBALES NO MANEJADOS ---
process.on('uncaughtException', (err) => {
    console.error(`\n💀 [UNCAUGHT-EXCEPTION] ========== ERROR NO CAPTURADO ==========`);
    console.error(`💀 [UNCAUGHT-EXCEPTION] Mensaje: ${err.message}`);
    console.error(`💀 [UNCAUGHT-EXCEPTION] Stack: ${err.stack}`);
    console.error(`💀 [UNCAUGHT-EXCEPTION] Timestamp: ${new Date().toISOString()}`);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n💀 [UNHANDLED-REJECTION] ========== PROMESA SIN MANEJAR ==========`);
    console.error(`💀 [UNHANDLED-REJECTION] Razón: ${reason}`);
    console.error(`💀 [UNHANDLED-REJECTION] Timestamp: ${new Date().toISOString()}`);
});

console.log('✅ [FINAL] Script cargado completamente - esperando server.listen()...');