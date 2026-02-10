import { MyBot, BazaarFlipRecommendation } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { getConfigProperty } from './configHelper'

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
}

// Internal list of tracked orders
let trackedOrders: BazaarOrderRecord[] = []

// Timer for periodic order checks
let checkTimer: NodeJS.Timeout | null = null

// Flag to track if we're currently managing orders
let isManagingOrders = false

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
 * Start the order management timer
 * Checks for orders to claim or cancel periodically
 */
export function startOrderManager(bot: MyBot): void {
    if (checkTimer) {
        log('[OrderManager] Timer already running', 'debug')
        return
    }
    
    const intervalSeconds = getConfigProperty('BAZAAR_ORDER_CHECK_INTERVAL_SECONDS')
    log(`[OrderManager] Starting order management timer (check every ${intervalSeconds}s)`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Started (checking every §e${intervalSeconds}s§7)`)
    
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
    const staleOrders = trackedOrders.filter(order => {
        const age = now - order.placedAt
        return !order.claimed && !order.cancelled && age > cancelTimeoutMs
    })
    
    if (staleOrders.length === 0) {
        log('[OrderManager] No stale orders to cancel', 'debug')
        return
    }
    
    log(`[OrderManager] Found ${staleOrders.length} stale orders to cancel`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Cancelling §e${staleOrders.length}§7 stale orders...`)
    
    // Cancel each stale order
    for (const order of staleOrders) {
        await cancelOrder(bot, order)
    }
}

/**
 * Claim a filled bazaar order via /bz → Manage Orders
 * This is triggered by chat message detection in ingameMessageHandler
 * 
 * Note: If bot is busy, the operation is queued and will retry after 1 second.
 * The return value in this case (false) only indicates the immediate attempt failed,
 * not the final result of the retry.
 */
export async function claimFilledOrders(bot: MyBot, itemName?: string, isBuyOrder?: boolean): Promise<boolean> {
    // Wait if bot is busy
    if (bot.state && bot.state !== 'claiming') {
        log('[OrderManager] Bot is busy, queueing claim operation (will retry in 1s)', 'info')
        setTimeout(() => claimFilledOrders(bot, itemName, isBuyOrder), 1000)
        return false
    }
    
    isManagingOrders = true
    
    return new Promise((resolve) => {
        let clickedManageOrders = false
        let claimedAny = false
        
        const timeout = setTimeout(() => {
            log('[OrderManager] Claim operation timed out (20 seconds)', 'warn')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            isManagingOrders = false
            resolve(false)
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
                    
                    resolve(claimedAny)
                }
            } catch (error) {
                log(`[OrderManager] Error in claim window handler: ${error}`, 'error')
                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                isManagingOrders = false
                clearTimeout(timeout)
                resolve(false)
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
 */
async function cancelOrder(bot: MyBot, order: BazaarOrderRecord): Promise<boolean> {
    // Wait if bot is busy
    if (bot.state) {
        log('[OrderManager] Bot is busy, cannot cancel order now', 'info')
        return false
    }
    
    isManagingOrders = true
    
    return new Promise((resolve) => {
        let clickedManageOrders = false
        let clickedOrder = false
        
        const timeout = setTimeout(() => {
            log('[OrderManager] Cancel operation timed out (20 seconds)', 'warn')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            isManagingOrders = false
            resolve(false)
        }, 20000)
        
        const windowHandler = async (window) => {
            try {
                await sleep(300)
                const title = getWindowTitle(window)
                log(`[OrderManager] Cancel window: ${title}`, 'debug')
                
                // Main bazaar page - click Manage Orders (slot 50)
                if (title.includes('Bazaar') && !clickedManageOrders) {
                    clickedManageOrders = true
                    log('[OrderManager] Clicking Manage Orders (slot 50)', 'info')
                    await sleep(200)
                    await clickWindow(bot, 50).catch(err => log(`[OrderManager] Error clicking Manage Orders: ${err}`, 'error'))
                    return
                }
                
                // Orders view - find the order to cancel
                if (clickedManageOrders && !clickedOrder) {
                    const orderPrefix = order.isBuyOrder ? 'BUY ' : 'SELL '
                    
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        
                        // Find matching order
                        if (name && name.startsWith(orderPrefix) && name.toLowerCase().includes(order.itemName.toLowerCase())) {
                            log(`[OrderManager] Found order to cancel: slot ${i}, item: ${name}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §7[OrderManager] Cancelling §e${name}`)
                            clickedOrder = true
                            
                            await sleep(200)
                            await clickWindow(bot, i).catch(() => {})
                            return
                        }
                    }
                    
                    // Order not found - might have been filled already
                    log(`[OrderManager] Order not found in Manage Orders: ${order.itemName}`, 'warn')
                    bot.removeListener('windowOpen', windowHandler)
                    bot.state = null
                    isManagingOrders = false
                    clearTimeout(timeout)
                    resolve(false)
                    return
                }
                
                // Order detail view - find and click cancel button
                if (clickedOrder) {
                    const cancelButtonName = order.isBuyOrder ? 'Cancel Buy Order' : 'Cancel Sell Offer'
                    let foundCancelButton = false
                    let foundClaimableOrder = false
                    
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        
                        // Check if this is a claimable filled order (has item name in it)
                        if (slot && slot.type && name && name.toLowerCase().includes(order.itemName.toLowerCase()) && 
                            !name.includes('Cancel') && !name.includes('Go Back')) {
                            foundClaimableOrder = true
                        }
                        
                        if (name && name.includes(cancelButtonName)) {
                            foundCancelButton = true
                            log(`[OrderManager] Clicking cancel button: slot ${i}`, 'info')
                            await sleep(200)
                            await clickWindow(bot, i).catch(() => {})
                            
                            // Mark as cancelled
                            order.cancelled = true
                            log(`[OrderManager] Cancelled ${order.isBuyOrder ? 'buy' : 'sell'} order: ${order.itemName}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §c[OrderManager] Cancelled order: §e${order.itemName}`)
                            
                            bot.removeListener('windowOpen', windowHandler)
                            bot.state = null
                            isManagingOrders = false
                            clearTimeout(timeout)
                            
                            // Clean up cancelled orders
                            cleanupTrackedOrders()
                            
                            resolve(true)
                            return
                        }
                    }
                    
                    // Cancel button not found - check if order is filled
                    if (!foundCancelButton) {
                        if (foundClaimableOrder) {
                            log(`[OrderManager] Order is filled, not stale: ${order.itemName}. Marking as claimed.`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Order is filled: §e${order.itemName}`)
                            order.claimed = true
                            cleanupTrackedOrders()
                        } else {
                            log(`[OrderManager] Cancel button not found for: ${order.itemName}`, 'warn')
                        }
                        
                        bot.removeListener('windowOpen', windowHandler)
                        bot.state = null
                        isManagingOrders = false
                        clearTimeout(timeout)
                        resolve(false)
                    }
                }
            } catch (error) {
                log(`[OrderManager] Error in cancel window handler: ${error}`, 'error')
                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                isManagingOrders = false
                clearTimeout(timeout)
                resolve(false)
            }
        }
        
        bot.removeAllListeners('windowOpen')
        bot.state = 'bazaar'
        bot.on('windowOpen', windowHandler)
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
