const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const XLSX = require("xlsx");
const pino = require("pino");

const MAX_CONTACTS = 500;
const logger = pino({ level: "silent" });

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    syncFullHistory: true,
  });

  sock.ev.on("creds.update", saveCreds);

  // Track contacts with their last message timestamp
  const contactsMap = new Map();
  const savedNames = new Map(); // names saved in your phone
  let historyDone = false;

  function getOrCreate(jid) {
    if (!contactsMap.has(jid)) {
      const phone = jid.replace("@s.whatsapp.net", "");
      contactsMap.set(jid, { phone, saved_name: "", whatsapp_name: "", chat_id: jid, last_msg: 0 });
    }
    return contactsMap.get(jid);
  }

  function addChat(jid, opts = {}) {
    if (!jid) return;
    if (
      jid.endsWith("@g.us") ||
      jid === "status@broadcast" ||
      jid.endsWith("@broadcast") ||
      jid.endsWith("@lid") ||
      jid.endsWith("@newsletter")
    ) return;
    if (!jid.endsWith("@s.whatsapp.net")) return;

    const entry = getOrCreate(jid);
    if (opts.savedName && !entry.saved_name) entry.saved_name = opts.savedName;
    if (opts.pushName && !entry.whatsapp_name) entry.whatsapp_name = opts.pushName;
    if (opts.timestamp && opts.timestamp > entry.last_msg) entry.last_msg = opts.timestamp;
  }

  sock.ev.on("messaging-history.set", ({ chats, contacts, isLatest }) => {
    console.log(`[history.set] ${chats?.length || 0} chats, ${contacts?.length || 0} contacts`);
    for (const c of (chats || [])) {
      const ts = c.conversationTimestamp?.low || c.conversationTimestamp || 0;
      // c.name = saved phone contact name, c.notify = WhatsApp push name
      addChat(c.id, { savedName: c.name, pushName: c.notify, timestamp: ts });
    }
    for (const c of (contacts || [])) {
      addChat(c.id, { savedName: c.name, pushName: c.notify });
    }
    if (isLatest) historyDone = true;
  });

  sock.ev.on("chats.upsert", (chats) => {
    console.log(`[chats.upsert] ${chats.length} chats`);
    for (const c of chats) {
      const ts = c.conversationTimestamp?.low || c.conversationTimestamp || 0;
      addChat(c.id, { savedName: c.name, pushName: c.notify, timestamp: ts });
    }
  });

  sock.ev.on("chats.set", ({ chats }) => {
    console.log(`[chats.set] ${chats?.length || 0} chats`);
    for (const c of (chats || [])) {
      const ts = c.conversationTimestamp?.low || c.conversationTimestamp || 0;
      addChat(c.id, { savedName: c.name, pushName: c.notify, timestamp: ts });
    }
  });

  sock.ev.on("contacts.upsert", (contacts) => {
    console.log(`[contacts.upsert] ${contacts.length} contacts`);
    for (const c of contacts) {
      // This event often carries the phone-saved contact name
      addChat(c.id, { savedName: c.name, pushName: c.notify });
    }
  });

  sock.ev.on("contacts.set", ({ contacts }) => {
    console.log(`[contacts.set] ${contacts?.length || 0} contacts`);
    for (const c of (contacts || [])) {
      addChat(c.id, { savedName: c.name, pushName: c.notify });
    }
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) {
      const jid = m.key?.remoteJid;
      const ts = m.messageTimestamp?.low || m.messageTimestamp || 0;
      addChat(jid, { pushName: m.pushName, timestamp: ts });
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Scan this QR code with your WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log("Connection lost, reconnecting...");
        start();
      } else {
        console.log("Logged out. Delete the auth_session folder and retry.");
      }
      return;
    }

    if (connection === "open") {
      console.log("Connected! Waiting for sync (30 seconds)...");

      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        console.log(`  ... ${contactsMap.size} contacts so far (${(i + 1) * 5}s)`);
        if (historyDone && contactsMap.size > 0) break;
      }

      console.log(`\nTotal unique contacts found: ${contactsMap.size}`);

      if (contactsMap.size === 0) {
        console.log("No contacts found. Try deleting auth_session folder and scanning again.");
        process.exit(0);
      }

      // Sort by last message timestamp (most recent first) — get all
      const sorted = Array.from(contactsMap.values())
        .sort((a, b) => b.last_msg - a.last_msg);

      console.log(`Keeping top ${sorted.length} most recent conversations.`);

      const rows = sorted.map((c, i) => ({
        include: "YES",
        "#": i + 1,
        phone: c.phone,
        name: c.saved_name || c.whatsapp_name || "",
        chat_id: c.chat_id,
        custom_name: "",
      }));

      const withName = rows.filter(r => r.name).length;
      console.log(`Contacts with a name: ${withName}/${sorted.length}`);

      const ws = XLSX.utils.json_to_sheet(rows);

      ws["!cols"] = [
        { wch: 10 },
        { wch: 5 },
        { wch: 18 },
        { wch: 25 },
        { wch: 35 },
        { wch: 22 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Contacts");
      XLSX.writeFile(wb, "contacts.xlsx");

      console.log(`\nExported ${sorted.length} contacts to contacts.xlsx (sorted by most recent chat)`);
      console.log("Next steps:");
      console.log("  1. Open contacts.xlsx");
      console.log("  2. Fill the 'custom_name' column for people you want to message");
      console.log("  3. Run: node 2-send-messages.js");

      process.exit(0);
    }
  });
}

start();
