import { MyBot, BazaarFlipRecommendation } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes, toTitleCase } from './utils'
import { getConfigProperty } from './configHelper'
import { areBazaarFlipsPaused, queueBazaarFlip } from './bazaarFlipPauser'
import { sendWebhookBazaarOrderPlaced } from './webhookHandler'
import { recordOrder, canPlaceOrder, refreshOrderCounts } from './bazaarOrderManager'
import { enqueueCommand, CommandPriority, clearBazaarOrders } from './commandQueue'
import { isBazaarDailyLimitReached, isBazaarOrderOnCooldown, getBazaarOrderCooldownRemaining } from './ingameMessageHandler'
import { getCurrentPurse } from './BAF'
import { findItemInSearchResults, getSlotName } from './bazaarHelpers'

// Constants
const RETRY_DELAY_MS = 1100
const OPERATION_TIMEOUT_MS = 20000
const MAX_LOGGED_SLOTS = 15 // Maximum number of slots to log per window to avoid spam
const MINEFLAYER_WINDOW_PROCESS_DELAY_MS = 300 // Time to wait for mineflayer to populate bot.currentWindow
const BAZAAR_RETRY_DELAY_MS = 2000
const MAX_ORDER_PLACEMENT_RETRIES = 3 // Maximum number of retries for order placement
const RETRY_BACKOFF_BASE_MS = 1000 // Base delay for exponential backoff between retries
const FIRST_SEARCH_RESULT_SLOT = 11 // Fallback slot for first item in bazaar search results
// Price failsafe thresholds
const PRICE_FAILSAFE_BUY_THRESHOLD = 0.9  // Reject buy orders if sign price < 90% of order price
const PRICE_FAILSAFE_SELL_THRESHOLD = 1.1 // Reject sell orders if sign price > 110% of order price
// Rate limiting for warning messages
const LIMIT_WARNING_COOLDOWN_MS = 60000 // Show "slots full" warning once per minute max
// Order placement confirmation
const ORDER_REJECTION_WAIT_MS = 1000 // Wait for server response after clicking confirm

// Track last time we showed the "slots full" warning
let lastLimitWarningTime = 0

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
    // BUG FIX #3: Ignore flip recommendations during startup phase
    if (bot.state === 'startup') {
        log('[BazaarDebug] Ignoring bazaar flip during startup phase', 'debug')
        return
    }
    
    // Check if bazaar flips are enabled in config
    if (!getConfigProperty('ENABLE_BAZAAR_FLIPS')) {
        log('[BazaarDebug] Bazaar flips are disabled in config', 'warn')
        return
    }

    // Feature 4: Check if daily sell limit reached (skip sell offers, allow buy orders)
    if (!recommendation.isBuyOrder && isBazaarDailyLimitReached()) {
        log('[BAF]: Cannot place sell offer - bazaar daily sell limit reached', 'warn')
        printMcChatToConsole('§f[§4BAF§f]: §cCannot place sell offer - daily sell limit reached')
        return
    }

    // Check if bazaar orders are on cooldown
    if (isBazaarOrderOnCooldown()) {
        const remainingMs = getBazaarOrderCooldownRemaining()
        const remainingSeconds = Math.ceil(remainingMs / 1000)
        log(`[BAF]: Bazaar orders on cooldown for ${remainingSeconds} more seconds, queuing order`, 'warn')
        printMcChatToConsole(`§f[§4BAF§f]: §e[Cooldown] Waiting ${remainingSeconds}s, then will retry order`)
        
        // Queue the order to retry after cooldown expires
        setTimeout(() => {
            log('[BAF]: Cooldown expired, retrying queued order', 'info')
            handleBazaarFlipRecommendation(bot, recommendation)
        }, remainingMs + 1000) // Add 1 second buffer
        return
    }

    // Check if we can place the order (dynamic slot checking) - pass bot for fast check mode
    const orderCheck = canPlaceOrder(recommendation.isBuyOrder, bot)
    if (!orderCheck.canPlace) {
        // If order count needs refresh, attempt to refresh and try again
        if (orderCheck.needsRefresh) {
            log('[BAF]: Order count is stale, refreshing...', 'info')
            printMcChatToConsole('§f[§4BAF§f]: §7Refreshing order count...')
            const refreshed = await refreshOrderCounts(bot)
            if (refreshed) {
                log('[BAF]: Order count refreshed, proceeding with order placement', 'info')
                // Check again after refresh
                const retryCheck = canPlaceOrder(recommendation.isBuyOrder, bot)
                // Block only if it's a confirmed hard limit (not stale, not can place)
                if (!retryCheck.canPlace && !retryCheck.needsRefresh) {
                    // Hard limit confirmed - discard the order
                    log(`[BAF]: Order limit reached - ${retryCheck.reason}, discarding order`, 'warn')
                    
                    // Rate-limit the warning message to once per minute
                    const now = Date.now()
                    if (now - lastLimitWarningTime >= LIMIT_WARNING_COOLDOWN_MS) {
                        printMcChatToConsole(`§f[§4BAF§f]: §e[Limit] ${retryCheck.reason} - order discarded`)
                        lastLimitWarningTime = now
                    }
                    
                    // Don't schedule retries - fast check mode is now enabled to free up slots
                    // Future recommendations will be processed once slots are available
                    return
                }
                // Otherwise continue with order placement (Hypixel will enforce actual limits)
            } else {
                // Refresh failed, but proceed anyway - Hypixel will enforce actual limits
                log('[BAF]: Failed to refresh order count, attempting order placement anyway (Hypixel will enforce limits)', 'warn')
                printMcChatToConsole('§f[§4BAF§f]: §e[Warning] Order count refresh failed, attempting placement...')
                // Don't return - continue with order placement
            }
        } else {
            // This is a hard limit from our counts - discard the order
            log(`[BAF]: Order limit reached - ${orderCheck.reason}, discarding order`, 'warn')
            
            // Rate-limit the warning message to once per minute
            const now = Date.now()
            if (now - lastLimitWarningTime >= LIMIT_WARNING_COOLDOWN_MS) {
                printMcChatToConsole(`§f[§4BAF§f]: §e[Limit] ${orderCheck.reason} - order discarded`)
                lastLimitWarningTime = now
            }
            
            // Don't schedule retries - fast check mode is now enabled to free up slots
            // Future recommendations will be processed once slots are available
            return
        }
    }

    // Feature 6: Check if bot can afford the order
    const totalPrice = recommendation.totalPrice || (recommendation.pricePerUnit * recommendation.amount)
    const currentPurse = getCurrentPurse()
    if (currentPurse > 0 && totalPrice > currentPurse) {
        log(`[BAF]: Cannot place order - insufficient funds (need ${totalPrice.toFixed(0)}, have ${currentPurse.toFixed(0)})`, 'warn')
        printMcChatToConsole(`§f[§4BAF§f]: §cCannot place order - insufficient funds`)
        return
    }

    // Check if bazaar flips are paused due to incoming AH flip
    if (areBazaarFlipsPaused()) {
        log('[BazaarDebug] Bazaar flips are paused due to incoming AH flip, queueing recommendation', 'warn')
        queueBazaarFlip(bot, recommendation)
        return
    }

    // Queue the bazaar flip with appropriate priority:
    // - SELL orders use HIGH priority (bypass queue limits, free up inventory)
    // - BUY orders use NORMAL priority (can be queued/limited)
    // Both are interruptible by AH flips
    const orderType = recommendation.isBuyOrder ? 'BUY' : 'SELL'
    const commandName = `Bazaar ${orderType}: ${recommendation.amount}x ${recommendation.itemName}`
    const priority = recommendation.isBuyOrder ? CommandPriority.NORMAL : CommandPriority.HIGH
    
    enqueueCommand(
        commandName,
        priority,
        async () => {
            await executeBazaarFlip(bot, recommendation)
        },
        true, // interruptible - can be interrupted by AH flips
        recommendation.itemName
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
    log(`[BazaarDebug] Price per unit: ${recommendation.pricePerUnit} coins`, 'info')
    log(`[BazaarDebug] Total price: ${recommendation.totalPrice || (recommendation.pricePerUnit * recommendation.amount)} coins`, 'info')
    log(`[BazaarDebug] Order type: ${recommendation.isBuyOrder ? 'BUY' : 'SELL'}`, 'info')
    log(`[BazaarDebug] =====================================`, 'info')
    
    printMcChatToConsole(`§f[§4BAF§f]: §7━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    printMcChatToConsole(`§f[§4BAF§f]: §e${recommendation.isBuyOrder ? 'BUY' : 'SELL'} ORDER §7- §e${recommendation.itemName}`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Amount: §a${recommendation.amount}x`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Price/unit: §6${recommendation.pricePerUnit.toFixed(1)} coins`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Total: §6${(recommendation.totalPrice || (recommendation.pricePerUnit * recommendation.amount)).toFixed(1)} coins`)
    printMcChatToConsole(`§f[§4BAF§f]: §7━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

    const { itemName, itemTag, amount, pricePerUnit, totalPrice, isBuyOrder } = recommendation
    const displayTotalPrice = totalPrice || (pricePerUnit * amount)

    // Prefer itemTag (internal ID like "FLAWED_PERIDOT_GEM") over itemName for /bz command
    // Using itemTag skips the search results page and goes directly to the item, which is faster
    // Falls back to itemName if itemTag is not available
    // When using itemName, convert to title case to ensure Hypixel's /bz command finds the item
    const searchTerm = itemTag || toTitleCase(itemName)
    if (!searchTerm) {
        throw new Error('Both itemTag and itemName are missing from recommendation')
    }
    if (itemTag) {
        log(`[BazaarDebug] Using itemTag "${itemTag}" for /bz command (faster, skips search results)`, 'info')
    } else if (itemName) {
        log(`[BazaarDebug] itemTag not available, using itemName "${itemName}" (converted to title case: "${searchTerm}") for /bz command`, 'info')
    }

    // Retry loop for order placement
    let lastError: Error | null = null
    for (let attempt = 1; attempt <= MAX_ORDER_PLACEMENT_RETRIES; attempt++) {
        bot.state = 'bazaar'
        let operationTimeout: NodeJS.Timeout | null = null
        const bazaarTracking = {
            windowOpened: false,
            retryTimer: null as NodeJS.Timeout | null,
            openTracker: null as ((packet: any) => void) | null
        }

        try {
            // Set operation timeout
            operationTimeout = setTimeout(() => {
                if (bot.state === 'bazaar') {
                    log("[BazaarDebug] ERROR: Timeout waiting for bazaar order placement (20 seconds)", 'error')
                    log("[BazaarDebug] This usually means the /bz command didn't open a window or the window detection failed", 'error')
                    printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Bazaar order timed out - check if /bz command works`)
                    bot.state = null
                    // Note: The placeBazaarOrder function will clean up its own listener on timeout
                }
            }, OPERATION_TIMEOUT_MS)

            bazaarTracking.openTracker = (packet) => {
                if (bazaarTracking.windowOpened) return
                bazaarTracking.windowOpened = true
                log(`[BazaarDebug] [Tracker] Detected open_window for bazaar flip: id=${packet?.windowId} type=${packet?.windowType} rawTitle=${JSON.stringify(packet?.windowTitle)}`, 'info')
            }
            bot._client.on('open_window', bazaarTracking.openTracker)
            
            if (attempt > 1) {
                // This is a retry - log it
                log(`[BazaarDebug] Retry attempt ${attempt}/${MAX_ORDER_PLACEMENT_RETRIES} for ${itemName}`, 'info')
                printMcChatToConsole(`§f[§4BAF§f]: §e[Retry] Attempt ${attempt}/${MAX_ORDER_PLACEMENT_RETRIES}`)
            } else {
                printMcChatToConsole(
                    `§f[§4BAF§f]: §fPlacing ${isBuyOrder ? 'buy' : 'sell'} order for ${amount}x ${itemName} at ${pricePerUnit.toFixed(1)} coins each (total: ${displayTotalPrice.toFixed(1)})`
                )
            }

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
            
            // Success! Clean up and return
            clearTimeout(operationTimeout)
            if (bazaarTracking.retryTimer) clearTimeout(bazaarTracking.retryTimer)
            if (bazaarTracking.openTracker) {
                bot._client.removeListener('open_window', bazaarTracking.openTracker)
            }
            bot.state = null
            return // Success - exit retry loop
        } catch (error) {
            lastError = error as Error
            const errorMessage = error instanceof Error ? error.message : String(error)
            
            // Check if this is a timeout error that we should retry
            const isTimeoutError = errorMessage.includes('timed out')
            const isRetryableError = isTimeoutError || errorMessage.includes('Price failsafe')
            
            log(`[BazaarDebug] Error handling bazaar flip (attempt ${attempt}/${MAX_ORDER_PLACEMENT_RETRIES}): ${errorMessage}`, 'error')
            
            if (attempt < MAX_ORDER_PLACEMENT_RETRIES && isRetryableError) {
                // Calculate exponential backoff delay
                const backoffDelay = RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1)
                log(`[BazaarDebug] Will retry after ${backoffDelay}ms delay...`, 'info')
                printMcChatToConsole(`§f[§4BAF§f]: §e[Retry] Retrying in ${backoffDelay}ms...`)
                
                // Clean up before retry
                if (operationTimeout) clearTimeout(operationTimeout)
                if (bazaarTracking.retryTimer) clearTimeout(bazaarTracking.retryTimer)
                if (bazaarTracking.openTracker) {
                    bot._client.removeListener('open_window', bazaarTracking.openTracker)
                }
                
                // Close any open windows before retry
                if (bot.currentWindow) {
                    try {
                        bot.closeWindow(bot.currentWindow)
                    } catch (e) {
                        log(`[BazaarDebug] Error closing window before retry: ${e}`, 'debug')
                    }
                }
                
                bot.state = null
                await sleep(backoffDelay)
                // Continue to next retry attempt
            } else {
                // Either max retries reached or non-retryable error
                if (!isRetryableError) {
                    log(`[BazaarDebug] Non-retryable error, aborting: ${errorMessage}`, 'error')
                    printMcChatToConsole(`§f[§4BAF§f]: §cNon-retryable error: ${errorMessage}`)
                    
                    // If this is a limit error, trigger an immediate order count refresh
                    // to ensure our counts are up to date for future orders
                    if (errorMessage.includes('Order limit reached')) {
                        log('[BazaarDebug] Triggering immediate order count refresh after limit error', 'info')
                        // Schedule refresh in background (don't await to avoid blocking)
                        refreshOrderCounts(bot).catch((err: unknown) => {
                            const errorMsg = err instanceof Error ? err.message : String(err)
                            log(`[BazaarDebug] Failed to refresh order counts after hitting limit: ${errorMsg}`, 'error')
                            log('[BazaarDebug] Future order placement may use stale counts until next refresh', 'warn')
                        })
                        
                        // Clear all pending bazaar orders from the queue since they will also fail
                        log('[BazaarDebug] Clearing pending bazaar orders from queue', 'info')
                        clearBazaarOrders()
                    }
                } else {
                    log(`[BazaarDebug] Max retries (${MAX_ORDER_PLACEMENT_RETRIES}) reached, giving up`, 'error')
                    printMcChatToConsole(`§f[§4BAF§f]: §cFailed after ${MAX_ORDER_PLACEMENT_RETRIES} attempts`)
                }
                printMcChatToConsole(`§f[§4BAF§f]: §cFailed to place bazaar order: ${errorMessage}`)
                
                // Clean up
                if (operationTimeout) clearTimeout(operationTimeout)
                if (bazaarTracking.retryTimer) clearTimeout(bazaarTracking.retryTimer)
                if (bazaarTracking.openTracker) {
                    bot._client.removeListener('open_window', bazaarTracking.openTracker)
                }
                bot.state = null
                
                // Re-throw the error to propagate it
                throw lastError
            }
        }
    }
    
    // If we get here, all retries failed
    bot.state = null
    throw lastError || new Error('Order placement failed after all retries')
}

/**
 * Place a bazaar order by navigating through the Hypixel bazaar interface
 * Exported for use by bazaarOrderManager for re-listing cancelled orders
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
export function placeBazaarOrder(bot: MyBot, itemName: string, amount: number, pricePerUnit: number, isBuyOrder: boolean): Promise<void> {
    // BUG 1 FIX: Add entry logging to verify function is being called
    log(`[BAF] [BazaarFlow] Starting placeBazaarOrder for ${itemName} (${amount}x @ ${pricePerUnit.toFixed(1)} coins, ${isBuyOrder ? 'BUY' : 'SELL'})`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[BazaarFlow] Placing ${isBuyOrder ? 'buy' : 'sell'} order for §e${itemName}`)
    
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
        
        // Helper: Check for red error messages in window
        // Window type is from bot.currentWindow (mineflayer Window type)
        const checkForBazaarErrors = (win: any): string | null => {
            // Known bazaar error patterns that should abort order placement
            const knownErrorPatterns = [
                'cannot place any more',
                'order limit',
                'insufficient',
                'not enough',
                'maximum orders',
                'buy order limit',
                'sell offer limit'
            ]
            
            for (let i = 0; i < win.slots.length; i++) {
                const slot = win.slots[i]
                if (!slot || !slot.nbt) continue
                
                // Check display name for red text (§c)
                const rawName = (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                if (rawName.includes('§c')) {
                    const cleanName = removeMinecraftColorCodes(rawName).toLowerCase()
                    // Check if it matches known error patterns
                    for (const pattern of knownErrorPatterns) {
                        if (cleanName.includes(pattern)) {
                            const fullCleanName = removeMinecraftColorCodes(rawName)
                            log(`[BazaarDebug] Detected bazaar error message: ${fullCleanName}`, 'warn')
                            return fullCleanName
                        }
                    }
                }
                
                // Also check lore for red text errors
                const lore = (slot?.nbt as any)?.value?.display?.value?.Lore?.value?.value
                if (lore && Array.isArray(lore)) {
                    for (const loreLine of lore) {
                        const rawLoreLine = loreLine.toString()
                        if (rawLoreLine.includes('§c')) {
                            const cleanLine = removeMinecraftColorCodes(rawLoreLine).toLowerCase()
                            // Check if it matches known error patterns
                            for (const pattern of knownErrorPatterns) {
                                if (cleanLine.includes(pattern)) {
                                    const fullCleanLine = removeMinecraftColorCodes(rawLoreLine)
                                    log(`[BazaarDebug] Detected bazaar error in lore: ${fullCleanLine}`, 'warn')
                                    return fullCleanLine
                                }
                            }
                        }
                    }
                }
            }
            return null
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
            log(`[BAF] [BazaarFlow] Window opened: "${title}" at step: ${currentStep}`, 'info')
            log(`[BazaarDebug] Window opened: "${title}" at step: ${currentStep}`, 'info')
            
            // Log all slots in this window for debugging
            logWindowSlots(window, title)
            
            // Check for red error messages from bazaar
            const errorMessage = checkForBazaarErrors(window)
            if (errorMessage) {
                log(`[BazaarDebug] Bazaar error detected: ${errorMessage}`, 'error')
                printMcChatToConsole(`§f[§4BAF§f]: §cBazaar error: ${errorMessage}`)
                printMcChatToConsole(`§f[§4BAF§f]: §cAbandoning order placement due to bazaar error`)
                bot._client.removeListener('open_window', windowListener)
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                reject(new Error(`Bazaar error: ${errorMessage}`))
                return
            }

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
                    
                    // Use findItemInSearchResults to prefer exact matches (BUG 2 & 3 FIX)
                    const itemSlot = findItemInSearchResults(window, itemName)
                    
                    if (itemSlot === -1) {
                        // BUG 3 FIX: Do NOT use fallback slot - if item not found, skip and fail
                        // Log what IS in the window so we can debug
                        const availableItems = []
                        for (let i = 0; i < window.slots.length; i++) {
                            const slot = window.slots[i]
                            if (!slot || !slot.nbt) continue
                            // getSlotName() already applies removeMinecraftColorCodes via getItemDisplayName()
                            const name = getSlotName(slot)
                            if (name && name !== '' && name !== 'close' && name !== 'Close') {
                                availableItems.push(`slot ${i}: ${name}`)
                            }
                        }
                        log(`[BAF] Item "${itemName}" not found in search results. Available: ${availableItems.join(', ')}`, 'warn')
                        printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Item "${itemName}" not found in search results`)
                        bot._client.removeListener('open_window', windowListener)
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        reject(new Error(`Item "${itemName}" not found in bazaar search results`))
                        return
                    }
                    
                    // Get the item name from the slot for logging
                    const slot = window.slots[itemSlot]
                    // getSlotName() already applies removeMinecraftColorCodes via getItemDisplayName()
                    const name = getSlotName(slot)
                    log(`[BazaarDebug] Found item "${name}" at slot ${itemSlot}`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Found] §e${name}§7 at slot §b${itemSlot}`)
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
                    log(`[BazaarDebug] Setting price per unit to ${pricePerUnit} via slot ${customPriceSlot}`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Price] Setting to §e${pricePerUnit.toFixed(1)}§7 coins via slot §b${customPriceSlot}`)
                    currentStep = 'setPrice'
                    
                    // Register sign handler BEFORE clicking to avoid race condition
                    bot._client.once('open_sign_entity', (packet: any) => {
                        const { location, text1, text2, text3, text4 } = packet
                        
                        // Failsafe: Check if the current price in the sign is lower than 90% of recommended price
                        // For BUY orders: sign shows instant-buy price, we want to place order below that
                        // For SELL orders: sign shows instant-sell price, we want to place order above that
                        // Validate that the market hasn't moved too far from the recommendation
                        let currentSignPrice = 0
                        const signTexts = [text1, text2, text3, text4].filter(t => t)
                        
                        for (const signText of signTexts) {
                            try {
                                // Parse JSON formatted text or plain text
                                let textContent = signText
                                if (typeof signText === 'string' && signText.includes('{')) {
                                    const parsed = JSON.parse(signText)
                                    textContent = parsed.text || parsed.extra?.[0] || signText
                                }
                                
                                // Remove non-numeric characters and try to parse as number
                                const cleanText = String(textContent).replace(/[^0-9.]/g, '')
                                const parsedPrice = parseFloat(cleanText)
                                
                                if (!isNaN(parsedPrice) && parsedPrice > 0) {
                                    currentSignPrice = parsedPrice
                                    break
                                }
                            } catch (e) {
                                // Ignore parsing errors, continue to next line
                            }
                        }
                        
                        // Apply failsafe check based on order type
                        if (currentSignPrice > 0) {
                            let failsafeTriggered = false
                            let reason = ''
                            
                            if (isBuyOrder) {
                                // Buy order: reject if sign price (instant-buy) is too low (< 90% of our order price)
                                // This means market crashed or recommendation is stale
                                const minAcceptablePrice = pricePerUnit * PRICE_FAILSAFE_BUY_THRESHOLD
                                if (currentSignPrice < minAcceptablePrice) {
                                    failsafeTriggered = true
                                    reason = `Sign instant-buy ${currentSignPrice.toFixed(1)} < ${(PRICE_FAILSAFE_BUY_THRESHOLD * 100)}% of order price ${pricePerUnit.toFixed(1)}`
                                }
                            } else {
                                // Sell order: reject if sign price (instant-sell) is too high (> 110% of our order price)
                                // This means market pumped or recommendation is stale
                                const maxAcceptablePrice = pricePerUnit * PRICE_FAILSAFE_SELL_THRESHOLD
                                if (currentSignPrice > maxAcceptablePrice) {
                                    failsafeTriggered = true
                                    reason = `Sign instant-sell ${currentSignPrice.toFixed(1)} > ${(PRICE_FAILSAFE_SELL_THRESHOLD * 100)}% of order price ${pricePerUnit.toFixed(1)}`
                                }
                            }
                            
                            if (failsafeTriggered) {
                                log(`[BazaarDebug] FAILSAFE: ${reason}`, 'warn')
                                printMcChatToConsole(`§f[§4BAF§f]: §c[Failsafe] Market price mismatch!`)
                                printMcChatToConsole(`§f[§4BAF§f]: §c[Failsafe] ${reason}`)
                                printMcChatToConsole(`§f[§4BAF§f]: §c[Failsafe] Closing GUI and retrying...`)
                                
                                // Close the window and reject to trigger retry
                                bot._client.removeListener('open_window', windowListener)
                                if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                                reject(new Error(`Price failsafe: ${reason}`))
                                return
                            }
                        }
                        
                        log(`[BazaarDebug] Sign opened for price, current sign price: ${currentSignPrice > 0 ? currentSignPrice : 'unknown'}, writing: ${pricePerUnit}`, 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §7[Sign] Writing price: §e${pricePerUnit.toFixed(1)}§7 coins`)
                        bot._client.write('update_sign', {
                            location: { x: location.x, y: location.y, z: location.z },
                            text1: `\"${pricePerUnit}\"`,
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
                    
                    // Set up listener to catch order rejection messages
                    let orderRejected = false
                    let rejectionReason = ''
                    const chatListener = (message: any) => {
                        const text = message.toString()
                        if (text.includes('[Bazaar]')) {
                            // Check for order limit messages
                            if (text.includes('maximum') && text.includes('orders')) {
                                orderRejected = true
                                rejectionReason = 'Order limit reached'
                                log(`[BazaarDebug] Order rejected: ${text}`, 'warn')
                            }
                            // Check for cooldown messages
                            else if (text.includes('cooldown')) {
                                orderRejected = true
                                rejectionReason = 'Orders on cooldown'
                                log(`[BazaarDebug] Order rejected: ${text}`, 'warn')
                            }
                        }
                    }
                    
                    try {
                        bot.on('message', chatListener)
                        
                        await sleep(200)
                        await clickWindow(bot, 13).catch(e => log(`[BazaarDebug] clickWindow error (expected): ${e}`, 'debug'))
                        
                        // Wait to see if Hypixel sends a rejection message
                        await sleep(ORDER_REJECTION_WAIT_MS)
                    } finally {
                        // Always clean up chat listener, even if an error occurs
                        bot.removeListener('message', chatListener)
                    }
                    
                    if (orderRejected) {
                        log(`[BazaarDebug] Order placement failed: ${rejectionReason}`, 'error')
                        printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Order placement failed: ${rejectionReason}`)
                        bot._client.removeListener('open_window', windowListener)
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        reject(new Error(rejectionReason))
                        return
                    }
                    
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

        // BUG 1 FIX: Log /bz command execution
        log(`[BAF] [BazaarFlow] Executing /bz ${itemName} to open bazaar`, 'info')
        bot.chat(`/bz ${itemName}`)
        
        // Set a timeout for the entire operation
        setTimeout(() => {
            bot._client.removeListener('open_window', windowListener)
            reject(new Error(`Bazaar order placement timed out at step: ${currentStep}`))
        }, OPERATION_TIMEOUT_MS)
    })
}
