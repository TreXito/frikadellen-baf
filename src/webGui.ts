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

interface AuthSession {
    token: string
    authenticated: boolean
    timestamp: number
}

class WebGuiServer {
    private httpServer: http.Server | null = null
    private wss: WebSocketServer | null = null
    private clients: Map<WebSocket, AuthSession> = new Map()
    private chatHistory: ChatMessage[] = []
    private bot: MyBot | null = null
    private botStatus: BotStatus = {
        connected: false,
        username: '',
        state: null,
        location: 'Unknown'
    }
    private maxChatHistory = 1000
    private password: string = ''

    constructor() {}

    public start(bot: MyBot): void {
        this.bot = bot
        this.botStatus.username = bot.username || 'Unknown'
        
        const port = getConfigProperty('WEB_GUI_PORT') || 8080
        this.password = getConfigProperty('WEB_GUI_PASSWORD') || ''
        
        // Create HTTP server
        this.httpServer = http.createServer((req, res) => {
            this.handleHttpRequest(req, res)
        })

        // Create WebSocket server for real-time updates
        this.wss = new WebSocketServer({ server: this.httpServer })
        
        this.wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
            // Create initial session (not authenticated)
            const session: AuthSession = {
                token: '',
                authenticated: !this.password, // Auto-authenticate if no password set
                timestamp: Date.now()
            }
            this.clients.set(ws, session)
            log(`Web GUI client connected (total: ${this.clients.size})`, 'info')
            
            // Send initial state (only if authenticated or no password required)
            if (session.authenticated) {
                this.sendToClient(ws, {
                    type: 'init',
                    chatHistory: this.chatHistory,
                    botStatus: this.botStatus,
                    requiresAuth: false
                })
            } else {
                this.sendToClient(ws, {
                    type: 'init',
                    requiresAuth: true
                })
            }

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

        // Register error handler BEFORE calling listen to avoid race conditions
        this.httpServer.on('error', (error: any) => {
            if (error.code === 'EADDRINUSE') {
                const address = error.address || '0.0.0.0'
                console.error(`\n❌ Port ${port} already in use on ${address}`)
                console.error(`   Another application is using this port. Please:`)
                console.error(`   1. Stop the other application using port ${port}`)
                console.error(`   2. Or change WEB_GUI_PORT in your config.toml to a different port`)
                console.error(`\n   Web GUI will not be available.\n`)
                log(`Failed to start web GUI: Port ${port} already in use on ${address}`, 'error')
                
                // Clean up WebSocket server (HTTP server failed to bind, so no need to close it)
                if (this.wss) {
                    this.wss.close()
                    this.wss = null
                }
                if (this.httpServer) {
                    this.httpServer = null
                }
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
        const session = this.clients.get(ws)
        if (!session) return

        // Handle authentication
        if (message.type === 'auth') {
            if (this.password && message.password === this.password) {
                session.authenticated = true
                session.token = Math.random().toString(36).substring(7)
                session.timestamp = Date.now()
                this.sendToClient(ws, {
                    type: 'authSuccess',
                    token: session.token,
                    chatHistory: this.chatHistory,
                    botStatus: this.botStatus
                })
                log('Web GUI client authenticated successfully', 'info')
            } else {
                this.sendToClient(ws, {
                    type: 'authFailed',
                    message: 'Invalid password'
                })
            }
            return
        }

        // Check authentication for other messages
        if (this.password && !session.authenticated) {
            this.sendToClient(ws, {
                type: 'authRequired',
                message: 'Authentication required'
            })
            return
        }

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
                    displayName: item.displayName || item.name,
                    // Add minecraft item ID for icon rendering
                    itemId: item.name.replace('minecraft:', '')
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
        this.clients.forEach((session, client) => {
            if (client.readyState === WebSocket.OPEN && session.authenticated) {
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
    <title>BAF - AMOLED Control Panel</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: #000000;
            color: #ffffff;
            padding: 20px;
            overflow-x: hidden;
        }
        
        .login-container {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: radial-gradient(circle at center, rgba(0, 255, 136, 0.1) 0%, rgba(0, 0, 0, 1) 70%);
        }
        
        .login-box {
            background: rgba(10, 10, 10, 0.9);
            backdrop-filter: blur(20px);
            border: 2px solid #00ff88;
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 0 50px rgba(0, 255, 136, 0.3), inset 0 0 30px rgba(0, 255, 136, 0.05);
            animation: glow 2s ease-in-out infinite alternate;
            max-width: 400px;
            width: 100%;
        }
        
        @keyframes glow {
            from { box-shadow: 0 0 30px rgba(0, 255, 136, 0.3), inset 0 0 20px rgba(0, 255, 136, 0.05); }
            to { box-shadow: 0 0 60px rgba(0, 255, 136, 0.5), inset 0 0 40px rgba(0, 255, 136, 0.1); }
        }
        
        .login-title {
            font-size: 2.5em;
            text-align: center;
            margin-bottom: 10px;
            background: linear-gradient(135deg, #00ff88, #ff00ff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-weight: bold;
        }
        
        .login-subtitle {
            text-align: center;
            color: #888;
            margin-bottom: 30px;
            font-size: 1.1em;
        }
        
        .container {
            max-width: 1600px;
            margin: 0 auto;
            display: none;
            animation: fadeIn 0.5s ease-in;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 30px;
            padding: 20px;
            background: rgba(10, 10, 10, 0.8);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(0, 255, 136, 0.3);
            border-radius: 15px;
            box-shadow: 0 0 30px rgba(0, 255, 136, 0.2);
        }
        
        .header-left {
            display: flex;
            align-items: center;
            gap: 20px;
        }
        
        .player-head {
            width: 64px;
            height: 64px;
            border-radius: 10px;
            border: 2px solid #00ff88;
            box-shadow: 0 0 20px rgba(0, 255, 136, 0.5);
            transition: all 0.3s;
        }
        
        .player-head:hover {
            transform: scale(1.1) rotate(5deg);
            box-shadow: 0 0 30px rgba(0, 255, 136, 0.8);
        }
        
        .header-info h1 {
            font-size: 2em;
            background: linear-gradient(135deg, #00ff88, #00aaff);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 5px;
        }
        
        .header-info .subtitle {
            color: #888;
            font-size: 0.9em;
        }
        
        .header-right {
            display: flex;
            gap: 10px;
        }
        
        .icon-btn {
            width: 50px;
            height: 50px;
            background: rgba(0, 255, 136, 0.1);
            border: 1px solid #00ff88;
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s;
            font-size: 1.5em;
        }
        
        .icon-btn:hover {
            background: rgba(0, 255, 136, 0.2);
            transform: translateY(-3px);
            box-shadow: 0 5px 20px rgba(0, 255, 136, 0.4);
        }
        
        .settings-panel {
            position: fixed;
            top: 0;
            right: -400px;
            width: 400px;
            height: 100vh;
            background: rgba(0, 0, 0, 0.95);
            backdrop-filter: blur(30px);
            border-left: 2px solid #00ff88;
            box-shadow: -10px 0 50px rgba(0, 255, 136, 0.3);
            padding: 30px;
            transition: right 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55);
            z-index: 1000;
            overflow-y: auto;
        }
        
        .settings-panel.open {
            right: 0;
        }
        
        .settings-title {
            font-size: 1.8em;
            color: #00ff88;
            margin-bottom: 30px;
            display: flex;
            align-items: center;
            gap: 10px;
        }
        
        .settings-group {
            margin-bottom: 30px;
        }
        
        .settings-group h3 {
            color: #ff00ff;
            margin-bottom: 15px;
            font-size: 1.2em;
        }
        
        .toggle-option {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px;
            background: rgba(0, 255, 136, 0.05);
            border: 1px solid rgba(0, 255, 136, 0.2);
            border-radius: 10px;
            margin-bottom: 10px;
            transition: all 0.3s;
        }
        
        .toggle-option:hover {
            background: rgba(0, 255, 136, 0.1);
            border-color: #00ff88;
        }
        
        .toggle-switch {
            position: relative;
            width: 60px;
            height: 30px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
            cursor: pointer;
            transition: all 0.3s;
        }
        
        .toggle-switch.active {
            background: #00ff88;
            box-shadow: 0 0 20px rgba(0, 255, 136, 0.5);
        }
        
        .toggle-switch::after {
            content: '';
            position: absolute;
            width: 24px;
            height: 24px;
            background: white;
            border-radius: 50%;
            top: 3px;
            left: 3px;
            transition: all 0.3s;
        }
        
        .toggle-switch.active::after {
            left: 33px;
        }
        
        .grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .panel {
            background: rgba(10, 10, 10, 0.8);
            backdrop-filter: blur(20px);
            border-radius: 15px;
            padding: 25px;
            border: 1px solid rgba(0, 255, 136, 0.3);
            box-shadow: 0 0 30px rgba(0, 255, 136, 0.1);
            transition: all 0.3s;
        }
        
        .panel:hover {
            border-color: rgba(0, 255, 136, 0.5);
            box-shadow: 0 0 40px rgba(0, 255, 136, 0.2);
        }
        
        .panel h2 {
            color: #00ff88;
            margin-bottom: 20px;
            font-size: 1.5em;
            display: flex;
            align-items: center;
            gap: 10px;
            text-shadow: 0 0 20px rgba(0, 255, 136, 0.5);
        }
        
        .status-indicator {
            width: 14px;
            height: 14px;
            border-radius: 50%;
            display: inline-block;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.2); opacity: 0.8; }
        }
        
        .status-online {
            background: #00ff88;
            box-shadow: 0 0 15px #00ff88;
        }
        
        .status-offline {
            background: #ff0055;
            box-shadow: 0 0 15px #ff0055;
        }
        
        #chatBox {
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(0, 255, 136, 0.2);
            border-radius: 10px;
            height: 500px;
            overflow-y: auto;
            padding: 15px;
            margin-bottom: 15px;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            line-height: 1.8;
            box-shadow: inset 0 0 20px rgba(0, 255, 136, 0.05);
        }
        
        #chatBox::-webkit-scrollbar {
            width: 8px;
        }
        
        #chatBox::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 10px;
        }
        
        #chatBox::-webkit-scrollbar-thumb {
            background: #00ff88;
            border-radius: 10px;
            box-shadow: 0 0 10px rgba(0, 255, 136, 0.5);
        }
        
        .chat-message {
            margin-bottom: 8px;
            padding: 5px 0;
            animation: slideIn 0.3s ease-out;
        }
        
        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-10px); }
            to { opacity: 1; transform: translateX(0); }
        }
        
        .chat-timestamp {
            color: #666;
            font-size: 0.85em;
        }
        
        .chat-info { color: #00aaff; text-shadow: 0 0 5px rgba(0, 170, 255, 0.5); }
        .chat-error { color: #ff0055; text-shadow: 0 0 5px rgba(255, 0, 85, 0.5); }
        .chat-chat { color: #ffffff; }
        .chat-system { color: #ffaa00; text-shadow: 0 0 5px rgba(255, 170, 0, 0.5); }
        
        .input-group {
            display: flex;
            gap: 10px;
        }
        
        input[type="text"], input[type="password"] {
            flex: 1;
            padding: 15px;
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(0, 255, 136, 0.3);
            border-radius: 10px;
            color: #fff;
            font-size: 14px;
            transition: all 0.3s;
        }
        
        input[type="text"]:focus, input[type="password"]:focus {
            outline: none;
            border-color: #00ff88;
            box-shadow: 0 0 20px rgba(0, 255, 136, 0.3);
            background: rgba(0, 0, 0, 0.8);
        }
        
        button {
            padding: 15px 30px;
            background: linear-gradient(135deg, #00ff88, #00dd77);
            border: none;
            border-radius: 10px;
            color: #000;
            font-weight: bold;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s;
            box-shadow: 0 0 20px rgba(0, 255, 136, 0.3);
        }
        
        button:hover {
            transform: translateY(-3px);
            box-shadow: 0 5px 30px rgba(0, 255, 136, 0.5);
        }
        
        button:active {
            transform: translateY(0);
        }
        
        button.danger {
            background: linear-gradient(135deg, #ff0055, #dd0044);
            box-shadow: 0 0 20px rgba(255, 0, 85, 0.3);
        }
        
        button.danger:hover {
            box-shadow: 0 5px 30px rgba(255, 0, 85, 0.5);
        }
        
        button.secondary {
            background: linear-gradient(135deg, #ff00ff, #dd00dd);
            box-shadow: 0 0 20px rgba(255, 0, 255, 0.3);
        }
        
        button.secondary:hover {
            box-shadow: 0 5px 30px rgba(255, 0, 255, 0.5);
        }
        
        .status-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 15px;
            margin-top: 15px;
        }
        
        .status-item {
            background: rgba(0, 0, 0, 0.6);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid rgba(0, 255, 136, 0.2);
            transition: all 0.3s;
        }
        
        .status-item:hover {
            border-color: #00ff88;
            background: rgba(0, 255, 136, 0.05);
            transform: translateY(-3px);
        }
        
        .status-label {
            color: #888;
            font-size: 0.9em;
            margin-bottom: 8px;
        }
        
        .status-value {
            color: #00ff88;
            font-size: 1.3em;
            font-weight: bold;
            text-shadow: 0 0 10px rgba(0, 255, 136, 0.5);
        }
        
        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }
        
        .button-group button {
            flex: 1;
        }
        
        #inventoryGrid {
            display: grid;
            grid-template-columns: repeat(9, 1fr);
            gap: 8px;
            margin-top: 15px;
        }
        
        .inventory-slot {
            aspect-ratio: 1;
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid rgba(0, 255, 136, 0.2);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            cursor: pointer;
            transition: all 0.3s;
            overflow: hidden;
        }
        
        .inventory-slot:hover {
            border-color: #00ff88;
            background: rgba(0, 255, 136, 0.1);
            transform: scale(1.05);
            box-shadow: 0 0 15px rgba(0, 255, 136, 0.4);
        }
        
        .inventory-slot.has-item {
            border-color: #00ff88;
            box-shadow: 0 0 10px rgba(0, 255, 136, 0.2);
        }
        
        .inventory-slot img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            image-rendering: pixelated;
            filter: drop-shadow(0 0 5px rgba(0, 255, 136, 0.3));
        }
        
        .item-count {
            position: absolute;
            bottom: 4px;
            right: 6px;
            font-size: 0.75em;
            color: #00ff88;
            text-shadow: 0 0 5px rgba(0, 255, 136, 0.8), 0 0 2px #000;
            font-weight: bold;
        }
        
        .error-message {
            color: #ff0055;
            text-align: center;
            margin-top: 15px;
            font-size: 0.9em;
            animation: shake 0.5s;
        }
        
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-10px); }
            75% { transform: translateX(10px); }
        }
        
        @media (max-width: 1024px) {
            .grid {
                grid-template-columns: 1fr;
            }
            
            .settings-panel {
                width: 100%;
                right: -100%;
            }
            
            #inventoryGrid {
                grid-template-columns: repeat(6, 1fr);
            }
        }
    </style>
</head>
<body>
    <div class="login-container" id="loginContainer">
        <div class="login-box">
            <div class="login-title">🎮 BAF</div>
            <div class="login-subtitle">AMOLED Control Panel</div>
            <form onsubmit="attemptLogin(event)">
                <div class="input-group" style="flex-direction: column; gap: 15px;">
                    <input type="password" id="passwordInput" placeholder="Enter password..." required />
                    <button type="submit" style="width: 100%;">🔓 Login</button>
                </div>
                <div id="loginError" class="error-message" style="display: none;"></div>
            </form>
        </div>
    </div>
    
    <div class="container" id="mainContainer">
        <div class="header">
            <div class="header-left">
                <img id="playerHead" class="player-head" src="" alt="Player" style="display: none;" />
                <div class="header-info">
                    <h1 id="headerUsername">BAF Control Panel</h1>
                    <p class="subtitle">Best Auto Flipper - AMOLED Edition</p>
                </div>
            </div>
            <div class="header-right">
                <div class="icon-btn" onclick="toggleSettings()" title="Settings">⚙️</div>
            </div>
        </div>
        
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
                    <button class="secondary" onclick="startBot()">Start Bot</button>
                </div>
                
                <h2 style="margin-top: 30px;">📦 Inventory</h2>
                <button onclick="loadInventory()" style="width: 100%; margin-bottom: 15px;">Refresh Inventory</button>
                <div id="inventoryGrid"></div>
            </div>
        </div>
    </div>
    
    <div class="settings-panel" id="settingsPanel">
        <div class="settings-title">⚙️ Settings</div>
        
        <div class="settings-group">
            <h3>🔒 Privacy Controls</h3>
            <div class="toggle-option">
                <span>Show Username</span>
                <div class="toggle-switch active" id="toggleUsername" onclick="togglePrivacy('username')"></div>
            </div>
            <div class="toggle-option">
                <span>Show Player Head</span>
                <div class="toggle-switch active" id="togglePlayerHead" onclick="togglePrivacy('playerHead')"></div>
            </div>
        </div>
        
        <button onclick="toggleSettings()" style="width: 100%; margin-top: 20px;">Close</button>
    </div>
    
    <script>
        let ws = null;
        let isAuthenticated = ${this.password ? 'false' : 'true'};
        let currentUsername = '';
        let privacySettings = {
            showUsername: localStorage.getItem('privacy_username') !== 'false',
            showPlayerHead: localStorage.getItem('privacy_playerHead') !== 'false'
        };
        
        function initPrivacySettings() {
            document.getElementById('toggleUsername').classList.toggle('active', privacySettings.showUsername);
            document.getElementById('togglePlayerHead').classList.toggle('active', privacySettings.showPlayerHead);
            updatePrivacyDisplay();
        }
        
        function togglePrivacy(setting) {
            if (setting === 'username') {
                privacySettings.showUsername = !privacySettings.showUsername;
                localStorage.setItem('privacy_username', privacySettings.showUsername);
                document.getElementById('toggleUsername').classList.toggle('active', privacySettings.showUsername);
            } else if (setting === 'playerHead') {
                privacySettings.showPlayerHead = !privacySettings.showPlayerHead;
                localStorage.setItem('privacy_playerHead', privacySettings.showPlayerHead);
                document.getElementById('togglePlayerHead').classList.toggle('active', privacySettings.showPlayerHead);
            }
            updatePrivacyDisplay();
        }
        
        function updatePrivacyDisplay() {
            const usernameEl = document.getElementById('headerUsername');
            const playerHeadEl = document.getElementById('playerHead');
            
            if (privacySettings.showUsername && currentUsername) {
                usernameEl.textContent = currentUsername;
            } else {
                usernameEl.textContent = 'BAF Control Panel';
            }
            
            if (privacySettings.showPlayerHead && currentUsername) {
                playerHeadEl.style.display = 'block';
                playerHeadEl.src = \`https://mc-heads.net/avatar/\${currentUsername}/64\`;
            } else {
                playerHeadEl.style.display = 'none';
            }
        }
        
        function toggleSettings() {
            document.getElementById('settingsPanel').classList.toggle('open');
        }
        
        function attemptLogin(event) {
            event.preventDefault();
            const password = document.getElementById('passwordInput').value;
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                showLoginError('Connecting to server...');
                setTimeout(() => attemptLogin(event), 1000);
                return;
            }
            
            ws.send(JSON.stringify({
                type: 'auth',
                password: password
            }));
        }
        
        function showLoginError(message) {
            const errorEl = document.getElementById('loginError');
            errorEl.textContent = message;
            errorEl.style.display = 'block';
        }
        
        function hideLogin() {
            document.getElementById('loginContainer').style.display = 'none';
            document.getElementById('mainContainer').style.display = 'block';
        }
        
        function connect() {
            ws = new WebSocket(\`ws://\${window.location.host}\`);
            
            ws.onopen = () => {
                console.log('Connected to BAF server');
                if (isAuthenticated) {
                    addSystemMessage('Connected to server');
                }
            };
            
            ws.onmessage = (event) => {
                const data = JSON.parse(event.data);
                handleMessage(data);
            };
            
            ws.onclose = () => {
                console.log('Disconnected from BAF server');
                if (isAuthenticated) {
                    addSystemMessage('Disconnected from server. Reconnecting...');
                }
                setTimeout(connect, 3000);
            };
            
            ws.onerror = (error) => {
                console.error('WebSocket error:', error);
            };
        }
        
        function handleMessage(data) {
            switch (data.type) {
                case 'authRequired':
                    isAuthenticated = false;
                    break;
                case 'authSuccess':
                    isAuthenticated = true;
                    hideLogin();
                    addSystemMessage('Authentication successful');
                    break;
                case 'authFailed':
                    showLoginError('Invalid password. Please try again.');
                    break;
                case 'init':
                    if (isAuthenticated) {
                        data.chatHistory.forEach(msg => addChatMessage(msg));
                        updateBotStatus(data.botStatus);
                    }
                    break;
                case 'chatMessage':
                    if (isAuthenticated) {
                        addChatMessage(data.message);
                    }
                    break;
                case 'statusUpdate':
                    if (isAuthenticated) {
                        updateBotStatus(data.status);
                    }
                    break;
                case 'inventory':
                    if (isAuthenticated) {
                        displayInventory(data.items);
                    }
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
            if (status.username) {
                currentUsername = status.username;
                updatePrivacyDisplay();
            }
            
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
            
            for (let i = 0; i < 36; i++) {
                const item = items.find(it => it.slot === i);
                const slot = document.createElement('div');
                slot.className = 'inventory-slot';
                
                if (item) {
                    slot.classList.add('has-item');
                    slot.title = \`\${item.displayName || item.name} x\${item.count}\`;
                    
                    const itemId = (item.name || 'stone').toLowerCase().replace(/[^a-z0-9_]/g, '_');
                    const img = document.createElement('img');
                    img.src = \`https://mc-heads.net/minecraft/item/\${itemId}\`;
                    img.onerror = function() {
                        this.style.display = 'none';
                        slot.textContent = item.name.substring(0, 3).toUpperCase();
                    };
                    slot.appendChild(img);
                    
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
        
        document.addEventListener('DOMContentLoaded', () => {
            const commandInput = document.getElementById('commandInput');
            commandInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    sendCommand();
                }
            });
            
            initPrivacySettings();
            
            if (!${this.password ? 'true' : 'false'}) {
                hideLogin();
            }
            
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
