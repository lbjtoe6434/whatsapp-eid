# WhatsApp Bulk Sender 💬

Send **personalized WhatsApp messages** to your contacts — each with a custom name — through a beautiful web interface.

Perfect for sending **Eid greetings**, **Ramadan wishes**, **holiday messages**, or any personalized bulk messages to your contacts.

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)
![License](https://img.shields.io/badge/License-MIT-blue)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Web-25D366?logo=whatsapp)

</div>

---

## ✨ Features

- 🔐 **QR Code Login** — Scan once, stay connected
- 👥 **Auto-Fetch Contacts** — Pulls all your WhatsApp conversations
- ✅ **Include/Exclude Toggle** — Click to include or skip contacts
- ✍️ **Custom Names** — Give each contact a personal name (nickname, title, etc.)
- 📝 **Message Template** — Write your message once, personalize with `{{name}}`
- 🧪 **Test Mode** — Send a test message before going bulk
- 🚀 **Bulk Send** — Send to everyone with random delays (anti-ban)
- 📊 **Live Progress** — Real-time progress bar and send log
- 📥📤 **Import/Export Excel** — Save your work, import it back later
- 🌙 **Dark WhatsApp Theme** — Looks and feels like WhatsApp

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/rayl999/whatsapp-bulk-sender.git
cd whatsapp-bulk-sender
npm install
```

### 2. Run

```bash
npm start
```

### 3. Open in browser

```
http://localhost:3000
```

### 4. Follow the 4 steps in the UI:

| Step | What to do |
|------|-----------|
| **1. Connect** | Scan the QR code with your WhatsApp |
| **2. Contacts** | Toggle who to include, type custom names |
| **3. Message** | Write your template using `{{name}}` |
| **4. Send** | Test first, then send to all! |

---

## 📱 How It Works

```
You scan QR → App connects to WhatsApp Web → Fetches your contacts
   → You pick who to message → Write a template → Send personalized messages
```

### Message Template Example

Template:
```
السلام عليكم {{name}}
كل عام وأنتم بخير
عيدكم مبارك
```

If the contact's custom name is **أبو محمد**, the message becomes:
```
السلام عليكم أبو محمد
كل عام وأنتم بخير
عيدكم مبارك
```

---

## 📂 Project Structure

```
whatsapp-bulk-sender/
├── server.js           # Express + Baileys backend
├── public/
│   └── index.html      # Web UI (single page app)
├── 1-fetch-contacts.js # CLI: fetch contacts to Excel
├── 2-send-messages.js  # CLI: send messages from Excel
├── auth_session/       # WhatsApp session (auto-created)
├── package.json
└── README.md
```

---

## 🛡️ Anti-Ban Measures

- **Random delays**: 3–8 seconds between each message
- **No spam**: Only sends to contacts you've chatted with
- **Personal messages**: Each message is different (custom name)
- **Manual control**: You review everything before sending

---

## ⚠️ Important Notes

- This tool uses [Baileys](https://github.com/WhiskeySockets/Baileys) (unofficial WhatsApp Web API)
- Use responsibly — don't spam people
- WhatsApp may temporarily ban accounts that send too many messages too fast
- The `auth_session/` folder contains your login session — keep it private
- Names shown are **WhatsApp profile names** (not your phone contacts)

---

## 🔧 CLI Mode (Advanced)

If you prefer the command line over the web UI:

```bash
# Step 1: Fetch contacts to Excel
node 1-fetch-contacts.js

# Step 2: Edit contacts.xlsx — fill custom_name column

# Step 3: Send messages
node 2-send-messages.js
```

---

## 📋 Requirements

- **Node.js** 18 or higher
- **npm** 8 or higher
- A **WhatsApp account** with active conversations

---

## 🤝 Contributing

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/awesome`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

---

## 📄 License

MIT License — use it however you want.

---

<div align="center">

**Built with ❤️ by [Rayan Lubbad](https://github.com/rayl999)**

عيدكم مبارك 🌙

</div>
