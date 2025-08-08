// WhatsApp Auto-Responder with Web QR Code Display
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode'); // For web QR generation
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

class WhatsAppAutoResponder {
    constructor() {
        this.client = null;
        this.isAwayMode = false;
        this.awayMessage = "I'm away from my smartphone. If urgent, call me on +33 XX XX XX XX";
        this.vipContacts = new Set();
        this.lastReplies = new Map();
        this.replyDelay = 30000;
        this.io = null;
        this.qrString = null; // Store QR code for web display
        this.isConnected = false;
        
        this.initializeWebServer();
        this.initializeWhatsApp();
    }

    initializeWhatsApp() {
        console.log('🔧 Initializing WhatsApp client...');
        
        this.client = new Client({
            authStrategy: new LocalAuth({
                name: 'auto-responder'
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
                    '--disable-gpu'
                ]
            }
        });

        // Event: QR Code received
        this.client.on('qr', async (qr) => {
            console.log('📱 QR Code received');
            
            // Show QR in terminal (existing functionality)
            qrcode.generate(qr, { small: true });
            console.log('👆 Or go to http://localhost:3000 to see QR code in browser');
            
            // Generate QR code data URL for web dashboard
            try {
                this.qrString = await QRCode.toDataURL(qr);
                console.log('✅ QR Code generated for web dashboard');
                
                // Send QR code to all connected web clients
                this.broadcastQRCode(this.qrString);
                this.broadcastLog('📱 Scan the QR code above with your WhatsApp');
            } catch (error) {
                console.error('❌ Error generating QR code for web:', error);
            }
        });

        // Event: Client ready
        this.client.on('ready', () => {
            console.log('✅ WhatsApp Auto-Responder is ready!');
            console.log('🌐 Dashboard available at: http://localhost:3000');
            this.isConnected = true;
            this.qrString = null; // Clear QR code when connected
            this.broadcastConnectionStatus(true);
            this.broadcastLog('✅ WhatsApp connected successfully!');
        });

        // Event: Authentication failure
        this.client.on('auth_failure', (msg) => {
            console.error('❌ Authentication failed:', msg);
            this.isConnected = false;
            this.broadcastConnectionStatus(false);
            this.broadcastLog('❌ Authentication failed - refresh page to get new QR code');
        });

        // Event: Disconnected
        this.client.on('disconnected', (reason) => {
            console.log('📵 WhatsApp disconnected:', reason);
            this.isConnected = false;
            this.qrString = null;
            this.broadcastConnectionStatus(false);
            this.broadcastLog('📵 WhatsApp disconnected - refresh page to reconnect');
        });

        // Event: New message received
        this.client.on('message_create', async (message) => {
            await this.handleIncomingMessage(message);
        });

        this.client.initialize();
    }

    // Broadcast QR code to web clients
    broadcastQRCode(qrDataURL) {
        if (this.io) {
            this.io.emit('qr-code', qrDataURL);
        }
    }

    // Broadcast connection status
    broadcastConnectionStatus(connected) {
        if (this.io) {
            this.io.emit('connection-status', { 
                connected, 
                qrCode: connected ? null : this.qrString 
            });
        }
    }

    async handleIncomingMessage(message) {
        try {
            if (!this.isAwayMode) return;
            if (message.fromMe) return;
            if (message.from.includes('@g.us')) return;

            const contact = await message.getContact();
            const contactId = contact.id.user;
            const contactName = contact.name || contact.pushname || contactId;

            if (this.vipContacts.has(contactId)) {
                console.log(`🔕 Skipping VIP contact: ${contactName}`);
                return;
            }

            const lastReplyTime = this.lastReplies.get(contactId);
            const now = Date.now();
            
            if (lastReplyTime && (now - lastReplyTime) < this.replyDelay) {
                console.log(`⏰ Rate limit: Already replied to ${contactName} recently`);
                return;
            }

            await this.sendAutoReply(message, contactName);
            this.lastReplies.set(contactId, now);

        } catch (error) {
            console.error('❌ Error handling message:', error);
        }
    }

    async sendAutoReply(originalMessage, contactName) {
        try {
            console.log(`📤 Sending auto-reply to: ${contactName}`);
            this.broadcastLog(`📤 Sending auto-reply to: ${contactName}`);
            
            await originalMessage.reply(this.awayMessage);
            
            console.log(`✅ Auto-reply sent to ${contactName}`);
            this.broadcastLog(`✅ Auto-reply sent to ${contactName}`);
            
        } catch (error) {
            console.error(`❌ Failed to send auto-reply to ${contactName}:`, error);
            this.broadcastLog(`❌ Failed to send auto-reply to ${contactName}`);
        }
    }

    initializeWebServer() {
        const app = express();
        const server = http.createServer(app);
        this.io = new Server(server);
        
        app.use(express.json());
        app.use(express.static('public'));
        
        // Socket.io connection handling
        this.io.on('connection', (socket) => {
            console.log('🌐 Dashboard connected');
            
            // Send current status to newly connected client
            socket.emit('connection-status', { 
                connected: this.isConnected, 
                qrCode: this.isConnected ? null : this.qrString 
            });
            
            if (this.qrString) {
                socket.emit('qr-code', this.qrString);
            }
            
            socket.emit('log', '🌐 Dashboard connected');
        });
        
        // Dashboard route
        app.get('/', (req, res) => {
            const dashboardHTML = this.generateDashboardHTML();
            res.send(dashboardHTML);
        });

        // API routes
        app.post('/api/toggle-away', (req, res) => {
            this.isAwayMode = !this.isAwayMode;
            console.log(`🔄 Away mode: ${this.isAwayMode ? 'ON' : 'OFF'}`);
            this.broadcastLog(`🔄 Away mode: ${this.isAwayMode ? 'ON' : 'OFF'}`);
            res.json({ awayMode: this.isAwayMode });
        });

        // =======================================================
        // NEW CODE ADDED HERE FOR THE IOS SHORTCUT
        // =======================================================
        app.get('/api/toggle-away-shortcut', (req, res) => {
            this.isAwayMode = !this.isAwayMode;
            console.log(`🔄 Away mode triggered by shortcut: ${this.isAwayMode ? 'ON' : 'OFF'}`);
            this.broadcastLog(`🔄 Away mode triggered by shortcut: ${this.isAwayMode ? 'ON' : 'OFF'}`);
            res.send(`Auto-reply mode has been set to ${this.isAwayMode}`);
        });
        // =======================================================

        app.post('/api/update-message', (req, res) => {
            const { message } = req.body;
            if (message && message.trim()) {
                this.awayMessage = message.trim();
                console.log(`✏️ Away message updated: ${this.awayMessage}`);
                this.broadcastLog(`✏️ Away message updated`);
                res.json({ success: true, message: this.awayMessage });
            } else {
                res.status(400).json({ error: 'Invalid message' });
            }
        });

        app.post('/api/add-vip', (req, res) => {
            const { phoneNumber } = req.body;
            if (phoneNumber) {
                this.vipContacts.add(phoneNumber);
                console.log(`⭐ Added VIP contact: ${phoneNumber}`);
                this.broadcastLog(`⭐ Added VIP contact: ${phoneNumber}`);
                res.json({ success: true, vips: Array.from(this.vipContacts) });
            } else {
                res.status(400).json({ error: 'Invalid phone number' });
            }
        });

        app.get('/api/status', (req, res) => {
            res.json({
                awayMode: this.isAwayMode,
                message: this.awayMessage,
                vipContacts: Array.from(this.vipContacts),
                isConnected: this.isConnected,
                qrCode: this.isConnected ? null : this.qrString
            });
        });

        const PORT = process.env.PORT || 3000;
        server.listen(PORT, () => {
            console.log(`🌐 Dashboard server running on http://localhost:${PORT}`);
        });
    }

    broadcastLog(message) {
        if (this.io) {
            this.io.emit('log', message);
        }
    }

    generateDashboardHTML() {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsApp Auto-Responder Dashboard</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f0f2f5; padding: 20px; }
        .container { max-width: 800px; margin: 0 auto; }
        .card { background: white; border-radius: 8px; padding: 24px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
        .header { text-align: center; color: #25d366; margin-bottom: 30px; }
        
        /* QR Code Section */
        .qr-section { text-align: center; padding: 20px; background: #f8f9fa; border-radius: 8px; margin-bottom: 20px; }
        .qr-code { max-width: 256px; margin: 0 auto; border: 2px solid #25d366; border-radius: 8px; }
        .qr-status { font-size: 18px; margin-bottom: 16px; }
        .qr-status.connected { color: #25d366; }
        .qr-status.disconnected { color: #666; }
        .qr-instructions { color: #666; margin-top: 12px; font-size: 14px; }
        
        .status { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
        .status-indicator { width: 12px; height: 12px; border-radius: 50%; margin-right: 8px; }
        .status-indicator.on { background: #25d366; }
        .status-indicator.off { background: #ccc; }
        .toggle-btn { background: #25d366; color: white; border: none; padding: 12px 24px; border-radius: 6px; cursor: pointer; font-size: 16px; }
        .toggle-btn:hover { background: #1ea952; }
        .toggle-btn.off { background: #ccc; }
        textarea { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; resize: vertical; }
        input { width: 100%; padding: 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
        .btn { background: #128c7e; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
        .btn:hover { background: #0d7377; }
        .form-group { margin-bottom: 16px; }
        label { display: block; margin-bottom: 6px; font-weight: 500; color: #333; }
        .vip-list { background: #f8f9fa; padding: 12px; border-radius: 6px; min-height: 60px; }
        .vip-item { background: white; padding: 8px 12px; margin: 4px 0; border-radius: 4px; border-left: 3px solid #25d366; }
        .logs { background: #2d3748; color: #e2e8f0; padding: 16px; border-radius: 6px; font-family: monospace; font-size: 12px; max-height: 200px; overflow-y: auto; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📱 WhatsApp Auto-Responder</h1>
            <p>Manage your away messages and digital boundaries</p>
        </div>

        <div class="card">
            <div class="qr-section">
                <div class="qr-status" id="qrStatus">Connecting to WhatsApp...</div>
                <div id="qrContainer" style="display: none;">
                    <img id="qrCode" class="qr-code" alt="QR Code">
                    <div class="qr-instructions">
                        1. Open WhatsApp on your phone<br>
                        2. Go to Settings → Linked Devices<br>
                        3. Tap "Link a Device"<br>
                        4. Scan this QR code
                    </div>
                </div>
                <div id="connectedMessage" style="display: none; color: #25d366; font-size: 18px;">
                    ✅ WhatsApp Connected Successfully!
                </div>
            </div>
        </div>

        <div class="card">
            <div class="status">
                <div style="display: flex; align-items: center;">
                    <div class="status-indicator" id="statusIndicator"></div>
                    <span id="statusText">Loading...</span>
                </div>
                <button class="toggle-btn" id="toggleBtn" onclick="toggleAwayMode()">
                    Toggle Away Mode
                </button>
            </div>
        </div>

        <div class="card">
            <h3>📝 Away Message</h3>
            <div class="form-group">
                <label for="awayMessage">Message sent to contacts when away:</label>
                <textarea id="awayMessage" rows="3" placeholder="I'm away from my smartphone. If urgent, call me on +33 XX XX XX XX"></textarea>
            </div>
            <button class="btn" onclick="updateMessage()">Update Message</button>
        </div>

        <div class="card">
            <h3>⭐ VIP Contacts</h3>
            <p style="margin-bottom: 16px; color: #666;">VIP contacts won't receive auto-replies</p>
            <div class="form-group">
                <label for="vipPhone">Add VIP Contact (phone number):</label>
                <input type="text" id="vipPhone" placeholder="e.g., 33123456789">
            </div>
            <button class="btn" onclick="addVIP()">Add VIP</button>
            <div class="vip-list" id="vipList">
                <em>No VIP contacts added yet</em>
            </div>
        </div>

        <div class="card">
            <h3>📊 Activity Log</h3>
            <div class="logs" id="activityLog">
                <div>🔧 Dashboard loaded</div>
            </div>
        </div>
    </div>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        let currentStatus = { awayMode: false, message: '', vipContacts: [], isConnected: false };
        const socket = io();

        // Socket.io event listeners
        socket.on('connect', () => {
            console.log('Connected to server');
            addLog('🌐 Connected to dashboard');
        });

        socket.on('log', (message) => {
            addLog(message);
        });

        // QR Code handling
        socket.on('qr-code', (qrDataURL) => {
            console.log('Received QR code');
            const qrContainer = document.getElementById('qrContainer');
            const qrCode = document.getElementById('qrCode');
            const qrStatus = document.getElementById('qrStatus');
            const connectedMessage = document.getElementById('connectedMessage');
            
            qrCode.src = qrDataURL;
            qrContainer.style.display = 'block';
            connectedMessage.style.display = 'none';
            qrStatus.textContent = '📱 Scan QR Code with WhatsApp';
            qrStatus.className = 'qr-status disconnected';
        });

        // Connection status handling
        socket.on('connection-status', (status) => {
            console.log('Connection status:', status);
            const qrContainer = document.getElementById('qrContainer');
            const qrStatus = document.getElementById('qrStatus');
            const connectedMessage = document.getElementById('connectedMessage');
            
            if (status.connected) {
                qrContainer.style.display = 'none';
                connectedMessage.style.display = 'block';
                qrStatus.textContent = '✅ WhatsApp Connected';
                qrStatus.className = 'qr-status connected';
            } else {
                connectedMessage.style.display = 'none';
                if (status.qrCode) {
                    const qrCode = document.getElementById('qrCode');
                    qrCode.src = status.qrCode;
                    qrContainer.style.display = 'block';
                    qrStatus.textContent = '📱 Scan QR Code with WhatsApp';
                } else {
                    qrStatus.textContent = 'Generating QR Code...';
                }
                qrStatus.className = 'qr-status disconnected';
            }
        });

        // Load initial status
        async function loadStatus() {
            try {
                const response = await fetch('/api/status');
                currentStatus = await response.json();
                updateUI();
            } catch (error) {
                console.error('Failed to load status:', error);
            }
        }

        function updateUI() {
            const indicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            const toggleBtn = document.getElementById('toggleBtn');
            const awayMessage = document.getElementById('awayMessage');
            const vipList = document.getElementById('vipList');

            // Update status
            if (currentStatus.awayMode) {
                indicator.className = 'status-indicator on';
                statusText.textContent = 'Away Mode: ON';
                toggleBtn.className = 'toggle-btn';
            } else {
                indicator.className = 'status-indicator off';
                statusText.textContent = 'Away Mode: OFF';
                toggleBtn.className = 'toggle-btn off';
            }

            // Update message
            awayMessage.value = currentStatus.message;

            // Update VIP list
            if (currentStatus.vipContacts.length > 0) {
                vipList.innerHTML = currentStatus.vipContacts
                    .map(contact => '<div class="vip-item">📞 ' + contact + '</div>')
                    .join('');
            } else {
                vipList.innerHTML = '<em>No VIP contacts added yet</em>';
            }
        }

        async function toggleAwayMode() {
            try {
                const response = await fetch('/api/toggle-away', { method: 'POST' });
                const result = await response.json();
                currentStatus.awayMode = result.awayMode;
                updateUI();
            } catch (error) {
                addLog('❌ Failed to toggle away mode');
            }
        }

        async function updateMessage() {
            const message = document.getElementById('awayMessage').value;
            try {
                const response = await fetch('/api/update-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message })
                });
                const result = await response.json();
                if (result.success) {
                    currentStatus.message = result.message;
                    addLog('✅ Away message updated');
                }
            } catch (error) {
                addLog('❌ Failed to update message');
            }
        }

        async function addVIP() {
            const phoneNumber = document.getElementById('vipPhone').value;
            if (!phoneNumber) return;
            
            try {
                const response = await fetch('/api/add-vip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ phoneNumber })
                });
                const result = await response.json();
                if (result.success) {
                    currentStatus.vipContacts = result.vips;
                    document.getElementById('vipPhone').value = '';
                    updateUI();
                    addLog(`⭐ Added VIP: ${phoneNumber}`);
                }
            } catch (error) {
                addLog('❌ Failed to add VIP contact');
            }
        }

        function addLog(message) {
            const log = document.getElementById('activityLog');
            const timestamp = new Date().toLocaleTimeString();
            log.innerHTML += `<div>[${timestamp}] ${message}</div>`;
            log.scrollTop = log.scrollHeight;
        }

        // Load status on page load
        loadStatus();
        
        // Refresh status every 30 seconds
        setInterval(loadStatus, 30000);
    </script>
</body>
</html>
        `;
    }
}

// Initialize the auto-responder
console.log('🚀 Starting WhatsApp Auto-Responder...');
const autoResponder = new WhatsAppAutoResponder();

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n👋 Shutting down gracefully...');
    if (autoResponder.client) {
        autoResponder.client.destroy();
    }
    process.exit(0);
});