const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const fs = require('fs');
const path = require('path');
const moment = require('moment-timezone'); 
const puppeteer = require('puppeteer'); 
const { execSync } = require('child_process');

// 1. ELIMINACIÓN DE COLA PESADA AL ARRANCAR (PARA EVITAR OOM)
const COLA_FILE = './data/cola.json';
if (fs.existsSync(COLA_FILE)) {
    try {
        fs.unlinkSync(COLA_FILE);
        console.log("💥 EMERGENCIA: Archivo de cola eliminado para liberar RAM.");
    } catch (e) {
        console.error("No se pudo borrar la cola:", e);
    }
}

// 2. DETECCIÓN DE RUTA DE CHROME (INSTALADO POR POSTINSTALL)
let RUTA_CHROME_DETECTADA = null;
const posiblesRutas = [
    '/opt/render/project/src/.cache/chrome/linux-144.0.7559.133/chrome-linux64/chrome',
    '/opt/render/project/src/.cache/chrome/linux-144.0.7559.96/chrome-linux64/chrome'
];
for (const r of posiblesRutas) {
    if (fs.existsSync(r)) {
        RUTA_CHROME_DETECTADA = r;
        console.log(`✅ Chrome localizado en: ${r}`);
        break;
    }
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

app.use(express.json());
app.set('view engine', 'ejs');

// --- VARIABLES DE ESTADO --- 
let client = null; 
let activeSessionName = null; 
let isClientReady = false;
let pdfQueue = [];
let normalQueue = [];
let pdfEnCiclo = 0;    
let normalEnCiclo = 0; 
let isProcessingQueue = false;
let mensajesEnRacha = 0;
let isPaused = false; 
let limiteRachaActual = Math.floor(Math.random() * (9 - 5 + 1) + 5); 

// --- FUNCIONES DE PERSISTENCIA --- 
function saveQueue() {
    try {
        const cleanPdf = pdfQueue.map(item => { const { resolve, ...data } = item; return data; });
        const cleanNormal = normalQueue.map(item => { const { resolve, ...data } = item; return data; });
        const backup = { pdfQueue: cleanPdf, normalQueue: cleanNormal, pdfEnCiclo, normalEnCiclo };
        if (!fs.existsSync('./data')) fs.mkdirSync('./data');
        fs.writeFileSync(COLA_FILE, JSON.stringify(backup, null, 2));
    } catch (e) { console.error("❌ Error guardando cuaderno:", e); }
}

function loadQueue() {
    // Desactivado temporalmente para estabilizar el inicio
    console.log("ℹ️ Saltando carga de cola para asegurar estabilidad.");
    return;
}

// --- MIDDLEWARE --- 
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!MI_TOKEN_SECRETO || token !== MI_TOKEN_SECRETO) return res.status(403).json({ error: 'Acceso denegado' });
    next();
};

const getRandomDelay = (min, max) => Math.floor(Math.random() * (max - min + 1) + min);

const checkOfficeHours = () => { 
    const hora = moment().tz('America/Mexico_City').hour();
    return (hora >= 8 && hora < 18) ? { isOpen: true } : { isOpen: false }; 
};

function getTurnoActual() {
    const hora = moment().tz('America/Mexico_City').hour();
    if ((hora >= 8 && hora < 10) || (hora >= 12 && hora < 14) || (hora >= 16 && hora < 18)) return 'chip-a';
    return 'chip-b'; 
}

function existeSesion(sessionName) { return fs.existsSync(`./data/session-client-${sessionName}`); }

function borrarSesion(sessionName) {
    const folderPath = `./data/session-client-${sessionName}`;
    try { if (fs.existsSync(folderPath)) fs.rmSync(folderPath, { recursive: true, force: true }); } 
    catch (e) { console.error(`Error borrando ${sessionName}:`, e); }
}

function recursiveDeleteLocks(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    try {
        const files = fs.readdirSync(dirPath);
        for (const file of files) {
            const currentPath = path.join(dirPath, file);
            if (fs.lstatSync(currentPath).isDirectory()) recursiveDeleteLocks(currentPath);
            else if (file.includes('Singleton') || file.includes('lockfile')) {
                fs.unlinkSync(currentPath);
                console.log(`🔓 Lock eliminado: ${file}`);
            }
        }
    } catch (e) { console.error("⚠️ Error limpiando locks:", e.message); }
}

// --- INICIAR SESIÓN --- 
async function startSession(sessionName, isManual = false) {
    let abortandoPorFaltaDeQR = false; 
    if (client) { try { await client.destroy(); } catch(e) {} client = null; isClientReady = false; }
    
    console.log(`🔵 INICIANDO: ${sessionName.toUpperCase()}`);
    io.emit('status', `⏳ Cargando ${sessionName.toUpperCase()}...`);

    const folderPath = path.resolve(`./data/session-client-${sessionName}`);
    recursiveDeleteLocks(folderPath);

    const puppeteerConfig = {
        headless: true,
        protocolTimeout: 300000,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', 
            '--no-first-run', 
            '--single-process', 
            '--disable-gpu',
            '--no-zygote',
            '--js-flags="--max-old-space-size=400"', // Límite estricto de RAM para Render
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    };
    if (RUTA_CHROME_DETECTADA) puppeteerConfig.executablePath = RUTA_CHROME_DETECTADA;

    console.log("🚀 Lanzando Puppeteer...");
    client = new Client({
        authStrategy: new LocalAuth({ clientId: `client-${sessionName}`, dataPath: './data' }),
        puppeteer: puppeteerConfig,
        qrMaxRetries: isManual ? 5 : 0,
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/refs/heads/main/html/2.3000.1031490220-alpha.html',
        }
    });

    client.on('qr', async (qr) => { 
        console.log("📸 QR Generado");
        if (!isManual) {
            abortandoPorFaltaDeQR = true; 
            await client.destroy();
            return;
        }
        io.emit('qr', qr); 
    });

    client.on('ready', () => { 
        isClientReady = true; 
        console.log(`✅ ${sessionName} LISTO`);
        io.emit('status', `✅ ACTIVO: ${sessionName.toUpperCase()}`); 
        processQueue(); 
    });

    try { 
        await client.initialize(); 
        console.log("⚙️ Cliente inicializado.");
    } catch (e) { console.error("❌ Error en Init:", e.message); }
}

// --- GENERADOR DE PDF --- 
async function generarYEnviarPDF(item, clientInstance) {
    try {
        const { datos_ticket, foto_evidencia } = item.pdfData;
        const htmlContent = `<html><body><div style="padding:20px; border:1px solid #000;">
            <h2>FERROLÁMINAS RICHAUD</h2>
            <p>Ticket: ${datos_ticket.folio}</p>
            <p>Total: $${datos_ticket.total}</p>
            ${foto_evidencia ? `<img src="${foto_evidencia}" style="width:300px;"/>` : ''}
        </div></body></html>`;

        const browser = await puppeteer.launch({ 
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--single-process', '--disable-gpu', '--js-flags="--max-old-space-size=300"'],
            executablePath: RUTA_CHROME_DETECTADA || undefined 
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });
        const pdfBuffer = await page.pdf({ format: 'A4' });
        await browser.close();

        const media = new MessageMedia('application/pdf', Buffer.from(pdfBuffer).toString('base64'), `Ticket-${datos_ticket.folio}.pdf`);
        let chatId = item.numero.replace(/\D/g, '') + '@c.us';
        if (chatId.startsWith('521')) chatId = chatId.replace('521', '52');
        
        await clientInstance.sendMessage(chatId, media, { caption: item.mensaje });
        return true;
    } catch (e) { console.error("❌ Error PDF:", e.message); return false; }
}

const processQueue = async () => {
    if (isProcessingQueue || (pdfQueue.length === 0 && normalQueue.length === 0)) return;
    if (isPaused || !isClientReady || !client) return; 
    isProcessingQueue = true;

    let item = pdfQueue.length > 0 ? pdfQueue[0] : normalQueue[0];
    let tipo = pdfQueue.length > 0 ? 'pdf' : 'normal';

    try {
        let cleanNumber = item.numero.replace(/\D/g, '') + '@c.us';
        console.log(`⏳ Enviando a ${item.numero}...`);
        
        if (tipo === 'pdf') {
            await generarYEnviarPDF(item, client);
        } else {
            await client.sendMessage(cleanNumber, item.mensaje);
        }
        console.log("✅ Mensaje enviado.");
    } catch (e) { console.error("❌ Error en cola:", e.message); }
    finally {
        if (tipo === 'pdf') pdfQueue.shift(); else normalQueue.shift();
        setTimeout(() => { isProcessingQueue = false; processQueue(); }, 30000);
    }
};

// --- RUTAS ---
app.post('/iniciar-chip-a', authMiddleware, (req, res) => { startSession('chip-a', true); res.json({ success: true }); });
app.post('/iniciar-chip-b', authMiddleware, (req, res) => { startSession('chip-b', true); res.json({ success: true }); });
app.get('/status', (req, res) => { res.json({ ready: isClientReady, cola: pdfQueue.length + normalQueue.length }); });
app.get('/', (req, res) => res.render('index'));

server.listen(PORT, () => {
    console.log(`🛡️ SERVIDOR EN PUERTO ${PORT}`);
    const turno = getTurnoActual();
    if (existeSesion(turno)) {
        console.log(`🤖 Auto-iniciando turno: ${turno}`);
        startSession(turno, false);
    }
});