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
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

// WebSocket connections
wss.on('connection', (ws, req) => {
    const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const sessionId = urlParams.get('sessionId');
    const clientType = urlParams.get('type');

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
                scrollSpeed: session.scrollSpeed
            }
        }));
    } else if (clientType === 'display') {
        session.displayClientIds.add(clientId);
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

                if ('script' in message.data) session.script = message.data.script;
                if ('scrollPosition' in message.data) session.scrollPosition = message.data.scrollPosition;
                if ('isPlaying' in message.data) session.isPlaying = message.data.isPlaying;
                if ('scrollSpeed' in message.data) session.scrollSpeed = message.data.scrollSpeed;
                session.updatedAt = Date.now();

                broadcastToDisplays(sessionId, {
                    script: session.script,
                    scrollPosition: session.scrollPosition,
                    isPlaying: session.isPlaying,
                    scrollSpeed: session.scrollSpeed
                });
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

        setTimeout(() => {
            if (!session.controlClientId && session.displayClientIds.size === 0) {
                sessions.delete(sessionId);
            }
        }, 5 * 60 * 1000);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Catch-all route - serve index.html for any unmatched routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Cleanup old sessions
setInterval(() => {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000;

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
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, closing server...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
