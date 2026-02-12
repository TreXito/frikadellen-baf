import { MyBot, BazaarFlipRecommendation } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { getConfigProperty } from './configHelper'
import { areBazaarFlipsPaused, areAHFlipsPending } from './bazaarFlipPauser'
import { enqueueCommand, CommandPriority } from './commandQueue'
import { sendWebhookBazaarOrderCancelled, sendWebhookBazaarOrderClaimed } from './webhookHandler'
import {
    findSlotWithName as findSlotByName,
    clickAndWaitForWindow,
    clickAndWaitForUpdate,
    findAndClick
} from './bazaarHelpers'

/**
 * Represents a tracked bazaar order
 */
interface BazaarOrderRecord {
    itemName: string
    amount: number
    pricePerUnit: number
    isBuyOrder: boolean
    placedAt: number // Date.now()
    claimed: boolean
    cancelled: boolean
    // Feature 2: Lore-based order details
    filled?: number // How many have been filled
    totalAmount?: number // Total amount ordered (same as amount, but parsed from lore)
    fillPercentage?: number // Percentage filled (0-100)
    isFullyFilled?: boolean // True if 100% filled
}

// Internal list of tracked orders
let trackedOrders: BazaarOrderRecord[] = []

// Timer for periodic order checks
let checkTimer: NodeJS.Timeout | null = null

// Flag to track if we're currently managing orders
let isManagingOrders = false

// Dynamic order slot limits (defaults to Hypixel's known limits, updated dynamically)
let maxTotalOrders = 21 // Default to 21, will be updated from Manage Orders window
let maxBuyOrders = 7
let currentBazaarOrders = 0
let currentBuyOrders = 0
let lastOrderCountUpdate = 0 // Timestamp of last order count update

// Flag to track if we hit a limit (to avoid spamming attempts)
let orderLimitReached = false
let buyOrderLimitReached = false

// Retry delay for claim operations when bazaar flips are paused (5 seconds)
const CLAIM_RETRY_DELAY_MS = 5000

// Constants for claiming filled orders
const MAX_CLAIM_ATTEMPTS = 3 // Maximum number of times to click an item slot to claim
const CLAIM_DELAY_MS = 300 // Delay in milliseconds between claim attempts

// Delay before immediate order check to ensure command queue is ready
const IMMEDIATE_CHECK_DELAY_MS = 2000

// Delay after clicking an order in Manage Orders for window content to update
const WINDOW_UPDATE_DELAY_MS = 400

// Delay between batch order cancellations (to avoid overwhelming the server)
const BATCH_CANCEL_DELAY_MS = 300

/**
 * Helper: Extract display name from slot NBT data
 */
function getSlotName(slot: any): string {
    if (!slot || !slot.nbt) return ''
    return (slot.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
}

/**
 * Helper: Extract lore from slot NBT data
 */
function getSlotLore(slot: any): string[] {
    if (!slot || !slot.nbt) return []
    const loreData = (slot.nbt as any)?.value?.display?.value?.Lore?.value?.value
    if (!loreData || !Array.isArray(loreData)) return []
    return loreData.map((line: any) => removeMinecraftColorCodes(line.toString()))
}

/**
 * Helper: Find a slot by display name substring
 */
function findSlotWithName(win: any, searchName: string): number {
    for (let i = 0; i < win.slots.length; i++) {
        const slot = win.slots[i]
        const name = removeMinecraftColorCodes(getSlotName(slot))
        if (name && name.includes(searchName)) return i
    }
    return -1
}

/**
 * Helper: waits for a NEW open_window event
 */
function waitForNewWindow(bot: MyBot, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            bot._client.removeListener('open_window', handler)
            resolve(false)
        }, timeout)
        
        const handler = () => {
            clearTimeout(timer)
            bot._client.removeListener('open_window', handler)
            resolve(true)
        }
        
        bot._client.once('open_window', handler)
    })
}

/**
 * Count orders in the Manage Orders window
 * Updates the global order counts and max limits
 * @param window The Manage Orders window
 * @returns Object with total, buy, and sell order counts
 */
function countOrdersInWindow(window: any): { total: number, buy: number, sell: number } {
    let buy = 0
    let sell = 0
    
    if (!window || !window.slots) {
        return { total: 0, buy: 0, sell: 0 }
    }
    
    for (let i = 0; i < window.slots.length; i++) {
        const slot = window.slots[i]
        if (!slot || !slot.nbt) continue
        const name = removeMinecraftColorCodes(getSlotName(slot))
        if (name.startsWith('BUY ')) buy++
        else if (name.startsWith('SELL ')) sell++
    }
    
    const total = buy + sell
    
    // Update global counts
    currentBazaarOrders = total
    currentBuyOrders = buy
    lastOrderCountUpdate = Date.now()
    
    // Try to infer max total orders from window size or use higher default
    // Manage Orders window typically has more slots than just the orders
    // We can't reliably detect the max from the window itself, so we update based on actual usage
    // If we see more orders than current max, update the max
    if (total > maxTotalOrders) {
        maxTotalOrders = total
        log(`[OrderManager] Updated maxTotalOrders to ${maxTotalOrders} based on observed orders`, 'info')
    }
    
    log(`[OrderManager] Order count: ${total} total (${buy} buy, ${sell} sell), max: ${maxTotalOrders}`, 'debug')
    
    return { total, buy, sell }
}

/**
 * Feature 2: Parse order lore to extract fill status and details
 * Lore format example:
 * - "Order amount: 64x"
 * - "Filled: 26/64 (40.6%)"
 * - "Price per unit: 490.0 coins"
 */
function parseLoreForOrderDetails(lore: any[]): { filled: number, totalAmount: number, fillPercentage: number, pricePerUnit: number } | null {
    if (!lore || !Array.isArray(lore)) return null
    
    const loreText = lore.map((line: any) => removeMinecraftColorCodes(line.toString())).join('\n')
    
    let filled = 0
    let totalAmount = 0
    let fillPercentage = 0
    let pricePerUnit = 0
    
    // Parse "Filled: 26/64 (40.6%)" or "Filled: 64/64 (100%)"
    const filledMatch = loreText.match(/Filled:\s*(\d+)\/(\d+)\s*\((\d+(?:\.\d+)?)%\)/)
    if (filledMatch) {
        filled = parseInt(filledMatch[1], 10)
        totalAmount = parseInt(filledMatch[2], 10)
        fillPercentage = parseFloat(filledMatch[3])
    }
    
    // Parse "Order amount: 64x"
    const amountMatch = loreText.match(/Order amount:\s*(\d+)x/)
    if (amountMatch && totalAmount === 0) {
        totalAmount = parseInt(amountMatch[1], 10)
    }
    
    // Parse "Price per unit: 490.0 coins"
    const priceMatch = loreText.match(/Price per unit:\s*([\d,]+(?:\.\d+)?)\s*coins/)
    if (priceMatch) {
        pricePerUnit = parseFloat(priceMatch[1].replace(/,/g, ''))
    }
    
    if (totalAmount > 0) {
        return { filled, totalAmount, fillPercentage, pricePerUnit }
    }
    
    return null
}

/**
 * Helper to parse order lore for startup order management
 * Returns structured data for order cancellation and re-listing
 */
function parseOrderLore(lore: string[]): {
    amount: number,
    filled: number,
    remaining: number,
    pricePerUnit: number,
    isFullyFilled: boolean
} {
    let amount = 0, filled = 0, pricePerUnit = 0
    
    for (const line of lore) {
        const clean = removeMinecraftColorCodes(line).trim()
        
        // "Order amount: 64x" or "Amount: 64x"
        const amountMatch = clean.match(/(?:Order )?[Aa]mount:\s*([\d,]+)/)
        if (amountMatch) amount = parseInt(amountMatch[1].replace(/,/g, ''), 10)
        
        // "Filled: 26/64 (40.6%)" or "Filled: 64/64"
        const filledMatch = clean.match(/Filled:\s*([\d,]+)\/([\d,]+)/)
        if (filledMatch) {
            filled = parseInt(filledMatch[1].replace(/,/g, ''), 10)
            amount = parseInt(filledMatch[2].replace(/,/g, ''), 10)
        }
        
        // "Price per unit: 490.0 coins"
        const priceMatch = clean.match(/Price per unit:\s*([\d,.]+)/)
        if (priceMatch) pricePerUnit = parseFloat(priceMatch[1].replace(/,/g, ''))
    }
    
    return {
        amount,
        filled,
        remaining: amount - filled,
        pricePerUnit,
        isFullyFilled: filled >= amount && amount > 0
    }
}

/**
 * Feature 3: Count current orders
 * @returns Object with total order count, buy order count, and limits
 */
export function getOrderCounts(): { totalOrders: number, buyOrders: number, maxTotalOrders: number, maxBuyOrders: number } {
    const activeOrders = trackedOrders.filter(o => !o.claimed && !o.cancelled)
    const buyOrders = activeOrders.filter(o => o.isBuyOrder).length
    return {
        totalOrders: activeOrders.length,
        buyOrders,
        maxTotalOrders,
        maxBuyOrders
    }
}

/**
 * Check if we can place a new order based on current counts
 * If the order count is stale (>2 minutes), returns false to trigger refresh
 * @param isBuyOrder Whether the order is a buy order
 * @returns Object with canPlace flag and reason if false
 */
export function canPlaceOrder(isBuyOrder: boolean): { canPlace: boolean, reason?: string, needsRefresh?: boolean } {
    // Check if order count is stale (older than 2 minutes)
    const now = Date.now()
    const twoMinutes = 2 * 60 * 1000
    const isStale = (now - lastOrderCountUpdate) > twoMinutes
    
    if (isStale && lastOrderCountUpdate > 0) {
        log('[OrderManager] Order count is stale (>2 minutes), needs refresh', 'debug')
        return { canPlace: false, reason: 'Order count needs refresh', needsRefresh: true }
    }
    
    // Use current counts from last Manage Orders scan
    if (currentBazaarOrders >= maxTotalOrders) {
        return { canPlace: false, reason: `Total order slots full (${currentBazaarOrders}/${maxTotalOrders})` }
    }
    
    if (isBuyOrder && currentBuyOrders >= maxBuyOrders) {
        return { canPlace: false, reason: `Buy order slots full (${currentBuyOrders}/${maxBuyOrders})` }
    }
    
    return { canPlace: true }
}

/**
 * Reset order limit flags when an order is claimed or cancelled
 * This allows the bot to try placing orders again after freeing up a slot
 */
export function resetOrderLimitFlags(): void {
    const wasTotalLimitReached = orderLimitReached
    const wasBuyLimitReached = buyOrderLimitReached
    
    orderLimitReached = false
    buyOrderLimitReached = false
    
    if (wasTotalLimitReached || wasBuyLimitReached) {
        log('[OrderManager] Order limit flags reset - slots are now available', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §a[OrderManager] Order slots freed up!')
    }
}

/**
 * Refresh order counts by opening Manage Orders window
 * Should be called before placing orders if count is stale (>2 minutes)
 * @returns Promise<boolean> True if refresh succeeded, false otherwise
 */
export async function refreshOrderCounts(bot: MyBot): Promise<boolean> {
    if (bot.state) {
        log('[OrderManager] Bot is busy, cannot refresh order counts', 'debug')
        return false
    }
    
    log('[OrderManager] Refreshing order counts...', 'debug')
    bot.state = 'bazaar'
    
    try {
        // Open /bz
        bot.chat('/bz')
        const bazaarOpened = await waitForNewWindow(bot, 5000)
        if (!bazaarOpened || !bot.currentWindow) {
            bot.state = null
            return false
        }
        
        await sleep(150)
        
        // Click "Manage Orders"
        const manageSlot = findSlotWithName(bot.currentWindow, 'Manage Orders')
        if (manageSlot === -1) {
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            return false
        }
        
        const manageWindow = waitForNewWindow(bot, 5000)
        await clickWindow(bot, manageSlot).catch(() => {})
        const manageOpened = await manageWindow
        
        if (!manageOpened || !bot.currentWindow) {
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            return false
        }
        
        await sleep(150)
        
        // Count orders in the window
        countOrdersInWindow(bot.currentWindow)
        
        // Close window
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        bot.state = null
        
        log(`[OrderManager] Order counts refreshed: ${currentBazaarOrders}/${maxTotalOrders} total`, 'info')
        return true
    } catch (error) {
        log(`[OrderManager] Error refreshing order counts: ${error}`, 'error')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        bot.state = null
        return false
    }
}

/**
 * Record a bazaar order that was successfully placed
 * Called by handleBazaarFlipRecommendation after order placement
 */
export function recordOrder(recommendation: BazaarFlipRecommendation): void {
    const order: BazaarOrderRecord = {
        itemName: recommendation.itemName,
        amount: recommendation.amount,
        pricePerUnit: recommendation.pricePerUnit,
        isBuyOrder: recommendation.isBuyOrder,
        placedAt: Date.now(),
        claimed: false,
        cancelled: false
    }
    
    trackedOrders.push(order)
    log(`[OrderManager] Recorded ${order.isBuyOrder ? 'buy' : 'sell'} order: ${order.amount}x ${order.itemName} @ ${order.pricePerUnit.toFixed(1)} coins`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Tracking ${order.isBuyOrder ? 'buy' : 'sell'} order for §e${order.itemName}`)
}

/**
 * Mark an order as claimed
 */
export function markOrderClaimed(itemName: string, isBuyOrder: boolean): void {
    const order = trackedOrders.find(o => o.itemName === itemName && o.isBuyOrder === isBuyOrder && !o.claimed)
    if (order) {
        order.claimed = true
        log(`[OrderManager] Marked ${order.isBuyOrder ? 'buy' : 'sell'} order as claimed: ${order.itemName}`, 'info')
        resetOrderLimitFlags() // Reset flags when order is claimed
    }
}

/**
 * Discover existing orders on startup
 * Scans Manage Orders to find any existing orders and track/cancel them as needed
 * @returns The number of orders discovered
 */
export async function discoverExistingOrders(bot: MyBot): Promise<number> {
    if (bot.state) {
        log('[OrderManager] Bot is busy, cannot discover orders now', 'info')
        return 0
    }
    
    log('[OrderManager] Discovering existing orders...', 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Checking for existing orders...`)
    
    isManagingOrders = true
    
    return new Promise((resolve) => {
        let clickedManageOrders = false
        
        const timeout = setTimeout(() => {
            log('[OrderManager] Order discovery timed out (20 seconds)', 'warn')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            isManagingOrders = false
            resolve(0)
        }, 20000)
        
        const windowHandler = async (window) => {
            try {
                await sleep(300)
                const title = getWindowTitle(window)
                log(`[OrderManager] Discovery window: ${title}`, 'debug')
                
                // Main bazaar page - click Manage Orders (slot 50)
                if (title.includes('Bazaar') && !clickedManageOrders) {
                    clickedManageOrders = true
                    log('[OrderManager] Clicking Manage Orders (slot 50)', 'info')
                    await sleep(200)
                    await clickWindow(bot, 50).catch(err => log(`[OrderManager] Error clicking Manage Orders: ${err}`, 'error'))
                    return
                }
                
                // Orders view - scan all orders
                if (clickedManageOrders) {
                    // Count orders in the window to update global counts
                    countOrdersInWindow(window)
                    
                    let foundOrders = 0
                    
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        
                        // Find orders (BUY or SELL items)
                        if (name && (name.startsWith('BUY ') || name.startsWith('SELL '))) {
                            const isBuyOrder = name.startsWith('BUY ')
                            const itemName = name.replace(/^(BUY|SELL) /, '')
                            
                            // Feature 2: Parse lore to get order details
                            const lore = (slot?.nbt as any)?.value?.display?.value?.Lore?.value?.value
                            let amount = 0
                            let pricePerUnit = 0
                            let filled = 0
                            let totalAmount = 0
                            let fillPercentage = 0
                            let isFullyFilled = false
                            
                            if (lore) {
                                const parsedLore = parseLoreForOrderDetails(lore)
                                if (parsedLore) {
                                    filled = parsedLore.filled
                                    totalAmount = parsedLore.totalAmount
                                    fillPercentage = parsedLore.fillPercentage
                                    pricePerUnit = parsedLore.pricePerUnit
                                    isFullyFilled = fillPercentage >= 100
                                    amount = totalAmount
                                } else {
                                    // Fallback to old parsing if new format fails
                                    const loreText = lore.map((line: any) => removeMinecraftColorCodes(line.toString())).join('\n')
                                    const amountMatch = loreText.match(/(\d+)x/)
                                    const priceMatch = loreText.match(/([\d,]+) coins/)
                                    if (amountMatch) amount = parseInt(amountMatch[1])
                                    if (priceMatch) pricePerUnit = parseFloat(priceMatch[1].replace(/,/g, ''))
                                }
                            }
                            
                            // Record the order with a timestamp from the past so it will be
                            // cancelled immediately after discovery (since we don't know the actual age)
                            // Set placedAt to be older than BAZAAR_ORDER_CANCEL_MINUTES
                            const cancelMinutes = getConfigProperty('BAZAAR_ORDER_CANCEL_MINUTES')
                            const cancelTimeoutMs = cancelMinutes * 60 * 1000
                            const order: BazaarOrderRecord = {
                                itemName,
                                amount: amount || 1,
                                pricePerUnit: pricePerUnit || 0,
                                isBuyOrder,
                                placedAt: Date.now() - cancelTimeoutMs - 1000, // 1 second past cancel threshold
                                claimed: false,
                                cancelled: false,
                                // Feature 2: Add lore-based details
                                filled,
                                totalAmount,
                                fillPercentage,
                                isFullyFilled
                            }
                            
                            trackedOrders.push(order)
                            foundOrders++
                            
                            log(`[OrderManager] Found existing order: ${name} (${fillPercentage.toFixed(1)}% filled)`, 'info')
                        }
                    }
                    
                    bot.removeListener('windowOpen', windowHandler)
                    bot.state = null
                    isManagingOrders = false
                    clearTimeout(timeout)
                    
                    if (foundOrders > 0) {
                        log(`[OrderManager] Discovered ${foundOrders} existing orders`, 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Found ${foundOrders} existing order(s)`)
                    } else {
                        log('[OrderManager] No existing orders found', 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] No existing orders`)
                    }
                    
                    resolve(foundOrders)
                }
            } catch (error) {
                log(`[OrderManager] Error in discovery window handler: ${error}`, 'error')
                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                isManagingOrders = false
                clearTimeout(timeout)
                resolve(0)
            }
        }
        
        bot.removeAllListeners('windowOpen')
        bot.state = 'bazaar'
        bot.on('windowOpen', windowHandler)
        bot.chat('/bz')
    })
}

/**
 * Start the order management timer
 * Checks for orders to claim or cancel periodically
 * @param bot The bot instance
 * @param checkImmediately If true, performs an immediate check before starting the timer
 */
export function startOrderManager(bot: MyBot, checkImmediately: boolean = false): void {
    if (checkTimer) {
        log('[OrderManager] Timer already running', 'debug')
        return
    }
    
    const intervalSeconds = getConfigProperty('BAZAAR_ORDER_CHECK_INTERVAL_SECONDS')
    log(`[OrderManager] Starting order management timer (check every ${intervalSeconds}s)`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Started (checking every §e${intervalSeconds}s§7)`)
    
    // Perform immediate check if requested (e.g., after discovering existing orders at startup)
    if (checkImmediately) {
        log('[OrderManager] Performing immediate check for stale orders...', 'info')
        // Use setTimeout to avoid blocking and give command queue time to initialize
        setTimeout(async () => {
            await checkOrders(bot)
        }, IMMEDIATE_CHECK_DELAY_MS)
    }
    
    checkTimer = setInterval(async () => {
        await checkOrders(bot)
    }, intervalSeconds * 1000)
}

/**
 * Stop the order management timer
 */
export function stopOrderManager(): void {
    if (checkTimer) {
        clearInterval(checkTimer)
        checkTimer = null
        log('[OrderManager] Stopped order management timer', 'info')
    }
}

/**
 * Check for orders that need to be cancelled due to timeout
 * Cancels ALL stale orders in a single batch operation
 */
async function checkOrders(bot: MyBot): Promise<void> {
    if (isManagingOrders) {
        log('[OrderManager] Already managing orders, skipping check', 'debug')
        return
    }
    
    // Don't check orders during grace period (bot still initializing)
    if (bot.state === 'gracePeriod') {
        log('[OrderManager] Skipping order check during grace period', 'debug')
        return
    }
    
    const cancelMinutes = getConfigProperty('BAZAAR_ORDER_CANCEL_MINUTES')
    const cancelTimeoutMs = cancelMinutes * 60 * 1000
    const now = Date.now()
    
    // Find stale orders that need cancelling
    // Skip orders that are fully filled (isFullyFilled = true)
    const staleOrders = trackedOrders.filter(order => {
        const age = now - order.placedAt
        const isStale = !order.claimed && !order.cancelled && age > cancelTimeoutMs
        const isNotFullyFilled = !order.isFullyFilled
        return isStale && isNotFullyFilled
    })
    
    if (staleOrders.length === 0) {
        log('[OrderManager] No stale orders to cancel', 'debug')
        return
    }
    
    log(`[OrderManager] Found ${staleOrders.length} stale order(s) to cancel`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Found §e${staleOrders.length}§7 stale order(s) - cancelling all`)
    
    // Queue a SINGLE command to cancel all stale orders in one Manage Orders session
    enqueueCommand(
        `Cancel All Stale Orders (${staleOrders.length})`,
        CommandPriority.LOW,
        async () => {
            await cancelAllStaleOrders(bot, staleOrders)
        },
        true // interruptible - can be interrupted by AH flips
    )
}

/**
 * Claim a filled bazaar order via /bz → Manage Orders
 * This is triggered by chat message detection in ingameMessageHandler
 * Queues the claim operation through the command queue
 */
export async function claimFilledOrders(bot: MyBot, itemName?: string, isBuyOrder?: boolean): Promise<boolean> {
    // Don't claim orders during grace period
    if (bot.state === 'gracePeriod') {
        log('[OrderManager] Skipping claim during grace period', 'debug')
        return false
    }
    
    // Don't claim orders while bazaar flips are paused
    if (areBazaarFlipsPaused()) {
        log('[OrderManager] Bazaar flips are paused, will retry claim later', 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Claim delayed - bazaar flips paused`)
        // Queue the claim for when bazaar flips resume
        setTimeout(() => claimFilledOrders(bot, itemName, isBuyOrder), CLAIM_RETRY_DELAY_MS)
        return false
    }
    
    // Queue the claim operation with LOW priority (not time-sensitive, maintenance task)
    const commandName = itemName ? `Claim Order: ${itemName}` : 'Claim Filled Orders'
    enqueueCommand(
        commandName,
        CommandPriority.LOW,
        async () => {
            await executeClaimFilledOrders(bot, itemName, isBuyOrder)
        },
        true // interruptible - can be interrupted by AH flips
    )
    
    return true
}

/**
 * Execute the claim filled orders operation
 * This is the actual implementation that runs from the queue
 */
async function executeClaimFilledOrders(bot: MyBot, itemName?: string, isBuyOrder?: boolean): Promise<void> {
    isManagingOrders = true
    
    return new Promise((resolve, reject) => {
        let clickedManageOrders = false
        let claimedAny = false
        
        const timeout = setTimeout(() => {
            log('[OrderManager] Claim operation timed out (20 seconds)', 'warn')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            isManagingOrders = false
            reject(new Error('Claim operation timeout'))
        }, 20000)
        
        const windowHandler = async (window) => {
            try {
                await sleep(200)
                const title = getWindowTitle(window)
                log(`[OrderManager] Claim window: ${title}`, 'debug')
                
                // Main bazaar page - click Manage Orders (slot 50)
                if (title.includes('Bazaar') && !clickedManageOrders) {
                    clickedManageOrders = true
                    log('[OrderManager] Clicking Manage Orders (slot 50)', 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Opening Manage Orders...`)
                    await sleep(150)
                    
                    if (areAHFlipsPending()) {
                        log('[OrderManager] AH flips pending, aborting claim', 'info')
                        bot.removeListener('windowOpen', windowHandler)
                        bot.state = null
                        isManagingOrders = false
                        clearTimeout(timeout)
                        reject(new Error('AH flips pending'))
                        return
                    }
                    
                    const success = await clickAndWaitForWindow(bot, 50)
                    if (!success) {
                        log('[OrderManager] Failed to open Manage Orders window', 'error')
                        bot.removeListener('windowOpen', windowHandler)
                        bot.state = null
                        isManagingOrders = false
                        clearTimeout(timeout)
                        reject(new Error('Failed to open Manage Orders'))
                    }
                    return
                }
                
                // Orders view - find and click filled orders to claim
                if (clickedManageOrders) {
                    // Count orders in the window to update global counts
                    countOrdersInWindow(window)
                    
                    let claimedAny = false
                    
                    for (let i = 0; i < window.slots.length; i++) {
                        if (areAHFlipsPending()) {
                            log('[OrderManager] AH flips pending, stopping claim loop', 'info')
                            break
                        }
                        
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        
                        // Look for claimable orders (BUY or SELL items)
                        if (name && (name.startsWith('BUY ') || name.startsWith('SELL '))) {
                            // If specific item and order type specified, only claim that one
                            if (itemName && isBuyOrder !== undefined) {
                                const matchesType = isBuyOrder ? name.startsWith('BUY ') : name.startsWith('SELL ')
                                const matchesItem = name.toLowerCase().includes(itemName.toLowerCase())
                                if (!matchesType || !matchesItem) continue
                            }
                            
                            // Parse lore to get order details for webhook
                            const lore = (slot?.nbt as any)?.value?.display?.value?.Lore?.value?.value
                            let orderAmount = 0
                            let pricePerUnit = 0
                            
                            if (lore) {
                                const parsedLore = parseLoreForOrderDetails(lore)
                                if (parsedLore) {
                                    orderAmount = parsedLore.totalAmount
                                    pricePerUnit = parsedLore.pricePerUnit
                                }
                            }
                            
                            log(`[OrderManager] Claiming order: slot ${i}, item: ${name}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Claiming §e${name}`)
                            
                            const claimed = await clickAndWaitForUpdate(bot, i, 400)
                            if (claimed) {
                                claimedAny = true
                                
                                // Click again for partial claims (may fail if already fully claimed)
                                if (!areAHFlipsPending()) {
                                    await clickAndWaitForUpdate(bot, i, 400).catch(() => {
                                        log(`[OrderManager] Second claim click failed (likely already claimed)`, 'debug')
                                    })
                                }
                                
                                // Mark as claimed in our tracking
                                const orderType = name.startsWith('BUY ')
                                const extractedName = name.replace(/^(BUY|SELL) /, '')
                                markOrderClaimed(extractedName, orderType)
                                
                                // Send webhook notification only if we have valid order details
                                if (orderAmount > 0 && pricePerUnit > 0) {
                                    sendWebhookBazaarOrderClaimed(
                                        extractedName,
                                        orderAmount,
                                        pricePerUnit,
                                        orderType
                                    )
                                } else {
                                    // Expected behavior when lore parsing fails - log at info level
                                    log(`[OrderManager] Webhook skipped - order details not available from lore (amount: ${orderAmount}, price: ${pricePerUnit})`, 'info')
                                }
                            }
                        }
                    }
                    
                    bot.removeListener('windowOpen', windowHandler)
                    bot.state = null
                    isManagingOrders = false
                    clearTimeout(timeout)
                    
                    if (claimedAny) {
                        log('[OrderManager] Successfully claimed orders', 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Orders claimed!`)
                    } else {
                        log('[OrderManager] No claimable orders found', 'info')
                    }
                    
                    // Remove fully claimed orders from tracking
                    cleanupTrackedOrders()
                    
                    resolve()
                }
            } catch (error) {
                log(`[OrderManager] Error in claim window handler: ${error}`, 'error')
                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                isManagingOrders = false
                clearTimeout(timeout)
                reject(error)
            }
        }
        
        bot.removeAllListeners('windowOpen')
        bot.state = 'claiming'
        bot.on('windowOpen', windowHandler)
        bot.chat('/bz')
    })
}

/**
 * Cancel ALL stale orders in a single Manage Orders session
 * FEATURE 2: Also re-lists cancelled sell offers during normal operation
 * Opens Manage Orders once, then loops through all stale orders cancelling them one by one
 */
async function cancelAllStaleOrders(bot: MyBot, staleOrders: BazaarOrderRecord[]): Promise<void> {
    if (staleOrders.length === 0) return

    log(`[OrderManager] Found ${staleOrders.length} stale order(s) - cancelling in single session`, 'info')

    // Import placeBazaarOrder for re-listing
    const { placeBazaarOrder } = await import('./bazaarFlipHandler')
    
    // Queue to track cancelled sell offers for re-listing
    const relistQueue: BazaarOrderRecord[] = []

    isManagingOrders = true
    bot.state = 'bazaar'

    try {
        // Step 1: Open /bz
        bot.chat('/bz')
        const bazaarOpened = await waitForNewWindow(bot, 5000)
        if (!bazaarOpened || !bot.currentWindow) {
            log('[OrderManager] Bazaar window did not open', 'warn')
            bot.state = null
            isManagingOrders = false
            return
        }
        await sleep(200)

        // Step 2: Click Manage Orders — new window opens
        const manageSlot = findSlotWithName(bot.currentWindow, 'Manage Orders')
        if (manageSlot === -1) {
            log('[OrderManager] Could not find Manage Orders button', 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            return
        }

        const manageOpened = waitForNewWindow(bot, 5000)
        await clickWindow(bot, manageSlot).catch(() => {})
        await manageOpened
        await sleep(200)

        if (!bot.currentWindow) {
            log('[OrderManager] Manage Orders window did not open', 'warn')
            bot.state = null
            isManagingOrders = false
            return
        }

        // Step 3: Update real order count from what we see
        const orderCount = countOrdersInWindow(bot.currentWindow)
        currentBazaarOrders = orderCount.total

        // Step 4: Cancel each stale order one by one, WITHOUT closing Manage Orders
        for (const order of staleOrders) {
            // Check if AH flips incoming — abort if so
            if (areAHFlipsPending()) {
                log('[OrderManager] AH flips incoming, aborting cancellation', 'info')
                break
            }

            // Find the order in the CURRENT window
            const searchPrefix = order.isBuyOrder ? 'BUY' : 'SELL'
            let orderSlot = -1
            for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                const slot = bot.currentWindow.slots[i]
                if (!slot || !slot.nbt) continue
                const name = removeMinecraftColorCodes(getSlotName(slot))
                if (name.includes(searchPrefix) && name.toLowerCase().includes(order.itemName.toLowerCase())) {
                    orderSlot = i
                    break
                }
            }

            if (orderSlot === -1) {
                log(`[OrderManager] ${order.itemName} not found in Manage Orders, removing from tracking`, 'debug')
                order.cancelled = true
                continue
            }

            // Click the order — same window updates
            await clickWindow(bot, orderSlot).catch(() => {})
            await sleep(WINDOW_UPDATE_DELAY_MS)

            if (!bot.currentWindow) break

            // Find and click Cancel Order
            const cancelSlot = findSlotWithName(bot.currentWindow, 'Cancel Order')
            if (cancelSlot !== -1) {
                await clickWindow(bot, cancelSlot).catch(() => {})
                await sleep(250)
                
                const ageMinutes = Math.floor((Date.now() - order.placedAt) / 60000)
                log(`[OrderManager] Cancelled ${order.isBuyOrder ? 'buy order' : 'sell offer'} for ${order.itemName}`, 'info')
                printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Cancelled ${order.isBuyOrder ? 'buy order' : 'sell offer'} for ${order.itemName}`)
                
                // FEATURE 2: Add cancelled sell offers to re-list queue
                if (!order.isBuyOrder && order.pricePerUnit > 0 && order.amount > 0) {
                    relistQueue.push(order)
                    log(`[OrderManager] Will re-list cancelled sell offer: ${order.itemName}`, 'debug')
                }
                
                // Send webhook notification
                sendWebhookBazaarOrderCancelled(
                    order.itemName,
                    order.amount,
                    order.pricePerUnit,
                    order.isBuyOrder,
                    ageMinutes,
                    order.filled || 0,
                    order.totalAmount || order.amount
                )
            } else {
                log(`[OrderManager] No Cancel Order for ${order.itemName} — may be fully filled`, 'info')
            }

            order.cancelled = true

            // After cancelling, the window should return to the Manage Orders list
            // Wait a moment for it to refresh
            await sleep(250)

            if (!bot.currentWindow) break
        }

        // Close window when done
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        await sleep(200)
        
        // FEATURE 2: Re-list cancelled sell offers
        for (const order of relistQueue) {
            if (areAHFlipsPending()) {
                log('[OrderManager] AH flips incoming, skipping re-listing', 'info')
                break
            }
            
            log(`[OrderManager] Re-listing cancelled sell offer: ${order.amount}x ${order.itemName} at ${order.pricePerUnit}`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Re-listing §e${order.itemName}`)
            
            try {
                await placeBazaarOrder(bot, order.itemName, order.amount, order.pricePerUnit, false)
                await sleep(400)
            } catch (err) {
                log(`[OrderManager] Failed to re-list ${order.itemName}: ${err}`, 'warn')
            }
        }
        
        // Clean up tracked orders
        cleanupTrackedOrders()
        
    } catch (error) {
        log(`[OrderManager] Error in cancelAllStaleOrders: ${error}`, 'error')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
    } finally {
        bot.state = null
        isManagingOrders = false
    }
}

/**
 * Cancel a stale bazaar order
 * Uses step-based window tracking to properly handle the 3-window flow:
 * 1. Bazaar category page → click "Manage Orders"
 * 2. Manage Orders list → find and click target order
 * 3. Order detail view → claim items (if any), then click cancel button
 */
async function cancelSingleOrder(bot: MyBot, order: BazaarOrderRecord): Promise<boolean> {
    // Wait if bot is busy
    if (bot.state) {
        log('[OrderManager] Bot is busy, cannot cancel order now', 'info')
        return false
    }
    
    isManagingOrders = true
    bot.state = 'bazaar'
    
    try {
        // Step 1: Open /bz — this opens a NEW window
        bot.chat('/bz')
        
        if (areAHFlipsPending()) {
            log('[OrderManager] AH flips pending, aborting cancel', 'info')
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        // Wait for the bazaar window to open
        const bazaarWindow = await waitForNewWindow(bot, 5000)
        if (!bazaarWindow) {
            log('[OrderManager] Bazaar window did not open', 'warn')
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        await sleep(150) // let mineflayer populate bot.currentWindow
        
        if (!bot.currentWindow) {
            log('[OrderManager] bot.currentWindow is null after /bz', 'warn')
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        if (areAHFlipsPending()) {
            log('[OrderManager] AH flips pending, aborting cancel', 'info')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        // Step 2: Click "Manage Orders" using resilient helper — this opens a NEW window
        const manageSuccess = await findAndClick(bot, 'Manage Orders', { waitForNewWindow: true, timeout: 5000 })
        if (!manageSuccess) {
            log('[OrderManager] Could not find or click Manage Orders button', 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        await sleep(150)
        
        if (!bot.currentWindow) {
            log('[OrderManager] bot.currentWindow is null after Manage Orders', 'warn')
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        if (areAHFlipsPending()) {
            log('[OrderManager] AH flips pending, aborting cancel', 'info')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        // Count orders in the window to update global counts
        countOrdersInWindow(bot.currentWindow)
        
        // Step 3: Find the order in the Manage Orders window
        const searchPrefix = order.isBuyOrder ? 'BUY' : 'SELL'
        let orderSlot = -1
        for (let i = 0; i < bot.currentWindow.slots.length; i++) {
            const slot = bot.currentWindow.slots[i]
            if (!slot || !slot.nbt) continue
            const name = removeMinecraftColorCodes(getSlotName(slot))
            if (name.includes(searchPrefix) && name.toLowerCase().includes(order.itemName.toLowerCase())) {
                orderSlot = i
                break
            }
        }
        
        if (orderSlot === -1) {
            log(`[OrderManager] Order not found in Manage Orders: ${searchPrefix} ${order.itemName}`, 'info')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            // Order not found - may have been filled/cancelled elsewhere
            order.cancelled = true
            cleanupTrackedOrders()
            bot.state = null
            isManagingOrders = false
            return true
        }
        
        if (areAHFlipsPending()) {
            log('[OrderManager] AH flips pending, aborting cancel', 'info')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        // Step 4: Click the order slot using resilient helper — SAME WINDOW UPDATES
        const orderClickSuccess = await clickAndWaitForUpdate(bot, orderSlot, 2000)
        if (!orderClickSuccess) {
            log('[OrderManager] Failed to click order or window did not update', 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        // Step 5: Now check the SAME bot.currentWindow for "Cancel Order"
        if (!bot.currentWindow) {
            log('[OrderManager] Window closed after clicking order', 'warn')
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        if (areAHFlipsPending()) {
            log('[OrderManager] AH flips pending, aborting cancel', 'info')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            return false
        }
        
        const cancelSlot = findSlotWithName(bot.currentWindow, 'Cancel Order')
        
        if (cancelSlot === -1) {
            // No cancel button — order is fully filled
            log(`[OrderManager] No Cancel Order button — order may be fully filled`, 'info')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            order.claimed = true
            cleanupTrackedOrders()
            bot.state = null
            isManagingOrders = false
            return true
        }
        
        // Step 6: Click "Cancel Order" using resilient helper — SAME WINDOW UPDATES
        const cancelSuccess = await clickAndWaitForUpdate(bot, cancelSlot, 300)
        if (cancelSuccess) {
            log(`[OrderManager] Cancelled ${searchPrefix.toLowerCase()} order for ${order.itemName}`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Cancelled ${order.isBuyOrder ? 'buy order' : 'sell offer'} for ${order.itemName}`)
            
            // Send webhook notification
            const ageMinutes = Math.floor((Date.now() - order.placedAt) / 60000)
            sendWebhookBazaarOrderCancelled(
                order.itemName,
                order.amount,
                order.pricePerUnit,
                order.isBuyOrder,
                ageMinutes,
                order.filled || 0,
                order.totalAmount || order.amount
            )
        } else {
            log(`[OrderManager] Cancel button click may not have succeeded`, 'warn')
        }
        
        // Close window and clean up
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        order.cancelled = true
        cleanupTrackedOrders()
        bot.state = null
        isManagingOrders = false
        return true
    } catch (error) {
        log(`[OrderManager] Error in cancelSingleOrder: ${error}`, 'error')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        bot.state = null
        isManagingOrders = false
        return false
    }
}

/**
 * Remove orders that have been fully claimed or cancelled
 */
function cleanupTrackedOrders(): void {
    const beforeCount = trackedOrders.length
    trackedOrders = trackedOrders.filter(order => !order.claimed && !order.cancelled)
    const removed = beforeCount - trackedOrders.length
    
    if (removed > 0) {
        log(`[OrderManager] Cleaned up ${removed} completed orders. Now tracking ${trackedOrders.length} orders`, 'info')
        resetOrderLimitFlags() // Reset flags when orders are cleaned up
    }
}

/**
 * Check if the order manager is currently busy
 */
export function isOrderManagerBusy(): boolean {
    return isManagingOrders
}

/**
 * Abort current order management operation (e.g., when AH flip arrives)
 */
export function abortOrderManagement(bot: MyBot): void {
    if (isManagingOrders) {
        log('[OrderManager] Aborting order management due to higher priority task', 'warn')
        printMcChatToConsole(`§f[§4BAF§f]: §c[OrderManager] Aborting - priority task detected`)
        
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        
        bot.state = null
        isManagingOrders = false
    }
}

/**
 * FEATURE 1: Startup Order Management
 * Discovers existing orders and immediately cancels stale ones, re-listing sell offers
 * This runs BEFORE normal operations begin (keeps bot.state = 'startup')
 * 
 * @returns Object with counts of cancelled and re-listed orders
 */
export async function startupOrderManagement(bot: MyBot): Promise<{ cancelled: number, relisted: number }> {
    log('[Startup] Checking and managing existing orders...', 'info')
    printMcChatToConsole('§f[§4BAF§f]: §7[Startup] Managing existing orders...')
    
    // Import placeBazaarOrder dynamically to avoid circular dependencies
    const { placeBazaarOrder } = await import('./bazaarFlipHandler')
    
    let cancelledCount = 0
    let relistedCount = 0
    
    try {
        // Open /bz → Manage Orders
        bot.chat('/bz')
        const bazaarOpened = await waitForNewWindow(bot, 5000)
        if (!bazaarOpened || !bot.currentWindow) {
            log('[Startup] Bazaar window did not open', 'warn')
            return { cancelled: 0, relisted: 0 }
        }
        await sleep(200)
        
        const manageSlot = findSlotWithName(bot.currentWindow, 'Manage Orders')
        if (manageSlot === -1) {
            log('[Startup] Could not find Manage Orders button', 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            return { cancelled: 0, relisted: 0 }
        }
        
        const manageOpened = waitForNewWindow(bot, 5000)
        await clickWindow(bot, manageSlot).catch(() => {})
        await manageOpened
        await sleep(200)
        
        if (!bot.currentWindow) {
            log('[Startup] Manage Orders window did not open', 'warn')
            return { cancelled: 0, relisted: 0 }
        }
        
        // Queues for re-listing
        const relistQueue: { itemName: string, pricePerUnit: number, amount: number }[] = []
        const sellQueue: { itemName: string, amount: number }[] = []
        
        // Parse each order slot
        for (let i = 0; i < bot.currentWindow.slots.length; i++) {
            const slot = bot.currentWindow.slots[i]
            if (!slot || !slot.nbt) continue
            
            const name = removeMinecraftColorCodes(getSlotName(slot))
            if (!name.startsWith('BUY ') && !name.startsWith('SELL ')) continue
            
            const isBuy = name.startsWith('BUY ')
            const itemName = name.replace(/^(BUY|SELL)\s+/, '').replace(/[☘☂✪◆❤]/g, '').trim()
            
            // Parse lore for fill status and price
            const lore = getSlotLore(slot)
            const orderInfo = parseOrderLore(lore)
            
            // All orders found on startup are considered stale (from previous session)
            // Click the order to open it
            await clickWindow(bot, i).catch(() => {})
            await sleep(300)
            
            if (!bot.currentWindow) break
            
            // Find Cancel Order button
            const cancelSlot = findSlotWithName(bot.currentWindow, 'Cancel Order')
            if (cancelSlot !== -1) {
                // Cancel the order
                await clickWindow(bot, cancelSlot).catch(() => {})
                await sleep(250)
                
                cancelledCount++
                
                if (!isBuy) {
                    // Sell offer cancelled — add to re-list queue
                    if (orderInfo.remaining > 0 && orderInfo.pricePerUnit > 0) {
                        relistQueue.push({
                            itemName,
                            pricePerUnit: orderInfo.pricePerUnit,
                            amount: orderInfo.remaining
                        })
                        log(`[Startup] Will re-list: ${orderInfo.remaining}x ${itemName} at ${orderInfo.pricePerUnit}`, 'debug')
                    }
                } else {
                    // Buy order cancelled — sell any claimed items
                    if (orderInfo.filled && orderInfo.filled > 0) {
                        sellQueue.push({
                            itemName,
                            amount: orderInfo.filled
                        })
                        log(`[Startup] Will sell ${orderInfo.filled}x ${itemName} from filled buy order`, 'debug')
                    }
                }
                
                log(`[Startup] Cancelled ${isBuy ? 'buy order' : 'sell offer'} for ${itemName}`, 'info')
            } else {
                // No cancel button — fully filled, just claimed
                if (isBuy && orderInfo.amount > 0) {
                    // Items from filled buy order should be sold
                    sellQueue.push({
                        itemName,
                        amount: orderInfo.amount
                    })
                    log(`[Startup] Will sell ${orderInfo.amount}x ${itemName} from completed buy order`, 'debug')
                }
                log(`[Startup] Claimed fully filled ${isBuy ? 'buy order' : 'sell offer'} for ${itemName}`, 'info')
            }
            
            // Wait for window to return to Manage Orders list
            await sleep(250)
            if (!bot.currentWindow) break
        }
        
        // Close Manage Orders
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        await sleep(200)
        
        // Re-list cancelled sell offers
        for (const item of relistQueue) {
            if (item.amount <= 0 || item.pricePerUnit <= 0) continue
            log(`[Startup] Re-listing sell offer: ${item.amount}x ${item.itemName} at ${item.pricePerUnit}`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §7[Startup] Re-listing §e${item.itemName}`)
            
            try {
                await placeBazaarOrder(bot, item.itemName, item.amount, item.pricePerUnit, false)
                relistedCount++
                await sleep(400)
            } catch (err) {
                log(`[Startup] Failed to re-list ${item.itemName}: ${err}`, 'warn')
            }
        }
        
        // List partially filled buy order items as sell offers
        // For now, we'll skip this as it requires fetching prices from Coflnet
        // This can be enhanced later if needed
        
        log(`[Startup] Order management complete - cancelled ${cancelledCount}, re-listed ${relistedCount}`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §a[Startup] Managed ${cancelledCount} order(s), re-listed ${relistedCount}`)
        
        return { cancelled: cancelledCount, relisted: relistedCount }
        
    } catch (error) {
        log(`[Startup] Error during order management: ${error}`, 'error')
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        return { cancelled: cancelledCount, relisted: relistedCount }
    }
}
