const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const crypto = require("crypto");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const AUTH_DIR = path.join(__dirname, "auth_sessions");

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

// ──────────────────────────────
// Multi-user session store
// Each user gets a unique sessionId stored in their browser
// ──────────────────────────────
const sessions = new Map(); // sessionId -> { sock, isConnected, contactsMap, historyDone, lastQR }

function getSession(sessionId) {
  return sessions.get(sessionId);
}

function createSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sock: null,
      isConnected: false,
      contactsMap: new Map(),
      historyDone: false,
      lastQR: null,
    });
  }
  return sessions.get(sessionId);
}

// Clean up idle sessions after 2 hours
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.lastActivity && now - session.lastActivity > 2 * 60 * 60 * 1000) {
      console.log(`[cleanup] Removing idle session ${id}`);
      try { if (session.sock) session.sock.end(); } catch {}
      sessions.delete(id);
    }
  }
}, 10 * 60 * 1000);

// ──────────────────────────────
// WhatsApp Connection (per user)
// ──────────────────────────────
async function connectWhatsApp(sessionId, socket) {
  const session = createSession(sessionId);
  session.lastActivity = Date.now();

  const sessionDir = path.join(AUTH_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const { version } = await fetchLatestBaileysVersion();

  // Close existing connection if any
  if (session.sock) {
    try { session.sock.end(); } catch {}
  }

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    syncFullHistory: true,
  });

  session.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  function getOrCreate(jid) {
    if (!session.contactsMap.has(jid)) {
      const phone = jid.replace("@s.whatsapp.net", "");
      session.contactsMap.set(jid, { phone, saved_name: "", whatsapp_name: "", chat_id: jid, last_msg: 0 });
    }
    return session.contactsMap.get(jid);
  }

  function addChat(jid, opts = {}) {
    if (!jid || typeof jid !== "string") return;
    if (
      jid.endsWith("@g.us") || jid === "status@broadcast" ||
      jid.endsWith("@broadcast") || jid.endsWith("@lid") || jid.endsWith("@newsletter")
    ) return;
    if (!jid.endsWith("@s.whatsapp.net")) return;
    const entry = getOrCreate(jid);
    if (opts.savedName && !entry.saved_name) entry.saved_name = opts.savedName;
    if (opts.pushName && !entry.whatsapp_name) entry.whatsapp_name = opts.pushName;
    if (opts.timestamp && opts.timestamp > entry.last_msg) entry.last_msg = opts.timestamp;
  }

  function processChats(chats) {
    if (!chats || !Array.isArray(chats)) return;
    for (const c of chats) {
      if (!c || !c.id) continue;
      const ts = c.conversationTimestamp?.low || c.conversationTimestamp || 0;
      addChat(c.id, { savedName: c.name, pushName: c.notify, timestamp: ts });
    }
  }

  function processContacts(contacts) {
    if (!contacts || !Array.isArray(contacts)) return;
    for (const c of contacts) {
      if (!c || !c.id) continue;
      addChat(c.id, { savedName: c.name, pushName: c.notify });
    }
  }

  function emitProgress() {
    socket.emit("sync-progress", { count: session.contactsMap.size, done: session.historyDone });
  }

  sock.ev.on("messaging-history.set", (data) => {
    try {
      console.log(`[${sessionId.slice(0,8)}] history.set: ${data?.chats?.length || 0} chats, ${data?.contacts?.length || 0} contacts`);
      processChats(data?.chats);
      processContacts(data?.contacts);
      if (data?.isLatest) session.historyDone = true;
      emitProgress();
    } catch (e) { console.error("[history.set] ERROR:", e.message); }
  });

  sock.ev.on("chats.upsert", (data) => {
    try {
      const chats = Array.isArray(data) ? data : data?.chats || [];
      processChats(chats);
      emitProgress();
    } catch (e) { console.error("[chats.upsert] ERROR:", e.message); }
  });

  sock.ev.on("chats.set", (data) => {
    try {
      const chats = Array.isArray(data) ? data : data?.chats || [];
      processChats(chats);
      emitProgress();
    } catch (e) { console.error("[chats.set] ERROR:", e.message); }
  });

  sock.ev.on("contacts.upsert", (data) => {
    try {
      const contacts = Array.isArray(data) ? data : data?.contacts || [];
      processContacts(contacts);
      emitProgress();
    } catch (e) { console.error("[contacts.upsert] ERROR:", e.message); }
  });

  sock.ev.on("contacts.set", (data) => {
    try {
      const contacts = Array.isArray(data) ? data : data?.contacts || [];
      processContacts(contacts);
      emitProgress();
    } catch (e) { console.error("[contacts.set] ERROR:", e.message); }
  });

  sock.ev.on("messages.upsert", (data) => {
    try {
      const messages = data?.messages || [];
      for (const m of messages) {
        const jid = m.key?.remoteJid;
        const ts = m.messageTimestamp?.low || m.messageTimestamp || 0;
        addChat(jid, { pushName: m.pushName, timestamp: ts });
      }
    } catch (e) { console.error("[messages.upsert] ERROR:", e.message); }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const qrDataUrl = await QRCode.toDataURL(qr, { width: 300 });
      session.lastQR = qrDataUrl;
      socket.emit("qr", qrDataUrl);
      console.log(`[${sessionId.slice(0,8)}] QR generated`);
    }

    if (connection === "close") {
      session.isConnected = false;
      socket.emit("status", { connected: false });
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => {
          connectWhatsApp(sessionId, socket).catch(err => {
            console.error(`[${sessionId.slice(0,8)}] Reconnect failed:`, err.message);
          });
        }, 3000);
      } else {
        socket.emit("logged-out");
      }
    }

    if (connection === "open") {
      session.isConnected = true;
      session.lastQR = null;
      console.log(`[${sessionId.slice(0,8)}] CONNECTED — syncing...`);
      socket.emit("status", { connected: true });

      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        console.log(`  [${sessionId.slice(0,8)}] ${session.contactsMap.size} contacts (${(i+1)*5}s)`);
        if (session.historyDone && session.contactsMap.size > 0) break;
      }
      console.log(`[${sessionId.slice(0,8)}] Sync done: ${session.contactsMap.size} contacts`);
      emitProgress();
    }
  });
}

// ──────────────────────────────
// API Routes — all session-aware
// ──────────────────────────────
app.get("/api/contacts", (req, res) => {
  const sid = req.query.sid;
  const session = sid && getSession(sid);
  if (!session) return res.json({ contacts: [], total: 0, connected: false });

  session.lastActivity = Date.now();
  const sorted = Array.from(session.contactsMap.values()).sort((a, b) => b.last_msg - a.last_msg);
  const contacts = sorted.map((c, i) => ({
    id: i + 1,
    phone: c.phone,
    name: c.saved_name || c.whatsapp_name || "",
    chat_id: c.chat_id,
  }));
  res.json({ contacts, total: contacts.length, connected: session.isConnected });
});

app.get("/api/status", (req, res) => {
  const sid = req.query.sid;
  const session = sid && getSession(sid);
  if (!session) return res.json({ connected: false, contacts: 0, synced: false });
  res.json({ connected: session.isConnected, contacts: session.contactsMap.size, synced: session.historyDone });
});

app.post("/api/logout", async (req, res) => {
  const sid = req.body.sid;
  const session = sid && getSession(sid);
  if (!session) return res.json({ ok: true });

  try {
    if (session.sock) await session.sock.logout();
    const sessionDir = path.join(AUTH_DIR, sid);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    sessions.delete(sid);
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/send", async (req, res) => {
  const { sid, chatId, message, image } = req.body;
  const session = sid && getSession(sid);
  if (!session || !session.isConnected || !session.sock) {
    return res.status(400).json({ error: "Not connected" });
  }

  session.lastActivity = Date.now();
  try {
    if (image) {
      const base64Data = image.split(",")[1];
      const buffer = Buffer.from(base64Data, "base64");
      await session.sock.sendMessage(chatId, { image: buffer, caption: message });
    } else {
      await session.sock.sendMessage(chatId, { text: message });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check for Cloud Run
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// ──────────────────────────────
// Socket.IO — per-user sessions
// ──────────────────────────────
io.on("connection", (socket) => {
  console.log(`[socket] New browser connected: ${socket.id}`);

  // Browser sends its sessionId (from localStorage)
  socket.on("init", async ({ sessionId }) => {
    if (!sessionId) return;
    console.log(`[socket] Init session ${sessionId.slice(0,8)}`);

    const session = getSession(sessionId);
    if (session) {
      // Existing session — send current state
      if (session.lastQR && !session.isConnected) socket.emit("qr", session.lastQR);
      if (session.isConnected) {
        socket.emit("status", { connected: true });
        socket.emit("sync-progress", { count: session.contactsMap.size, done: session.historyDone });
      }
    }
  });

  // Browser requests WhatsApp connection
  socket.on("connect-wa", async ({ sessionId }) => {
    if (!sessionId) return;
    console.log(`[socket] Connecting WA for ${sessionId.slice(0,8)}`);
    try {
      await connectWhatsApp(sessionId, socket);
    } catch (err) {
      console.error(`[${sessionId.slice(0,8)}] Connect failed:`, err.message);
      socket.emit("error", { message: err.message });
    }
  });

  socket.on("disconnect", () => {
    console.log(`[socket] Browser disconnected: ${socket.id}`);
  });
});

// ──────────────────────────────
fs.mkdirSync(AUTH_DIR, { recursive: true });

server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Bulk Sender running on port ${PORT}`);
  console.log(`   Multi-user mode — each browser gets its own session\n`);
});
