const express = require('express');
const cors = require('cors');
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');

const app = express();

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 } // 20MB file limit
});

// ======================================================
// TTL (AUTO-CLEANUP) MEMORY STORE TO PREVENT MEMORY LEAKS
// ======================================================
class AutoCleanStore {
    constructor(ttlMinutes = 30) {
        this.store = new Map();
        this.ttl = ttlMinutes * 60 * 1000;
        // Run cleanup every 10 minutes
        setInterval(() => this.cleanup(), 10 * 60 * 1000);
    }

    set(key, value) {
        this.store.set(key, { value, timestamp: Date.now() });
    }

    get(key) {
        const item = this.store.get(key);
        if (!item) return null;
        item.timestamp = Date.now(); // Reset TTL on access
        return item.value;
    }

    has(key) {
        return this.store.has(key);
    }

    cleanup() {
        const now = Date.now();
        for (const [key, item] of this.store.entries()) {
            if (now - item.timestamp > this.ttl) {
                this.store.delete(key);
            }
        }
    }
}

const sessionStore = new AutoCleanStore(30);

const NOTRACK_HEADERS = {
    'origin': 'https://notrack.ai',
    'referer': 'https://notrack.ai/chat',
    'accept': '*/*',
    'accept-language': 'en-US',
    'user-agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36'
};

const DEV_CREDITS = {
    developer: "Ramzan Ahsan",
    whatsapp_group: "https://chat.whatsapp.com/FiZBn0BykHX47d1iHLOay1"
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseCleanText(rawData) {
    if (typeof rawData !== 'string') return rawData;
    const lines = rawData.split('\n');
    let fullText = '';
    
    for (let line of lines) {
        if (line.startsWith('data: ')) {
            try {
                const parsed = JSON.parse(line.replace('data: ', '').trim());
                if (parsed.type === 'message' && parsed.content) return parsed.content;
                if (parsed.type === 'delta' && parsed.chunk) fullText += parsed.chunk;
            } catch (e) {}
        }
    }
    return fullText.trim() || rawData;
}

function extractCookies(headers) {
    const rawCookies = headers['set-cookie'];
    if (!rawCookies) return '';
    return rawCookies.map(c => c.split(';')[0]).join('; ');
}

// Upload & OCR Polling Helper (FIXED INFINITE POLLING ISSUE)
async function processFileUpload(fileBuffer, originalname, mimetype) {
    const formData = new FormData();
    formData.append('file', fileBuffer, {
        filename: originalname || 'image.jpg',
        contentType: mimetype || 'image/jpeg'
    });

    const uploadRes = await axios.post('https://notrack.ai/api/upload', formData, {
        headers: {
            ...NOTRACK_HEADERS,
            ...formData.getHeaders()
        },
        timeout: 15000
    });

    const sessionCookies = extractCookies(uploadRes.headers);
    let fileData = uploadRes.data;
    let fileId = fileData.file_id || fileData.id;
    let isReady = fileData.status === 'ready';

    // Poll status properly if processing asynchronously
    let attempts = 0;
    while (!isReady && attempts < 5) {
        await sleep(1000);
        attempts++;
        try {
            const statusRes = await axios.get(`https://notrack.ai/api/file/${fileId}`, {
                headers: { ...NOTRACK_HEADERS, 'cookie': sessionCookies },
                timeout: 5000
            });
            if (statusRes.data && statusRes.data.status === 'ready') {
                isReady = true;
                break;
            }
        } catch (err) {
            break; // Break gracefully if status check route unavailable
        }
    }

    return { fileId, sessionCookies };
}

// Root Endpoint
app.get('/', (req, res) => {
    res.json({
        status: "active",
        message: "High Performance Express API Engine",
        routes: {
            chat: "/chat (POST)",
            speech: "/speech?chat_id=YOUR_ID (GET)",
            upload: "/upload (POST)"
        },
        ...DEV_CREDITS
    });
});

// ======================================================
// 1. CHAT ROUTE
// ======================================================
app.post('/chat', upload.single('file'), async (req, res) => {
    try {
        let user_input = req.body.user_input || req.body.text || "Kya likha h";
        let chat_id = req.body.chat_id || null;
        let attachment_ids = [];
        let activeCookies = '';

        if (chat_id && sessionStore.has(chat_id)) {
            activeCookies = sessionStore.get(chat_id);
        }

        // Direct File Upload Parsing
        if (req.file) {
            const { fileId, sessionCookies } = await processFileUpload(req.file.buffer, req.file.originalname, req.file.mimetype);
            if (fileId) attachment_ids.push(fileId);
            if (sessionCookies) activeCookies = sessionCookies;
        }

        // Base64 Attachment Handling
        if (req.body.attachments) {
            let incomingAtt = req.body.attachments;
            if (typeof incomingAtt === 'string') {
                try { incomingAtt = JSON.parse(incomingAtt); } catch (e) { incomingAtt = [incomingAtt]; }
            }

            if (Array.isArray(incomingAtt)) {
                for (let att of incomingAtt) {
                    if (typeof att === 'string' && att.startsWith('data:image')) {
                        const parts = att.split(',');
                        const mimeMatch = parts[0].match(/:(.*?);/);
                        const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                        const buffer = Buffer.from(parts[1], 'base64');
                        
                        const { fileId, sessionCookies } = await processFileUpload(buffer, `img_${Date.now()}.jpg`, mimeType);
                        if (fileId) attachment_ids.push(fileId);
                        if (sessionCookies) activeCookies = sessionCookies;
                    } else if (typeof att === 'string') {
                        attachment_ids.push(att);
                    }
                }
            }
        }

        if (attachment_ids.length > 0) {
            await sleep(1000);
        }

        // Compute Multi-turn index counter
        let messageIdx = 1;
        if (chat_id && sessionStore.has(`${chat_id}_idx`)) {
            messageIdx = sessionStore.get(`${chat_id}_idx`) + 1;
        }

        const dispatchPayload = {
            user_input: user_input,
            mode: "usual",
            model: "C",
            persona: "detailed",
            max_turns: 6,
            chat_id: chat_id === 'null' ? null : chat_id,
            attachments: attachment_ids,
            regenerate: false,
            edit: false,
            edit_mid: null
        };

        const headers = { ...NOTRACK_HEADERS, 'content-type': 'application/json' };
        if (activeCookies) headers['cookie'] = activeCookies;

        const dispatchRes = await axios.post('https://notrack.ai/api/dispatch', dispatchPayload, { 
            headers, 
            timeout: 45000 
        });
        
        const responseText = parseCleanText(dispatchRes.data);

        // Capture session cookies
        const newCookies = extractCookies(dispatchRes.headers);
        if (newCookies) activeCookies = newCookies;

        let activeChatId = chat_id;
        if (!activeChatId && dispatchRes.data && typeof dispatchRes.data === 'object' && dispatchRes.data.chat_id) {
            activeChatId = dispatchRes.data.chat_id;
        }
        if (!activeChatId) {
            activeChatId = `chat_${Date.now()}`;
        }

        // Save State in TTL Store
        if (activeCookies) sessionStore.set(activeChatId, activeCookies);
        sessionStore.set(`${activeChatId}_text`, responseText);
        sessionStore.set(`${activeChatId}_idx`, messageIdx);

        const host = req.get('host');
        const protocol = req.protocol;
        const speechUrl = `${protocol}://${host}/speech?chat_id=${activeChatId}&idx=${messageIdx}&lang=en`;

        return res.json({
            status: "success",
            ...DEV_CREDITS,
            chat_id: activeChatId,
            message_idx: messageIdx,
            attachments_processed: attachment_ids,
            text_response: responseText,
            speech_url: speechUrl
        });

    } catch (error) {
        return res.status(500).json({ 
            status: "error", 
            ...DEV_CREDITS, 
            message: error.response?.data?.message || error.message 
        });
    }
});

// ======================================================
// 2. SPEECH ROUTE
// ======================================================
app.get('/speech', async (req, res) => {
    try {
        const { chat_id, lang, idx } = req.query;
        if (!chat_id) return res.status(400).json({ error: "Missing chat_id parameter" });

        const savedCookie = sessionStore.get(chat_id) || '';
        const speechIdx = idx || sessionStore.get(`${chat_id}_idx`) || 1;
        let voiceBuffer = null;

        const headers = { ...NOTRACK_HEADERS, 'content-type': 'application/json' };
        if (savedCookie) headers['cookie'] = savedCookie;

        try {
            const response = await axios.post('https://notrack.ai/speak.php', {
                chat_id: chat_id,
                idx: Number(speechIdx),
                chunk: 0,
                lang: lang || "en"
            }, { headers: headers, responseType: 'arraybuffer', timeout: 7000 });

            if (response.data && response.data.byteLength > 200) {
                voiceBuffer = response.data;
            }
        } catch (e) {}

        // Fallback TTS Stream
        if (!voiceBuffer) {
            const cachedText = sessionStore.get(`${chat_id}_text`) || "Response ready";
            const cleanText = cachedText.replace(/[*_#`]/g, '').slice(0, 300); // Remove markdown syntax for TTS
            const encodedText = encodeURIComponent(cleanText);
            const fallbackUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodedText}&tl=${lang || 'en'}&client=tw-ob`;

            const fallbackRes = await axios.get(fallbackUrl, {
                responseType: 'arraybuffer',
                headers: { 'user-agent': 'Mozilla/5.0' }
            });
            voiceBuffer = fallbackRes.data;
        }

        res.setHeader('Content-Type', 'audio/mpeg');
        return res.send(Buffer.from(voiceBuffer));
    } catch (error) {
        return res.status(500).json({ status: "error", message: error.message });
    }
});

// ======================================================
// 3. UPLOAD ROUTE
// ======================================================
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file provided" });
        const { fileId, sessionCookies } = await processFileUpload(req.file.buffer, req.file.originalname, req.file.mimetype);
        return res.json({ status: "success", file_id: fileId, cookie: sessionCookies, ...DEV_CREDITS });
    } catch (error) {
        return res.status(500).json({ status: "error", message: error.message });
    }
});

module.exports = app;
