// index.js
// Lazy — WhatsApp Auto-Responder (simple & stable dashboard)

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');

class WhatsAppAutoResponder {
  constructor() {
    this.client = null;
    this.isAwayMode = false;
    this.awayMessage =
      "Hey! I'm a little off my phone right now. If it's urgent, please call me.";
    this.vipContacts = new Set();
    this.lastReplies = new Map();            // key = contactId OR groupId
    this.replyDelay = 12 * 60 * 60 * 1000;   // 12h
    this.qrString = null;                    // data URL for dashboard
    this.isConnected = false;

    this.initializeWebServer();
    this.initializeWhatsApp();
  }

  initializeWhatsApp() {
    console.log('🔧 Initializing WhatsApp client...');

    this.client = new Client({
      authStrategy: new LocalAuth({
        name: 'auto-responder',
        dataPath: './whatsapp-session',
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
        ],
      },
    });

    // QR
    this.client.on('qr', async (qr) => {
      console.log('📱 QR Code received (also printed in terminal)');
      qrcode.generate(qr, { small: true });
      try {
        this.qrString = await QRCode.toDataURL(qr);
        this.isConnected = false;
      } catch (e) {
        console.error('❌ Error generating QR data URL:', e);
      }
    });

    // Ready
    this.client.on('ready', () => {
      console.log('✅ Lazy Auto-Responder is ready!');
      console.log('🤖 Send "/help" to yourself for commands');
      this.isConnected = true;
      this.qrString = null;
    });

    // Auth failure
    this.client.on('auth_failure', (msg) => {
      console.error('❌ Authentication failed:', msg);
      this.isConnected = false;
    });

    // Disconnected
    this.client.on('disconnected', (reason) => {
      console.log('📵 WhatsApp disconnected:', reason);
      this.isConnected = false;
      // a new QR will be emitted by the library soon
    });

    // New message
    this.client.on('message_create', async (message) => {
      await this.handleIncomingMessage(message);
    });

    this.client.initialize();
  }

  async handleIncomingMessage(message) {
    try {
      // Commands (only from you)
      if (message.fromMe && message.body.startsWith('/')) {
        await this.handleBotCommand(message);
        return;
      }

      // Only reply in away mode; never to yourself
      if (!this.isAwayMode) return;
      if (message.fromMe) return;

      const chat = await message.getChat();
      const isGroup = chat.isGroup === true;

      // Skip archived
      if (chat.archived) return;

      const contact = await message.getContact();
      const contactId =
        (contact.id && (contact.id._serialized || contact.id.user)) ||
        'unknown-contact';
      const contactName = contact.name || contact.pushname || contactId;

      // VIPs suppress DMs only
      if (!isGroup && this.vipContacts.has(contactId)) return;

      // Per-group or per-contact 12h window
      const groupId = chat.id?._serialized;
      const replyKey = isGroup ? groupId : contactId;
      const last = this.lastReplies.get(replyKey);
      const now = Date.now();
      if (last && now - last < this.replyDelay) return;

      await message.reply(this.awayMessage);
      this.lastReplies.set(replyKey, now);
    } catch (e) {
      console.error('❌ Error handling message:', e);
    }
  }

  async handleBotCommand(message) {
    try {
      const parts = message.body.trim().slice(1).split(' ');
      const cmd = parts[0].toLowerCase();
      const params = parts.slice(1).join(' ');

      let response = '';
      switch (cmd) {
        case 'help':
          response =
            '🍃 *Lazy — Auto-Responder*\n\n' +
            '• /help — Show this menu\n' +
            '• /status — Current status\n' +
            '• /on — Turn away mode ON\n' +
            '• /off — Turn away mode OFF\n' +
            '• /toggle — Toggle away mode\n' +
            '• /msg <text> — Update away message\n' +
            '• /vip add <number> — Add VIP (DM only)\n' +
            '• /vip remove <number> — Remove VIP\n' +
            '• /vip list — Show VIPs\n' +
            '• /clear — Clear reply history (12h timers)';
          break;

        case 'status':
          response =
            '📊 *Status*\n\n' +
            `• Away Mode: ${this.isAwayMode ? '🟢 ON' : '🔴 OFF'}\n` +
            `• VIPs: ${this.vipContacts.size}\n` +
            `• Keys in window: ${this.lastReplies.size}\n` +
            `• Message: "${this.awayMessage}"`;
          break;

        case 'on':
          this.isAwayMode = true;
          response = '✅ Away mode ON — auto-replies active.';
          break;

        case 'off':
          this.isAwayMode = false;
          response = '✅ Away mode OFF — auto-replies paused.';
          break;

        case 'toggle':
          this.isAwayMode = !this.isAwayMode;
          response = `✅ Away mode ${this.isAwayMode ? 'ON' : 'OFF'}`;
          break;

        case 'msg':
          if (params) {
            this.awayMessage = params;
            response = `✏️ Message updated:\n"${this.awayMessage}"`;
          } else {
            response = '❌ Provide a message, e.g. /msg In a meeting.';
          }
          break;

        case 'vip': {
          const sub = parts[1]?.toLowerCase();
          const num = parts[2];
          if (sub === 'add' && num) {
            this.vipContacts.add(num);
            response = `✅ VIP added: ${num}`;
          } else if (sub === 'remove' && num) {
            this.vipContacts.delete(num);
            response = `✅ VIP removed: ${num}`;
          } else if (sub === 'list') {
            const list = Array.from(this.vipContacts);
            response = list.length
              ? `⭐ *VIPs (DM only):*\n\n${list.map(v => `• ${v}`).join('\n')}`
              : '⭐ No VIPs yet';
          } else {
            response =
              'Usage:\n• /vip add 33123456789\n• /vip remove 33123456789\n• /vip list';
          }
          break;
        }

        case 'clear':
          this.lastReplies.clear();
          response = '🧹 Timers cleared. Contacts & groups can receive replies again.';
          break;

        default:
          response = `❌ Unknown command: ${cmd}\n\nType /help.`;
      }

      await message.reply(response);
    } catch (e) {
      console.error('❌ Error processing command:', e);
      try { await message.reply('❌ Error processing command.'); } catch {}
    }
  }

  initializeWebServer() {
    const app = express();
    app.use(express.json());

    // Web UI
    app.get('/', (req, res) => res.send(this.generateDashboardHTML()));

    // APIs
    app.post('/api/set-away', (req, res) => {
      this.isAwayMode = !!(req.body && req.body.on);
      res.json({ awayMode: this.isAwayMode });
    });

    app.post('/api/update-message', (req, res) => {
      const msg = (req.body && req.body.message || '').trim();
      if (!msg) return res.status(400).json({ error: 'Invalid message' });
      this.awayMessage = msg;
      res.json({ success: true, message: this.awayMessage });
    });

    app.post('/api/add-vip', (req, res) => {
      const num = (req.body && req.body.phoneNumber || '').trim();
      if (!num) return res.status(400).json({ error: 'Invalid phone number' });
      this.vipContacts.add(num);
      res.json({ success: true, vips: Array.from(this.vipContacts) });
    });

    app.post('/api/remove-vip', (req, res) => {
      const num = (req.body && req.body.phoneNumber || '').trim();
      if (!num) return res.status(400).json({ error: 'Invalid phone number' });
      this.vipContacts.delete(num);
      res.json({ success: true, vips: Array.from(this.vipContacts) });
    });

    app.post('/api/clear-history', (_req, res) => {
      this.lastReplies.clear();
      res.json({ success: true });
    });

    app.get('/api/status', (_req, res) => {
      res.json({
        awayMode: this.isAwayMode,
        message: this.awayMessage,
        vipContacts: Array.from(this.vipContacts),
        isConnected: this.isConnected,
        qrCode: this.isConnected ? null : (this.qrString || null),
        replyHistoryCount: this.lastReplies.size,
      });
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`🌐 Dashboard running on http://localhost:${PORT}`);
    });
  }

  generateDashboardHTML() {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Lazy — WhatsApp Auto-Responder</title>
<style>
  :root{
    --bg:#f6f7fb; --card:#ffffff; --ink:#111827; --muted:#6b7280;
    --brand:#34c759; --brand-600:#2fb052; --border:#e5e7eb;
    --ring: rgba(52,199,89,.25); --shadow: 0 10px 30px rgba(0,0,0,.06);
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Inter,Arial,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:1120px;margin:0 auto;padding:28px}
  h1{font-size:22px;margin:0}
  .subtitle{color:var(--muted);margin-top:6px}
  .grid{display:grid;grid-template-columns:1fr;gap:16px;margin-top:16px}
  @media(min-width:1024px){.grid{grid-template-columns: 1.1fr 1fr 1fr}}
  .card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:16px;box-shadow:var(--shadow)}
  .card h3{margin:0 0 12px 0;font-size:16px}
  .muted{color:var(--muted);font-size:13px}

  /* Switch container */
.switch-wrap {
  width: 76px; /* matches toggle width */
}

/* Toggle body */
.switch {
  position: relative;
  width: 76px;
  height: 38px;
  background: #e9e9ec;
  border-radius: 999px;
  border: 1px solid #d1d5db;
  cursor: pointer;
  transition: 0.2s;
}
.switch::after {
  content: "";
  position: absolute;
  top: 3px;
  left: 3px;
  width: 32px;
  height: 32px;
  background: #fff;
  border-radius: 50%;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
  transition: 0.2s;
}
.switch.on {
  background: var(--brand);
}
.switch.on::after {
  left: 41px;
}

/* Toggle labels */
.switch-labels {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 76px; /* aligns with toggle */
  padding: 0 6px; /* pull in text from edges */
  margin-top: 8px;
  font-size: 12px;
  line-height: 1;
  color: var(--muted);
}

/* Label states */
.switch-labels .on {
  color: #9ca3af;
  font-weight: 600;
}
.switch.on + .switch-labels .on {
  color: var(--brand-600);
}
.switch.on + .switch-labels .off {
  color: #9ca3af;
}
.switch:not(.on) + .switch-labels .off {
  color: #111827;
  font-weight: 600;
}


  textarea,input{width:100%;background:#fafafa;border:1px solid var(--border);color:var(--ink);padding:10px;border-radius:12px;outline:none}
  textarea:focus,input:focus{border-color:var(--brand); box-shadow:0 0 0 4px var(--ring)}
  label{display:block;font-weight:600;margin:10px 0 6px}
  .btn{cursor:pointer;border:none;border-radius:12px;padding:10px 14px;color:white;background:var(--brand);font-weight:600}
  .btn:hover{background:var(--brand-600)}
  .btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--border)}
  .btn.danger{background:#ef4444}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

  .qr-wrap{display:grid;place-items:center;gap:12px;padding:16px;border-radius:12px;background:#fafafa;border:1px dashed var(--border)}
  .qr-code{max-width:240px;border-radius:10px;border:2px solid #eef2ee;box-shadow:0 0 0 6px #f0fbf3}

  .list{display:grid;gap:8px}
  .vip-item{display:flex;align-items:center;justify-content:space-between;background:#fafafa;border:1px solid var(--border);padding:8px 10px;border-radius:12px}
  .vip-item button{border:none;background:transparent;color:#ef4444;cursor:pointer;font-size:14px}

  .log{background:#ffffff;color:#1f2937;border-radius:12px;padding:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;max-height:280px;overflow:auto;border:1px solid var(--border)}
  .log div{padding:4px 0;border-bottom:1px dashed #e5e7eb}
  .log div:last-child{border-bottom:none}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Lazy — WhatsApp Auto-Responder</h1>
    <div class="subtitle">Simple, calm, and out of your way.</div>

    <div class="grid">
      <!-- 1) SETUP -->
      <div class="card">
        <h3>1) Setup</h3>
        <div class="muted" style="margin-bottom:10px;">
          Reply window: DMs → one per contact / 12h • Groups → one per group / 12h • VIPs suppress DMs only • Archived chats never get replies.
        </div>
        <div class="qr-wrap" style="margin-top:10px;">
          <div class="muted" id="qrStatus">Connecting to WhatsApp...</div>
          <div id="qrContainer" style="display:none;">
            <img id="qrCode" class="qr-code" alt="QR Code">
            <div class="muted">WhatsApp → Settings → Linked Devices → Link a Device → Scan</div>
          </div>
          <div id="connectedMessage" style="display:none;color:#166534;font-weight:600;">
            ✅ Connected to WhatsApp
          </div>
        </div>
      </div>

     <!-- 2) CONTROLS -->
<div class="card">
  <h3>2) Controls</h3>
  <label>Away Mode</label>
  <div class="switch-wrap">
    <div id="awaySwitch" class="switch" role="switch" aria-checked="false" tabindex="0"></div>
    <div class="switch-labels">
      <span class="off">OFF</span>
      <span class="on">ON</span>
    </div>
  </div>

  <label for="awayMessage">Away message</label>
  <textarea id="awayMessage" rows="3" placeholder="Hey! I'm a little off my phone right now. If it's urgent, please call me."></textarea>
  <div class="row" style="margin-top:10px;">
    <button class="btn" onclick="updateMessage()">Update Message</button>
  </div>

  <div style="margin-top:16px;">
    <label for="vipPhone">VIP contact (phone number)</label>
    <input id="vipPhone" placeholder="e.g., 33123456789" />
    <div class="row" style="margin-top:10px;">
      <button class="btn" onclick="addVIP()">Add VIP</button>
      <button class="btn ghost" onclick="loadStatus()">Refresh</button>
    </div>
    <div id="vipList" class="list" style="margin-top:10px;">
      <div class="muted"><em>No VIP contacts yet</em></div>
    </div>
  </div>
</div>


      <!-- 3) LOGS -->
      <div class="card">
        <h3>3) Logs</h3>
        <div id="activityLog" class="log"><div>[${new Date().toLocaleTimeString()}] 🔧 Dashboard loaded</div></div>
        <div class="row" style="margin-top:10px;">
          <button class="btn ghost" onclick="refresh()">Refresh</button>
          <button class="btn danger" onclick="clearHistory()">Reset 12h Timers</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    // Minimal, robust dashboard logic: poll /api/status and update DOM
    let state = { awayMode:false, message:"", vipContacts:[], isConnected:false, qrCode:null };

    function logLine(text){
      const log = document.getElementById('activityLog');
      if (!log) return;
      const row = document.createElement('div');
      row.textContent = '[' + new Date().toLocaleTimeString() + '] ' + text;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }

    function setSwitch(on){
      const sw = document.getElementById('awaySwitch');
      if (!sw) return;
      sw.classList.toggle('on', !!on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
    }

    async function refresh(){
      try {
        const res = await fetch('/api/status', { cache:'no-store' });
        state = await res.json();
        render();
      } catch (e) {
        console.error('status error', e);
        logLine('❌ Failed to load status');
      }
    }

    function render(){
      // Setup
      const qrContainer = document.getElementById('qrContainer');
      const qrStatus = document.getElementById('qrStatus');
      const connectedMessage = document.getElementById('connectedMessage');
      const qrImg = document.getElementById('qrCode');

      if (state.isConnected) {
        if (qrContainer) qrContainer.style.display = 'none';
        if (connectedMessage) connectedMessage.style.display = 'block';
        if (qrStatus) qrStatus.textContent = '✅ Connected';
      } else {
        if (connectedMessage) connectedMessage.style.display = 'none';
        if (qrStatus) qrStatus.textContent = state.qrCode ? '📱 Scan QR Code with WhatsApp' : 'Generating QR Code...';
        if (qrContainer) qrContainer.style.display = state.qrCode ? 'block' : 'none';
        if (qrImg && state.qrCode) qrImg.src = state.qrCode;
      }

      // Controls
      setSwitch(state.awayMode);
      const msg = document.getElementById('awayMessage');
      if (msg) msg.value = state.message;

      const vipList = document.getElementById('vipList');
      if (vipList) {
        if (state.vipContacts && state.vipContacts.length) {
          vipList.innerHTML = state.vipContacts.map(v =>
            '<div class="vip-item">' +
              '<div>📞 ' + v + '</div>' +
              '<button title="Remove" onclick="removeVIP(\\'' + v + '\\')">🗑️</button>' +
            '</div>'
          ).join('');
        } else {
          vipList.innerHTML = '<div class="muted"><em>No VIP contacts yet</em></div>';
        }
      }
    }

    async function setAway(on){
      try {
        const r = await fetch('/api/set-away', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({on})});
        const j = await r.json();
        state.awayMode = j.awayMode;
        render();
        logLine('🔄 Away mode → ' + (state.awayMode ? 'ON' : 'OFF'));
      } catch(e){ console.error(e); }
    }
    function toggleSwitch(){
      const isOn = document.getElementById('awaySwitch')?.classList.contains('on');
      setAway(!isOn);
    }

    async function updateMessage(){
      const message = document.getElementById('awayMessage').value;
      try{
        const r = await fetch('/api/update-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message})});
        const j = await r.json();
        if (j.success) { state.message = j.message; logLine('✅ Away message updated'); }
      } catch(e){ console.error(e); }
    }

    async function addVIP(){
      const phone = document.getElementById('vipPhone').value.trim();
      if (!phone) return;
      try{
        const r = await fetch('/api/add-vip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});
        const j = await r.json();
        if (j.success){ state.vipContacts = j.vips; document.getElementById('vipPhone').value=''; render(); logLine('⭐ VIP added: ' + phone); }
      } catch(e){ console.error(e); }
    }

    async function removeVIP(phone){
      try{
        const r = await fetch('/api/remove-vip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});
        const j = await r.json();
        if (j.success){ state.vipContacts = j.vips; render(); logLine('🗑️ VIP removed: ' + phone); }
      } catch(e){ console.error(e); }
    }

    async function clearHistory(){
      try{ 
        const r = await fetch('/api/clear-history',{method:'POST'});
        const j = await r.json();
        if (j.success) logLine('🧹 Timers reset');
      } catch(e){ console.error(e); }
    }

    // Wire events
    document.addEventListener('click', (e)=>{ if(e.target.id==='awaySwitch') toggleSwitch(); });
    document.addEventListener('keydown', (e)=>{
      if(e.target.id==='awaySwitch' && (e.key==='Enter' || e.key===' ')){ e.preventDefault(); toggleSwitch(); }
    });

    // Expose functions
    window.refresh = refresh;
    window.updateMessage = updateMessage;
    window.addVIP = addVIP;
    window.removeVIP = removeVIP;
    window.clearHistory = clearHistory;

    // Start polling
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>
    `;
  }
}

// ==== Boot ====
console.log('🚀 Starting Lazy Auto-Responder...');
const appInstance = new WhatsAppAutoResponder();

// ==== Graceful shutdown ====
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  if (appInstance.client) appInstance.client.destroy();
  process.exit(0);
});
