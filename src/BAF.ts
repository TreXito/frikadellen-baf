import { createBot } from 'mineflayer'
import { createFastWindowClicker } from './fastWindowClick'
import { initLogger, log, printMcChatToConsole } from './logger'
import { clickWindow, isCoflChatMessage, removeMinecraftColorCodes, sleep } from './utils'
import { onWebsocketCreateAuction } from './sellHandler'
import { tradePerson } from './tradeHandler'
import { swapProfile } from './swapProfileHandler'
import { flipHandler, onItemWhitelistedMessage } from './flipHandler'
import { claimSoldItem, registerIngameMessageHandler } from './ingameMessageHandler'
import { MyBot, TextMessageData } from '../types/autobuy'
import { getConfigProperty, initConfigHelper, updatePersistentConfigProperty } from './configHelper'
import { getSessionId } from './coflSessionManager'
import { sendWebhookInitialized } from './webhookHandler'
import { handleCommand, setupConsoleInterface } from './consoleHandler'
import { initAFKHandler, tryToTeleportToIsland } from './AFKHandler'
import { runSequence } from './sequenceRunner'
import { handleBazaarFlipRecommendation, parseBazaarFlipMessage, parseBazaarFlipJson } from './bazaarFlipHandler'
import { checkAndPauseForAHFlip } from './bazaarFlipPauser'
import { startWebGui, addWebGuiChatMessage } from './webGui'
import { initAccountSwitcher } from './accountSwitcher'
import { getProxyConfig } from './proxyHelper'
const WebSocket = require('ws')
var prompt = require('prompt-sync')()
initConfigHelper()
initLogger()
const version = 'af-2.0.0'
let _websocket: WebSocket
let bot: MyBot
let ingameName = getConfigProperty('INGAME_NAME')

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
    
    setupBotHandlers()
}

function setupBotHandlers() {
    // Log packets
    //addLoggerToClientWriteFunction(bot._client)
    
    bot.on('kicked', (reason,_)=>log(reason, 'warn'))
    bot.on('error', log)

    bot.once('login', () => {
        log(`Logged in as ${bot.username}`)
        
        // Log configuration for diagnostics
        const bazaarFlipsEnabled = getConfigProperty('ENABLE_BAZAAR_FLIPS')
        const ahFlipsEnabled = getConfigProperty('ENABLE_AH_FLIPS')
        log(`[Config] Bazaar Flips: ${bazaarFlipsEnabled ? 'ENABLED' : 'DISABLED'}`, 'info')
        log(`[Config] AH Flips: ${ahFlipsEnabled ? 'ENABLED' : 'DISABLED'}`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7Configuration - Bazaar Flips: §${bazaarFlipsEnabled ? 'a' : 'c'}${bazaarFlipsEnabled ? 'ENABLED' : 'DISABLED'}§7, AH Flips: §${ahFlipsEnabled ? 'a' : 'c'}${ahFlipsEnabled ? 'ENABLED' : 'DISABLED'}`)
        
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
            flipHandler(bot, data)
            break
        case 'chatMessage':
            if (data.length > 1 && data[1].text.includes('matched your Whitelist entry:') && !isCoflChatMessage(data[1].text)) {
                onItemWhitelistedMessage(data[1].text)
            }

            for (let da of [...(data as TextMessageData[])]) {
                let isCoflChat = isCoflChatMessage(da.text)
                if (!isCoflChat) {
                    log(message, 'debug')
                }
                
                // Check if this is an AH flip incoming message and pause if needed
                checkAndPauseForAHFlip(da.text, getConfigProperty('ENABLE_BAZAAR_FLIPS'), getConfigProperty('ENABLE_AH_FLIPS'))
                
                // Check if this is a bazaar flip recommendation
                const bazaarFlip = parseBazaarFlipMessage(da.text)
                if (bazaarFlip) {
                    log('[BazaarDebug] Detected bazaar flip recommendation from chat message', 'info')
                    log(`[BazaarDebug] Parsed: ${bazaarFlip.amount}x ${bazaarFlip.itemName} @ ${bazaarFlip.pricePerUnit.toFixed(1)} coins`, 'info')
                    handleBazaarFlipRecommendation(bot, bazaarFlip)
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
            let isCoflChat = isCoflChatMessage(data.text)
            if (!isCoflChat) {
                log(message, 'debug')
            }
            
            // Check if this is an AH flip incoming message and pause if needed
            checkAndPauseForAHFlip(data.text, getConfigProperty('ENABLE_BAZAAR_FLIPS'), getConfigProperty('ENABLE_AH_FLIPS'))
            
            // Check if this is a bazaar flip recommendation
            const bazaarFlip = parseBazaarFlipMessage(data.text)
            if (bazaarFlip) {
                log('[BazaarDebug] Detected bazaar flip recommendation from writeToChat message', 'info')
                log(`[BazaarDebug] Parsed: ${bazaarFlip.amount}x ${bazaarFlip.itemName} @ ${bazaarFlip.pricePerUnit.toFixed(1)} coins`, 'info')
                handleBazaarFlipRecommendation(bot, bazaarFlip)
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
            const parsedBazaarFlip = parseBazaarFlipJson(data)
            if (parsedBazaarFlip) {
                handleBazaarFlipRecommendation(bot, parsedBazaarFlip)
            } else {
                log(`Failed to parse bazaar flip data from websocket: ${JSON.stringify(data)}`, 'error')
            }
            break
        case 'bzRecommend':
            log(`[BazaarDebug] ===== RECEIVED bzRecommend MESSAGE =====`, 'info')
            log(`[BazaarDebug] Raw data: ${JSON.stringify(data)}`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §7[Websocket] Received bazaar flip recommendation`)
            
            if (!bot || !bot.username) {
                log('[BazaarDebug] Bot not initialized, ignoring bzRecommend', 'warn')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Bot not initialized, cannot process recommendation`)
                break
            }
            
            const bzRecommendFlip = parseBazaarFlipJson(data)
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

async function onScoreboardChanged() {
    if (
        bot.scoreboard.sidebar.items.map(item => item.displayName.getText(null).replace(item.name, '')).find(e => e.includes('Purse:') || e.includes('Piggy:'))
    ) {
        bot.removeListener('scoreboardTitleChanged', onScoreboardChanged)
        log('Joined SkyBlock')
        initAFKHandler(bot)
        ;(bot as any).AFKHandlerInitialized = true
        setTimeout(async () => {
            let wss = await getCurrentWebsocket()
            log('Waited for grace period to end. Flips can now be bought.')
            bot.state = null
            bot.removeAllListeners('scoreboardTitleChanged')

            wss.send(
                JSON.stringify({
                    type: 'uploadScoreboard',
                    data: JSON.stringify(bot.scoreboard.sidebar.items.map(item => item.displayName.getText(null).replace(item.name, '')))
                })
            )
            
            // Request bazaar flips if enabled
            if (getConfigProperty('ENABLE_BAZAAR_FLIPS')) {
                // Wait for the server connection to stabilize before requesting flips
                // This ensures the websocket is ready to handle the command and response
                await sleep(1000)
                log('Requesting bazaar flip recommendations...')
                wss.send(
                    JSON.stringify({
                        type: 'getbazaarflips',
                        data: JSON.stringify('')
                    })
                )
            }
        }, 5500)
        await sleep(2500)
        tryToTeleportToIsland(bot, 0)

        await sleep(20000)
        // trying to claim sold items if sold while user was offline
        claimSoldItem(bot)
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

