import http from 'http'
import { WebSocket, WebSocketServer } from 'ws'
import { MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log } from './logger'

interface ChatMessage {
    timestamp: number
    message: string
    type: 'info' | 'error' | 'chat' | 'system'
}

interface BotStatus {
    connected: boolean
    username: string
    state: string | null
    location: string
}

class WebGuiServer {
    private httpServer: http.Server | null = null
    private wss: WebSocketServer | null = null
    private clients: Set<WebSocket> = new Set()
    private chatHistory: ChatMessage[] = []
    private bot: MyBot | null = null
    private botStatus: BotStatus = {
        connected: false,
        username: '',
        state: null,
        location: 'Unknown'
    }
    private maxChatHistory = 1000

    constructor() {}

    public start(bot: MyBot): void {
        this.bot = bot
        this.botStatus.username = bot.username || 'Unknown'
        
        const port = getConfigProperty('WEB_GUI_PORT') || 8080
        
        // Create HTTP server
        this.httpServer = http.createServer((req, res) => {
            this.handleHttpRequest(req, res)
        })

        // Create WebSocket server for real-time updates
        this.wss = new WebSocketServer({ server: this.httpServer })
        
        this.wss.on('connection', (ws: WebSocket) => {
            this.clients.add(ws)
            log(`Web GUI client connected (total: ${this.clients.size})`, 'info')
            
            // Send initial state
            this.sendToClient(ws, {
                type: 'init',
                chatHistory: this.chatHistory,
                botStatus: this.botStatus
            })

            ws.on('message', (data: Buffer) => {
                try {
                    const message = JSON.parse(data.toString())
                    this.handleClientMessage(ws, message)
                } catch (error) {
                    log(`Error parsing web GUI message: ${error}`, 'error')
                }
            })

            ws.on('close', () => {
                this.clients.delete(ws)
                log(`Web GUI client disconnected (total: ${this.clients.size})`, 'info')
            })
        })

        this.httpServer.on('error', (error: any) => {
            if (error.code === 'EADDRINUSE') {
                const address = error.address || '0.0.0.0'
                console.error(`\n❌ Port ${port} already in use on ${address}`)
                console.error(`   Another application is using this port. Please:`)
                console.error(`   1. Stop the other application using port ${port}`)
                console.error(`   2. Or change WEB_GUI_PORT in your config.toml to a different port`)
                console.error(`\n   Web GUI will not be available.\n`)
                log(`Failed to start web GUI: Port ${port} already in use on ${address}`, 'error')
                
                // Clean up
                this.httpServer = null
                this.wss = null
            } else {
                console.error(`\n❌ Failed to start web GUI: ${error.message}\n`)
                log(`Failed to start web GUI: ${error.message}`, 'error')
            }
        })

        this.httpServer.listen(port, () => {
            log(`Web GUI started on http://localhost:${port}`, 'info')
            console.log(`\n🌐 Web GUI available at: http://localhost:${port}\n`)
        })

        // Update bot status
        this.updateBotStatus()
    }

    private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
        // Serve the HTML page
        if (req.url === '/' || req.url === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' })
            res.end(this.getHtmlPage())
        } else {
            res.writeHead(404)
            res.end('Not Found')
        }
    }

    private handleClientMessage(ws: WebSocket, message: any): void {
        switch (message.type) {
            case 'command':
                this.addChatMessage(`> ${message.command}`, 'system')
                // The command will be handled by the console handler through executeCommand
                if (this.bot && typeof message.command === 'string') {
                    // Import and use the handleCommand function
                    import('./consoleHandler').then(({ handleCommand }) => {
                        handleCommand(this.bot!, message.command)
                    }).catch(err => {
                        log(`Error executing command from web GUI: ${err}`, 'error')
                    })
                }
                break
            
            case 'stopBot':
                this.addChatMessage('Stopping bot connection...', 'system')
                this.stopBot()
                break
            
            case 'startBot':
                this.addChatMessage('Starting bot connection...', 'system')
                this.startBot()
                break
            
            case 'getInventory':
                this.sendInventory(ws)
                break
        }
    }

    public addChatMessage(message: string, type: ChatMessage['type'] = 'chat'): void {
        const chatMessage: ChatMessage = {
            timestamp: Date.now(),
            message,
            type
        }
        
        this.chatHistory.push(chatMessage)
        
        // Limit chat history size
        if (this.chatHistory.length > this.maxChatHistory) {
            this.chatHistory.shift()
        }

        // Broadcast to all connected clients
        this.broadcast({
            type: 'chatMessage',
            message: chatMessage
        })
    }

    private updateBotStatus(): void {
        if (!this.bot) return

        this.botStatus.connected = this.bot.player !== null && this.bot.player !== undefined
        this.botStatus.state = this.bot.state || null
        
        // Try to determine location from scoreboard
        if (this.bot.scoreboard && this.bot.scoreboard.sidebar) {
            const items = this.bot.scoreboard.sidebar.items || []
            const title = this.bot.scoreboard.sidebar.title
            if (title !== null && title !== undefined) {
                let cleanTitle: string
                const titleObj: any = title
                if (typeof titleObj === 'object' && titleObj.getText && typeof titleObj.getText === 'function') {
                    cleanTitle = titleObj.getText(null)
                } else {
                    cleanTitle = String(titleObj)
                }
                if (cleanTitle.includes('SKYBLOCK')) {
                    this.botStatus.location = 'SkyBlock'
                }
            }
        }

        this.broadcast({
            type: 'statusUpdate',
            status: this.botStatus
        })

        // Continue updating every 5 seconds
        setTimeout(() => this.updateBotStatus(), 5000)
    }

    private sendInventory(ws: WebSocket): void {
        if (!this.bot) {
            this.sendToClient(ws, {
                type: 'inventory',
                items: [],
                error: 'Bot not connected'
            })
            return
        }

        try {
            const inventory = this.bot.inventory.slots.map((item, index) => {
                if (!item) return null
                return {
                    slot: index,
                    name: item.name,
                    count: item.count,
                    displayName: item.displayName || item.name
                }
            }).filter(item => item !== null)

            this.sendToClient(ws, {
                type: 'inventory',
                items: inventory
            })
        } catch (error) {
            log(`Error getting inventory: ${error}`, 'error')
            this.sendToClient(ws, {
                type: 'inventory',
                items: [],
                error: String(error)
            })
        }
    }

    private stopBot(): void {
        if (!this.bot) return
        
        try {
            // Close websocket connection if available
            import('./BAF').then(({ getCurrentWebsocket }) => {
                getCurrentWebsocket().then(ws => {
                    ws.close()
                    this.addChatMessage('Websocket connection closed', 'info')
                })
            })
            
            // Disconnect from Hypixel
            this.bot.quit('Stopped by web GUI')
            this.botStatus.connected = false
            this.addChatMessage('Bot disconnected from Hypixel', 'info')
            
            this.broadcast({
                type: 'statusUpdate',
                status: this.botStatus
            })
        } catch (error) {
            log(`Error stopping bot: ${error}`, 'error')
            this.addChatMessage(`Error stopping bot: ${error}`, 'error')
        }
    }

    private startBot(): void {
        this.addChatMessage('Bot restart not yet implemented. Please restart the application.', 'error')
        // Note: Restarting the bot connection is complex and would require refactoring BAF.ts
        // For now, users should restart the application
    }

    private sendToClient(ws: WebSocket, data: any): void {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data))
        }
    }

    private broadcast(data: any): void {
        const message = JSON.stringify(data)
        this.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message)
            }
        })
    }

    private getHtmlPage(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>BAF - Web Control Panel</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #1a1a2e;
            color: #eee;
            padding: 20px;
        }
        
        .container {
            max-width: 1400px;
            margin: 0 auto;
        }
        
        h1 {
            color: #00ff88;
            margin-bottom: 10px;
            font-size: 2.5em;
        }
        
        .subtitle {
            color: #888;
            margin-bottom: 30px;
            font-size: 1.1em;
        }
        
        .grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .panel {
            background: #16213e;
            border-radius: 10px;
            padding: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        }
        
        .panel h2 {
            color: #00ff88;
            margin-bottom: 15px;
            font-size: 1.5em;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
        }
        
        .status-online {
            background: #00ff88;
            box-shadow: 0 0 10px #00ff88;
        }
        
        .status-offline {
            background: #ff4444;
            box-shadow: 0 0 10px #ff4444;
        }
        
        #chatBox {
            background: #0f1419;
            border: 1px solid #2a2a3e;
            border-radius: 5px;
            height: 500px;
            overflow-y: auto;
            padding: 15px;
            margin-bottom: 15px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            line-height: 1.6;
        }
        
        .chat-message {
            margin-bottom: 5px;
            padding: 3px 0;
        }
        
        .chat-timestamp {
            color: #666;
            font-size: 0.85em;
        }
        
        .chat-info { color: #00aaff; }
        .chat-error { color: #ff4444; }
        .chat-chat { color: #eee; }
        .chat-system { color: #ffaa00; }
        
        .input-group {
            display: flex;
            gap: 10px;
        }
        
        input[type="text"] {
            flex: 1;
            padding: 12px;
            background: #0f1419;
            border: 1px solid #2a2a3e;
            border-radius: 5px;
            color: #eee;
            font-size: 14px;
        }
        
        input[type="text"]:focus {
            outline: none;
            border-color: #00ff88;
        }
        
        button {
            padding: 12px 24px;
            background: #00ff88;
            border: none;
            border-radius: 5px;
            color: #000;
            font-weight: bold;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s;
        }
        
        button:hover {
            background: #00dd77;
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0, 255, 136, 0.3);
        }
        
        button:active {
            transform: translateY(0);
        }
        
        button.danger {
            background: #ff4444;
        }
        
        button.danger:hover {
            background: #dd3333;
            box-shadow: 0 4px 8px rgba(255, 68, 68, 0.3);
        }
        
        .status-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-top: 15px;
        }
        
        .status-item {
            background: #0f1419;
            padding: 15px;
            border-radius: 5px;
            border: 1px solid #2a2a3e;
        }
        
        .status-label {
            color: #888;
            font-size: 0.9em;
            margin-bottom: 5px;
        }
        
        .status-value {
            color: #00ff88;
            font-size: 1.2em;
            font-weight: bold;
        }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }
        
        .button-group button {
            flex: 1;
        }
        
        #inventoryGrid {
            display: grid;
            grid-template-columns: repeat(9, 1fr);
            gap: 5px;
            margin-top: 15px;
        }
        
        .inventory-slot {
            aspect-ratio: 1;
            background: #0f1419;
            border: 1px solid #2a2a3e;
            border-radius: 3px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 0.8em;
            position: relative;
            cursor: pointer;
            transition: all 0.2s;
        }
        
        .inventory-slot:hover {
            border-color: #00ff88;
            background: #1a2332;
        }
        
        .inventory-slot.has-item {
            border-color: #00ff88;
        }
        
        .item-count {
            position: absolute;
            bottom: 2px;
            right: 4px;
            font-size: 0.7em;
            color: #00ff88;
        }
        
        @media (max-width: 1024px) {
            .grid {
                grid-template-columns: 1fr;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎮 BAF Control Panel</h1>
        <p class="subtitle">Best Auto Flipper - Web Interface</p>
        
        <div class="grid">
            <div class="panel">
                <h2>💬 Chat & Console</h2>
                <div id="chatBox"></div>
                <div class="input-group">
                    <input type="text" id="commandInput" placeholder="Enter command (e.g., /cofl getbazaar)..." />
                    <button onclick="sendCommand()">Send</button>
                </div>
            </div>
            
            <div class="panel">
                <h2>
                    <span class="status-indicator" id="statusIndicator"></span>
                    Bot Status
                </h2>
                <div class="status-grid">
                    <div class="status-item">
                        <div class="status-label">Username</div>
                        <div class="status-value" id="username">-</div>
                    </div>
                    <div class="status-item">
                        <div class="status-label">Connection</div>
                        <div class="status-value" id="connection">-</div>
                    </div>
                    <div class="status-item">
                        <div class="status-label">State</div>
                        <div class="status-value" id="state">-</div>
                    </div>
                    <div class="status-item">
                        <div class="status-label">Location</div>
                        <div class="status-value" id="location">-</div>
                    </div>
                </div>
                
                <div class="button-group">
                    <button class="danger" onclick="stopBot()">Stop Bot</button>
                    <button onclick="startBot()">Start Bot</button>
                </div>
                
                <h2 style="margin-top: 30px;">📦 Inventory</h2>
                <button onclick="loadInventory()" style="width: 100%; margin-bottom: 10px;">Refresh Inventory</button>
                <div id="inventoryGrid"></div>
            </div>
        </div>
    </div>
    
    <script>
        let ws = null;
        
        function connect() {
            ws = new WebSocket(\`ws://\${window.location.host}\`);
            
            ws.onopen = () => {
                console.log('Connected to BAF server');
                addSystemMessage('Connected to server');
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleMessage(data);
            };
            
            ws.onclose = () => {
                console.log('Disconnected from BAF server');
                addSystemMessage('Disconnected from server. Reconnecting...');
                setTimeout(connect, 3000);
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }
        
        function handleMessage(data) {
            switch (data.type) {
                case 'init':
                    data.chatHistory.forEach(msg => addChatMessage(msg));
                    updateBotStatus(data.botStatus);
                    break;
                case 'chatMessage':
                    addChatMessage(data.message);
                    break;
                case 'statusUpdate':
                    updateBotStatus(data.status);
                    break;
                case 'inventory':
                    displayInventory(data.items);
                    break;
            }
        }
        
        function addChatMessage(msg) {
            const chatBox = document.getElementById('chatBox');
            const div = document.createElement('div');
            div.className = \`chat-message chat-\${msg.type}\`;
            
            const time = new Date(msg.timestamp).toLocaleTimeString();
            div.innerHTML = \`<span class="chat-timestamp">[\${time}]</span> \${escapeHtml(msg.message)}\`;
            
            chatBox.appendChild(div);
            chatBox.scrollTop = chatBox.scrollHeight;
        }
        
        function addSystemMessage(text) {
            addChatMessage({
                timestamp: Date.now(),
                message: text,
                type: 'system'
            });
        }
        
        function updateBotStatus(status) {
            document.getElementById('username').textContent = status.username || '-';
            document.getElementById('connection').textContent = status.connected ? 'Online' : 'Offline';
            document.getElementById('state').textContent = status.state || 'Idle';
            document.getElementById('location').textContent = status.location || 'Unknown';
            
            const indicator = document.getElementById('statusIndicator');
            indicator.className = \`status-indicator \${status.connected ? 'status-online' : 'status-offline'}\`;
        }
        
        function displayInventory(items) {
            const grid = document.getElementById('inventoryGrid');
            grid.innerHTML = '';
            
            // Create 36 slots (standard inventory size)
            for (let i = 0; i < 36; i++) {
                const item = items.find(it => it.slot === i);
                const slot = document.createElement('div');
                slot.className = 'inventory-slot';
                
                if (item) {
                    slot.classList.add('has-item');
                    slot.title = \`\${item.displayName || item.name} x\${item.count}\`;
                    slot.textContent = item.name.substring(0, 3).toUpperCase();
                    
                    if (item.count > 1) {
                        const count = document.createElement('span');
                        count.className = 'item-count';
                        count.textContent = item.count;
                        slot.appendChild(count);
                    }
                }
                
                grid.appendChild(slot);
            }
        }
        
        function sendCommand() {
            const input = document.getElementById('commandInput');
            const command = input.value.trim();
            
            if (command && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'command',
                    command: command
                }));
                input.value = '';
            }
        }
        
        function stopBot() {
            if (confirm('Are you sure you want to stop the bot? It will disconnect from Hypixel.')) {
                ws.send(JSON.stringify({ type: 'stopBot' }));
            }
        }
        
        function startBot() {
            alert('Bot restart requires restarting the application. Please use the start script or npm run start.');
        }
        
        function loadInventory() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'getInventory' }));
            }
        }
        
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
        
        // Handle Enter key in command input
        document.addEventListener('DOMContentLoaded', () => {
            const input = document.getElementById('commandInput');
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendCommand();
                }
            });
            
            connect();
        });
    </script>
</body>
</html>`
    }

    public stop(): void {
        if (this.wss) {
            this.wss.close()
        }
        if (this.httpServer) {
            this.httpServer.close()
        }
        log('Web GUI stopped', 'info')
    }
}

let webGuiInstance: WebGuiServer | null = null

export function startWebGui(bot: MyBot): void {
    if (webGuiInstance) {
        log('Web GUI already running', 'warn')
        return
    }
    
    webGuiInstance = new WebGuiServer()
    webGuiInstance.start(bot)
}

export function addWebGuiChatMessage(message: string, type: 'info' | 'error' | 'chat' | 'system' = 'chat'): void {
    if (webGuiInstance) {
        webGuiInstance.addChatMessage(message, type)
    }
}

export function stopWebGui(): void {
    if (webGuiInstance) {
        webGuiInstance.stop()
        webGuiInstance = null
    }
}
