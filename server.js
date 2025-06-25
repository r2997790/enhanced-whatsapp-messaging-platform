const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(express.static('.'));
app.use(express.json());

// Global variables
let whatsappClient = null;
let isReady = false;
let qrString = '';
let connectedSockets = new Set();

// Enhanced rate limiting
const messageQueue = new Map();
const RATE_LIMIT = {
    maxMessages: 20,
    timeWindow: 60000, // 1 minute
    delayBetweenMessages: 3000, // 3 seconds
    bulkMaxMessages: 5,
    bulkTimeWindow: 300000 // 5 minutes for bulk
};

// Bulk messaging state
const activeBulkSends = new Map();

// Initialize WhatsApp client
function initializeWhatsAppClient() {
    console.log('🚀 Initializing WhatsApp client...');
    
    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-enhanced-client',
            dataPath: './auth_data'
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
        },
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
        }
    });

    // QR Code generation
    whatsappClient.on('qr', async (qr) => {
        console.log('📱 QR Code generated, scan with WhatsApp app');
        try {
            qrString = await qrcode.toDataURL(qr);
            io.emit('qr', qrString);
            console.log('✅ QR Code sent to all connected clients');
        } catch (error) {
            console.error('❌ Error generating QR code:', error);
        }
    });

    // Authentication events
    whatsappClient.on('authenticated', () => {
        console.log('✅ WhatsApp client authenticated successfully');
        io.emit('authenticated');
    });

    whatsappClient.on('auth_failure', (msg) => {
        console.error('❌ Authentication failed:', msg);
        io.emit('auth_failure', msg);
    });

    // Ready event
    whatsappClient.on('ready', () => {
        console.log('🎉 WhatsApp client is ready!');
        isReady = true;
        io.emit('ready');
    });

    // Disconnection handling
    whatsappClient.on('disconnected', (reason) => {
        console.log('🔌 WhatsApp client disconnected:', reason);
        isReady = false;
        io.emit('disconnected', reason);
        
        // Attempt to reconnect after a delay
        setTimeout(() => {
            console.log('🔄 Attempting to reconnect...');
            initializeWhatsAppClient();
        }, 5000);
    });

    // Message events
    whatsappClient.on('message_create', (message) => {
        if (!message.fromMe) {
            console.log('📨 Received message:', {
                from: message.from,
                body: message.body,
                timestamp: new Date(message.timestamp * 1000)
            });
        }
    });

    // Error handling
    whatsappClient.on('error', (error) => {
        console.error('❌ WhatsApp client error:', error);
    });

    // Initialize the client
    whatsappClient.initialize().catch(error => {
        console.error('❌ Failed to initialize WhatsApp client:', error);
    });
}

// Enhanced rate limiting functions
function checkRateLimit(identifier, type = 'message') {
    const now = Date.now();
    const userMessages = messageQueue.get(identifier) || [];
    
    const config = type === 'bulk' ? 
        { max: RATE_LIMIT.bulkMaxMessages, window: RATE_LIMIT.bulkTimeWindow } :
        { max: RATE_LIMIT.maxMessages, window: RATE_LIMIT.timeWindow };
    
    // Remove old messages outside the time window
    const recentMessages = userMessages.filter(
        timestamp => now - timestamp < config.window
    );
    
    messageQueue.set(identifier, recentMessages);
    
    return recentMessages.length < config.max;
}

function addToRateLimit(identifier) {
    const now = Date.now();
    const userMessages = messageQueue.get(identifier) || [];
    userMessages.push(now);
    messageQueue.set(identifier, userMessages);
}

// Enhanced message validation
function validateMessage(to, message) {
    const errors = [];
    
    // Validate phone number
    if (!to || typeof to !== 'string') {
        errors.push('Invalid phone number format');
    } else {
        const cleanPhone = to.replace(/[^\d]/g, '');
        if (cleanPhone.length < 10 || cleanPhone.length > 15) {
            errors.push('Phone number must be between 10-15 digits');
        }
    }
    
    // Validate message content
    if (!message || typeof message !== 'string') {
        errors.push('Message content is required');
    } else if (message.length > 4096) {
        errors.push('Message is too long (max 4096 characters)');
    }
    
    return errors;
}

// Enhanced bulk request validation
function validateBulkRequest(phoneNumbers, message) {
    const errors = [];
    
    // Validate phone numbers array
    if (!Array.isArray(phoneNumbers) || phoneNumbers.length === 0) {
        errors.push('Phone numbers array is required and cannot be empty');
    } else {
        if (phoneNumbers.length > 50) {
            errors.push('Maximum 50 recipients allowed per bulk send');
        }
        
        // Validate each phone number
        const invalidNumbers = [];
        phoneNumbers.forEach((phone, index) => {
            const validationErrors = validateMessage(phone, 'test');
            if (validationErrors.length > 0) {
                invalidNumbers.push(`Position ${index + 1}: ${phone}`);
            }
        });
        
        if (invalidNumbers.length > 0) {
            errors.push(`Invalid phone numbers found: ${invalidNumbers.slice(0, 3).join(', ')}${invalidNumbers.length > 3 ? ` and ${invalidNumbers.length - 3} more` : ''}`);
        }
    }
    
    // Validate message
    if (!message || typeof message !== 'string') {
        errors.push('Message content is required');
    } else {
        if (message.length > 4096) {
            errors.push('Message is too long (max 4096 characters)');
        }
        if (message.trim().length === 0) {
            errors.push('Message cannot be empty');
        }
    }
    
    return errors;
}

// Format phone number for WhatsApp
function formatPhoneNumber(phone) {
    // Remove all non-digit characters
    const cleaned = phone.replace(/[^\d]/g, '');
    
    // Ensure it has the @c.us suffix
    if (!phone.includes('@c.us')) {
        return cleaned + '@c.us';
    }
    
    return phone;
}

// Enhanced message sending with retry logic
async function sendMessage(to, message, retries = 3) {
    if (!whatsappClient || !isReady) {
        throw new Error('WhatsApp client is not ready');
    }
    
    const formattedNumber = formatPhoneNumber(to);
    
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            console.log(`📤 Sending message to ${formattedNumber} (attempt ${attempt}/${retries})`);
            
            // Send the message
            const result = await whatsappClient.sendMessage(formattedNumber, message);
            console.log(`✅ Message sent successfully to ${formattedNumber}`);
            
            return {
                success: true,
                messageId: result.id.id,
                timestamp: new Date().toISOString()
            };
            
        } catch (error) {
            console.error(`❌ Attempt ${attempt} failed for ${formattedNumber}:`, error.message);
            
            if (attempt === retries) {
                throw error;
            }
            
            // Wait before retry
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}

// Enhanced bulk message sending with progress tracking
async function sendBulkMessages(phoneNumbers, message, delay = 5000, socket = null) {
    const results = [];
    const totalMessages = phoneNumbers.length;
    let successCount = 0;
    let failureCount = 0;
    
    console.log(`📋 Starting bulk send to ${totalMessages} recipients with ${delay}ms delay`);
    
    const startTime = Date.now();
    const bulkId = `bulk_${Date.now()}_${socket?.id || 'system'}`;
    
    // Add to active bulk sends
    activeBulkSends.set(bulkId, {
        socketId: socket?.id,
        total: totalMessages,
        sent: 0,
        failed: 0,
        startTime: startTime
    });
    
    for (let i = 0; i < phoneNumbers.length; i++) {
        const phone = phoneNumbers[i];
        const formattedPhone = formatPhoneNumber(phone);
        
        try {
            // Check if we should continue
            if (!whatsappClient || !isReady) {
                throw new Error('WhatsApp client disconnected during bulk send');
            }
            
            console.log(`📤 [${i + 1}/${totalMessages}] Sending to ${formattedPhone}`);
            
            // Send message with retry logic
            const result = await sendMessage(formattedPhone, message, 2);
            
            results.push({
                phone: formattedPhone,
                status: 'success',
                messageId: result.messageId,
                timestamp: result.timestamp,
                index: i + 1
            });
            
            successCount++;
            
            // Emit success to specific socket if provided
            if (socket) {
                socket.emit('message_sent', {
                    to: formattedPhone,
                    message: message,
                    messageId: result.messageId,
                    timestamp: result.timestamp,
                    bulkIndex: i + 1,
                    bulkTotal: totalMessages
                });
            }
            
            // Emit progress to all clients
            io.emit('bulk_progress', {
                bulkId: bulkId,
                sent: successCount,
                failed: failureCount,
                total: totalMessages,
                current: i + 1,
                currentPhone: formattedPhone,
                status: 'sending'
            });
            
        } catch (error) {
            console.error(`❌ [${i + 1}/${totalMessages}] Failed to send to ${formattedPhone}:`, error.message);
            
            results.push({
                phone: formattedPhone,
                status: 'failed',
                error: error.message,
                timestamp: new Date().toISOString(),
                index: i + 1
            });
            
            failureCount++;
            
            // Emit failure to specific socket if provided
            if (socket) {
                socket.emit('message_failed', {
                    to: formattedPhone,
                    message: message,
                    error: error.message,
                    timestamp: new Date().toISOString(),
                    bulkIndex: i + 1,
                    bulkTotal: totalMessages
                });
            }
            
            // Emit progress update
            io.emit('bulk_progress', {
                bulkId: bulkId,
                sent: successCount,
                failed: failureCount,
                total: totalMessages,
                current: i + 1,
                currentPhone: formattedPhone,
                status: 'error',
                lastError: error.message
            });
        }
        
        // Smart delay between messages (except for the last one)
        if (i < phoneNumbers.length - 1) {
            const smartDelay = Math.max(delay, RATE_LIMIT.delayBetweenMessages);
            console.log(`⏳ Waiting ${smartDelay}ms before next message...`);
            await new Promise(resolve => setTimeout(resolve, smartDelay));
        }
    }
    
    // Calculate completion stats
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);
    const successRate = totalMessages > 0 ? Math.round((successCount / totalMessages) * 100) : 0;
    
    console.log(`📊 Bulk send complete in ${duration}s: ${successCount} sent, ${failureCount} failed (${successRate}% success rate)`);
    
    // Remove from active bulk sends
    activeBulkSends.delete(bulkId);
    
    // Emit completion status
    io.emit('bulk_completed', {
        bulkId: bulkId,
        total: totalMessages,
        sent: successCount,
        failed: failureCount,
        duration: duration,
        successRate: successRate,
        results: results
    });
    
    return {
        total: totalMessages,
        sent: successCount,
        failed: failureCount,
        duration: duration,
        successRate: successRate,
        results: results
    };
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log('🔗 New client connected:', socket.id);
    connectedSockets.add(socket);
    
    // Send current QR code if available
    if (qrString && !isReady) {
        socket.emit('qr', qrString);
    } else if (isReady) {
        socket.emit('ready');
    }
    
    // Handle single message sending
    socket.on('send_message', async (data) => {
        try {
            const { to, message } = data;
            
            // Validate input
            const validationErrors = validateMessage(to, message);
            if (validationErrors.length > 0) {
                socket.emit('message_failed', {
                    to: to,
                    message: message,
                    error: validationErrors.join(', '),
                    timestamp: new Date().toISOString()
                });
                return;
            }
            
            // Check rate limit
            if (!checkRateLimit(socket.id)) {
                socket.emit('message_failed', {
                    to: to,
                    message: message,
                    error: 'Rate limit exceeded. Please wait before sending more messages.',
                    timestamp: new Date().toISOString()
                });
                return;
            }
            
            // Send message
            const result = await sendMessage(to, message);
            addToRateLimit(socket.id);
            
            socket.emit('message_sent', {
                to: to,
                message: message,
                messageId: result.messageId,
                timestamp: result.timestamp
            });
            
        } catch (error) {
            console.error('❌ Error sending message:', error);
            socket.emit('message_failed', {
                to: data.to,
                message: data.message,
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    });
    
    // Enhanced bulk message handler
    socket.on('send_bulk_messages', async (data) => {
        try {
            const { phoneNumbers, message, delay = 5000 } = data;
            
            console.log(`📋 Bulk message request from ${socket.id}: ${phoneNumbers.length} recipients`);
            
            // Validate bulk request
            const validationErrors = validateBulkRequest(phoneNumbers, message);
            if (validationErrors.length > 0) {
                socket.emit('bulk_failed', {
                    error: validationErrors.join(', '),
                    timestamp: new Date().toISOString()
                });
                return;
            }
            
            // Check if user already has active bulk send
            const hasActiveBulk = Array.from(activeBulkSends.values()).some(
                bulk => bulk.socketId === socket.id
            );
            
            if (hasActiveBulk) {
                socket.emit('bulk_failed', {
                    error: 'You already have an active bulk send in progress',
                    timestamp: new Date().toISOString()
                });
                return;
            }
            
            // Check bulk rate limit
            if (!checkRateLimit(`bulk_${socket.id}`, 'bulk')) {
                socket.emit('bulk_failed', {
                    error: 'Bulk send rate limit exceeded. Please wait before sending another batch.',
                    timestamp: new Date().toISOString()
                });
                return;
            }
            
            // Add to bulk rate limit
            addToRateLimit(`bulk_${socket.id}`);
            
            // Emit start event
            socket.emit('bulk_started', {
                total: phoneNumbers.length,
                delay: delay,
                timestamp: new Date().toISOString()
            });
            
            // Start bulk sending
            const results = await sendBulkMessages(phoneNumbers, message, delay, socket);
            
            // Emit completion
            socket.emit('bulk_completed', {
                results: results,
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            console.error('❌ Error in bulk send:', error);
            socket.emit('bulk_failed', {
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
    });
    
    // Handle bulk status requests
    socket.on('get_bulk_status', () => {
        const activeBulk = Array.from(activeBulkSends.values()).find(
            bulk => bulk.socketId === socket.id
        );
        
        socket.emit('bulk_status', {
            hasActiveBulk: !!activeBulk,
            activeBulkCount: activeBulkSends.size,
            timestamp: new Date().toISOString()
        });
    });
    
    // Handle client status requests
    socket.on('get_status', () => {
        socket.emit('status', {
            ready: isReady,
            hasQR: !!qrString,
            timestamp: new Date().toISOString()
        });
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected:', socket.id);
        connectedSockets.delete(socket);
    });
});

// REST API Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        whatsapp: {
            ready: isReady,
            hasQR: !!qrString
        },
        server: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            connectedClients: connectedSockets.size,
            activeBulkSends: activeBulkSends.size
        }
    });
});

// API endpoint to get status
app.get('/api/status', (req, res) => {
    res.json({
        ready: isReady,
        hasQR: !!qrString,
        connectedClients: connectedSockets.size,
        activeBulkSends: activeBulkSends.size,
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('❌ Server error:', error);
    res.status(500).json({
        success: false,
        error: 'Internal server error'
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found'
    });
});

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('🛑 Shutting down gracefully...');
    
    try {
        if (whatsappClient) {
            console.log('🔌 Closing WhatsApp client...');
            await whatsappClient.destroy();
        }
        
        console.log('🔌 Closing server...');
        server.close(() => {
            console.log('✅ Server closed successfully');
            process.exit(0);
        });
    } catch (error) {
        console.error('❌ Error during shutdown:', error);
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('🛑 Received SIGTERM, shutting down...');
    
    try {
        if (whatsappClient) {
            await whatsappClient.destroy();
        }
        server.close(() => {
            process.exit(0);
        });
    } catch (error) {
        console.error('❌ Error during SIGTERM shutdown:', error);
        process.exit(1);
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log('🚀 Enhanced WhatsApp Messaging Platform with Bulk Messaging started');
    console.log(`📡 Server running on http://${HOST}:${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('🔄 Initializing WhatsApp client...');
    
    // Initialize WhatsApp client
    initializeWhatsAppClient();
});

// Export for testing purposes
module.exports = { app, server, io };