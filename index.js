// index.js
// Lazy — WhatsApp Auto-Responder (sleek, Apple-ish)

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

class WhatsAppAutoResponder {
  constructor() {
    this.client = null;
    this.isAwayMode = false;
    this.awayMessage =
      "Hey! I'm a little off my phone right now. If it's urgent, please call me.";
    this.vipContacts = new Set(); // normalized digits only
    this.lastReplies = new Map();
    this.replyDelay = 12 * 60 * 60 * 1000; // 12 hours
    this.io = null;
    this.qrString = null;
    this.isConnected = false;

    this.initializeWebServer();
    this.initializeWhatsApp();
  }

  // ===== Helpers =====
  normalizeNumber(n) {
    if (!n) return null;
    const digits = String(n).replace(/\D+/g, '');
    return digits.length ? digits : null;
  }

  // ===== WhatsApp =====
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

    this.client.on('qr', async (qr) => {
      console.log('📱 QR Code received');
      qrcode.generate(qr, { small: true });
      try {
        this.qrString = await QRCode.toDataURL(qr);
        this.broadcastQRCode(this.qrString);
        this.broadcastConnectionStatus(false);
        this.broadcastLog('📱 Scan the QR code to link your device');
      } catch (e) {
        console.error('❌ Error generating QR for web:', e);
      }
    });

    this.client.on('ready', () => {
      console.log('✅ Lazy Auto-Responder is ready!');
      console.log('🤖 Send "/help" to yourself for commands');
      this.isConnected = true;
      this.qrString = null;
      this.broadcastConnectionStatus(true);
      this.broadcastLog('✅ WhatsApp connected');
    });

    this.client.on('auth_failure', (msg) => {
      console.error('❌ Authentication failed:', msg);
      this.isConnected = false;
      this.broadcastConnectionStatus(false);
      this.broadcastLog('❌ Authentication failed — refresh to get a new QR');
    });

    this.client.on('disconnected', (reason) => {
      console.log('📵 WhatsApp disconnected:', reason);
      this.isConnected = false;
      this.qrString = null;
      this.broadcastConnectionStatus(false);
      this.broadcastLog('📵 Disconnected — refresh page to reconnect');
    });

    this.client.on('message_create', async (message) => {
      await this.handleIncomingMessage(message);
    });

    this.client.initialize();
  }

  // ===== Broadcasting to dashboard =====
  broadcastQRCode(qrDataURL) {
    if (this.io) this.io.emit('qr-code', qrDataURL);
  }
  broadcastConnectionStatus(connected) {
    if (this.io) {
      this.io.emit('connection-status', {
        connected,
        qrCode: connected ? null : this.qrString,
      });
    }
  }
  broadcastLog(message) {
    if (this.io) this.io.emit('log', message);
  }

  // ===== Messaging logic =====
  async handleIncomingMessage(message) {
    try {
      if (message.fromMe && message.body.startsWith('/')) {
        await this.handleBotCommand(message);
        return;
      }

      if (!this.isAwayMode) return;
      if (message.fromMe) return;

      const chat = await message.getChat();
      const isGroup = chat.isGroup === true;

      if (chat.archived) {
        console.log(`📁 Skipping archived chat: ${chat.name || chat.id?._serialized}`);
        return;
      }

      const contact = await message.getContact();
      const contactNumber = contact.id?.user || null; // WA JID user part (digits)
      const contactName = contact.name || contact.pushname || contactNumber || 'unknown-contact';

      if (!isGroup) {
        const normalized = this.normalizeNumber(contactNumber);
        if (normalized && this.vipContacts.has(normalized)) {
          console.log(`🔕 Skipping VIP contact: ${contactName} (${normalized})`);
          return;
        }
      }

      const groupId = chat.id?._serialized;
      const replyKey = isGroup ? groupId : (contactNumber || 'unknown-contact');

      const lastReplyTime = this.lastReplies.get(replyKey);
      const now = Date.now();
      if (lastReplyTime && now - lastReplyTime < this.replyDelay) {
        console.log(
          `⏰ Rate limit: Already replied to ${isGroup ? 'group' : 'contact'} ${contactName} recently`
        );
        return;
      }

      await this.sendAutoReply(message, isGroup ? (chat.name || groupId) : contactName);
      this.lastReplies.set(replyKey, now);
    } catch (error) {
      console.error('❌ Error handling message:', error);
    }
  }

  async sendAutoReply(originalMessage, displayName) {
    try {
      console.log(`📤 Auto-reply → ${displayName}`);
      this.broadcastLog(`📤 Auto-reply → ${displayName}`);
      await originalMessage.reply(this.awayMessage);
      this.broadcastLog(`✅ Sent to ${displayName}`);
    } catch (error) {
      console.error(`❌ Failed to send auto-reply to ${displayName}:`, error);
      this.broadcastLog(`❌ Failed to send to ${displayName}`);
    }
  }

  async handleBotCommand(message) {
    try {
      const command = message.body.trim();
      console.log(`🤖 Processing command: ${command}`);

      const parts = command.slice(1).split(' ');
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
            '• /clear — Clear reply history (resets 12h timers)';
          break;

        case 'status':
          response =
            '📊 *Status*\n\n' +
            `• Away Mode: ${this.isAwayMode ? '🟢 ON' : '🔴 OFF'}\n` +
            `• VIPs: ${this.vipContacts.size}\n` +
            `• Reply Keys: ${this.lastReplies.size} (contacts + groups)\n` +
            '• Window: 12h per contact (DM), 12h per group\n' +
            `• Message: "${this.awayMessage}"`;
          break;

        case 'on':
          this.isAwayMode = true;
          response = '✅ Away mode ON — auto-replies active.';
          this.broadcastLog('🟢 Away mode ON');
          break;

        case 'off':
          this.isAwayMode = false;
          response = '✅ Away mode OFF — auto-replies paused.';
          this.broadcastLog('🔴 Away mode OFF');
          break;

        case 'toggle':
          this.isAwayMode = !this.isAwayMode;
          response = `✅ Away mode ${this.isAwayMode ? 'ON' : 'OFF'}`;
          this.broadcastLog(`🔄 Away mode → ${this.isAwayMode ? 'ON' : 'OFF'}`);
          break;

        case 'msg':
          if (params) {
            this.awayMessage = params;
            response = `✏️ Message updated:\n"${this.awayMessage}"`;
            this.broadcastLog('✏️ Away message updated');
          } else {
            response = '❌ Please provide a message. Example: /msg In a meeting, back soon.';
          }
          break;

        case 'vip': {
          const subCmd = parts[1]?.toLowerCase();
          const normalized = this.normalizeNumber(parts[2]);

          if (subCmd === 'add' && normalized) {
            this.vipContacts.add(normalized);
            response = `✅ VIP added: ${normalized}`;
            this.broadcastLog(`⭐ VIP added: ${normalized}`);
          } else if (subCmd === 'remove' && normalized) {
            this.vipContacts.delete(normalized);
            response = `✅ VIP removed: ${normalized}`;
            this.broadcastLog(`🗑️ VIP removed: ${normalized}`);
          } else if (subCmd === 'list') {
            const vips = Array.from(this.vipContacts);
            response = vips.length
              ? `⭐ *VIPs (DM only):*\n\n${vips.map((v) => `• ${v}`).join('\n')}`
              : '⭐ No VIPs yet';
          } else {
            response =
              '❌ Invalid VIP command.\n' +
              'Usage:\n• /vip add 33123456789\n• /vip remove 33123456789\n• /vip list';
          }
          break;
        }

        case 'clear':
          this.lastReplies.clear();
          response = '🧹 Timers cleared — contacts & groups can receive replies again.';
          this.broadcastLog('🧹 Reply history cleared');
          break;

        default:
          response = `❌ Unknown command: ${cmd}\n\nType /help to see available commands.`;
      }

      await message.reply(response);
      console.log(`✅ Bot command processed: ${cmd}`);
    } catch (error) {
      console.error('❌ Error processing bot command:', error);
      await message.reply('❌ Error processing command. Please try again.');
    }
  }

  // ===== Web server =====
  initializeWebServer() {
    const app = express();
    const server = http.createServer(app);
    this.io = new Server(server);

    app.use(express.json());
    app.use(express.static('public'));

    this.io.on('connection', (socket) => {
      console.log('🌐 Dashboard connected');
      socket.emit('connection-status', {
        connected: this.isConnected,
        qrCode: this.isConnected ? null : this.qrString,
      });
      if (this.qrString) socket.emit('qr-code', this.qrString);
      socket.emit('log', '🌐 Dashboard connected');
    });

    app.get('/', (req, res) => res.send(this.generateDashboardHTML()));

    // APIs
    app.post('/api/set-away', (req, res) => {
      this.isAwayMode = !!(req.body && req.body.on);
      this.broadcastLog(`🔄 Away set → ${this.isAwayMode ? 'ON' : 'OFF'}`);
      res.json({ awayMode: this.isAwayMode });
    });

    app.post('/api/update-message', (req, res) => {
      const { message } = req.body || {};
      if (message && String(message).trim()) {
        this.awayMessage = String(message).trim();
        this.broadcastLog('✏️ Away message updated');
        return res.json({ success: true, message: this.awayMessage });
      }
      res.status(400).json({ error: 'Invalid message' });
    });

    app.post('/api/add-vip', (req, res) => {
      const normalized = this.normalizeNumber(req.body?.phoneNumber);
      if (normalized) {
        this.vipContacts.add(normalized);
        this.broadcastLog(`⭐ VIP added: ${normalized}`);
        return res.json({ success: true, vips: Array.from(this.vipContacts) });
      }
      res.status(400).json({ error: 'Invalid phone number' });
    });

    app.post('/api/remove-vip', (req, res) => {
      const normalized = this.normalizeNumber(req.body?.phoneNumber);
      if (normalized) {
        this.vipContacts.delete(normalized);
        this.broadcastLog(`🗑️ VIP removed: ${normalized}`);
        return res.json({ success: true, vips: Array.from(this.vipContacts) });
      }
      res.status(400).json({ error: 'Invalid phone number' });
    });

    app.post('/api/clear-history', (req, res) => {
      this.lastReplies.clear();
      this.broadcastLog('🧹 Reply history cleared');
      res.json({ success: true });
    });

    app.get('/api/status', (req, res) => {
      res.json({
        awayMode: this.isAwayMode,
        message: this.awayMessage,
        vipContacts: Array.from(this.vipContacts),
        isConnected: this.isConnected,
        qrCode: this.isConnected ? null : this.qrString,
        replyHistoryCount: this.lastReplies.size,
      });
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`🌐 Dashboard running on http://localhost:${PORT}`);
    });
  }

  // ===== Dashboard =====
  generateDashboardHTML() {
    const bootstrap = JSON.stringify({
      awayMode: this.isAwayMode,
      message: this.awayMessage,
      vipContacts: Array.from(this.vipContacts),
      isConnected: this.isConnected,
      qrCode: this.qrString || null,
    });

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
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

.switch{position:relative;width:88px;height:40px;background:#e9e9ec;border-radius:999px;border:1px solid #d1d5db;cursor:pointer;transition:.2s}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:34px;height:34px;background:#fff;border-radius:50%;box-shadow:0 2px 6px rgba(0,0,0,.15);transition:.2s}
.switch.on{background:var(--brand)}
.switch.on::after{left:51px}
.switch-labels{display:flex;gap:12px;align-items:center;margin-top:10px;font-size:12px;color:var(--muted)}
.switch-labels span.on{color:var(--brand-600);font-weight:600}

label{display:block;font-weight:600;margin:10px 0 6px}
textarea,input{width:100%;background:#fafafa;border:1px solid var(--border);color:var(--ink);padding:10px;border-radius:12px;outline:none}
textarea:focus,input:focus{border-color:var(--brand); box-shadow:0 0 0 4px var(--ring)}
.btn{cursor:pointer;border:none;border-radius:12px;padding:10px 14px;color:white;background:var(--brand);font-weight:600}
.btn:hover{background:var(--brand-600)}
.btn.ghost{background:transparent;color:var(--ink);border:1px solid var(--border)}
.btn.danger{background:#ef4444}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}

.qr-wrap{display:grid;place-items:center;gap:12px;padding:16px;border-radius:12px;background:#fafafa;border:1px dashed var(--border)}
.qr-code{max-width:260px;border-radius:10px;border:2px solid #eef2ee;box-shadow:0 0 0 6px #f0fbf3}

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
        <div id="connectedMessage" style="display:none;color:#166534;font-weight:600;">✅ Connected to WhatsApp</div>
      </div>
    </div>

    <!-- 2) CONTROLS -->
    <div class="card">
      <h3>2) Controls</h3>
      <label>Away Mode</label>
      <div id="awaySwitch" class="switch" role="switch" aria-checked="false" tabindex="0"></div>
      <div class="switch-labels"><span>OFF</span><span class="on">ON</span></div>

      <label for="awayMessage">Away message</label>
      <textarea id="awayMessage" rows="3" placeholder="Hey! I'm a little off my phone right now. If it's urgent, please call me."></textarea>
      <div class="row" style="margin-top:10px;">
        <button class="btn" onclick="updateMessage()">Update Message</button>
      </div>

      <div style="margin-top:16px;">
        <label for="vipPhone">VIP contact (phone number)</label>
        <input id="vipPhone" placeholder="e.g., +33123456789" />
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
      <div id="activityLog" class="log"><div>🔧 Dashboard loaded</div></div>
      <div class="row" style="margin-top:10px;">
        <button class="btn ghost" onclick="loadStatus()">Refresh</button>
        <button class="btn danger" onclick="clearHistory()">Reset 12h Timers</button>
      </div>
    </div>
  </div>
</div>

<!-- Server-hydrated state -->
<script id="lazy-bootstrap" type="application/json">${bootstrap}</script>

<script src="/socket.io/socket.io.js"></script>
<script>
try {
  let currentStatus = {awayMode:false,message:"",vipContacts:[],isConnected:false,qrCode:null};
  (function(){ const el=document.getElementById('lazy-bootstrap'); if(el&&el.textContent){ try{ currentStatus=JSON.parse(el.textContent);}catch{}}})();

  const socket = io();

  function setSwitch(on){
    const sw=document.getElementById('awaySwitch');
    if(on){ sw.classList.add('on'); sw.setAttribute('aria-checked','true'); }
    else { sw.classList.remove('on'); sw.setAttribute('aria-checked','false'); }
  }
  function toggleSwitch(){
    const isOn=document.getElementById('awaySwitch').classList.contains('on');
    fetch('/api/set-away',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:!isOn})})
      .then(r=>r.json()).then(d=>{ currentStatus.awayMode=d.awayMode; setSwitch(d.awayMode); addLog('🔄 Away mode → '+(d.awayMode?'ON':'OFF')); })
      .catch(()=>addLog('❌ Failed to set away mode'));
  }
  document.addEventListener('click',(e)=>{ if(e.target.id==='awaySwitch') toggleSwitch(); });
  document.addEventListener('keydown',(e)=>{ if(e.target.id==='awaySwitch' && (e.key==='Enter'||e.key===' ')){ e.preventDefault(); toggleSwitch(); }});

  socket.on('connect',()=>addLog('🌐 Connected to dashboard'));
  socket.on('log',(m)=>addLog(m));
  socket.on('qr-code',(qr)=>{ currentStatus.isConnected=false; currentStatus.qrCode=qr; updateUI(); });
  socket.on('connection-status',(s)=>{ currentStatus.isConnected=!!s.connected; currentStatus.qrCode=s.qrCode||null; updateUI(); });

  async function loadStatus(){
    try{
      const res=await fetch('/api/status',{cache:'no-store'});
      currentStatus=await res.json();
      updateUI();
    }catch{ addLog('❌ Failed to load status'); }
  }

  function updateUI(){
    const qrContainer=document.getElementById('qrContainer');
    const qrStatus=document.getElementById('qrStatus');
    const connectedMessage=document.getElementById('connectedMessage');

    if(currentStatus.isConnected){
      if(qrContainer) qrContainer.style.display='none';
      if(connectedMessage) connectedMessage.style.display='block';
      if(qrStatus) qrStatus.textContent='✅ Connected';
    }else{
      if(connectedMessage) connectedMessage.style.display='none';
      if(qrStatus) qrStatus.textContent=currentStatus.qrCode?'📱 Scan QR Code with WhatsApp':'Generating QR Code...';
      if(qrContainer) qrContainer.style.display=currentStatus.qrCode?'block':'none';
      if(currentStatus.qrCode){ const img=document.getElementById('qrCode'); if(img) img.src=currentStatus.qrCode; }
    }

    setSwitch(currentStatus.awayMode);
    const awayMessage=document.getElementById('awayMessage'); if(awayMessage) awayMessage.value=currentStatus.message;

    const vipList=document.getElementById('vipList');
    if(vipList){
      if(currentStatus.vipContacts && currentStatus.vipContacts.length){
        vipList.innerHTML=currentStatus.vipContacts.map(function(v){
          return '<div class="vip-item"><div>📞 '+v+'</div><button title="Remove" onclick="removeVIP(\\''+v+'\\')">🗑️</button></div>';
        }).join('');
      }else{
        vipList.innerHTML='<div class="muted"><em>No VIP contacts yet</em></div>';
      }
    }
  }

  async function updateMessage(){
    const message=document.getElementById('awayMessage').value;
    try{
      const res=await fetch('/api/update-message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message})});
      const data=await res.json(); if(data.success){ currentStatus.message=data.message; addLog('✅ Away message updated'); }
    }catch{ addLog('❌ Failed to update message'); }
  }

  async function addVIP(){
    const phone=document.getElementById('vipPhone').value.trim();
    if(!phone) return;
    try{
      const res=await fetch('/api/add-vip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});
      const data=await res.json();
      if(data.success){ currentStatus.vipContacts=data.vips; document.getElementById('vipPhone').value=''; updateUI(); addLog('⭐ VIP added: '+phone); }
      else addLog('❌ '+(data.error||'Failed to add VIP'));
    }catch{ addLog('❌ Failed to add VIP'); }
  }

  async function removeVIP(phone){
    try{
      const res=await fetch('/api/remove-vip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone})});
      const data=await res.json();
      if(data.success){ currentStatus.vipContacts=data.vips; updateUI(); addLog('🗑️ VIP removed: '+phone); }
      else addLog('❌ '+(data.error||'Failed to remove VIP'));
    }catch{ addLog('❌ Failed to remove VIP'); }
  }

  async function clearHistory(){
    try{
      const res=await fetch('/api/clear-history',{method:'POST'});
      const data=await res.json(); if(data.success) addLog('🧹 Timers reset — contacts & groups can receive replies again');
    }catch{ addLog('❌ Failed to reset timers'); }
  }

  function addLog(message){
    const log=document.getElementById('activityLog');
    const row=document.createElement('div');
    const t=new Date().toLocaleTimeString();
    row.textContent='['+t+'] '+message;
    if(log){ log.appendChild(row); log.scrollTop=log.scrollHeight; }
  }

  function initLazy(){ updateUI(); loadStatus(); setInterval(loadStatus,5000); }
  if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', initLazy, {once:true}); } else { initLazy(); }

  window.updateMessage=updateMessage;
  window.addVIP=addVIP;
  window.removeVIP=removeVIP;
  window.clearHistory=clearHistory;

} catch(e){ console.error('Lazy dashboard script error', e); }
</script>
</body></html>`;
  }
}

// ==== Boot sequence ====
console.log('🚀 Starting Lazy Auto-Responder...');
const appInstance = new WhatsAppAutoResponder();

// ==== Graceful shutdown ====
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  if (appInstance.client) appInstance.client.destroy();
  process.exit(0);
});
