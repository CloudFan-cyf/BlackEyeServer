const WebSocket = require('ws');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const SECRET_KEY = 'BlackEYEBYCyf&Qp';

// Initialize SQLite database
const db = new sqlite3.Database('./database.sqlite');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT)");
});

// Express app setup
const app = express();
app.use(bodyParser.json());

// Helper function to create JWT token
function createToken(username) {
    return jwt.sign({ username }, SECRET_KEY, { expiresIn: '1h' });
}

// User registration endpoint
app.post('/register', (req, res) => {
    const { username, password, secret } = req.body;

    // Log the request data
    console.log('Register request:', req.body);

    // Check if the provided secret matches the server's secret key
    if (secret !== SECRET_KEY) {
        console.log('Invalid secret key');
        return res.status(401).json({ error: 'Invalid secret key' });
    }

    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, password], (err) => {
        if (err) {
            console.log('Registration error:', err.message);
            return res.status(400).json({ error: 'Username already exists' });
        }
        res.json({ message: 'User registered successfully' });
    });
});

// User login endpoint
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err || !row) {
            return res.status(401).json({error: 'Invalid credentials'});
        }
        const token = createToken(username);
        res.json({ token });
    });
});

const server = require('http').createServer(app);
const wssEsp = new WebSocket.Server({ noServer: true });
const wssUser = new WebSocket.Server({ noServer: true });

let lastFrame = null;
let espSocket = null; // Variable to store ESP32 WebSocket connection

server.on('upgrade', function upgrade(request, socket, head) {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

    if (pathname === '/esp32') {
        wssEsp.handleUpgrade(request, socket, head, function done(ws) {
            wssEsp.emit('connection', ws, request);
        });
    } else if (pathname === '/user') {
        // Extract token from headers
        const token = request.headers['sec-websocket-protocol'];
        if (token) {
            jwt.verify(token, SECRET_KEY, (err, decoded) => {
                if (err) {
                    socket.destroy();
                    return;
                }
                request.username = decoded.username;
                wssUser.handleUpgrade(request, socket, head, function done(ws) {
                    wssUser.emit('connection', ws, request);
                });
            });
        } else {
            socket.destroy();
        }
    } else {
        socket.destroy();
    }
});

wssEsp.on('connection', function connection(ws) {
    console.log('ESP32 connected');
    espSocket = ws; // Store the ESP32 connection

    ws.on('message', function incoming(message, isBinary) {
        if (isBinary) {
            const dataType = message[0];
            const data = message.slice(1);
            
            // Save the latest frame if it's video data
            if (dataType === 0x01) {
                lastFrame = data;
            }

            // Send the frame or audio to all connected user clients immediately
            wssUser.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(message, { binary: true });
                }
            });
        } else {
            console.log('ESP32 sent text:', message.toString()); // 使用 toString() 确保以文本形式输出
            // Forward battery data or other text data to all connected users
            wssUser.clients.forEach(client => {
                 if (client.readyState === WebSocket.OPEN) {
                     client.send(message);
                 }
             });
        }
    });

    ws.on('close', () => {
        console.log('ESP32 disconnected');
        espSocket = null;
    });

    ws.on('error', (error) => {
        console.error('ESP32 connection error:', error);
    });
});

wssUser.on('connection', function connection(ws, request) {
    console.log('User connected:', request.username);
    // Send wake command to ESP32 if this is the first user to connect
    if (wssUser.clients.size === 1 && espSocket && espSocket.readyState === WebSocket.OPEN) {
        espSocket.send("wake");
    }

    ws.on('message', function incoming(message) {
        // Forward control commands to ESP32
        if (espSocket && espSocket.readyState === WebSocket.OPEN) {
            
            espSocket.send(message.toString());
        }
    });

    ws.on('close', function () {
        console.log('User disconnected:', request.username);
        // Send sleep command to ESP32 if no more users are connected
        if (wssUser.clients.size === 0 && espSocket && espSocket.readyState === WebSocket.OPEN) {
            espSocket.send("sleep");
        }
    });

    ws.on('error', (error) => {
        console.error('User connection error:', error);
    });
});

server.listen(5901, () => {
    console.log('Server is listening on port 5901');
});
