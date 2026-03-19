const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const XLSX = require("xlsx");
const pino = require("pino");

// ============================================
// MESSAGE TEMPLATE — {{name}} = custom_name
// ============================================
const MESSAGE_TEMPLATE = `السلام عليكم 
{{name}}
كل عام وأنتم بخير
عيدكم مبارك
تقبل الله صيامكم وقيامكم وأعاده الله علينا وعليكم أعوامًا عديدة في صحة وسلامة و سعادة وأمن وأمان
ريان لبد`;
// ============================================

// SET TO true TO SEND TO EVERYONE, false TO TEST ONE PERSON
const SEND_ALL = true;
// TEST: set the phone number to test with (without +)
const TEST_PHONE = "XXXXXXXXXXX"; // لولو

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_session");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });

  sock.ev.on("creds.update", saveCreds);

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
      console.log("Connected! Reading contacts_to_message.xlsx...");
      await new Promise((r) => setTimeout(r, 3000));

      try {
        const wb = XLSX.readFile("contacts_to_message.xlsx");
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws);

        let toSend = rows.filter((r) => r.custom_name && String(r.custom_name).trim());

        if (!SEND_ALL) {
          // TEST MODE: only send to test phone
          toSend = toSend.filter((r) => String(r.phone).trim() === TEST_PHONE);
          if (toSend.length === 0) {
            console.log(`Test contact ${TEST_PHONE} not found or has no custom_name.`);
            process.exit(0);
          }
          console.log(`\n🧪 TEST MODE — sending only to: ${toSend[0].custom_name} (${TEST_PHONE})\n`);
        } else {
          console.log(`\n🚀 BULK MODE — sending to ${toSend.length} contacts\n`);
        }

        for (const contact of toSend) {
          const name = String(contact.custom_name).trim();
          const message = MESSAGE_TEMPLATE.replace(/\{\{name\}\}/g, name);
          const jid = contact.chat_id;

          console.log(`--- Message to ${name} (${contact.phone}) ---`);
          console.log(message);
          console.log("---\n");

          await sock.sendMessage(jid, { text: message });
          console.log(`✅ Sent to ${name} (${contact.phone})\n`);

          if (SEND_ALL) {
            // Random delay 3-8 seconds between messages
            const delay = 3000 + Math.random() * 5000;
            await new Promise((r) => setTimeout(r, delay));
          }
        }

        console.log("\nDone!");
      } catch (err) {
        console.error("Error:", err);
      }

      process.exit(0);
    }
  });
}

start();
