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