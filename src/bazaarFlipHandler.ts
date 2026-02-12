import { MyBot, BazaarFlipRecommendation } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { getConfigProperty } from './configHelper'
import { areBazaarFlipsPaused, queueBazaarFlip, areAHFlipsPending } from './bazaarFlipPauser'
import { sendWebhookBazaarOrderPlaced } from './webhookHandler'
import { recordOrder, canPlaceOrder, refreshOrderCounts, getOrderCounts } from './bazaarOrderManager'
import { enqueueCommand, CommandPriority } from './commandQueue'
import { isBazaarDailyLimitReached } from './ingameMessageHandler'
import { getCurrentPurse } from './BAF'
import { getFreeInventorySlots } from './inventoryManager'
import { recordBuyOrder, recordSellOrder } from './bazaarProfitTracker'
import {  
    findItemInSearchResults,
    findSlotWithName as findSlotByName,
    clickAndWaitForWindow,
    clickAndWaitForSign,
    waitForNewWindow,
    findAndClick
} from './bazaarHelpers'

// Constants
const RETRY_DELAY_MS = 1100
const OPERATION_TIMEOUT_MS = 20000
const MAX_LOGGED_SLOTS = 15 // Maximum number of slots to log per window to avoid spam
const MINEFLAYER_WINDOW_PROCESS_DELAY_MS = 300 // Time to wait for mineflayer to populate bot.currentWindow
const BAZAAR_RETRY_DELAY_MS = 100

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

    // Proactive inventory check before placing buy orders
    // Using threshold of 3 free slots to provide adequate buffer
    if (recommendation.isBuyOrder) {
        const freeSlots = getFreeInventorySlots(bot)
        if (freeSlots <= 3) {
            log('[BAF] Skipping buy order — inventory nearly full (need to free space first)', 'warn')
            printMcChatToConsole('§f[§4BAF§f]: §c[BAF] Skipping buy order — inventory nearly full')
            // TODO: Could queue auto-sell here and retry later
            return
        }
    }

    // Feature 4: Check if daily sell limit reached (skip sell offers, allow buy orders)
    if (!recommendation.isBuyOrder && isBazaarDailyLimitReached()) {
        log('[BAF]: Cannot place sell offer - bazaar daily sell limit reached', 'warn')
        printMcChatToConsole('§f[§4BAF§f]: §cCannot place sell offer - daily sell limit reached')
        return
    }

    // Only buy orders are subject to queue limit and order slot checks
    if (recommendation.isBuyOrder) {
        // Check if we can place the order (dynamic slot checking)
        const orderCheck = canPlaceOrder(recommendation.isBuyOrder)
        if (!orderCheck.canPlace) {
            // If order count needs refresh, try to refresh it
            if (orderCheck.needsRefresh) {
                log('[BAF]: Order count is stale, refreshing...', 'info')
                const refreshed = await refreshOrderCounts(bot)
                if (refreshed) {
                    // Re-check after refresh
                    const recheckOrder = canPlaceOrder(recommendation.isBuyOrder)
                    if (!recheckOrder.canPlace) {
                        log(`[BAF]: Cannot place order after refresh - ${recheckOrder.reason}`, 'warn')
                        printMcChatToConsole(`§f[§4BAF§f]: §cCannot place order - ${recheckOrder.reason}`)
                        return
                    }
                    // If can place after refresh, continue
                } else {
                    log('[BAF]: Failed to refresh order count, skipping order', 'warn')
                    return
                }
            } else {
                log(`[BAF]: Cannot place order - ${orderCheck.reason}`, 'warn')
                printMcChatToConsole(`§f[§4BAF§f]: §cCannot place order - ${orderCheck.reason}`)
                return
            }
        }
    }
    // Sell offers — skip order slot checks entirely

    // Feature 6: Check if bot can afford the order (buy orders only)
    if (recommendation.isBuyOrder) {
        const totalCost = recommendation.totalPrice || (recommendation.pricePerUnit * recommendation.amount)
        const currentPurse = getCurrentPurse()
        
        if (currentPurse > 0 && currentPurse < totalCost) {
            log(`[BAF] Cannot place buy order - insufficient funds (purse: ${currentPurse}, cost: ${totalCost})`, 'warn')
            printMcChatToConsole(`§f[§4BAF§f]: §cCannot place buy order - insufficient funds`)
            return
        }
    }
    // Sell offers — skip insufficient funds check entirely

    // Check if bazaar flips are paused due to incoming AH flip
    if (areBazaarFlipsPaused()) {
        log('[BazaarDebug] Bazaar flips are paused due to incoming AH flip, queueing recommendation', 'warn')
        queueBazaarFlip(bot, recommendation)
        return
    }

    // BUG 2: Check for duplicate tracked orders
    const orderCounts = getOrderCounts()
    const activeOrders = orderCounts.totalOrders
    if (activeOrders > 0) {
        // Import trackedOrders to check for duplicates
        const { default: bazaarOrderManager } = require('./bazaarOrderManager')
        // We need to check if there's already an order for this item
        // This is handled in the commandQueue now
    }

    // Queue the bazaar flip with priority based on order type
    // Sell offers get HIGH priority (process first), buy orders get NORMAL priority
    // This ensures sell offers (which free inventory) are processed before buy orders
    const orderType = recommendation.isBuyOrder ? 'BUY' : 'SELL'
    const priority = recommendation.isBuyOrder ? CommandPriority.NORMAL : CommandPriority.HIGH
    const commandName = `Bazaar ${orderType}: ${recommendation.amount}x ${recommendation.itemName}`
    
    // BUG 2: Pass item name for duplicate detection and add retry wrapper
    enqueueCommand(
        commandName,
        priority,
        async () => {
            // First attempt
            try {
                await executeBazaarFlip(bot, recommendation)
            } catch (error) {
                // BUG 2: If first attempt fails, retry once after a short delay
                log(`[BAF] Bazaar operation failed, retrying in ${BAZAAR_RETRY_DELAY_MS}ms: ${error}`, 'warn')
                printMcChatToConsole(`§f[§4BAF§f]: §e[BAF] Retrying bazaar operation in ${BAZAAR_RETRY_DELAY_MS}ms...`)
                await sleep(BAZAAR_RETRY_DELAY_MS)
                
                // Check if AH flips are pending before retry
                if (areAHFlipsPending()) {
                    log('[BAF] Skipping retry — AH flips pending', 'info')
                    throw new Error('AH flips incoming - retry aborted')
                }
                
                // Second attempt - let this one throw if it fails
                await executeBazaarFlip(bot, recommendation)
            }
        },
        true, // interruptible - can be interrupted by AH flips
        recommendation.itemName // for duplicate checking
    )
}

/**
 * Execute a bazaar flip operation
 * This is the actual implementation that runs from the queue
 */
async function executeBazaarFlip(bot: MyBot, recommendation: BazaarFlipRecommendation): Promise<void> {
    // BUG 3: Check if AH flips are pending before starting
    if (areAHFlipsPending()) {
        log('[BAF] Aborting bazaar operation — AH flips incoming', 'info')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        bot.state = null
        throw new Error('AH flips incoming - operation aborted')
    }
    
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

    try {
        const { itemName, amount, pricePerUnit, isBuyOrder } = recommendation
        
        printMcChatToConsole(
            `§f[§4BAF§f]: §fPlacing ${isBuyOrder ? 'buy' : 'sell'} order for ${amount}x ${itemName} at ${pricePerUnit.toFixed(1)} coins each`
        )

        // BUG 2: Use new resilient placeBazaarOrder function
        await placeBazaarOrder(bot, itemName, amount, pricePerUnit, isBuyOrder)
        
        // Record the order for tracking (claiming and cancelling)
        recordOrder(recommendation)
        
        // Record order for profit tracking
        if (recommendation.isBuyOrder) {
            recordBuyOrder(recommendation.itemName, recommendation.pricePerUnit, recommendation.amount)
        } else {
            recordSellOrder(recommendation.itemName, recommendation.pricePerUnit, recommendation.amount)
        }
        
        log('[BazaarDebug] ===== BAZAAR FLIP ORDER COMPLETED =====', 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §aSuccessfully placed bazaar order!`)
    } catch (error) {
        log(`[BazaarDebug] Error handling bazaar flip: ${error}`, 'error')
        printMcChatToConsole(`§f[§4BAF§f]: §cFailed to place bazaar order: ${error}`)
        throw error // Re-throw to trigger retry
    } finally {
        bot.state = null
    }
}

/**
 * BUG 2: Place a bazaar order by navigating through the Hypixel bazaar interface
 * Now uses resilient helper functions with automatic retries for each step
 */
/**
 * Place a bazaar order (buy or sell)
 * Exported for use by startupOrderManagement and other modules
 */
export async function placeBazaarOrder(bot: MyBot, itemName: string, amount: number, pricePerUnit: number, isBuyOrder: boolean): Promise<void> {
    // Step 1: /bz command — opens new window
    bot.chat(`/bz ${itemName}`)
    const bazaarOpened = await waitForNewWindow(bot, 2000)
    if (!bazaarOpened || !bot.currentWindow) {
        log(`[BAF] /bz didn't open a window`, 'warn')
        throw new Error('/bz command failed to open window')
    }
    
    // Step 2: If search results page, find and click the correct item
    const title = getWindowTitle(bot.currentWindow)
    if (title && title.includes('Bazaar')) {
        // Wait for search results to populate after window opens
        await sleep(500)
        
        // Search results — find exact match using BUG 1 fix
        const itemSlot = findItemInSearchResults(bot.currentWindow, itemName)
        if (itemSlot === -1) {
            log(`[BAF] Item "${itemName}" not found in search results`, 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            throw new Error(`Item "${itemName}" not found in search results`)
        }
        // Click item — opens new window or same window updates
        const clicked = await clickAndWaitForWindow(bot, itemSlot, 1000)
        if (!bot.currentWindow) {
            throw new Error('Window closed after item selection')
        }
    }
    
    // Step 3: Item detail page — click Create Buy Order or Create Sell Offer
    const orderButtonName = isBuyOrder ? 'Create Buy Order' : 'Create Sell Offer'
    const orderButtonClicked = await findAndClick(bot, orderButtonName, { waitForNewWindow: true, timeout: 1000 })
    if (!orderButtonClicked) {
        log(`[BAF] "${orderButtonName}" button click failed`, 'warn')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        throw new Error(`Failed to click "${orderButtonName}"`)
    }
    
    // Step 4: Amount step (buy orders only — sell offers skip this)
    if (isBuyOrder) {
        // Find and click Custom Amount — this opens a sign
        const customAmountSlot = findSlotByName(bot.currentWindow, 'Custom Amount')
        if (customAmountSlot !== -1) {
            const amountSigned = await clickAndWaitForSign(bot, customAmountSlot, Math.floor(amount).toString())
            if (!amountSigned) {
                log(`[BAF] Custom Amount sign failed`, 'warn')
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                throw new Error('Failed to set amount')
            }
            // Wait for window to return after sign
            await waitForNewWindow(bot, 1000)
        }
    }
    
    // Step 5: Price step — click Custom Price, opens a sign
    if (!bot.currentWindow) {
        throw new Error('Window closed before price step')
    }
    const customPriceSlot = findSlotByName(bot.currentWindow, 'Custom Price')
    if (customPriceSlot === -1) {
        log(`[BAF] Custom Price button not found`, 'warn')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        throw new Error('Custom Price button not found')
    }
    
    const priceSigned = await clickAndWaitForSign(bot, customPriceSlot, pricePerUnit.toFixed(1))
    if (!priceSigned) {
        log(`[BAF] Custom Price sign failed`, 'warn')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        throw new Error('Failed to set price')
    }
    
    // Wait for confirm window after sign
    await waitForNewWindow(bot, 1000)
    
    // Step 6: Confirm — click slot 13
    if (!bot.currentWindow) {
        throw new Error('Window closed before confirmation')
    }
    await clickWindow(bot, 13).catch(() => {})
    
    log(`[BAF] Successfully placed ${isBuyOrder ? 'buy order' : 'sell offer'} for ${amount}x ${itemName}`, 'info')
    
    // Send webhook notification
    const totalPrice = pricePerUnit * amount
    sendWebhookBazaarOrderPlaced(itemName, amount, pricePerUnit, totalPrice, isBuyOrder)
    
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
}
