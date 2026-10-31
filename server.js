import makeWASocket, {
  DisconnectReason,
  isJidStatusBroadcast,
  downloadMediaMessage,
  initAuthCreds,
  BufferJSON,
  proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import axios from 'axios';
import QRCode from 'qrcode';
import crypto from 'crypto';
import os from 'os';
import { createClient } from '@supabase/supabase-js';
import { readFile, writeFile, mkdir, unlink, readdir, stat } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: 'silent' });

// ============================================================
// CONFIG & ENVIRONMENT VARIABLES
// ============================================================
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const BOT_LOGO_URL = 'https://i.imgur.com/8QO4z8m.png'; 

// SUPABASE CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
const USERS_FILE = path.join(__dirname, 'users.json');

const activeSockets = new Map();
const messageStore = new Map();
const aiMemory = new Map();

// ============================================================
// SUPABASE AUTH STATE (Saves WhatsApp Login)
// ============================================================
async function useSupabaseAuthState(userId) {
  const writeData = async (data, key) => {
    const json = JSON.stringify(data, BufferJSON.replacer);
    const { error } = await supabase
      .from('wa_sessions')
      .upsert({ id: `${userId}_${key}`, data: json });
    if (error) console.error('Supabase write error:', error);
  };

  const readData = async (key) => {
    const { data, error } = await supabase
      .from('wa_sessions')
      .select('data')
      .eq('id', `${userId}_${key}`)
      .single();
    
    if (error || !data) return null;
    return JSON.parse(data.data, BufferJSON.reviver);
  };

  const removeData = async (key) => {
    await supabase.from('wa_sessions').delete().eq('id', `${userId}_${key}`);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
  };
}

// ============================================================
// HELPERS
// ============================================================
async function loadUsers() { 
  try { 
    return JSON.parse(await readFile(USERS_FILE, 'utf8')); 
  } catch (e) { 
    await writeFile(USERS_FILE, '{}'); 
    return {}; 
  } 
}

async function saveUsers(u) { 
  try {
    await writeFile(USERS_FILE, JSON.stringify(u, null, 2)); 
  } catch (e) {
    console.error('Failed to save user:', e);
  }
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + 'h ' : '') + (m ? m + 'm ' : '') + sec + 's';
}

async function askGemini(prompt, history = [], systemPrompt = '') {
  if (!GEMINI_API_KEY) throw new Error('No GEMINI_API_KEY set');
  const contents = [];
  for (const h of history) contents.push({ role: h.role === 'user' ? 'user' : 'model', parts: [{ text: h.text }] });
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const body = { contents };
  if (systemPrompt) body.systemInstruction = { parts: [{ text: systemPrompt }] };

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + GEMINI_API_KEY;
  const r = await axios.post(url, body, { timeout: 45000 });
  return r.data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response';
}

// ============================================================
// BOT SESSION
// ============================================================
async function createBotSession(userId, phone) {
  if (activeSockets.has(userId)) {
    try { activeSockets.get(userId).sock?.end(); } catch {}
    activeSockets.delete(userId);
  }

  const { state, saveCreds } = await useSupabaseAuthState(userId);

  const sock = makeWASocket({
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['Ubuntu', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async (key) => {
      try { return messageStore.get(key.remoteJid + ':' + key.id)?.message || undefined; } catch { return undefined; }
    },
  });

  const entry = { sock, status: 'CONNECTING', phone, pairingCode: null, connectedAt: null, userId };
  activeSockets.set(userId, entry);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !sock.authState.creds.registered) entry.status = 'QR_READY';
    if (connection === 'connecting') entry.status = 'CONNECTING';
    if (connection === 'open') {
      entry.status = 'CONNECTED';
      entry.connectedAt = Date.now();
      entry.pairingCode = null;
      console.log('[user ' + userId + '] connected');
      
      try {
        await sock.updateProfileName('HACKERXKESCHEME');
        const res = await axios.get(BOT_LOGO_URL, { responseType: 'arraybuffer' });
        await sock.updateProfilePicture(sock.user.id, Buffer.from(res.data));
      } catch (err) {}
    }
    if (connection === 'close') {
      entry.status = 'DISCONNECTED';
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) setTimeout(() => createBotSession(userId, phone), 5000);
    }
  });

  sock.ev.on('call', async (calls) => {
    for (const c of calls) {
      if (c.status === 'offer') { try { await sock.rejectCall(c.id, c.from); } catch {} }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      const sender = msg.key.participant || msg.key.remoteJid;

      // 1. Silent View-Once Interceptor
      const voMsg = msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2 || msg.message?.viewOnceMessageV2Extension;
      if (voMsg && !msg.key.fromMe) {
        try {
          const inner = voMsg.message;
          const vt = Object.keys(inner)[0];
          if (['imageMessage', 'videoMessage', 'audioMessage'].includes(vt)) {
            const buf = await downloadMediaMessage({ message: inner, key: msg.key }, 'buffer', {}, { logger });
            const selfJid = sock.user.id.split(':')[0] + '@s.whatsapp.net';
            const cap = '👁️ *Intercepted View Once*\nFrom: ' + sender.split('@')[0];
            if (vt === 'imageMessage') await sock.sendMessage(selfJid, { image: buf, caption: cap });
            else if (vt === 'videoMessage') await sock.sendMessage(selfJid, { video: buf, caption: cap });
            else await sock.sendMessage(selfJid, { audio: buf, mimetype: 'audio/mpeg' });
            continue;
          }
        } catch (e) {}
      }

      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      // 2. AI Auto-Reply
      if (text && !text.startsWith('.') && !msg.key.fromMe) {
        let shouldRespond = !jid.endsWith('@g.us');
        if (jid.endsWith('@g.us')) {
          const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
          if (contextInfo?.mentionedJid?.includes(sock.user.id.split(':')[0] + '@s.whatsapp.net')) shouldRespond = true;
        }
        if (shouldRespond) {
          try {
            await sock.sendPresenceUpdate('composing', jid);
            const reply = await askGemini(text, [], 'You are HACKERXKESCHEME, a highly intelligent AI.');
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });
            await sock.sendPresenceUpdate('paused', jid);
          } catch (e) {}
        }
        continue;
      }

      // 3. Commands
      if (!text.startsWith('.')) continue;
      if (!msg.key.fromMe) continue;
      
      const args = text.slice(1).trim().split(/\s+/);
      let cmd = args.shift().toLowerCase();

      try { await handleCommand(sock, msg, jid, cmd, args); } catch (err) { console.error(err.message); }
    }
  });

  return entry;
}

// ============================================================
// COMMAND HANDLER
// ============================================================
async function handleCommand(sock, msg, jid, cmd, args) {
  if (cmd === 'menu') {
    await sock.sendMessage(jid, { text: '╔═══════════════╗\n  👑 *MENU*\n╠───────────────╣\n║ ➣ *.ping* .alive*\n║ ➣ *.ai* .meme*\n║ ➣ *.daily* .balance*\n╚═══════════════╝' });
  }
  if (cmd === 'ping') await sock.sendMessage(jid, { text: '🏓 Pong!' });
  if (cmd === 'alive') await sock.sendMessage(jid, { text: '✅ Alive: ' + formatDuration(process.uptime() * 1000) });
  if (cmd === 'ai') {
    const q = args.join(' ');
    try {
      const reply = await askGemini(q, [], 'You are HACKERXKESCHEME.');
      await sock.sendMessage(jid, { text: reply });
    } catch (e) { await sock.sendMessage(jid, { text: '❌ ' + e.message }); }
  }
}

// ============================================================
// EXPRESS APP & AUTH
// ============================================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'atomic-secret-' + Math.random(),
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { 
    secure: false, 
    maxAge: 30 * 24 * 60 * 60 * 1000 
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Routes ---
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username min 3, password min 6' });
    }
    const users = await loadUsers();
    if (users[username]) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    const hash = await bcrypt.hash(password, 10);
    users[username] = { password: hash, createdAt: Date.now() };
    await saveUsers(users);
    
    req.session.userId = username;
    res.json({ success: true, user: { username } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const users = await loadUsers();
    const user = users[username];
    
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    req.session.userId = username;
    res.json({ success: true, user: { username } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  res.json({ user: { username: req.session.userId } });
});

// --- Session Routes ---
app.get('/api/session', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const entry = activeSockets.get(req.session.userId);
  if (!entry) return res.json({ status: 'NONE' });
  res.json({ status: entry.status, pairingCode: entry.pairingCode });
});

app.post('/api/session/create', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const { phone } = req.body;
  
  if (!phone || !/^\d{8,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Invalid phone number format. Use digits only (e.g., 254712345678).' });
  }

  try {
    // Force close any existing socket to free memory
    if (activeSockets.has(req.session.userId)) {
      const old = activeSockets.get(req.session.userId);
      try { old.sock?.end(); } catch (e) {}
      activeSockets.delete(req.session.userId);
    }

    const entry = await createBotSession(req.session.userId, phone);
    
    // Wait longer for Baileys to initialize to prevent memory spike
    await new Promise(r => setTimeout(r, 4000)); 

    if (!entry.sock.authState.creds.registered) {
      const code = await entry.sock.requestPairingCode(phone);
      entry.pairingCode = code; 
      entry.status = 'AWAITING_PAIR';
      res.json({ success: true, code });
    } else {
      res.json({ success: true, alreadyRegistered: true });
    }
  } catch (err) { 
    console.error('Session create error:', err);
    res.status(500).json({ error: 'Server ran out of memory. Please try again.' }); 
  }
});

app.post('/api/session/delete', async (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  const userId = req.session.userId;
  const entry = activeSockets.get(userId);
  
  if (entry) { 
    try { await entry.sock.logout(); } catch {} 
    try { entry.sock.end(); } catch {} 
    activeSockets.delete(userId); 
  }
  
  await supabase.from('wa_sessions').delete().like('id', userId + '_%');
  res.json({ success: true });
});

// ============================================================
// STARTUP
// ============================================================
async function restoreSessions() {
  try {
    const users = await loadUsers();
    for (const userId of Object.keys(users)) {
      console.log('Checking Supabase for session: ' + userId);
      await createBotSession(userId, null);
    }
  } catch (e) {
    console.error('Restore error:', e);
  }
}

app.listen(PORT, '0.0.0.0', () => console.log('🌐 http://localhost:' + PORT));
restoreSessions().catch(console.error);
