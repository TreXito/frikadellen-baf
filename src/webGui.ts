import http from 'http'
import crypto from 'crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log } from './logger'
import { removeMinecraftColorCodes } from './utils'

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
                session.token = crypto.randomBytes(32).toString('hex')
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
                
                // Extract display name from NBT data if available
                let displayName = item.name
                try {
                    const nbtValue = item.nbt?.value as any
                    if (nbtValue?.display?.value?.Name?.value) {
                        displayName = removeMinecraftColorCodes(nbtValue.display.value.Name.value)
                    }
                } catch (e) {
                    // If NBT parsing fails, use the item name - this is expected for vanilla items
                    log(`Debug: Could not parse NBT for item ${item.name} at slot ${index}`, 'debug')
                }
                
                // Format item name for better display (remove minecraft: prefix, capitalize)
                const formattedName = item.name.replace('minecraft:', '')
                    .split('_')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                    .join(' ')
                
                return {
                    slot: index,
                    name: item.name,
                    count: item.count,
                    displayName: displayName !== item.name ? displayName : formattedName,
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
    <title>BAF - Control Panel</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #0a0e27 0%, #1a1a2e 50%, #16213e 100%);
            color: #e0e0e0;
            padding: 20px;
            overflow-x: hidden;
            min-height: 100vh;
        }
        
        .login-container {
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            background: radial-gradient(circle at 50% 50%, rgba(52, 152, 219, 0.1) 0%, transparent 50%);
        }
        
        .login-box {
            background: rgba(26, 26, 46, 0.95);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(52, 152, 219, 0.3);
            border-radius: 16px;
            padding: 48px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            max-width: 420px;
            width: 100%;
            transition: all 0.3s ease;
        }
        
        .login-box:hover {
            box-shadow: 0 12px 48px rgba(52, 152, 219, 0.2);
            transform: translateY(-2px);
        }
        
        .login-title {
            font-size: 2.5em;
            text-align: center;
            margin-bottom: 12px;
            background: linear-gradient(135deg, #3498db 0%, #2ecc71 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            font-weight: 700;
            letter-spacing: -1px;
        }
        
        .login-subtitle {
            text-align: center;
            color: #8892a6;
            margin-bottom: 32px;
            font-size: 1em;
            font-weight: 400;
        }
        
        .container {
            max-width: 1600px;
            margin: 0 auto;
            display: none;
            animation: fadeIn 0.6s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(30px); }
            to { opacity: 1; transform: translateY(0); }
        }
        
        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 32px;
            padding: 24px 32px;
            background: rgba(26, 26, 46, 0.95);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(52, 152, 219, 0.2);
            border-radius: 16px;
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
            transition: all 0.3s ease;
        }
        
        .header:hover {
            box-shadow: 0 6px 32px rgba(52, 152, 219, 0.15);
        }
        
        .header-left {
            display: flex;
            align-items: center;
            gap: 20px;
        }
        
        .player-head {
            width: 64px;
            height: 64px;
            border-radius: 12px;
            border: 2px solid rgba(52, 152, 219, 0.5);
            box-shadow: 0 4px 16px rgba(52, 152, 219, 0.2);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .player-head:hover {
            transform: scale(1.05);
            box-shadow: 0 8px 24px rgba(52, 152, 219, 0.4);
            border-color: rgba(52, 152, 219, 0.8);
        }
        
        .header-info h1 {
            font-size: 1.75em;
            background: linear-gradient(135deg, #3498db 0%, #2ecc71 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 4px;
            font-weight: 700;
            letter-spacing: -0.5px;
        }
        
        .header-info .subtitle {
            color: #8892a6;
            font-size: 0.875em;
            font-weight: 400;
        }
        
        .header-right {
            display: flex;
            gap: 12px;
        }
        
        .icon-btn {
            width: 48px;
            height: 48px;
            background: rgba(52, 152, 219, 0.1);
            border: 1px solid rgba(52, 152, 219, 0.3);
            border-radius: 12px;
            display: flex;
            align-items: center;
            justify-content: center;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-size: 1.5em;
        }
        
        .icon-btn:hover {
            background: rgba(52, 152, 219, 0.2);
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(52, 152, 219, 0.25);
            border-color: rgba(52, 152, 219, 0.5);
        }
        
        .icon-btn:active {
            transform: translateY(0);
        }
        
        .settings-panel {
            position: fixed;
            top: 0;
            right: -420px;
            width: 420px;
            height: 100vh;
            background: rgba(26, 26, 46, 0.98);
            backdrop-filter: blur(30px);
            border-left: 1px solid rgba(52, 152, 219, 0.3);
            box-shadow: -8px 0 40px rgba(0, 0, 0, 0.5);
            padding: 32px;
            transition: right 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            z-index: 1000;
            overflow-y: auto;
        }
        
        .settings-panel.open {
            right: 0;
        }
        
        .settings-title {
            font-size: 1.5em;
            color: #3498db;
            margin-bottom: 32px;
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 600;
        }
        
        .settings-group {
            margin-bottom: 32px;
        }
        
        .settings-group h3 {
            color: #3498db;
            margin-bottom: 16px;
            font-size: 1.1em;
            font-weight: 600;
        }
        
        .toggle-option {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px;
            background: rgba(52, 152, 219, 0.05);
            border: 1px solid rgba(52, 152, 219, 0.2);
            border-radius: 12px;
            margin-bottom: 12px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .toggle-option:hover {
            background: rgba(52, 152, 219, 0.1);
            border-color: rgba(52, 152, 219, 0.4);
        }
        
        .toggle-switch {
            position: relative;
            width: 56px;
            height: 28px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 14px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .toggle-switch.active {
            background: linear-gradient(135deg, #3498db, #2ecc71);
            box-shadow: 0 4px 16px rgba(52, 152, 219, 0.4);
        }
        
        .toggle-switch::after {
            content: '';
            position: absolute;
            width: 22px;
            height: 22px;
            background: white;
            border-radius: 50%;
            top: 3px;
            left: 3px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        }
        
        .toggle-switch.active::after {
            left: 31px;
        }
        
        .grid {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 24px;
            margin-bottom: 24px;
        }
        
        .panel {
            background: rgba(26, 26, 46, 0.95);
            backdrop-filter: blur(20px);
            border-radius: 16px;
            padding: 28px;
            border: 1px solid rgba(52, 152, 219, 0.2);
            box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .panel:hover {
            border-color: rgba(52, 152, 219, 0.4);
            box-shadow: 0 6px 32px rgba(52, 152, 219, 0.15);
            transform: translateY(-2px);
        }
        
        .panel h2 {
            color: #3498db;
            margin-bottom: 24px;
            font-size: 1.375em;
            display: flex;
            align-items: center;
            gap: 12px;
            font-weight: 600;
            text-shadow: none;
        }
        
        .status-indicator {
            width: 12px;
            height: 12px;
            border-radius: 50%;
            display: inline-block;
            animation: pulse 2s ease-in-out infinite;
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.15); opacity: 0.7; }
        }
        
        .status-online {
            background: #2ecc71;
            box-shadow: 0 0 12px rgba(46, 204, 113, 0.6);
        }
        
        .status-offline {
            background: #e74c3c;
            box-shadow: 0 0 12px rgba(231, 76, 60, 0.6);
        }
        
        #chatBox {
            background: rgba(16, 16, 28, 0.8);
            border: 1px solid rgba(52, 152, 219, 0.2);
            border-radius: 12px;
            height: 500px;
            overflow-y: auto;
            padding: 16px;
            margin-bottom: 16px;
            font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.7;
            box-shadow: inset 0 2px 12px rgba(0, 0, 0, 0.3);
        }
        
        #chatBox::-webkit-scrollbar {
            width: 6px;
        }
        
        #chatBox::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.2);
            border-radius: 3px;
        }
        
        #chatBox::-webkit-scrollbar-thumb {
            background: linear-gradient(180deg, #3498db, #2ecc71);
            border-radius: 3px;
        }
        
        #chatBox::-webkit-scrollbar-thumb:hover {
            background: linear-gradient(180deg, #5dade2, #58d68d);
        }
        
        .chat-message {
            margin-bottom: 6px;
            padding: 6px 0;
            animation: slideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        @keyframes slideIn {
            from { opacity: 0; transform: translateX(-20px); }
            to { opacity: 1; transform: translateX(0); }
        }
        
        .chat-timestamp {
            color: #5a6c7d;
            font-size: 0.85em;
            margin-right: 8px;
        }
        
        .chat-info { color: #3498db; }
        .chat-error { color: #e74c3c; }
        .chat-chat { color: #ecf0f1; }
        .chat-system { color: #f39c12; }
        
        .input-group {
            display: flex;
            gap: 12px;
        }
        
        input[type="text"], input[type="password"] {
            flex: 1;
            padding: 14px 16px;
            background: rgba(16, 16, 28, 0.8);
            border: 1px solid rgba(52, 152, 219, 0.3);
            border-radius: 12px;
            color: #ecf0f1;
            font-size: 14px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            font-family: inherit;
        }
        
        input[type="text"]:focus, input[type="password"]:focus {
            outline: none;
            border-color: #3498db;
            box-shadow: 0 4px 16px rgba(52, 152, 219, 0.25);
            background: rgba(0, 0, 0, 0.8);
        }
        
        button {
            padding: 14px 28px;
            background: linear-gradient(135deg, #3498db, #2ecc71);
            border: none;
            border-radius: 12px;
            color: #ffffff;
            font-weight: 600;
            cursor: pointer;
            font-size: 14px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 16px rgba(52, 152, 219, 0.3);
            font-family: inherit;
        }
        
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 24px rgba(52, 152, 219, 0.4);
        }
        
        button:active {
            transform: translateY(0);
        }
        
        button.danger {
            background: linear-gradient(135deg, #e74c3c, #c0392b);
            box-shadow: 0 4px 16px rgba(231, 76, 60, 0.3);
        }
        
        button.danger:hover {
            box-shadow: 0 6px 24px rgba(231, 76, 60, 0.4);
        }
        
        button.secondary {
            background: linear-gradient(135deg, #9b59b6, #8e44ad);
            box-shadow: 0 4px 16px rgba(155, 89, 182, 0.3);
        }
        
        button.secondary:hover {
            box-shadow: 0 6px 24px rgba(155, 89, 182, 0.4);
        }
        
        .status-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 16px;
            margin-top: 16px;
        }
        
        .status-item {
            background: rgba(16, 16, 28, 0.8);
            padding: 20px;
            border-radius: 12px;
            border: 1px solid rgba(52, 152, 219, 0.2);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        .status-item:hover {
            border-color: rgba(52, 152, 219, 0.5);
            background: rgba(52, 152, 219, 0.05);
            transform: translateY(-2px);
        }
        
        .status-label {
            color: #8892a6;
            font-size: 0.875em;
            margin-bottom: 8px;
            font-weight: 500;
        }
        
        .status-value {
            color: #3498db;
            font-size: 1.25em;
            font-weight: 600;
        }
        
        .button-group {
            display: flex;
            gap: 12px;
            margin-top: 24px;
        }
        
        .button-group button {
            flex: 1;
        }
        
        #inventoryGrid {
            display: grid;
            grid-template-columns: repeat(9, 1fr);
            gap: 8px;
            margin-top: 16px;
        }
        
        .inventory-slot {
            aspect-ratio: 1;
            background: rgba(16, 16, 28, 0.8);
            border: 1px solid rgba(52, 152, 219, 0.2);
            border-radius: 8px;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            overflow: hidden;
        }
        
        .inventory-slot:hover {
            border-color: rgba(52, 152, 219, 0.6);
            background: rgba(52, 152, 219, 0.1);
            transform: scale(1.05);
            box-shadow: 0 4px 16px rgba(52, 152, 219, 0.3);
        }
        
        .inventory-slot.has-item {
            border-color: rgba(46, 204, 113, 0.5);
            box-shadow: 0 2px 8px rgba(46, 204, 113, 0.2);
        }
        
        .inventory-slot img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            image-rendering: pixelated;
        }
        
        .item-count {
            position: absolute;
            bottom: 4px;
            right: 6px;
            font-size: 0.75em;
            color: #ffffff;
            text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.8);
            font-weight: 700;
            background: rgba(0, 0, 0, 0.6);
            padding: 2px 6px;
            border-radius: 4px;
        }
        
        .error-message {
            color: #e74c3c;
            text-align: center;
            margin-top: 16px;
            font-size: 0.9em;
            animation: shake 0.5s cubic-bezier(0.4, 0, 0.2, 1);
        }
        
        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-8px); }
            75% { transform: translateX(8px); }
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
            <div class="login-subtitle">Control Panel</div>
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
                    <p class="subtitle">Best Auto Flipper for Hypixel Skyblock</p>
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
        
        let loginRetries = 0;
        const maxLoginRetries = 10;
        
        function attemptLogin(event) {
            event.preventDefault();
            const password = document.getElementById('passwordInput').value;
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                if (loginRetries < maxLoginRetries) {
                    loginRetries++;
                    showLoginError('Connecting to server...');
                    setTimeout(() => attemptLogin(event), 1000);
                } else {
                    showLoginError('Failed to connect to server. Please refresh the page.');
                }
                return;
            }
            
            loginRetries = 0;
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
            
            // Try to parse message as JSON to check for rich message data
            let messageContent = msg.message;
            try {
                const richData = JSON.parse(msg.message);
                if (richData && typeof richData === 'object' && richData.text) {
                    // This is a rich message with potential onClick and hover
                    const textSpan = document.createElement('span');
                    textSpan.textContent = richData.text;
                    textSpan.style.cursor = richData.onClick ? 'pointer' : 'default';
                    
                    if (richData.onClick) {
                        textSpan.style.textDecoration = 'underline';
                        textSpan.style.color = '#3498db';
                        textSpan.title = richData.hover || 'Click to execute: ' + richData.onClick;
                        textSpan.onclick = function() {
                            if (richData.onClick) {
                                sendCommand(richData.onClick);
                            }
                        };
                    } else if (richData.hover) {
                        textSpan.title = richData.hover;
                    }
                    
                    div.innerHTML = \`<span class="chat-timestamp">[\${time}]</span> \`;
                    div.appendChild(textSpan);
                } else {
                    // Not a rich message, display normally
                    div.innerHTML = \`<span class="chat-timestamp">[\${time}]</span> \${escapeHtml(messageContent)}\`;
                }
            } catch (e) {
                // Not JSON or parsing failed, display as plain text
                div.innerHTML = \`<span class="chat-timestamp">[\${time}]</span> \${escapeHtml(messageContent)}\`;
            }
            
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
                    
                    const img = document.createElement('img');
                    img.style.width = '100%';
                    img.style.height = '100%';
                    img.style.imageRendering = 'pixelated';
                    
                    // Try multiple icon sources for better coverage
                    const itemId = item.itemId || (item.name || 'stone').toLowerCase().replace(/[^a-z0-9_]/g, '_');
                    const iconSources = [
                        \`https://sky.coflnet.com/static/icon/\${itemId}\`,
                        \`https://mc-heads.net/minecraft/item/\${itemId}\`,
                        \`https://sky.shiiyu.moe/item/\${itemId}\`
                    ];
                    
                    let sourceIndex = 0;
                    img.src = iconSources[sourceIndex];
                    
                    img.onerror = function() {
                        sourceIndex++;
                        if (sourceIndex < iconSources.length) {
                            this.src = iconSources[sourceIndex];
                        } else {
                            // All sources failed, show text fallback
                            this.style.display = 'none';
                            const fallback = document.createElement('div');
                            fallback.style.cssText = 'font-size: 10px; text-align: center; color: #888;';
                            fallback.textContent = itemId.substring(0, 3).toUpperCase();
                            slot.appendChild(fallback);
                        }
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
        
        function sendCommand(cmd) {
            const input = document.getElementById('commandInput');
            const command = cmd || input.value.trim();
            
            if (command && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'command',
                    command: command
                }));
                if (!cmd) {
                    input.value = '';
                }
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
