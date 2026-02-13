import { createBot } from 'mineflayer'
import { createFastWindowClicker } from './fastWindowClick'
import { initLogger, log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, isCoflChatMessage, removeMinecraftColorCodes, sleep } from './utils'
import { onWebsocketCreateAuction } from './sellHandler'
import { tradePerson } from './tradeHandler'
import { swapProfile } from './swapProfileHandler'
import { AutoBuy, addAutoBuyHelpers, onItemWhitelistedMessage, getWhitelistedData } from './autoBuy'
import { StateManager } from './stateManager'
import { SocketWrapper } from './socketWrapper'
import { claimSoldItem, registerIngameMessageHandler } from './ingameMessageHandler'
import { MyBot, TextMessageData } from '../types/autobuy'
import { getConfigProperty, initConfigHelper, updatePersistentConfigProperty } from './configHelper'
import { getSessionId } from './coflSessionManager'
import { sendWebhookInitialized, sendWebhookStartupComplete } from './webhookHandler'
import { handleCommand, setupConsoleInterface } from './consoleHandler'
import { initAFKHandler, tryToTeleportToIsland } from './AFKHandler'
import { runSequence } from './sequenceRunner'
import { handleBazaarFlipRecommendation, parseBazaarFlipMessage, parseBazaarFlipJson } from './bazaarFlipHandler'
import { checkAndPauseForAHFlip } from './bazaarFlipPauser'
import { startWebGui, addWebGuiChatMessage } from './webGui'
import { initAccountSwitcher } from './accountSwitcher'
import { getProxyConfig } from './proxyHelper'
import { checkAndBuyCookie } from './cookieHandler'
import { startOrderManager, discoverExistingOrders, startupOrderManagement } from './bazaarOrderManager'
import { initCommandQueue, enqueueCommand, CommandPriority } from './commandQueue'
import { startProfitReportTimer } from './bazaarProfitTracker'
const WebSocket = require('ws')
const EventEmitter = require('events')
var prompt = require('prompt-sync')()
initConfigHelper()
initLogger()
const version = 'af-3.0'
const GUI_LOG_DELAY_MS = 100
let _websocket: WebSocket
let bot: MyBot
let autoBuyInstance: AutoBuy | null = null
let socketWrapper: SocketWrapper | null = null
let ingameName = getConfigProperty('INGAME_NAME')

// Store Coflnet premium information
let coflnetPremiumTier: string | null = null
let coflnetPremiumExpires: string | null = null
let coflnetConnectionId: string | null = null

// Store current purse amount (Feature 6)
let currentPurse: number = 0

// Bazaar flip request interval (Feature 5)
let bazaarFlipRequestInterval: NodeJS.Timeout | null = null

// Bot start time for uptime tracking
let botStartTime: number = Date.now()

if (!ingameName) {
    ingameName = prompt('Enter your ingame name: ')
    updatePersistentConfigProperty('INGAME_NAME', ingameName)
}

// Prompt for auction house flips setting if not set
if (getConfigProperty('ENABLE_AH_FLIPS') === undefined) {
    let enableAHFlips = prompt('Enable auction house flips (true/false)? ').toLowerCase()
    updatePersistentConfigProperty('ENABLE_AH_FLIPS', enableAHFlips === 'true' || enableAHFlips === 't' || enableAHFlips === 'yes' || enableAHFlips === 'y')
}

// Prompt for bazaar flips setting if not set
if (getConfigProperty('ENABLE_BAZAAR_FLIPS') === undefined) {
    let enableBazaarFlips = prompt('Enable bazaar flips (true/false)? ').toLowerCase()
    updatePersistentConfigProperty('ENABLE_BAZAAR_FLIPS', enableBazaarFlips === 'true' || enableBazaarFlips === 't' || enableBazaarFlips === 'yes' || enableBazaarFlips === 'y')
}

// Prompt for web GUI port if not set
if (getConfigProperty('WEB_GUI_PORT') === undefined) {
    let port = prompt('Web GUI port (default 8080, press Enter to skip)? ')
    if (port && port.trim()) {
        updatePersistentConfigProperty('WEB_GUI_PORT', parseInt(port) || 8080)
    } else {
        updatePersistentConfigProperty('WEB_GUI_PORT', 8080)
    }
}

log(`Starting BAF v${version} for ${ingameName}`, 'info')
log(`AH Flips: ${getConfigProperty('ENABLE_AH_FLIPS') ? 'ENABLED' : 'DISABLED'}`, 'info')
log(`Bazaar Flips: ${getConfigProperty('ENABLE_BAZAAR_FLIPS') ? 'ENABLED' : 'DISABLED'}`, 'info')

// Initialize account switcher if configured
const accountSwitchingEnabled = initAccountSwitcher((username) => {
    log(`Account switch requested to: ${username}`, 'info')
    switchAccount(username)
})

if (accountSwitchingEnabled) {
    log('Account switching is ENABLED', 'info')
} else {
    log('Account switching is DISABLED', 'info')
}

// Create initial bot instance
createBotInstance(ingameName)

function createBotInstance(username: string) {
    log(`Creating bot instance for ${username}`, 'info')
    
    // Build bot options - using any type as mineflayer's BotOptions doesn't expose all internal options
    const botOptions: any = {
        username: username,
        auth: 'microsoft',
        logErrors: true,
        version: '1.8.9',
        host: 'mc.hypixel.net'
    }
    
    // Add proxy configuration if enabled
    const proxyConfig = getProxyConfig()
    if (proxyConfig) {
        // Custom connect function for SOCKS5 proxy support
        botOptions.connect = (client: any) => {
            // For SOCKS proxy support with mineflayer
            // This requires the socks module
            try {
                const SocksClient = require('socks').SocksClient
                const options = {
                    proxy: {
                        host: proxyConfig.host,
                        port: proxyConfig.port,
                        type: 5, // SOCKS5
                        userId: proxyConfig.username,
                        password: proxyConfig.password
                    },
                    command: 'connect',
                    destination: {
                        host: 'mc.hypixel.net',
                        port: 25565
                    }
                }
                
                SocksClient.createConnection(options).then((info: any) => {
                    client.setSocket(info.socket)
                    client.emit('connect')
                }).catch((err: any) => {
                    log(`Proxy connection error: ${err}`, 'error')
                    client.emit('error', err)
                })
            } catch (error) {
                log(`Failed to use proxy. Make sure 'socks' module is installed: npm install socks`, 'error')
                log(`Error: ${error}`, 'error')
            }
        }
    }
    
    bot = createBot(botOptions)
    
    bot.setMaxListeners(0)
    bot.state = 'gracePeriod'
    createFastWindowClicker(bot._client)
    
    // Add AutoBuy helper methods to bot
    addAutoBuyHelpers(bot)
    
    // Initialize socket wrapper and AutoBuy instance
    if (!socketWrapper) {
        socketWrapper = new SocketWrapper()
    }
    
    const stateManager = new StateManager()
    autoBuyInstance = new AutoBuy(
        bot,
        null, // webhook
        socketWrapper,
        username,
        stateManager,
        null, // relist
        null  // bank
    )
    
    setupBotHandlers()
}

function setupBotHandlers() {
    // Log packets
    //addLoggerToClientWriteFunction(bot._client)
    
    bot.on('kicked', (reason,_)=>log(reason, 'warn'))
    bot.on('error', log)

    // Global GUI logging to track every window the bot sees
    const guiWindowLogger = (packet) => {
        const rawTitle = JSON.stringify(packet?.windowTitle)
        log(`[GUIDebug] open_window id=${packet?.windowId} type=${packet?.windowType} rawTitle=${rawTitle}`, 'info')
        setTimeout(() => {
            if (bot.currentWindow) {
                log(`[GUIDebug] currentWindow title="${getWindowTitle(bot.currentWindow)}" slots=${bot.currentWindow.slots.length}`, 'info')
            } else {
                log('[GUIDebug] currentWindow is null after open_window packet', 'warn')
            }
        }, GUI_LOG_DELAY_MS)
    }
    const guiCloseLogger = (window) => {
        if (!window) return
        log(`[GUIDebug] windowClose id=${(window as any)?.id ?? 'unknown'} title="${getWindowTitle(window)}"`, 'info')
    }
    bot._client.on('open_window', guiWindowLogger)
    bot.on('windowClose', guiCloseLogger)

    bot.once('login', () => {
        log(`Logged in as ${bot.username}`)
        
        // Log configuration for diagnostics
        const bazaarFlipsEnabled = getConfigProperty('ENABLE_BAZAAR_FLIPS')
        const ahFlipsEnabled = getConfigProperty('ENABLE_AH_FLIPS')
        log(`[Config] Bazaar Flips: ${bazaarFlipsEnabled ? 'ENABLED' : 'DISABLED'}`, 'info')
        log(`[Config] AH Flips: ${ahFlipsEnabled ? 'ENABLED' : 'DISABLED'}`, 'info')
        
        // Format status message with colors
        const bzColor = bazaarFlipsEnabled ? 'a' : 'c'
        const bzStatus = bazaarFlipsEnabled ? 'ENABLED' : 'DISABLED'
        const ahColor = ahFlipsEnabled ? 'a' : 'c'
        const ahStatus = ahFlipsEnabled ? 'ENABLED' : 'DISABLED'
        printMcChatToConsole(`§f[§4BAF§f]: §7Configuration - Bazaar Flips: §${bzColor}${bzStatus}§7, AH Flips: §${ahColor}${ahStatus}`)
        
        // Start web GUI if port is configured
        const webGuiPort = getConfigProperty('WEB_GUI_PORT')
        if (webGuiPort) {
            try {
                startWebGui(bot)
            } catch (error) {
                log(`Failed to start web GUI: ${error}`, 'error')
            }
        }
        
        connectWebsocket()
        bot._client.on('packet', async function (packet, packetMeta) {
            if (packetMeta.name.includes('disconnect')) {
                let wss = await getCurrentWebsocket()
                wss.send(
                    JSON.stringify({
                        type: 'report',
                        data: `"${JSON.stringify(packet)}"`
                    })
                )
                printMcChatToConsole('§f[§4BAF§f]: §fYou were disconnected from the server...')
                printMcChatToConsole('§f[§4BAF§f]: §f' + JSON.stringify(packet))
            }
        })
    })

    bot.once('spawn', async () => {
        await bot.waitForChunksToLoad()
        await sleep(2000)
        bot.chat('/play sb')
        bot.on('scoreboardTitleChanged', onScoreboardChanged)
        registerIngameMessageHandler(bot)
        
        // Initialize AFK handler after a delay to ensure it runs even if the bot doesn't join SkyBlock immediately
        // This is a fallback to handle cases where the bot stays in lobby
        setTimeout(() => {
            if (!(bot as any).AFKHandlerInitialized) {
                log('Initializing AFK handler as fallback', 'info')
                initAFKHandler(bot)
                ;(bot as any).AFKHandlerInitialized = true
            }
        }, 15000)
    })

    bot.on('end', (reason) => {
        console.log(`Bot disconnected. Reason: ${reason}`);
        log(`Bot disconnected. Reason: ${reason}`, 'warn')
    })
}

/**
 * Switches to a different account by disconnecting and reconnecting
 */
function switchAccount(newUsername: string) {
    log(`Switching from ${bot.username} to ${newUsername}`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §6Switching to account: ${newUsername}`)
    
    // Close websocket without auto-reconnect by removing the reconnect handler
    if (_websocket) {
        _websocket.onclose = () => {} // Prevent auto-reconnect during account switch
        _websocket.close()
    }
    
    // Disconnect bot
    if (bot) {
        bot.removeAllListeners()
        bot.quit()
    }
    
    // Wait a bit before reconnecting
    setTimeout(() => {
        ingameName = newUsername
        createBotInstance(newUsername)
    }, 2000)
}

function connectWebsocket(url: string = getConfigProperty('WEBSOCKET_URL')) {
    log(`Called connectWebsocket for ${url}`)
    _websocket = new WebSocket(`${url}?player=${bot.username}&version=${version}&SId=${getSessionId(ingameName)}`)
    _websocket.onopen = function () {
        log(`Opened websocket to ${url}`)
        setupConsoleInterface(bot)
        sendWebhookInitialized()
        updatePersistentConfigProperty('WEBSOCKET_URL', url)
    }
    _websocket.onmessage = function (msg) {
        try {
            onWebsocketMessage(msg)
        } catch (e) {
            log('Error while handling websocket message: ' + e, 'error')
            log('Message: ' + JSON.stringify(msg), 'error')
        }
    }
    _websocket.onclose = function (e) {
        printMcChatToConsole('§f[§4BAF§f]: §4Connection closed. Reconnecting...')
        log('Connection closed. Reconnecting... ', 'warn')
        setTimeout(function () {
            connectWebsocket()
        }, 1000)
    }
    _websocket.onerror = function (err) {
        log('Connection error: ' + JSON.stringify(err), 'error')
        _websocket.close()
    }
}

async function onWebsocketMessage(msg) {
    let message = JSON.parse(msg.data)
    let data = JSON.parse(message.data)
    
    // Log ALL message types for diagnostics (helps identify if bazaar flip messages are being sent)
    // This is especially useful for debugging bazaar flip issues
    log(`[WebSocket] Received message type: ${message.type}`, 'debug')

    switch (message.type) {
        case 'flip':
            log(message, 'debug')
            // Emit flip event through socket wrapper for AutoBuy class
            if (socketWrapper) {
                socketWrapper.emitFlip(data)
            }
            break
        case 'chatMessage':
            if (data.length > 1 && data[1].text.includes('matched your Whitelist entry:') && !isCoflChatMessage(data[1].text)) {
                onItemWhitelistedMessage(data[1].text)
            }

            for (let da of [...(data as TextMessageData[])]) {
                // Inject referral ID into Coflnet auth URLs
                if (da.text && da.text.includes('sky.coflnet.com/authmod?') && !da.text.includes('refId=')) {
                    da.text = da.text.replace(/(&amp;conId=)/, '&amp;refId=9KKPN9$1')
                }
                if (da.onClick && da.onClick.includes('sky.coflnet.com/authmod?') && !da.onClick.includes('refId=')) {
                    da.onClick = da.onClick.replace(/(&amp;conId=)/, '&amp;refId=9KKPN9$1')
                }
                if (da.hover && da.hover.includes('sky.coflnet.com/authmod?') && !da.hover.includes('refId=')) {
                    da.hover = da.hover.replace(/(&amp;conId=)/, '&amp;refId=9KKPN9$1')
                }
                
                let isCoflChat = isCoflChatMessage(da.text)
                if (!isCoflChat) {
                    log(message, 'debug')
                }
                
                // Extract Coflnet connection ID
                const connectionIdMatch = da.text.match(/Your connection id is ([a-f0-9]{32})/)
                if (connectionIdMatch) {
                    coflnetConnectionId = connectionIdMatch[1]
                    log(`[Coflnet] Connection ID: ${coflnetConnectionId}`, 'info')
                }
                
                // Check if this is an AH flip incoming message and pause if needed
                checkAndPauseForAHFlip(da.text, getConfigProperty('ENABLE_BAZAAR_FLIPS'), getConfigProperty('ENABLE_AH_FLIPS'), bot)
                
                // BUG 2 FIX: Ignore bazaar flips during startup
                if (bot.state === 'startup') {
                    log('[Websocket] Ignoring bazaar flip during startup', 'debug')
                } else {
                    // Check if this is a bazaar flip recommendation
                    const bazaarFlip = parseBazaarFlipMessage(da.text)
                    if (bazaarFlip) {
                        log('[BazaarDebug] Detected bazaar flip recommendation from chat message', 'info')
                        log(`[BazaarDebug] Parsed: ${bazaarFlip.amount}x ${bazaarFlip.itemName} @ ${bazaarFlip.pricePerUnit.toFixed(1)} coins`, 'info')
                        handleBazaarFlipRecommendation(bot, bazaarFlip)
                    }
                }
                
                if (getConfigProperty('USE_COFL_CHAT') || !isCoflChat) {
                    printMcChatToConsole(da.text)
                    
                    // Send rich message data to web GUI if available
                    if (da.onClick || da.hover) {
                        try {
                            const cleanText = removeMinecraftColorCodes(da.text)
                            const cleanHover = da.hover ? removeMinecraftColorCodes(da.hover) : undefined
                            addWebGuiChatMessage(JSON.stringify({
                                text: cleanText,
                                onClick: da.onClick,
                                hover: cleanHover
                            }), 'chat')
                        } catch (e) {
                            // Web GUI not available, ignore
                        }
                    }
                }
            }
            break
        case 'writeToChat':
            // Inject referral ID into Coflnet auth URLs
            if (data.text && data.text.includes('sky.coflnet.com/authmod?') && !data.text.includes('refId=')) {
                data.text = data.text.replace(/(&amp;conId=)/, '&amp;refId=9KKPN9$1')
            }
            
            let isCoflChat = isCoflChatMessage(data.text)
            if (!isCoflChat) {
                log(message, 'debug')
            }
            
            // Extract Coflnet premium tier and expiration date
            // Message format: "You have Premium until 2026-Feb-10 08:55 UTC"
            const premiumMatch = data.text.match(/You have (.+?) until (.+?)(?:\\n|$)/)
            if (premiumMatch) {
                coflnetPremiumTier = premiumMatch[1].trim()
                coflnetPremiumExpires = premiumMatch[2].trim()
                log(`[Coflnet] Premium: ${coflnetPremiumTier} until ${coflnetPremiumExpires}`, 'info')
            }
            
            // Check if this is an AH flip incoming message and pause if needed
            checkAndPauseForAHFlip(data.text, getConfigProperty('ENABLE_BAZAAR_FLIPS'), getConfigProperty('ENABLE_AH_FLIPS'), bot)
            
            // BUG 2 FIX: Ignore bazaar flips during startup
            if (bot.state === 'startup') {
                log('[Websocket] Ignoring bazaar flip during startup', 'debug')
            } else {
                // Check if this is a bazaar flip recommendation
                const bazaarFlip = parseBazaarFlipMessage(data.text)
                if (bazaarFlip) {
                    log('[BazaarDebug] Detected bazaar flip recommendation from writeToChat message', 'info')
                    log(`[BazaarDebug] Parsed: ${bazaarFlip.amount}x ${bazaarFlip.itemName} @ ${bazaarFlip.pricePerUnit.toFixed(1)} coins`, 'info')
                    handleBazaarFlipRecommendation(bot, bazaarFlip)
                }
            }
            
            if (getConfigProperty('USE_COFL_CHAT') || !isCoflChat) {
                printMcChatToConsole((data as TextMessageData).text)
            }
            break
        case 'swapProfile':
            log(message, 'debug')
            swapProfile(bot, data)

            break
        case 'createAuction':
            log(message, 'debug')
            onWebsocketCreateAuction(bot, data)
            break
        case 'trade':
            log(message, 'debug')
            tradePerson(bot, data)
            break
        case 'tradeResponse':
            let tradeDisplay = (bot.currentWindow.slots[39].nbt.value as any).display.value.Name.value
            if (tradeDisplay.includes('Deal!') || tradeDisplay.includes('Warning!')) {
                await sleep(3400)
            }
            clickWindow(bot, 39).catch(err => log(`Error clicking trade response slot: ${err}`, 'error'))
            break
        case 'getInventory':
            log('Uploading inventory...')
            let wss = await getCurrentWebsocket()
            wss.send(
                JSON.stringify({
                    type: 'uploadInventory',
                    data: JSON.stringify(bot.inventory)
                })
            )
            break
        case 'execute':
            log(message, 'debug')
            handleCommand(bot, data, true) // Prevent echo loop
            break
        case 'runSequence':
            log(message, 'debug')
            break
        case 'privacySettings':
            log(message, 'debug')
            data.chatRegex = new RegExp(data.chatRegex)
            bot.privacySettings = data
            break
        case 'bazaarFlip':
            log(message, 'debug')
            // BUG 2 FIX: Ignore bazaar flips during startup
            if (bot.state === 'startup') {
                log('[Websocket] Ignoring bazaarFlip during startup', 'debug')
                break
            }
            const parsedBazaarFlip = parseBazaarFlipJson(data)
            if (parsedBazaarFlip) {
                handleBazaarFlipRecommendation(bot, parsedBazaarFlip)
            } else {
                log(`Failed to parse bazaar flip data from websocket: ${JSON.stringify(data)}`, 'error')
            }
            break
        case 'placeOrder':
            log(`[BazaarDebug] ===== RECEIVED placeOrder MESSAGE =====`, 'info')
            log(`[BazaarDebug] Raw data type: ${typeof data}`, 'info')
            log(`[BazaarDebug] Raw data: ${JSON.stringify(data)}`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §7[Websocket] Received bazaar flip recommendation`)
            
            // BUG 2 FIX: Ignore placeOrder during startup
            if (bot.state === 'startup') {
                log('[Websocket] Ignoring placeOrder during startup', 'debug')
                printMcChatToConsole(`§f[§4BAF§f]: §e[Startup] Ignoring flip during startup`)
                break
            }
            
            if (!bot || !bot.username) {
                log('[BazaarDebug] Bot not initialized, ignoring placeOrder', 'warn')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Bot not initialized, cannot process recommendation`)
                break
            }
            
            const placeOrderParsed = typeof data === 'string' ? JSON.parse(data) : data
            const placeOrderFlip = parseBazaarFlipJson(placeOrderParsed)
            if (placeOrderFlip) {
                log(`[BazaarDebug] Successfully parsed placeOrder: ${placeOrderFlip.amount}x ${placeOrderFlip.itemName} at ${placeOrderFlip.pricePerUnit.toFixed(1)} coins (${placeOrderFlip.isBuyOrder ? 'BUY' : 'SELL'})`, 'info')
                handleBazaarFlipRecommendation(bot, placeOrderFlip)
            } else {
                log(`[BazaarDebug] ERROR: Failed to parse placeOrder data: ${JSON.stringify(data)}`, 'error')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Failed to parse bazaar flip data`)
            }
            break
        case 'bzRecommend':
            log(`[BazaarDebug] ===== RECEIVED bzRecommend MESSAGE =====`, 'info')
            log(`[BazaarDebug] Raw data type: ${typeof data}`, 'info')
            log(`[BazaarDebug] Raw data: ${JSON.stringify(data)}`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §7[Websocket] Received bazaar flip recommendation`)
            
            // BUG 2 FIX: Ignore bzRecommend during startup
            if (bot.state === 'startup') {
                log('[Websocket] Ignoring bzRecommend during startup', 'debug')
                printMcChatToConsole(`§f[§4BAF§f]: §e[Startup] Ignoring flip during startup`)
                break
            }
            
            if (!bot || !bot.username) {
                log('[BazaarDebug] Bot not initialized, ignoring bzRecommend', 'warn')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Bot not initialized, cannot process recommendation`)
                break
            }
            
            const bzRecommendParsed = typeof data === 'string' ? JSON.parse(data) : data
            const bzRecommendFlip = parseBazaarFlipJson(bzRecommendParsed)
            if (bzRecommendFlip) {
                log(`[BazaarDebug] Successfully parsed bzRecommend: ${bzRecommendFlip.amount}x ${bzRecommendFlip.itemName} at ${bzRecommendFlip.pricePerUnit.toFixed(1)} coins (${bzRecommendFlip.isBuyOrder ? 'BUY' : 'SELL'})`, 'info')
                handleBazaarFlipRecommendation(bot, bzRecommendFlip)
            } else {
                log(`[BazaarDebug] ERROR: Failed to parse bzRecommend data: ${JSON.stringify(data)}`, 'error')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Failed to parse bazaar flip data`)
            }
            break
        case 'getbazaarflips':
            log(`[BazaarDebug] Received getbazaarflips response`, 'info')
            log(`[BazaarDebug] Response data: ${JSON.stringify(data)}`, 'debug')
            
            // BUG 2 FIX: Ignore getbazaarflips during startup
            if (bot.state === 'startup') {
                log('[Websocket] Ignoring getbazaarflips during startup', 'debug')
                break
            }
            
            // Handle response from /cofl getbazaarflips command
            // Data could be a single recommendation or an array of recommendations
            if (Array.isArray(data)) {
                log(`[BazaarDebug] Processing ${data.length} bazaar flip recommendations`, 'info')
                // Handle multiple recommendations
                for (let recommendation of data) {
                    const parsed = parseBazaarFlipJson(recommendation)
                    if (parsed) {
                        handleBazaarFlipRecommendation(bot, parsed)
                    }
                }
            } else if (data && typeof data === 'object') {
                log(`[BazaarDebug] Processing single bazaar flip recommendation`, 'info')
                // Handle single recommendation
                const parsed = parseBazaarFlipJson(data)
                if (parsed) {
                    handleBazaarFlipRecommendation(bot, parsed)
                }
            } else {
                log(`[BazaarDebug] ERROR: Unexpected data format in getbazaarflips response: ${typeof data}`, 'error')
            }
            break
        default:
            log(`Unknown websocket message type: ${message.type}`, 'warn')
            log(`Message data: ${JSON.stringify(data)}`, 'debug')
            break
    }
}

/**
 * BUG 1 FIX: Timeout wrapper for async operations
 * Wraps a promise with a timeout and ensures cleanup on timeout
 * Properly cancels the timeout when the promise resolves to prevent spurious timeout messages
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, name: string, bot: MyBot): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
        let settled = false
        
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            log(`[Startup] ${name} timed out after ${ms / 1000}s`, 'warn')
            printMcChatToConsole(`§f[§4BAF§f]: §c[Startup] ${name} timed out`)
            if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow) } catch(e) {} }
            resolve(undefined)
        }, ms)
        
        promise.then((result) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve(result)
        }).catch((err) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            log(`[Startup] ${name} error: ${err}`, 'warn')
            resolve(undefined)
        })
    })
}

/**
 * Runs the startup workflow after joining SkyBlock
 * Order: Cookie check → Discover orders → Execute orders → Start accepting flips
 * BUG FIX #3: Keeps bot.state = 'startup' throughout to prevent interruptions
 * BUG FIX #3: All steps wrapped with timeouts to prevent infinite hangs
 */
async function runStartupWorkflow() {
    // BUG FIX #3: Set startup state to prevent interruptions during entire startup phase
    bot.state = 'startup'
    
    // BUG 3 FIX: Global timeout for entire startup workflow (2 minutes)
    // Use a flag to prevent double execution with finally block
    let timeoutFired = false
    const startupTimeout = setTimeout(() => {
        timeoutFired = true
        log('[Startup] Startup timed out after 2 minutes! Forcing completion.', 'error')
        printMcChatToConsole('§f[§4BAF§f]: §c[Startup] Workflow timed out! Forcing completion.')
        if (bot.currentWindow) {
            try { bot.closeWindow(bot.currentWindow) } catch(e) {}
        }
        // Don't set bot.state = null here, let finally block handle it
    }, 120000) // 2 minutes
    
    let ordersFound = 0
    
    try {
        log('========================================', 'info')
        log('Starting BAF Startup Workflow', 'info')
        log('========================================', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §6========================================')
        printMcChatToConsole('§f[§4BAF§f]: §6Starting BAF Startup Workflow')
        printMcChatToConsole('§f[§4BAF§f]: §6========================================')
        
        // Step 1: Check and buy cookie if needed (15 second timeout)
        log('[Startup] Step 1/4: Checking cookie status...', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §7[Startup] §bStep 1/4: §fChecking cookie status...')
        try {
            await withTimeout(checkAndBuyCookie(bot), 15000, 'Cookie check', bot)
            log('[Startup] Cookie check complete', 'info')
            printMcChatToConsole('§f[§4BAF§f]: §a[Startup] Cookie check complete')
        } catch (err) {
            log(`[Startup] Cookie check error: ${err}`, 'error')
            printMcChatToConsole('§f[§4BAF§f]: §c[Startup] Cookie check error')
        }
        
        await sleep(1000)
        
        // Step 2: Manage existing orders (cancel stale ones and re-list) - FEATURE 1 (90 second timeout)
        if (getConfigProperty('ENABLE_BAZAAR_FLIPS')) {
            log('[Startup] Step 2/4: Managing existing orders...', 'info')
            printMcChatToConsole('§f[§4BAF§f]: §7[Startup] §bStep 2/4: §fManaging existing orders...')
            try {
                const result = await withTimeout(startupOrderManagement(bot), 90000, 'Order management', bot)
                if (result) {
                    ordersFound = result.cancelled
                    log(`[Startup] Order management complete - cancelled ${result.cancelled}, re-listed ${result.relisted}`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §a[Startup] Order management complete`)
                } else {
                    log('[Startup] Order management timed out or returned no result', 'warn')
                }
            } catch (err) {
                log(`[Startup] Order management error: ${err}`, 'error')
                printMcChatToConsole('§f[§4BAF§f]: §c[Startup] Order management error')
            }
        } else {
            log('[Startup] Step 2/4: Skipping order management (Bazaar flips disabled)', 'info')
            printMcChatToConsole('§f[§4BAF§f]: §7[Startup] §bStep 2/4: §7Skipped (Bazaar flips disabled)')
        }
        
        await sleep(1000)
        
        // Step 3: Claim sold items from offline sales (30 second timeout)
        log('[Startup] Step 3/4: Claiming sold items...', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §7[Startup] §bStep 3/4: §fClaiming sold items...')
        try {
            await withTimeout(claimSoldItem(bot), 30000, 'Sold items claim', bot)
            log('[Startup] Sold items claim complete', 'info')
            printMcChatToConsole('§f[§4BAF§f]: §a[Startup] Sold items claim complete')
        } catch (err) {
            log(`[Startup] Claim sold items error: ${err}`, 'error')
            printMcChatToConsole('§f[§4BAF§f]: §c[Startup] Claim sold items error')
        }
        
        await sleep(2000)
        
        // Step 4: Ready to accept flips
        log('[Startup] Step 4/4: Starting flip acceptance...', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §7[Startup] §bStep 4/4: §fStarting flip acceptance...')
        
        // Get websocket for requesting flips
        const wss = await getCurrentWebsocket()
        
        // Start bazaar order manager if bazaar flips are enabled
        if (getConfigProperty('ENABLE_BAZAAR_FLIPS')) {
            // Pass true to trigger immediate check if orders were discovered at startup
            startOrderManager(bot, ordersFound > 0)
            
            // Start auto-requesting bazaar flips every 5 minutes (Feature 5)
            startBazaarFlipRequests(wss)
        }
        
        // Request bazaar flips if enabled (initial request)
        if (getConfigProperty('ENABLE_BAZAAR_FLIPS')) {
            await sleep(1000)
            log('[Startup] Requesting bazaar flip recommendations...', 'info')
            wss.send(
                JSON.stringify({
                    type: 'getbazaarflips',
                    data: JSON.stringify('')
                })
            )
        }
        
        log('========================================', 'info')
        log('Startup Workflow Complete - Ready!', 'info')
        log('========================================', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §6========================================')
        printMcChatToConsole('§f[§4BAF§f]: §a§lStartup Workflow Complete - Ready!')
        printMcChatToConsole('§f[§4BAF§f]: §6========================================')
    } finally {
        // Clear the global timeout
        clearTimeout(startupTimeout)
        
        // BUG FIX #3: Clear startup state - bot can now accept flips and commands
        // Only clear if timeout hasn't already cleared it
        if (!timeoutFired) {
            bot.state = null
        } else {
            // Ensure state is cleared even if timeout fired
            bot.state = null
        }
        
        // Send webhook notification about startup complete
        sendWebhookStartupComplete(ordersFound)
        
        // Start profit tracking timer if bazaar flips are enabled
        if (getConfigProperty('ENABLE_BAZAAR_FLIPS')) {
            startProfitReportTimer()
        }
    }
}

async function onScoreboardChanged() {
    if (
        bot.scoreboard.sidebar.items.map(item => item.displayName.getText(null).replace(item.name, '')).find(e => e.includes('Purse:') || e.includes('Piggy:'))
    ) {
        bot.removeListener('scoreboardTitleChanged', onScoreboardChanged)
        log('Joined SkyBlock')
        initAFKHandler(bot)
        ;(bot as any).AFKHandlerInitialized = true
        
        // Initialize command queue immediately after joining SkyBlock
        initCommandQueue(bot)
        
        setTimeout(async () => {
            let wss = await getCurrentWebsocket()
            log('Waited for grace period to end. Flips can now be bought.')
            bot.state = null
            bot.removeAllListeners('scoreboardTitleChanged')

            const scoreboardData = bot.scoreboard.sidebar.items.map(item => item.displayName.getText(null).replace(item.name, ''))
            
            // Parse purse from scoreboard (Feature 6)
            parsePurseFromScoreboard(scoreboardData)
            
            // Set up 5-second interval to regularly update purse
            setInterval(() => {
                const purse = getPurseFromScoreboard(bot)
                if (purse > 0) currentPurse = purse
            }, 5000)
            
            wss.send(
                JSON.stringify({
                    type: 'uploadScoreboard',
                    data: JSON.stringify(scoreboardData)
                })
            )
            
            // Run the startup workflow
            await runStartupWorkflow()
        }, 5500)
        await sleep(2500)
        tryToTeleportToIsland(bot, 0)
    }
}

export function changeWebsocketURL(newURL: string) {
    _websocket.onclose = () => {}
    _websocket.close()
    if (_websocket.readyState === WebSocket.CONNECTING || _websocket.readyState === WebSocket.CLOSING) {
        setTimeout(() => {
            changeWebsocketURL(newURL)
        }, 500)
        return
    }
    connectWebsocket(newURL)
}

/**
 * Start auto-requesting bazaar flips every 5 minutes (Feature 5)
 */
function startBazaarFlipRequests(wss: WebSocket): void {
    // Clear existing interval if any
    if (bazaarFlipRequestInterval) {
        clearInterval(bazaarFlipRequestInterval)
    }
    
    log('[BazaarFlips] Starting auto-request timer (every 5 minutes)', 'info')
    printMcChatToConsole('§f[§4BAF§f]: §7[BazaarFlips] Auto-request enabled (every §e5 minutes§7)')
    
    bazaarFlipRequestInterval = setInterval(() => {
        // Only request if bazaar flips are enabled and bot is idle
        if (getConfigProperty('ENABLE_BAZAAR_FLIPS') && bot.state === null) {
            log('[BazaarFlips] Auto-requesting bazaar flips...', 'info')
            wss.send(
                JSON.stringify({
                    type: 'getbazaarflips',
                    data: JSON.stringify('')
                })
            )
        }
    }, 5 * 60 * 1000) // 5 minutes
}

/**
 * Stop auto-requesting bazaar flips (Feature 5)
 */
export function stopBazaarFlipRequests(): void {
    if (bazaarFlipRequestInterval) {
        clearInterval(bazaarFlipRequestInterval)
        bazaarFlipRequestInterval = null
        log('[BazaarFlips] Stopped auto-request timer', 'info')
    }
}

export async function getCurrentWebsocket(): Promise<WebSocket> {
    if (_websocket.readyState === WebSocket.OPEN) {
        return _websocket
    }
    return new Promise(async resolve => {
        await sleep(1000)
        let socket = await getCurrentWebsocket()
        resolve(socket)
    })
}

/**
 * Get stored Coflnet premium information
 * Returns null values if not yet received from Coflnet
 */
export function getCoflnetPremiumInfo() {
    return {
        tier: coflnetPremiumTier,
        expires: coflnetPremiumExpires,
        connectionId: coflnetConnectionId
    }
}

/**
 * Parse purse amount from scoreboard using bot.scoreboard API
 * Uses the exact pattern from sendScoreboard(): item.displayName.getText(null).replace(item.name, '')
 * Scoreboard line format: "Purse: 1,151,612,206" or "Purse: 1,151,612,206 (+5)"
 * Also handles "Piggy:" for piggy bank variant
 */
function getPurseFromScoreboard(bot: MyBot): number {
    try {
        if (!bot?.scoreboard?.sidebar?.items) return 0

        for (const item of bot.scoreboard.sidebar.items) {
            const text = item.displayName.getText(null).replace(item.name, '')
            if (text.includes('Purse:') || text.includes('Piggy:')) {
                // Strip color codes, then extract the number
                const clean = removeMinecraftColorCodes(text)
                const match = clean.match(/(?:Purse|Piggy):\s*([\d,]+)/)
                if (match) {
                    return parseInt(match[1].replace(/,/g, ''), 10)
                }
            }
        }
        return 0
    } catch (e) {
        log(`Error parsing purse: ${e}`, 'debug')
        return 0
    }
}

/**
 * Legacy function for parsing from pre-processed scoreboard lines
 * Now calls the new getPurseFromScoreboard function
 */
function parsePurseFromScoreboard(scoreboardLines: string[]): void {
    // Update the global currentPurse
    currentPurse = getPurseFromScoreboard(bot)
}

/**
 * Get current purse amount (Feature 6)
 * Returns 0 if purse has not been parsed yet
 */
export function getCurrentPurse(): number {
    return currentPurse
}

/**
 * Get bot start time for uptime calculation
 */
export function getBotStartTime(): number {
    return botStartTime
}
