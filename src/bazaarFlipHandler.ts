import { MyBot, BazaarFlipRecommendation } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { getConfigProperty } from './configHelper'
import { areBazaarFlipsPaused, queueBazaarFlip } from './bazaarFlipPauser'
import { sendWebhookBazaarOrderPlaced } from './webhookHandler'
import { recordOrder } from './bazaarOrderManager'
import { enqueueCommand, CommandPriority } from './commandQueue'

// Constants
const RETRY_DELAY_MS = 1100
const OPERATION_TIMEOUT_MS = 20000
const MAX_LOGGED_SLOTS = 15 // Maximum number of slots to log per window to avoid spam
const MINEFLAYER_WINDOW_PROCESS_DELAY_MS = 300 // Time to wait for mineflayer to populate bot.currentWindow
const BAZAAR_RETRY_DELAY_MS = 2000

/**
 * Parse bazaar flip data from JSON response (from websocket)
 * This handles the structured JSON data sent by the server via bzRecommend messages
 * 
 * The actual bzRecommend format from Coflnet:
 * { itemName: "Flawed Peridot Gemstone", itemTag: "FLAWED_PERIDOT_GEM", price: 3054.1, amount: 64, isSell: false }
 * Where 'price' is the price PER PIECE (not total for the order)
 * 
 * Also supports:
 * - { itemName: "Item", amount: 4, pricePerUnit: 265000, totalPrice: 1060000, isBuyOrder: true }
 * 
 * @param data The JSON data from the websocket
 * @returns Parsed recommendation or null if data is invalid
 */
export function parseBazaarFlipJson(data: any): BazaarFlipRecommendation | null {
    try {
        log(`[BazaarDebug] Parsing bazaar flip JSON: ${JSON.stringify(data)}`, 'info')
        let itemName: string
        let amount: number
        let pricePerUnit: number
        let totalPrice: number | undefined
        let isBuyOrder: boolean

        // Try to extract item name (could be 'itemName', 'item', or 'name')
        itemName = data.itemName || data.item || data.name
        if (!itemName) {
            log('[BazaarDebug] ERROR: Missing item name in bazaar flip JSON data', 'error')
            return null
        }
        log(`[BazaarDebug] Parsed item name: ${itemName}`, 'info')

        // Try to extract amount (could be 'amount', 'count', 'quantity')
        amount = parseInt(data.amount || data.count || data.quantity)
        if (!amount || isNaN(amount)) {
            log('[BazaarDebug] ERROR: Missing or invalid amount in bazaar flip JSON data', 'error')
            return null
        }
        log(`[BazaarDebug] Parsed amount: ${amount}`, 'info')

        // Extract price - handle different field names and meanings
        // 'pricePerUnit' / 'unitPrice' are per-unit prices
        // 'price' from Coflnet is the price PER PIECE (not total for the whole order)
        if (data.pricePerUnit || data.unitPrice) {
            pricePerUnit = parseFloat(data.pricePerUnit || data.unitPrice)
            if (!pricePerUnit || isNaN(pricePerUnit)) {
                log('[BazaarDebug] ERROR: Missing or invalid price in bazaar flip JSON data', 'error')
                return null
            }
            totalPrice = data.totalPrice ? parseFloat(data.totalPrice) : pricePerUnit * amount
            log(`[BazaarDebug] Parsed price per unit from pricePerUnit field: ${pricePerUnit}`, 'info')
            log(`[BazaarDebug] Calculated total price: ${totalPrice}`, 'info')
        } else if (data.price) {
            // 'price' field is the price PER PIECE (Coflnet sends per-piece price)
            pricePerUnit = parseFloat(data.price)
            if (!pricePerUnit || isNaN(pricePerUnit)) {
                log('[BazaarDebug] ERROR: Missing or invalid price in bazaar flip JSON data', 'error')
                return null
            }
            totalPrice = data.totalPrice ? parseFloat(data.totalPrice) : pricePerUnit * amount
            log(`[BazaarDebug] Parsed price per unit from price field: ${pricePerUnit}`, 'info')
            log(`[BazaarDebug] Calculated total price: ${totalPrice.toFixed(1)} (${pricePerUnit} * ${amount})`, 'info')
        } else {
            log('[BazaarDebug] ERROR: Missing price in bazaar flip JSON data', 'error')
            return null
        }

        // Determine if it's a buy or sell order
        // Check 'isBuyOrder', 'isSell', 'type', or 'orderType' fields
        if (typeof data.isBuyOrder === 'boolean') {
            isBuyOrder = data.isBuyOrder
        } else if (typeof data.isSell === 'boolean') {
            isBuyOrder = !data.isSell
        } else if (data.type) {
            isBuyOrder = data.type.toLowerCase() === 'buy'
        } else if (data.orderType) {
            isBuyOrder = data.orderType.toLowerCase() === 'buy'
        } else {
            // Default to buy order
            isBuyOrder = true
        }
        log(`[BazaarDebug] Order type: ${isBuyOrder ? 'BUY' : 'SELL'}`, 'info')

        log(`[BazaarDebug] Successfully parsed bazaar flip: ${amount}x ${itemName} @ ${pricePerUnit.toFixed(1)} (total: ${totalPrice?.toFixed(1)}) [${isBuyOrder ? 'BUY' : 'SELL'}]`, 'info')

        return {
            itemName,
            itemTag: data.itemTag || undefined,
            amount,
            pricePerUnit,
            totalPrice,
            isBuyOrder
        }
    } catch (error) {
        log(`[BazaarDebug] ERROR: Exception while parsing bazaar flip JSON data: ${error}`, 'error')
        return null
    }
}

/**
 * Parse a bazaar flip recommendation message from Coflnet
 * Example: "[Coflnet]: Recommending an order of 4x Cindershade for 1.06M(1)"
 * 
 * The format is: "[Coflnet]: Recommending an order of {amount}x {itemName} for {price}({index})"
 * Where:
 * - amount: number of items to buy/sell
 * - itemName: the name of the bazaar item
 * - price: total price with optional K/M suffix (e.g., "1.06M", "500K", "1000")
 * - index: a number that corresponds to a clickable command (e.g., (1) -> /bz ItemName)
 * 
 * @param message The raw chat message from Coflnet
 * @returns Parsed recommendation or null if not a bazaar flip message
 */
export function parseBazaarFlipMessage(message: string): BazaarFlipRecommendation | null {
    const cleanMessage = removeMinecraftColorCodes(message)
    
    // Check if this is a bazaar flip recommendation
    if (!cleanMessage.includes('[Coflnet]') || !cleanMessage.includes('Recommending an order of')) {
        return null
    }

    try {
        // Extract amount and item name: "4x Cindershade"
        const orderMatch = cleanMessage.match(/(\d+)x\s+([^\s]+(?:\s+[^\s]+)*?)\s+for/)
        if (!orderMatch) {
            return null
        }

        const amount = parseInt(orderMatch[1])
        const itemName = orderMatch[2].trim()

        // Extract price: "1.06M"
        const priceMatch = cleanMessage.match(/for\s+([\d.]+[KkMm]?)\(/)
        if (!priceMatch) {
            return null
        }

        const priceStr = priceMatch[1]
        let totalPrice = parseFloat(priceStr)
        
        // Convert K/M suffixes to actual numbers
        if (priceStr.toLowerCase().endsWith('k')) {
            totalPrice *= 1000
        } else if (priceStr.toLowerCase().endsWith('m')) {
            totalPrice *= 1000000
        }

        const pricePerUnit = totalPrice / amount

        // Determine if it's a buy or sell order based on message content
        // If the message contains "sell" or "offer", it's a sell order
        // Otherwise, default to buy order (most common for flipping)
        const isBuyOrder = !(cleanMessage.toLowerCase().includes('sell') || cleanMessage.toLowerCase().includes('offer'))

        return {
            itemName,
            amount,
            pricePerUnit,
            totalPrice,
            isBuyOrder
        }
    } catch (error) {
        log(`Error parsing bazaar flip message: ${error}`, 'error')
        return null
    }
}

/**
 * Handle a bazaar flip recommendation from Coflnet
 * Queues the operation through the command queue system for proper ordering
 * 
 * @param bot The Minecraft bot instance
 * @param recommendation The parsed bazaar flip recommendation
 */
export async function handleBazaarFlipRecommendation(bot: MyBot, recommendation: BazaarFlipRecommendation) {
    // Check if bazaar flips are enabled in config
    if (!getConfigProperty('ENABLE_BAZAAR_FLIPS')) {
        log('[BazaarDebug] Bazaar flips are disabled in config', 'warn')
        return
    }

    // Check if bazaar flips are paused due to incoming AH flip
    if (areBazaarFlipsPaused()) {
        log('[BazaarDebug] Bazaar flips are paused due to incoming AH flip, queueing recommendation', 'warn')
        queueBazaarFlip(bot, recommendation)
        return
    }

    // Queue the bazaar flip with NORMAL priority
    // This ensures it doesn't interrupt other operations and executes in order
    const orderType = recommendation.isBuyOrder ? 'BUY' : 'SELL'
    const commandName = `Bazaar ${orderType}: ${recommendation.amount}x ${recommendation.itemName}`
    
    enqueueCommand(
        commandName,
        CommandPriority.NORMAL,
        async () => {
            await executeBazaarFlip(bot, recommendation)
        }
    )
}

/**
 * Execute a bazaar flip operation
 * This is the actual implementation that runs from the queue
 */
async function executeBazaarFlip(bot: MyBot, recommendation: BazaarFlipRecommendation): Promise<void> {
    // Double-check bot state before execution (queue should handle this, but safety check)
    if (bot.state) {
        log(`[BazaarDebug] Bot is busy (state: ${bot.state}), cannot execute flip`, 'warn')
        throw new Error(`Bot busy: ${bot.state}`)
    }

    log(`[BazaarDebug] ===== STARTING BAZAAR FLIP ORDER =====`, 'info')
    log(`[BazaarDebug] Item: ${recommendation.itemName}`, 'info')
    log(`[BazaarDebug] Amount: ${recommendation.amount}`, 'info')
    log(`[BazaarDebug] Price per unit: ${recommendation.pricePerUnit.toFixed(1)} coins`, 'info')
    log(`[BazaarDebug] Total price: ${recommendation.totalPrice ? recommendation.totalPrice.toFixed(1) : (recommendation.pricePerUnit * recommendation.amount).toFixed(1)} coins`, 'info')
    log(`[BazaarDebug] Order type: ${recommendation.isBuyOrder ? 'BUY' : 'SELL'}`, 'info')
    log(`[BazaarDebug] =====================================`, 'info')
    
    printMcChatToConsole(`§f[§4BAF§f]: §7━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    printMcChatToConsole(`§f[§4BAF§f]: §e${recommendation.isBuyOrder ? 'BUY' : 'SELL'} ORDER §7- §e${recommendation.itemName}`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Amount: §a${recommendation.amount}x`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Price/unit: §6${recommendation.pricePerUnit.toFixed(1)} coins`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Total: §6${recommendation.totalPrice ? recommendation.totalPrice.toFixed(0) : (recommendation.pricePerUnit * recommendation.amount).toFixed(0)} coins`)
    printMcChatToConsole(`§f[§4BAF§f]: §7━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

    bot.state = 'bazaar'
    let operationTimeout = setTimeout(() => {
        if (bot.state === 'bazaar') {
            log("[BazaarDebug] ERROR: Timeout waiting for bazaar order placement (20 seconds)", 'error')
            log("[BazaarDebug] This usually means the /bz command didn't open a window or the window detection failed", 'error')
            printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Bazaar order timed out - check if /bz command works`)
            bot.state = null
            // Note: The placeBazaarOrder function will clean up its own listener on timeout
        }
    }, OPERATION_TIMEOUT_MS)
    const bazaarTracking = {
        windowOpened: false,
        retryTimer: null as NodeJS.Timeout | null,
        openTracker: null as ((packet: any) => void) | null
    }

    try {
        const { itemName, itemTag, amount, pricePerUnit, totalPrice, isBuyOrder } = recommendation
        const displayTotalPrice = totalPrice ? totalPrice.toFixed(0) : (pricePerUnit * amount).toFixed(0)

        // Use itemName (display name like "Flawed Peridot Gemstone") if available, otherwise fall back to itemTag
        // The /bz command expects display names as shown in Hypixel's bazaar UI
        const searchTerm = itemName || itemTag
        if (!itemName && itemTag) {
            log(`[BazaarDebug] WARNING: itemName not provided, using itemTag "${itemTag}" as fallback`, 'warn')
            log(`[BazaarDebug] This may not work if /bz expects display names instead of internal IDs`, 'warn')
        }
        bazaarTracking.openTracker = (packet) => {
            if (bazaarTracking.windowOpened) return
            bazaarTracking.windowOpened = true
            log(`[BazaarDebug] [Tracker] Detected open_window for bazaar flip: id=${packet?.windowId} type=${packet?.windowType} rawTitle=${JSON.stringify(packet?.windowTitle)}`, 'info')
        }
        bot._client.on('open_window', bazaarTracking.openTracker)
        
        printMcChatToConsole(
            `§f[§4BAF§f]: §fPlacing ${isBuyOrder ? 'buy' : 'sell'} order for ${amount}x ${itemName} at ${pricePerUnit.toFixed(1)} coins each (total: ${displayTotalPrice})`
        )

        // CRITICAL: Set up listener BEFORE opening bazaar to catch the first window
        // Use bot._client.on('open_window') for low-level protocol handling
        // Do NOT use bot.removeAllListeners('windowOpen') as that breaks mineflayer's internal handler
        log('[BazaarDebug] Setting up window listener for bazaar order placement', 'info')
        const orderPromise = placeBazaarOrder(bot, itemName, amount, pricePerUnit, isBuyOrder)
        
        // Small delay to ensure Node.js event loop has processed the listener registration
        // This guarantees the listener is active before the window opens
        await sleep(100)
        
        // Open bazaar for the item - the listener is now ready to catch this event
        log(`[BazaarDebug] Opening bazaar with command: /bz ${searchTerm}`, 'info')
        log(`[BazaarDebug] Using search term: "${searchTerm}" (itemTag: ${itemTag || 'not provided'}, itemName: ${itemName})`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7[Command] Executing §b/bz ${searchTerm}`)
        bazaarTracking.retryTimer = setTimeout(() => {
            if (!bazaarTracking.windowOpened && bot.state === 'bazaar') {
                log(`[BazaarDebug] No bazaar GUI opened after initial /bz command, retrying with "/bz ${searchTerm}"`, 'warn')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Warning] Bazaar GUI did not open, retrying command...`)
                bot.chat(`/bz ${searchTerm}`)
            }
        }, BAZAAR_RETRY_DELAY_MS)
        bot.chat(`/bz ${searchTerm}`)

        await orderPromise
        
        // Record the order for tracking (claiming and cancelling)
        recordOrder(recommendation)
        
        log('[BazaarDebug] ===== BAZAAR FLIP ORDER COMPLETED =====', 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §aSuccessfully placed bazaar order!`)
    } catch (error) {
        log(`[BazaarDebug] Error handling bazaar flip: ${error}`, 'error')
        printMcChatToConsole(`§f[§4BAF§f]: §cFailed to place bazaar order: ${error}`)
    } finally {
        clearTimeout(operationTimeout)
        if (bazaarTracking.retryTimer) clearTimeout(bazaarTracking.retryTimer)
        if (bazaarTracking.openTracker) {
            bot._client.removeListener('open_window', bazaarTracking.openTracker)
        }
        bot.state = null
    }
}

/**
 * Place a bazaar order by navigating through the Hypixel bazaar interface
 * 
 * The bazaar interface has multiple steps:
 * 1. Search results (title: "Bazaar ➜ ..." when opened via /bz <item>)
 * 2. Item detail view (title: "Bazaar ➜ ItemName") with Create Buy Order / Create Sell Offer
 * 3. Amount selection - buy orders only (title: "How many do you want to...")
 * 4. Price selection (title: "How much do you want to pay/be paid")
 * 5. Confirmation (title: "Confirm...")
 * 
 * @param bot The Minecraft bot instance
 * @param itemName Name of the item (used to find it in search results)
 * @param amount Number of items to buy/sell
 * @param pricePerUnit Price per item unit
 * @param isBuyOrder True for buy order, false for sell offer
 * @returns Promise that resolves when the order is placed
 */
function placeBazaarOrder(bot: MyBot, itemName: string, amount: number, pricePerUnit: number, isBuyOrder: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let currentStep = 'initial'

        // Helper: find a slot by display name substring
        const findSlotWithName = (win, searchName: string): number => {
            for (let i = 0; i < win.slots.length; i++) {
                const slot = win.slots[i]
                const name = removeMinecraftColorCodes(
                    (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                )
                if (name && name.includes(searchName)) return i
            }
            return -1
        }
        
        // Helper: log all slots in current window for debugging
        const logWindowSlots = (win, title: string) => {
            log(`[BazaarDebug] === Window Opened: "${title}" ===`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §7[Window] §e${title}`)
            
            const importantSlots: any[] = []
            for (let i = 0; i < win.slots.length; i++) {
                const slot = win.slots[i]
                if (slot && slot.type !== 0) { // 0 = air
                    const name = removeMinecraftColorCodes(
                        (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || slot.name || 'Unknown'
                    )
                    importantSlots.push({ slot: i, name })
                }
            }
            
            // Log up to MAX_LOGGED_SLOTS important slots to avoid spam
            const slotsToLog = importantSlots.slice(0, MAX_LOGGED_SLOTS)
            slotsToLog.forEach(({ slot, name }) => {
                log(`[BazaarDebug]   Slot ${slot}: ${name}`, 'info')
            })
            
            if (importantSlots.length > MAX_LOGGED_SLOTS) {
                log(`[BazaarDebug]   ... and ${importantSlots.length - MAX_LOGGED_SLOTS} more slots`, 'info')
            }
            
            log(`[BazaarDebug] === End Window Slots (${importantSlots.length} items) ===`, 'info')
        }
        
        // Use low-level open_window event to avoid breaking mineflayer's windowOpen handler
        const windowListener = async (packet) => {
            // Wait for mineflayer to process the window and populate bot.currentWindow
            await sleep(MINEFLAYER_WINDOW_PROCESS_DELAY_MS)
            
            const window = bot.currentWindow
            if (!window) {
                log('[BazaarDebug] WARNING: bot.currentWindow is null after window packet', 'warn')
                return
            }
            
            let title = getWindowTitle(window)
            log(`[BazaarDebug] Window opened: "${title}" at step: ${currentStep}`, 'info')
            
            // Log all slots in this window for debugging
            logWindowSlots(window, title)

            try {
                // 1. Item detail page - detected by order buttons, works with ANY window title
                let hasOrderButton = findSlotWithName(window, 'Create Buy Order') !== -1 ||
                                     findSlotWithName(window, 'Create Sell Offer') !== -1

                if (hasOrderButton && currentStep !== 'selectOrderType') {
                    const buttonName = isBuyOrder ? 'Create Buy Order' : 'Create Sell Offer'
                    const slotToClick = findSlotWithName(window, buttonName)
                    if (slotToClick === -1) throw new Error(`Could not find "${buttonName}" button`)
                    log(`[BazaarDebug] On item detail page, clicking "${buttonName}" (slot ${slotToClick})`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Action] Clicking §e${buttonName}§7 at slot §b${slotToClick}`)
                    currentStep = 'selectOrderType'
                    await sleep(200)
                    await clickWindow(bot, slotToClick).catch(e => log(`[BazaarDebug] clickWindow error (expected): ${e}`, 'debug'))
                }
                // 2. Search results page - has "Bazaar" in title
                else if (title.includes('Bazaar') && currentStep === 'initial') {
                    // Search results page - find and click the matching item
                    log(`[BazaarDebug] On search results page, looking for item: "${itemName}"`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Search] Looking for §e${itemName}`)
                    currentStep = 'searchResults'
                    
                    let itemSlot = -1
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        if (name && name.toLowerCase().includes(itemName.toLowerCase())) {
                            itemSlot = i
                            log(`[BazaarDebug] Found item "${name}" at slot ${itemSlot}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §7[Found] §e${name}§7 at slot §b${itemSlot}`)
                            break
                        }
                    }
                    
                    if (itemSlot === -1) {
                        // Fallback to slot 11 (first search result position)
                        itemSlot = 11
                        log(`[BazaarDebug] Item not found by name, using fallback slot ${itemSlot}`, 'warn')
                        printMcChatToConsole(`§f[§4BAF§f]: §c[Warning] Item not found, using fallback slot ${itemSlot}`)
                    }
                    await sleep(200)
                    await clickWindow(bot, itemSlot).catch(e => log(`[BazaarDebug] clickWindow error (expected): ${e}`, 'debug'))
                }
                // 3. Amount screen - ONLY for buy orders (sell offers skip this step)
                else if (findSlotWithName(window, 'Custom Amount') !== -1 && isBuyOrder) {
                    const customAmountSlot = findSlotWithName(window, 'Custom Amount')
                    log(`[BazaarDebug] Setting amount to ${amount} via slot ${customAmountSlot}`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Amount] Setting to §e${amount}§7 via slot §b${customAmountSlot}`)
                    currentStep = 'setAmount'
                    
                    // Register sign handler BEFORE clicking to avoid race condition
                    bot._client.once('open_sign_entity', ({ location }) => {
                        log(`[BazaarDebug] Sign opened for amount, writing: ${amount}`, 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §7[Sign] Writing amount: §e${amount}`)
                        bot._client.write('update_sign', {
                            location: { x: location.x, y: location.y, z: location.z },
                            text1: `\"${amount.toString()}\"`,
                            text2: '{"italic":false,"extra":["^^^^^^^^^^^^^^^"],"text":""}',
                            text3: '{"italic":false,"extra":[""],"text":""}',
                            text4: '{"italic":false,"extra":[""],"text":""}'
                        })
                    })
                    
                    // Click Custom Amount at the detected slot
                    await sleep(200)
                    await clickWindow(bot, customAmountSlot).catch(e => log(`[BazaarDebug] clickWindow error (expected): ${e}`, 'debug'))
                }
                // Safety: If Custom Amount appears for a sell offer, skip it
                else if (findSlotWithName(window, 'Custom Amount') !== -1 && !isBuyOrder) {
                    log(`[BazaarDebug] WARNING: Custom Amount screen appeared for sell offer - skipping`, 'warn')
                    printMcChatToConsole(`§f[§4BAF§f]: §c[Warning] Unexpected amount screen for sell offer - skipping`)
                    // Don't process this window further, return to wait for next window
                    return
                }
                // 4. Price screen
                else if (findSlotWithName(window, 'Custom Price') !== -1) {
                    const customPriceSlot = findSlotWithName(window, 'Custom Price')
                    log(`[BazaarDebug] Setting price per unit to ${pricePerUnit.toFixed(1)} via slot ${customPriceSlot}`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Price] Setting to §e${pricePerUnit.toFixed(1)}§7 coins via slot §b${customPriceSlot}`)
                    currentStep = 'setPrice'
                    
                    // Register sign handler BEFORE clicking to avoid race condition
                    bot._client.once('open_sign_entity', ({ location }) => {
                        log(`[BazaarDebug] Sign opened for price, writing: ${pricePerUnit.toFixed(1)}`, 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §7[Sign] Writing price: §e${pricePerUnit.toFixed(1)}§7 coins`)
                        bot._client.write('update_sign', {
                            location: { x: location.x, y: location.y, z: location.z },
                            text1: `\"${pricePerUnit.toFixed(1)}\"`,
                            text2: '{"italic":false,"extra":["^^^^^^^^^^^^^^^"],"text":""}',
                            text3: '{"italic":false,"extra":[""],"text":""}',
                            text4: '{"italic":false,"extra":[""],"text":""}'
                        })
                    })
                    
                    // Click Custom Price at the detected slot
                    await sleep(200)
                    await clickWindow(bot, customPriceSlot).catch(e => log(`[BazaarDebug] clickWindow error (expected): ${e}`, 'debug'))
                }
                // 5. Confirm screen - click slot 13
                else if (currentStep === 'setPrice') {
                    // After setting price, the next window is always the confirm screen.
                    // The confirm button is at slot 13. It is labeled "Buy Order" for buys
                    // and "Sell Offer" for sells (NOT "Confirm").
                    // Do NOT use findSlotWithName to find it because "Buy Order" would also
                    // match "Create Buy Order" from step 1 via .includes(). Just use slot 13.
                    log(`[BazaarDebug] Confirming bazaar ${isBuyOrder ? 'buy' : 'sell'} order at slot 13`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Confirm] Placing ${isBuyOrder ? 'buy' : 'sell'} order at slot §b13`)
                    currentStep = 'confirm'
                    await sleep(200)
                    await clickWindow(bot, 13).catch(e => log(`[BazaarDebug] clickWindow error (expected): ${e}`, 'debug'))
                    
                    log(`[BazaarDebug] Order placement complete`, 'info')
                    
                    // Send webhook notification
                    const totalPrice = pricePerUnit * amount
                    sendWebhookBazaarOrderPlaced(itemName, amount, pricePerUnit, totalPrice, isBuyOrder)
                    
                    bot._client.removeListener('open_window', windowListener)
                    await sleep(500)
                    resolve()
                }
            } catch (error) {
                log(`[BazaarDebug] Error in window handler at step ${currentStep}: ${error}`, 'error')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Failed at step ${currentStep}: ${error}`)
                bot._client.removeListener('open_window', windowListener)
                reject(error)
            }
        }

        // Use low-level open_window event instead of high-level windowOpen
        bot._client.on('open_window', windowListener)

        // Set a timeout for the entire operation
        setTimeout(() => {
            bot._client.removeListener('open_window', windowListener)
            reject(new Error(`Bazaar order placement timed out at step: ${currentStep}`))
        }, 20000)
    })
}
