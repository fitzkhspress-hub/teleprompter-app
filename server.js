const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Serve index.html at root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Store active sessions and their state
const sessions = new Map();
const wsConnections = new Map();

// Initialize a session
function getOrCreateSession(sessionId) {
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, {
            sessionId,
            script: '',
            scrollPosition: 0,
            isPlaying: false,
            scrollSpeed: 1,
            updatedAt: Date.now(),
            controlClientId: null,
            displayClientIds: new Set()
        });
    }
    return sessions.get(sessionId);
}

// Broadcast to all display clients in a session
function broadcastToDisplays(sessionId, data) {
    const session = sessions.get(sessionId);
    if (!session) return;

    session.displayClientIds.forEach(clientId => {
        const ws = wsConnections.get(clientId);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'sync',
                ...data
            }));
        }
    });
}

// Notify control client of display connections
function notifyControlOfDisplays(sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.controlClientId) return;

    const ws = wsConnections.get(session.controlClientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'displayCount',
            count: session.displayClientIds.size
        }));
    }
}

// WebSocket connections
wss.on('connection', (ws, req) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const sessionId = urlParams.get('sessionId');
    const clientType = urlParams.get('type'); // 'control' or 'display'

    if (!sessionId) {
        ws.close(1008, 'sessionId required');
        return;
    }

    wsConnections.set(clientId, ws);
    const session = getOrCreateSession(sessionId);

    if (clientType === 'control') {
        session.controlClientId = clientId;
        ws.send(JSON.stringify({
            type: 'connected',
            role: 'control',
            sessionId,
            currentState: {
                script: session.script,
                scrollPosition: session.scrollPosition,
                isPlaying: session.isPlaying,
                scrollSpeed: session.scrollSpeed,
                displayCount: session.displayClientIds.size
            }
        }));
    } else if (clientType === 'display') {
        session.displayClientIds.add(clientId);
        notifyControlOfDisplays(sessionId);
        ws.send(JSON.stringify({
            type: 'connected',
            role: 'display',
            sessionId,
            currentState: {
                script: session.script,
                scrollPosition: session.scrollPosition,
                isPlaying: session.isPlaying,
                scrollSpeed: session.scrollSpeed
            }
        }));
    }

    // Handle messages
    ws.on('message', (messageData) => {
        try {
            const message = JSON.parse(messageData);

            if (message.type === 'update') {
                const session = sessions.get(sessionId);
                if (!session) return;

                // Update session state
                if ('script' in message.data) session.script = message.data.script;
                if ('scrollPosition' in message.data) session.scrollPosition = message.data.scrollPosition;
                if ('isPlaying' in message.data) session.isPlaying = message.data.isPlaying;
                if ('scrollSpeed' in message.data) session.scrollSpeed = message.data.scrollSpeed;
                session.updatedAt = Date.now();

                // Broadcast to displays
                broadcastToDisplays(sessionId, {
                    script: session.script,
                    scrollPosition: session.scrollPosition,
                    isPlaying: session.isPlaying,
                    scrollSpeed: session.scrollSpeed
                });

                // Notify control of successful broadcast
                if (clientType === 'control') {
                    ws.send(JSON.stringify({
                        type: 'broadcast_sent',
                        displayCount: session.displayClientIds.size
                    }));
                }
            }
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    // Handle disconnection
    ws.on('close', () => {
        wsConnections.delete(clientId);
        const session = sessions.get(sessionId);
        if (!session) return;

        if (session.controlClientId === clientId) {
            session.controlClientId = null;
        }
        session.displayClientIds.delete(clientId);

        // Clean up empty sessions after 5 minutes
        setTimeout(() => {
            if (!session.controlClientId && session.displayClientIds.size === 0) {
                sessions.delete(sessionId);
            }
        }, 5 * 60 * 1000);

        notifyControlOfDisplays(sessionId);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// REST API endpoints (fallback for polling)
app.post('/api/session/:sessionId/update', (req, res) => {
    const { sessionId } = req.params;
    const session = getOrCreateSession(sessionId);

    // Update session state
    if ('script' in req.body) session.script = req.body.script;
    if ('scrollPosition' in req.body) session.scrollPosition = req.body.scrollPosition;
    if ('isPlaying' in req.body) session.isPlaying = req.body.isPlaying;
    if ('scrollSpeed' in req.body) session.scrollSpeed = req.body.scrollSpeed;
    session.updatedAt = Date.now();

    // Broadcast via REST (for clients that can't use WebSocket)
    broadcastToDisplays(sessionId, {
        script: session.script,
        scrollPosition: session.scrollPosition,
        isPlaying: session.isPlaying,
        scrollSpeed: session.scrollSpeed
    });

    res.json({
        success: true,
        displayCount: session.displayClientIds.size,
        session
    });
});

app.get('/api/session/:sessionId', (req, res) => {
    const { sessionId } = req.params;
    const session = getOrCreateSession(sessionId);

    res.json({
        sessionId,
        script: session.script,
        scrollPosition: session.scrollPosition,
        isPlaying: session.isPlaying,
        scrollSpeed: session.scrollSpeed,
        displayCount: session.displayClientIds.size
    });
});

app.get('/api/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        activeSessions: sessions.size,
        activeConnections: wsConnections.size
    });
});

// Cleanup old sessions every 10 minutes
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes

    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.updatedAt > maxAge && !session.controlClientId && session.displayClientIds.size === 0) {
            sessions.delete(sessionId);
        }
    }
}, 10 * 60 * 1000);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Teleprompter server running on port ${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
    console.log(`REST API: http://localhost:${PORT}/api`);
});

// Catch-all route - serve index.html for any unmatched routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
