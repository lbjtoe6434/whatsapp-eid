const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
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

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "10mb" }));

let sock = null;
let isConnected = false;
const contactsMap = new Map();
let historyDone = false;
let lastQR = null; // cache QR so late-connecting browsers get it

// ──────────────────────────────
// WhatsApp Connection
// ──────────────────────────────
async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    syncFullHistory: true,
  });

  sock.ev.on("creds.update", saveCreds);

  function getOrCreate(jid) {
    if (!contactsMap.has(jid)) {
      const phone = jid.replace("@s.whatsapp.net", "");
      contactsMap.set(jid, { phone, saved_name: "", whatsapp_name: "", chat_id: jid, last_msg: 0 });
    }
    return contactsMap.get(jid);
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
    io.emit("sync-progress", { count: contactsMap.size, done: historyDone });
  }

  // Listen to ALL events — with try/catch so nothing silently breaks
  sock.ev.on("messaging-history.set", (data) => {
    try {
      console.log(`[history.set] ${data?.chats?.length || 0} chats, ${data?.contacts?.length || 0} contacts, isLatest=${data?.isLatest}`);
      processChats(data?.chats);
      processContacts(data?.contacts);
      if (data?.isLatest) historyDone = true;
      emitProgress();
    } catch (e) { console.error("[history.set] ERROR:", e.message); }
  });

  sock.ev.on("chats.upsert", (data) => {
    try {
      const chats = Array.isArray(data) ? data : data?.chats || [];
      console.log(`[chats.upsert] ${chats.length} chats`);
      processChats(chats);
      emitProgress();
    } catch (e) { console.error("[chats.upsert] ERROR:", e.message); }
  });

  sock.ev.on("chats.set", (data) => {
    try {
      const chats = Array.isArray(data) ? data : data?.chats || [];
      console.log(`[chats.set] ${chats.length} chats`);
      processChats(chats);
      emitProgress();
    } catch (e) { console.error("[chats.set] ERROR:", e.message); }
  });

  sock.ev.on("contacts.upsert", (data) => {
    try {
      const contacts = Array.isArray(data) ? data : data?.contacts || [];
      console.log(`[contacts.upsert] ${contacts.length} contacts`);
      processContacts(contacts);
      emitProgress();
    } catch (e) { console.error("[contacts.upsert] ERROR:", e.message); }
  });

  sock.ev.on("contacts.set", (data) => {
    try {
      const contacts = Array.isArray(data) ? data : data?.contacts || [];
      console.log(`[contacts.set] ${contacts.length} contacts`);
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
      lastQR = qrDataUrl;
      io.emit("qr", qrDataUrl);
      console.log("[QR] New QR code generated — scan it in the browser");
    }

    if (connection === "close") {
      isConnected = false;
      io.emit("status", { connected: false });
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(() => connectWhatsApp(), 3000);
      } else {
        io.emit("logged-out");
      }
    }

    if (connection === "open") {
      isConnected = true;
      lastQR = null;
      console.log("[connection] OPEN — waiting for sync events...");
      io.emit("status", { connected: true });

      // Wait for sync like the working CLI version does
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        console.log(`  ... ${contactsMap.size} contacts so far (${(i + 1) * 5}s)`);
        if (historyDone && contactsMap.size > 0) break;
      }
      console.log(`[sync done] Total: ${contactsMap.size} contacts`);
      emitProgress();
    }
  });
}

// ──────────────────────────────
// API Routes (stateless — no file I/O)
// ──────────────────────────────

// Get synced contacts from WhatsApp
app.get("/api/contacts", (req, res) => {
  const sorted = Array.from(contactsMap.values()).sort((a, b) => b.last_msg - a.last_msg);
  const contacts = sorted.map((c, i) => ({
    id: i + 1,
    phone: c.phone,
    name: c.saved_name || c.whatsapp_name || "",
    chat_id: c.chat_id,
  }));
  console.log(`[API] Returning ${contacts.length} contacts`);
  res.json({ contacts, total: contacts.length, connected: isConnected });
});

// Connection status
app.get("/api/status", (req, res) => {
  res.json({ connected: isConnected, contacts: contactsMap.size, synced: historyDone });
});

// Logout
app.post("/api/logout", async (req, res) => {
  try {
    if (sock) await sock.logout();
    fs.rmSync("auth_session", { recursive: true, force: true });
    contactsMap.clear();
    historyDone = false;
    isConnected = false;
    res.json({ ok: true });
    setTimeout(() => connectWhatsApp(), 1000);
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Send single message (text or image+caption)
app.post("/api/send", async (req, res) => {
  const { chatId, message, image } = req.body;
  if (!isConnected || !sock) return res.status(400).json({ error: "Not connected" });
  try {
    if (image) {
      // image is a base64 data URL like "data:image/png;base64,..."
      const base64Data = image.split(",")[1];
      const buffer = Buffer.from(base64Data, "base64");
      await sock.sendMessage(chatId, {
        image: buffer,
        caption: message,
      });
    } else {
      await sock.sendMessage(chatId, { text: message });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Send cached QR to browsers that connect late
io.on("connection", (socket) => {
  if (lastQR && !isConnected) socket.emit("qr", lastQR);
  if (isConnected) socket.emit("status", { connected: true });
});

// ──────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Bulk Sender running at http://localhost:${PORT}\n`);
  connectWhatsApp();
});
