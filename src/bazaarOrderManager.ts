import { MyBot, BazaarFlipRecommendation } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { getConfigProperty } from './configHelper'
import { areBazaarFlipsPaused } from './bazaarFlipPauser'
import { enqueueCommand, CommandPriority } from './commandQueue'

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

// Retry delay for claim operations when bazaar flips are paused (5 seconds)
const CLAIM_RETRY_DELAY_MS = 5000

// Constants for claiming filled orders
const MAX_CLAIM_ATTEMPTS = 3 // Maximum number of times to click an item slot to claim
const CLAIM_DELAY_MS = 300 // Delay in milliseconds between claim attempts

// Delay before immediate order check to ensure command queue is ready
const IMMEDIATE_CHECK_DELAY_MS = 2000

// Delay after clicking an order in Manage Orders for window content to update
const WINDOW_UPDATE_DELAY_MS = 800

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
 * Feature 3: Count current orders
 * @returns Object with total order count and buy order count
 */
export function getOrderCounts(): { totalOrders: number, buyOrders: number } {
    const activeOrders = trackedOrders.filter(o => !o.claimed && !o.cancelled)
    const buyOrders = activeOrders.filter(o => o.isBuyOrder).length
    return {
        totalOrders: activeOrders.length,
        buyOrders
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
 */
async function checkOrders(bot: MyBot): Promise<void> {
    if (isManagingOrders) {
        log('[OrderManager] Already managing orders, skipping check', 'debug')
        return
    }
    
    const cancelMinutes = getConfigProperty('BAZAAR_ORDER_CANCEL_MINUTES')
    const cancelTimeoutMs = cancelMinutes * 60 * 1000
    const now = Date.now()
    
    // Find stale orders that need cancelling
    // Feature 2: Skip orders that are fully filled (isFullyFilled = true)
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
    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Found §e${staleOrders.length}§7 stale order(s)...`)
    
    // Only cancel ONE order per cycle (as per requirements)
    const orderToCancel = staleOrders[0]
    const ageMinutes = Math.floor((now - orderToCancel.placedAt) / 60000)
    log(`[OrderManager] Queuing cancellation of stale ${orderToCancel.isBuyOrder ? 'buy order' : 'sell offer'} for ${orderToCancel.itemName} (age: ${ageMinutes} minutes)`, 'info')
    
    // Queue the cancel operation with LOW priority
    const commandName = `Cancel Order: ${orderToCancel.itemName}`
    enqueueCommand(
        commandName,
        CommandPriority.LOW,
        async () => {
            await cancelOrder(bot, orderToCancel)
        }
    )
}

/**
 * Claim a filled bazaar order via /bz → Manage Orders
 * This is triggered by chat message detection in ingameMessageHandler
 * Queues the claim operation through the command queue
 */
export async function claimFilledOrders(bot: MyBot, itemName?: string, isBuyOrder?: boolean): Promise<boolean> {
    // Don't claim orders while bazaar flips are paused
    if (areBazaarFlipsPaused()) {
        log('[OrderManager] Bazaar flips are paused, will retry claim later', 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Claim delayed - bazaar flips paused`)
        // Queue the claim for when bazaar flips resume
        setTimeout(() => claimFilledOrders(bot, itemName, isBuyOrder), CLAIM_RETRY_DELAY_MS)
        return false
    }
    
    // Queue the claim operation with LOW priority
    const commandName = itemName ? `Claim Order: ${itemName}` : 'Claim Filled Orders'
    enqueueCommand(
        commandName,
        CommandPriority.LOW,
        async () => {
            await executeClaimFilledOrders(bot, itemName, isBuyOrder)
        }
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
                await sleep(300)
                const title = getWindowTitle(window)
                log(`[OrderManager] Claim window: ${title}`, 'debug')
                
                // Main bazaar page - click Manage Orders (slot 50)
                if (title.includes('Bazaar') && !clickedManageOrders) {
                    clickedManageOrders = true
                    log('[OrderManager] Clicking Manage Orders (slot 50)', 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Opening Manage Orders...`)
                    await sleep(200)
                    await clickWindow(bot, 50).catch(err => log(`[OrderManager] Error clicking Manage Orders: ${err}`, 'error'))
                    return
                }
                
                // Orders view - find and click filled orders to claim
                if (clickedManageOrders) {
                    for (let i = 0; i < window.slots.length; i++) {
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
                            
                            log(`[OrderManager] Claiming order: slot ${i}, item: ${name}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Claiming §e${name}`)
                            
                            await clickWindow(bot, i).catch(() => {})
                            claimedAny = true
                            await sleep(500)
                            
                            // Click again for partial claims (may fail if already fully claimed)
                            try { 
                                await clickWindow(bot, i)
                                await sleep(500)
                            } catch (e) { 
                                // Expected: already fully claimed or transaction rejected
                                log(`[OrderManager] Second claim click failed (likely already claimed): ${e}`, 'debug')
                            }
                            
                            // Mark as claimed in our tracking
                            const orderType = name.startsWith('BUY ')
                            const extractedName = name.replace(/^(BUY|SELL) /, '')
                            markOrderClaimed(extractedName, orderType)
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
 * Cancel a stale bazaar order
 * Uses step-based window tracking to properly handle the 3-window flow:
 * 1. Bazaar category page → click "Manage Orders"
 * 2. Manage Orders list → find and click target order
 * 3. Order detail view → claim items (if any), then click cancel button
 */
async function cancelOrder(bot: MyBot, order: BazaarOrderRecord): Promise<boolean> {
    // Wait if bot is busy
    if (bot.state) {
        log('[OrderManager] Bot is busy, cannot cancel order now', 'info')
        return false
    }
    
    isManagingOrders = true
    
    return new Promise((resolve) => {
        let cancelStep: 'waitForBazaar' | 'waitForManageOrders' | 'waitForOrderDetail' | 'done' = 'waitForBazaar'
        
        // Helper: find a slot by display name substring
        const findSlotWithName = (win: any, searchName: string): number => {
            for (let i = 0; i < win.slots.length; i++) {
                const slot = win.slots[i]
                const name = removeMinecraftColorCodes(
                    (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                )
                if (name && name.includes(searchName)) return i
            }
            return -1
        }
        
        const timeout = setTimeout(() => {
            log('[OrderManager] Cancel operation timed out (20 seconds)', 'warn')
            bot._client.removeListener('open_window', windowListener)
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            bot.state = null
            isManagingOrders = false
            resolve(false)
        }, 20000)
        
        // Helper function to process order details after clicking on an order
        // This is needed because clicking an order doesn't open a new window, it just updates the current one
        const processOrderDetails = async () => {
            try {
                const window = bot.currentWindow
                if (!window) {
                    log('[OrderManager] ERROR: bot.currentWindow is null when processing order details', 'error')
                    bot._client.removeListener('open_window', windowListener)
                    bot.state = null
                    isManagingOrders = false
                    clearTimeout(timeout)
                    resolve(false)
                    return
                }
                
                cancelStep = 'done' // Mark as done to prevent window listener from processing
                
                const title = getWindowTitle(window)
                log(`[OrderManager] Processing order details from currentWindow: "${title}"`, 'debug')
                
                // First pass: Check for claimable items and claim them
                let claimableSlot = -1
                for (let i = 0; i < window.slots.length; i++) {
                    const slot = window.slots[i]
                    const name = removeMinecraftColorCodes(
                        (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                    )
                    
                    if (slot && slot.type && name) {
                        const lore = (slot?.nbt as any)?.value?.display?.value?.Lore?.value?.value
                        const hasClaimIndicator = lore && lore.some((line: any) => {
                            const loreText = removeMinecraftColorCodes(line.toString())
                            return loreText.includes('Click to claim') || loreText.includes('Status: Filled')
                        })
                        
                        // Strip special characters like ☘ when comparing
                        const strippedItemName = order.itemName.replace(/[☘]/g, '').trim()
                        const strippedSlotName = name.replace(/[☘]/g, '').trim()
                        
                        if (hasClaimIndicator && strippedSlotName.toLowerCase().includes(strippedItemName.toLowerCase())) {
                            claimableSlot = i
                            log(`[OrderManager] Found claimable items at slot ${i}: ${name}`, 'info')
                            break
                        }
                    }
                }
                
                // If there are claimable items, claim them
                if (claimableSlot !== -1) {
                    log(`[OrderManager] Claiming items from slot ${claimableSlot}...`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Claiming filled items...`)
                    
                    // Click the order slot to claim
                    await sleep(300)
                    await clickWindow(bot, claimableSlot).catch(err => {
                        log(`[OrderManager] Claim click failed: ${err}`, 'debug')
                    })
                    
                    // Wait for server to process claim
                    await sleep(500)
                    
                    // According to Feature 1: Click the same slot again if needed (for partial fills)
                    // The window may still have unclaimed/unfilled portions
                    log(`[OrderManager] Clicking order slot again to ensure all claims are done...`, 'debug')
                    await clickWindow(bot, claimableSlot).catch(err => {
                        log(`[OrderManager] Second claim click failed: ${err}`, 'debug')
                    })
                    
                    // Wait for window to refresh after all claims are done
                    await sleep(500)
                    log(`[OrderManager] All claims processed, checking for cancel button...`, 'info')
                }
                
                // Re-check current window for the cancel button (window may have refreshed after claiming)
                const currentWindow = bot.currentWindow
                if (!currentWindow) {
                    log('[OrderManager] ERROR: bot.currentWindow is null after claiming', 'error')
                    bot._client.removeListener('open_window', windowListener)
                    bot.state = null
                    isManagingOrders = false
                    clearTimeout(timeout)
                    resolve(claimableSlot !== -1)
                    return
                }
                
                // Now look for the cancel button at slot 13
                // According to Feature 1, Cancel Order button should be at slot 13
                const cancelSlot = 13
                const cancelSlotItem = currentWindow.slots[cancelSlot]
                const cancelSlotName = removeMinecraftColorCodes(
                    (cancelSlotItem?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                )
                
                log(`[OrderManager] Checking slot 13 for Cancel button: "${cancelSlotName}"`, 'debug')
                
                // Check if slot 13 has "Cancel Order" or "Cancel" in the name
                if (!cancelSlotName || !cancelSlotName.toLowerCase().includes('cancel')) {
                    // No cancel button - order was fully filled
                    if (claimableSlot !== -1) {
                        log(`[OrderManager] Order fully filled, no cancel button found: ${order.itemName}`, 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Order fully filled: §e${order.itemName}`)
                        order.claimed = true
                    } else {
                        log(`[OrderManager] No cancel button or claimable items found for: ${order.itemName}`, 'warn')
                    }
                    
                    cleanupTrackedOrders()
                    
                    bot._client.removeListener('open_window', windowListener)
                    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                    bot.state = null
                    isManagingOrders = false
                    clearTimeout(timeout)
                    resolve(claimableSlot !== -1)
                    return
                }
                
                // Click cancel button at slot 13
                log(`[OrderManager] Clicking cancel button at slot 13: "${cancelSlotName}"`, 'info')
                printMcChatToConsole(`§f[§4BAF§f]: §c[OrderManager] Cancelling remaining order...`)
                await sleep(200)
                await clickWindow(bot, cancelSlot).catch(e => log(`[OrderManager] clickWindow error: ${e}`, 'debug'))
                
                // Wait for server to process, then clean up
                await sleep(500)
                
                // Mark as cancelled
                order.cancelled = true
                log(`[OrderManager] Cancelled ${order.isBuyOrder ? 'buy' : 'sell'} order: ${order.itemName}`, 'info')
                printMcChatToConsole(`§f[§4BAF§f]: §c[OrderManager] Cancelled order: §e${order.itemName}`)
                
                cleanupTrackedOrders()
                
                bot._client.removeListener('open_window', windowListener)
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                bot.state = null
                isManagingOrders = false
                clearTimeout(timeout)
                resolve(true)
            } catch (error) {
                log(`[OrderManager] Error in processOrderDetails: ${error}`, 'error')
                bot._client.removeListener('open_window', windowListener)
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                bot.state = null
                isManagingOrders = false
                clearTimeout(timeout)
                resolve(false)
            }
        }
        
        const windowListener = async (packet: any) => {
            try {
                // Wait for mineflayer to process the window and populate bot.currentWindow
                await sleep(300)
                
                const window = bot.currentWindow
                if (!window) {
                    log('[OrderManager] WARNING: bot.currentWindow is null after window packet, skipping this window event', 'warn')
                    return
                }
                
                const title = getWindowTitle(window)
                log(`[OrderManager] Window opened: "${title}" at step: ${cancelStep}`, 'debug')
                
                if (cancelStep === 'waitForBazaar') {
                    // Step 1: Bazaar category page opened - click "Manage Orders"
                    const manageSlot = findSlotWithName(window, 'Manage Orders')
                    if (manageSlot === -1) {
                        log('[OrderManager] Manage Orders button not found in bazaar window', 'warn')
                        return // Not the right window, wait for correct one
                    }
                    
                    log('[OrderManager] Clicking Manage Orders (slot ' + manageSlot + ')', 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Opening Manage Orders...`)
                    cancelStep = 'waitForManageOrders'
                    await sleep(200)
                    await clickWindow(bot, manageSlot).catch(e => log(`[OrderManager] clickWindow error: ${e}`, 'debug'))
                }
                else if (cancelStep === 'waitForManageOrders') {
                    // Step 2: Manage Orders window opened - find the stale order
                    const searchPrefix = order.isBuyOrder ? 'BUY ' : 'SELL '
                    let orderSlot = -1
                    
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        
                        // Strip special characters like ☘ when comparing
                        const strippedName = name.replace(/[☘]/g, '').trim()
                        const strippedItemName = order.itemName.replace(/[☘]/g, '').trim()
                        
                        if (strippedName.startsWith(searchPrefix) && strippedName.toLowerCase().includes(strippedItemName.toLowerCase())) {
                            orderSlot = i
                            log(`[OrderManager] Found order to cancel: slot ${i}, item: ${name}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Cancelling §e${name}`)
                            break
                        }
                    }
                    
                    if (orderSlot === -1) {
                        // Order not found - already filled or gone
                        log(`[OrderManager] Order not found in Manage Orders: ${order.itemName}, removing from tracking`, 'warn')
                        printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Order not found: §e${order.itemName}`)
                        
                        order.cancelled = true
                        cleanupTrackedOrders()
                        
                        bot._client.removeListener('open_window', windowListener)
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        bot.state = null
                        isManagingOrders = false
                        clearTimeout(timeout)
                        resolve(false)
                        return
                    }
                    
                    cancelStep = 'waitForOrderDetail'
                    await sleep(200)
                    await clickWindow(bot, orderSlot).catch(e => log(`[OrderManager] clickWindow error: ${e}`, 'debug'))
                    
                    // After clicking order, the window content updates but no new window event fires
                    // Need to manually process the order details from bot.currentWindow
                    await sleep(WINDOW_UPDATE_DELAY_MS) // Wait for window to update
                    await processOrderDetails()
                    return // Exit after processing details
                }
                else if (cancelStep === 'waitForOrderDetail') {
                    // Fallback: This should not be reached since we process details immediately after clicking
                    // However, kept as safety in case window event fires unexpectedly
                    // Step 3: Order detail window opened - look for claimable items, then cancel button
                    
                    // First, check for claimable items
                    let claimableSlot = -1
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        
                        if (slot && slot.type && name) {
                            const lore = (slot?.nbt as any)?.value?.display?.value?.Lore?.value?.value
                            const hasClaimIndicator = lore && lore.some((line: any) => {
                                const loreText = removeMinecraftColorCodes(line.toString())
                                return loreText.includes('Click to claim') || loreText.includes('Status: Filled')
                            })
                            
                            // Strip special characters like ☘ when comparing
                            const strippedItemName = order.itemName.replace(/[☘]/g, '').trim()
                            const strippedSlotName = name.replace(/[☘]/g, '').trim()
                            
                            if (hasClaimIndicator && strippedSlotName.toLowerCase().includes(strippedItemName.toLowerCase())) {
                                claimableSlot = i
                                log(`[OrderManager] Found claimable items at slot ${i}: ${name}`, 'info')
                                break
                            }
                        }
                    }
                    
                    // If there are claimable items, claim them
                    if (claimableSlot !== -1) {
                        log(`[OrderManager] Claiming items from slot ${claimableSlot}...`, 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Claiming filled items...`)
                        
                        // Click up to MAX_CLAIM_ATTEMPTS times to claim (handles partial fills)
                        for (let clickCount = 0; clickCount < MAX_CLAIM_ATTEMPTS; clickCount++) {
                            await sleep(CLAIM_DELAY_MS)
                            await clickWindow(bot, claimableSlot).catch(err => {
                                log(`[OrderManager] Claim click ${clickCount + 1} failed: ${err}`, 'debug')
                            })
                        }
                        
                        await sleep(CLAIM_DELAY_MS)
                        log(`[OrderManager] Claimed items, checking for cancel button...`, 'info')
                        await sleep(300)
                    }
                    
                    // Now look for the cancel button
                    const cancelButtonName = order.isBuyOrder ? 'Cancel Buy Order' : 'Cancel Sell Offer'
                    const cancelSlot = findSlotWithName(window, cancelButtonName)
                    
                    if (cancelSlot === -1) {
                        // No cancel button - order was fully filled
                        if (claimableSlot !== -1) {
                            log(`[OrderManager] Order fully filled, no cancel button found: ${order.itemName}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Order fully filled: §e${order.itemName}`)
                            order.claimed = true
                        } else {
                            log(`[OrderManager] No cancel button or claimable items found for: ${order.itemName}`, 'warn')
                        }
                        
                        cleanupTrackedOrders()
                        
                        bot._client.removeListener('open_window', windowListener)
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        bot.state = null
                        isManagingOrders = false
                        clearTimeout(timeout)
                        resolve(claimableSlot !== -1)
                        return
                    }
                    
                    // Click cancel button
                    log(`[OrderManager] Clicking cancel button at slot ${cancelSlot}`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §c[OrderManager] Cancelling remaining order...`)
                    cancelStep = 'done'
                    await sleep(200)
                    await clickWindow(bot, cancelSlot).catch(e => log(`[OrderManager] clickWindow error: ${e}`, 'debug'))
                    
                    // Wait for server to process, then clean up
                    await sleep(500)
                    
                    // Mark as cancelled
                    order.cancelled = true
                    log(`[OrderManager] Cancelled ${order.isBuyOrder ? 'buy' : 'sell'} order: ${order.itemName}`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §c[OrderManager] Cancelled order: §e${order.itemName}`)
                    
                    cleanupTrackedOrders()
                    
                    bot._client.removeListener('open_window', windowListener)
                    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                    bot.state = null
                    isManagingOrders = false
                    clearTimeout(timeout)
                    resolve(true)
                }
            } catch (error) {
                log(`[OrderManager] Error in cancel window handler: ${error}`, 'error')
                bot._client.removeListener('open_window', windowListener)
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                bot.state = null
                isManagingOrders = false
                clearTimeout(timeout)
                resolve(false)
            }
        }
        
        // Register listener BEFORE sending /bz (critical for catching first window)
        bot._client.on('open_window', windowListener)
        bot.state = 'bazaar'
        bot.chat('/bz')
    })
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
