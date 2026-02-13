import { MyBot } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { ChatMessage } from 'prismarine-chat'
import { sendWebhookItemPurchased, sendWebhookItemSold, sendWebhookBazaarOrderFilled } from './webhookHandler'
import { getCurrentWebsocket } from './BAF'
import { getWhitelistedData, getCurrentFlip, clearCurrentFlip, getPurchaseStartTime, clearPurchaseStartTime } from './flipHandler'
import { trackFlipPurchase } from './flipTracker'
import { claimFilledOrders, markOrderClaimed, refreshOrderCounts, updateMaxTotalOrders, updateMaxBuyOrders } from './bazaarOrderManager'
import { handleInventoryFull } from './inventoryManager'
import { clearAHFlipsPending } from './bazaarFlipPauser'
import { enqueueCommand, CommandPriority } from './commandQueue'

// if nothing gets bought for 1 hours, send a report
let errorTimeout
// Track last buyspeed to prevent duplicate timing messages
let oldBuyspeed = -1
// Store buy speed for webhook
let lastBuySpeed = 0

// Feature 4: Bazaar daily sell limit tracking
let bazaarDailyLimitReached = false
let bazaarLimitResetTimer: NodeJS.Timeout | null = null

// Debounce timer for order count refresh after limit detection
let orderRefreshDebounceTimer: NodeJS.Timeout | null = null

// Bazaar order cooldown tracking
let bazaarOrderCooldownUntil: number = 0 // Timestamp when cooldown expires

// BUG 2: Stashed items tracking
// This flag is set when stash messages appear and serves as a session-wide warning
// It doesn't need to be reset because if items were stashed once, the user should check
let hasStashedItems = false

/**
 * Export function to check if items are in stash (for future use)
 */
export function hasItemsInStash(): boolean {
    return hasStashedItems
}

/**
 * Export function to reset stash flag (for manual clearing or future automation)
 */
export function clearStashFlag(): void {
    hasStashedItems = false
    log('[BAF] Stash flag cleared', 'debug')
}

export async function registerIngameMessageHandler(bot: MyBot) {
    let wss = await getCurrentWebsocket()
    bot.on('message', (message: ChatMessage, type) => {
        let text = message.getText(null)
        if (type == 'chat') {
            printMcChatToConsole(message.toAnsi())
            // Display timing when "Putting coins in escrow..." appears (TPM+ pattern)
            if (text === 'Putting coins in escrow...') {
                const startTime = getPurchaseStartTime()
                if (startTime !== null) {
                    const buyspeed = Date.now() - startTime
                    // Prevent duplicate messages with same timing
                    if (buyspeed !== oldBuyspeed) {
                        oldBuyspeed = buyspeed
                        lastBuySpeed = buyspeed
                        printMcChatToConsole(`§f[§4BAF§f]: §aAuction bought in ${buyspeed}ms`)
                    }
                    clearPurchaseStartTime()
                    // Close the window after purchase is complete
                    if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                }
            }
            if (text.startsWith('You purchased')) {
                // BUG 3: Clear AH flips pending flag after purchase
                clearAHFlipsPending()
                
                wss.send(
                    JSON.stringify({
                        type: 'uploadTab',
                        data: JSON.stringify(Object.keys(bot.players).map(playername => bot.players[playername].displayName.getText(null)))
                    })
                )
                wss.send(
                    JSON.stringify({
                        type: 'uploadScoreboard',
                        data: JSON.stringify(bot.scoreboard.sidebar.items.map(item => item.displayName.getText(null).replace(item.name, '')))
                    })
                )
                claimPurchased(bot)

                let itemName = text.split(' purchased ')[1].split(' for ')[0]
                let price = text.split(' for ')[1].split(' coins!')[0].replace(/,/g, '')
                let whitelistedData = getWhitelistedData(itemName, price)
                let flip = getCurrentFlip()

                // Track flip purchase for profit/time calculations
                if (flip) {
                    trackFlipPurchase(itemName, parseFloat(price), flip)
                    clearCurrentFlip()
                }

                sendWebhookItemPurchased(itemName, price, whitelistedData, flip, lastBuySpeed)
                lastBuySpeed = 0 // Reset to prevent stale data in next purchase
                setNothingBoughtFor1HourTimeout(wss)
            }
            // Handle auction errors (expired, not found, etc.)
            if (text.includes('There was an error with the auction house!')) {
                const startTime = getPurchaseStartTime()
                if (startTime !== null) {
                    const totalPurchaseTime = Date.now() - startTime
                    printMcChatToConsole(`§f[§4BAF§f]: §cAuction failed in ${totalPurchaseTime}ms`)
                    clearPurchaseStartTime()
                }
            }
            if (text.startsWith('[Auction]') && text.includes('bought') && text.includes('for')) {
                log('New item sold - queuing claim with HIGH priority')
                
                // Queue the claim with HIGH priority so it runs immediately after current task
                enqueueCommand(
                    'Claim Sold Auction',
                    CommandPriority.HIGH,
                    async () => {
                        await claimSoldItem(bot)
                    },
                    true // interruptible - can be interrupted by AH flips
                )

                sendWebhookItemSold(
                    text.split(' bought ')[1].split(' for ')[0],
                    text.split(' for ')[1].split(' coins')[0].replace(/,/g, ''),
                    text.split('[Auction] ')[1].split(' bought ')[0]
                )
            }
            if (bot.privacySettings && bot.privacySettings.chatRegex.test(text)) {
                wss.send(
                    JSON.stringify({
                        type: 'chatBatch',
                        data: JSON.stringify([text])
                    })
                )
            }
            // Forward all bazaar messages to the websocket so Coflnet knows about
            // order placements, fills, and claims (if not already sent by privacy regex)
            if (text.includes('[Bazaar]') && !(bot.privacySettings?.chatRegex?.test(text))) {
                wss.send(
                    JSON.stringify({
                        type: 'chatBatch',
                        data: JSON.stringify([text])
                    })
                )
            }
            // Detect bazaar order filled messages and claim them via order manager
            // Handles both buy order fills and sell offer fills
            if (text.includes('[Bazaar]') && text.includes('was filled!')) {
                let itemName = ''
                let amount = 0
                let isBuyOrder = false
                
                if (text.includes('Buy Order')) {
                    log('Bazaar buy order filled, claiming via order manager', 'info')
                    isBuyOrder = true
                    // Extract item name and amount: "[Bazaar] Your Buy Order for 64x ☘ Flawed Peridot Gemstone was filled!"
                    const match = text.match(/Buy Order for (\d+)x (.+) was filled!/)
                    if (match) {
                        amount = parseInt(match[1], 10)
                        itemName = match[2].trim()
                    }
                } else if (text.includes('Sell Offer')) {
                    log('Bazaar sell offer filled, claiming via order manager', 'info')
                    isBuyOrder = false
                    // Extract item name and amount: "[Bazaar] Your Sell Offer for 64x ☘ Flawed Peridot Gemstone was filled!"
                    const match = text.match(/Sell Offer for (\d+)x (.+) was filled!/)
                    if (match) {
                        amount = parseInt(match[1], 10)
                        itemName = match[2].trim()
                    }
                } else {
                    log('Bazaar order filled, claiming via order manager', 'info')
                }
                
                // Send webhook for filled order
                if (itemName && amount > 0) {
                    sendWebhookBazaarOrderFilled(itemName, amount, isBuyOrder)
                }
                
                // Mark as claimed immediately to prevent cancellation attempts
                if (itemName) {
                    markOrderClaimed(itemName, isBuyOrder)
                }
                
                // Use the new order manager to claim
                claimFilledOrders(bot, itemName, isBuyOrder)
            }
            
            // Detect when orders are claimed to mark them as claimed
            // "[Bazaar] Claimed 4x ☘ Perfect Jade Gemstone worth 47,999,990 coins bought for 11,999,997 each!"
            // "[Bazaar] Claimed 4x ☘ Perfect Jade Gemstone worth 47,999,990 coins sold for 11,999,997 each!"
            if (text.includes('[Bazaar]') && text.includes('Claimed ') && text.includes(' coins')) {
                let itemName = ''
                let isBuyOrder = false
                
                // Detect buy vs sell based on "bought for" vs "sold for"
                if (text.includes('bought for')) {
                    isBuyOrder = true
                    const match = text.match(/Claimed \d+x (.+) worth .+ coins bought for/)
                    if (match) itemName = match[1].trim()
                } else if (text.includes('sold for')) {
                    isBuyOrder = false
                    const match = text.match(/Claimed \d+x (.+) worth .+ coins sold for/)
                    if (match) itemName = match[1].trim()
                }
                
                if (itemName) {
                    log(`[Bazaar] Order claimed: ${itemName} (${isBuyOrder ? 'buy' : 'sell'})`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §a[OrderManager] Order is filled: §e${itemName}`)
                    markOrderClaimed(itemName, isBuyOrder)
                }
            }
            
            // Feature 4: Detect bazaar daily sell limit
            if (text.includes('[Bazaar]') && removeMinecraftColorCodes(text).includes('You reached the daily limit in items value that you may sell on the bazaar!')) {
                bazaarDailyLimitReached = true
                log('[BAF]: §cBazaar daily sell limit reached! Disabling sell offers.', 'error')
                printMcChatToConsole('§f[§4BAF§f]: §cBazaar daily sell limit reached! Disabling sell offers.')
                
                // Set timer to reset after 24 hours
                if (bazaarLimitResetTimer) {
                    clearTimeout(bazaarLimitResetTimer)
                }
                bazaarLimitResetTimer = setTimeout(() => {
                    bazaarDailyLimitReached = false
                    log('[BAF]: Bazaar daily sell limit reset', 'info')
                    printMcChatToConsole('§f[§4BAF§f]: §aBazaar daily sell limit reset')
                }, 24 * 60 * 60 * 1000) // 24 hours
            }
            
            // BUG 2: Detect stashed items messages
            const cleanMessage = removeMinecraftColorCodes(text).toLowerCase()
            if (cleanMessage.includes('stashed away')) {
                hasStashedItems = true
                log('[BAF] ⚠ Items detected in stash! Inventory may have been full.', 'warn')
                printMcChatToConsole('§f[§4BAF§f]: §e⚠ Items are in stash! Free inventory space and pick up manually.')
            }
            
            // Detect bazaar order limit messages to dynamically update limits
            // Examples: "[Bazaar] You may only have 25 orders open at once!"
            //           "[Bazaar] You may only have 7 buy orders open at once!"
            //           "[Bazaar] You reached your maximum of 14 bazaar orders!"
            if (text.includes('[Bazaar]')) {
                const cleanText = removeMinecraftColorCodes(text)
                const lowerCleanText = cleanText.toLowerCase()
                
                // Check for "may only have" pattern (current Hypixel message format)
                const hasMayOnlyHaveMessage = lowerCleanText.includes('may only have')
                // Check for "reached maximum" pattern (alternate Hypixel message format)
                const hasReachedMaximumMessage = lowerCleanText.includes('reached') && lowerCleanText.includes('maximum')
                
                if (hasMayOnlyHaveMessage || hasReachedMaximumMessage) {
                    let limitDetected = false
                    
                    if (hasMayOnlyHaveMessage) {
                        // Match patterns like "You may only have 7 buy orders open at once!"
                        // Must check buy orders FIRST to avoid false matches with total orders
                        const buyOrderMatch = cleanText.match(/may only have (\d+) buy orders? (?:open )?at once/i)
                        if (buyOrderMatch) {
                            const limit = parseInt(buyOrderMatch[1], 10)
                            log(`[BAF]: Detected buy order limit: ${limit}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §e[OrderManager] Detected limit: ${limit} buy orders`)
                            updateMaxBuyOrders(limit)
                            limitDetected = true
                        }
                        
                        // Match patterns like "You may only have 25 orders open at once!" (but NOT "buy orders")
                        // Use negative lookbehind to exclude messages with "buy" before "orders"
                        const totalOrderMatch = cleanText.match(/may only have (\d+) (?!buy )orders? (?:open )?at once/i)
                        if (totalOrderMatch && !buyOrderMatch) {
                            const limit = parseInt(totalOrderMatch[1], 10)
                            log(`[BAF]: Detected total order limit: ${limit}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §e[OrderManager] Detected limit: ${limit} total orders`)
                            updateMaxTotalOrders(limit)
                            limitDetected = true
                        }
                    }
                    
                    if (hasReachedMaximumMessage) {
                        // Match patterns like "You reached your maximum of 14 bazaar orders!"
                        // Check for "buy orders" or "buy order" first to distinguish from total orders
                        const reachedBuyOrderMatch = cleanText.match(/reached (?:your |the )?maximum of (\d+) (?:bazaar )?buy orders?/i)
                        if (reachedBuyOrderMatch) {
                            const limit = parseInt(reachedBuyOrderMatch[1], 10)
                            log(`[BAF]: Detected buy order limit (reached maximum): ${limit}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §e[OrderManager] Detected limit: ${limit} buy orders`)
                            updateMaxBuyOrders(limit)
                            limitDetected = true
                        }
                        
                        // Match patterns like "You reached your maximum of 14 bazaar orders!" (but NOT "buy orders")
                        const reachedTotalOrderMatch = cleanText.match(/reached (?:your |the )?maximum of (\d+) (?:bazaar )?(?!buy )orders?/i)
                        if (reachedTotalOrderMatch && !reachedBuyOrderMatch) {
                            const limit = parseInt(reachedTotalOrderMatch[1], 10)
                            log(`[BAF]: Detected total order limit (reached maximum): ${limit}`, 'info')
                            printMcChatToConsole(`§f[§4BAF§f]: §e[OrderManager] Detected limit: ${limit} total orders`)
                            updateMaxTotalOrders(limit)
                            limitDetected = true
                        }
                    }
                    
                    // If any limit was detected, schedule a debounced order count refresh
                    if (limitDetected) {
                        log('[BAF]: Scheduling debounced order count refresh after limit detection', 'info')
                        
                        // Clear any existing refresh timer to debounce multiple rapid limit messages
                        if (orderRefreshDebounceTimer) {
                            clearTimeout(orderRefreshDebounceTimer)
                        }
                        
                        // Schedule refresh after 2 seconds (debounced)
                        orderRefreshDebounceTimer = setTimeout(() => {
                            orderRefreshDebounceTimer = null
                            refreshOrderCounts(bot).catch((err: any) => {
                                log(`[BAF]: Error refreshing order counts after limit detection: ${err}`, 'error')
                            })
                        }, 2000) // Wait 2 seconds to let GUI close and debounce multiple messages
                    }
                }
            }
            
            // Detect "Placing orders is on cooldown for up to 1 minute!" message
            if (text.includes('[Bazaar]') && text.includes('cooldown')) {
                const cleanText = removeMinecraftColorCodes(text)
                log('[BAF]: Detected bazaar order cooldown message', 'warn')
                printMcChatToConsole('§f[§4BAF§f]: §c[Cooldown] Bazaar orders on cooldown - waiting 1 minute')
                
                // Set cooldown to expire in 1 minute (60 seconds)
                bazaarOrderCooldownUntil = Date.now() + 60000
                
                log(`[BAF]: Bazaar order cooldown set until ${new Date(bazaarOrderCooldownUntil).toISOString()}`, 'info')
            }
            
            // Detect "You don't have the space required to claim that!" message
            if (text.includes("You don't have the space required to claim that!")) {
                log('[BAF]: Inventory full detected - triggering inventory management', 'warn')
                printMcChatToConsole('§f[§4BAF§f]: §c[InventoryFull] Cannot claim - inventory full!')
                
                // Trigger inventory management in background
                handleInventoryFull(bot).catch(err => {
                    log(`[BAF]: Error handling inventory full: ${err}`, 'error')
                })
            }
        }
    })

    setNothingBoughtFor1HourTimeout(wss)
}

/**
 * Feature 4: Check if bazaar daily sell limit has been reached
 * @returns true if the sell limit has been reached, false otherwise
 */
export function isBazaarDailyLimitReached(): boolean {
    return bazaarDailyLimitReached
}

/**
 * Check if bazaar orders are on cooldown
 * @returns true if on cooldown, false otherwise
 */
export function isBazaarOrderOnCooldown(): boolean {
    return Date.now() < bazaarOrderCooldownUntil
}

/**
 * Get the remaining cooldown time in milliseconds
 * @returns milliseconds until cooldown expires, or 0 if not on cooldown
 */
export function getBazaarOrderCooldownRemaining(): number {
    const remaining = bazaarOrderCooldownUntil - Date.now()
    return remaining > 0 ? remaining : 0
}

export function claimPurchased(bot: MyBot, useCollectAll: boolean = true): Promise<boolean> {
    return new Promise((resolve, reject) => {
        if (bot.state) {
            log('Currently busy with something else (' + bot.state + ') -> not claiming purchased item')
            setTimeout(async () => {
                let result = await claimPurchased(bot)
                resolve(result)
            }, 1000)
            return
        }

        let timeout = setTimeout(() => {
            log('Claiming of purchased auction failed. Removing lock')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            resolve(false)
        }, 5000)

        const windowHandler = async (window) => {
            let title = getWindowTitle(window)
            log('Claiming auction window: ' + title)

            if (title.toString().includes('Auction House')) {
                // Add a small delay to ensure the window is fully loaded before clicking
                await sleep(300)
                clickWindow(bot, 13).catch(err => log(`Error clicking auction house slot: ${err}`, 'error'))
            }

            if (title.toString().includes('Your Bids')) {
                let slotToClick = -1
                for (let i = 0; i < window.slots.length; i++) {
                    const slot = window.slots[i]
                    let name = (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString()
                    if (useCollectAll && slot?.type === 380 && name?.includes('Claim') && name?.includes('All')) {
                        log('Found cauldron to claim all purchased auctions -> clicking index ' + i)
                        clickWindow(bot, i).catch(err => log(`Error clicking claim all slot: ${err}`, 'error'))
                        bot.removeListener('windowOpen', windowHandler)
                        bot.state = null
                        clearTimeout(timeout)
                        resolve(true)
                        return
                    }
                    let lore = (slot?.nbt as any)?.value?.display?.value?.Lore?.value?.value?.toString()
                    if (lore?.includes('Status:') && lore?.includes('Sold!')) {
                        log('Found claimable purchased auction. Gonna click index ' + i)
                        log(JSON.stringify(slot))
                        slotToClick = i
                    }
                }
                if (slotToClick === -1) {
                    log('No claimable purchased auction found')
                    bot.removeListener('windowOpen', windowHandler)
                    bot.state = null
                    bot.closeWindow(window)
                    clearTimeout(timeout)
                    resolve(false)
                    return
                }
                clickWindow(bot, slotToClick).catch(err => log(`Error clicking purchased auction slot: ${err}`, 'error'))
            }

            if (title.toString().includes('BIN Auction View')) {
                log('Claiming purchased auction...')
                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                clearTimeout(timeout)
                clickWindow(bot, 31).catch(err => log(`Error claiming purchased auction: ${err}`, 'error'))
                resolve(true)
            }
        }

        // CRITICAL: Clear all previous windowOpen listeners to prevent conflicts
        // This prevents stale handlers from claim/sell operations from interfering
        bot.removeAllListeners('windowOpen')
        bot.state = 'claiming'
        bot.on('windowOpen', windowHandler)
        bot.chat('/ah')
    })
}

/**
 * BUG 1 FIX: Claim all sold auction items
 * Properly processes the Manage Auctions window to claim all sold items
 * Loops through items and re-scans after each claim (slots shift after claiming)
 */
export async function claimSoldItem(bot: MyBot): Promise<boolean> {
    log('[Startup] Claiming sold AH items...', 'info')
    
    // Helper functions (local to avoid circular dependencies)
    function getSlotName(slot: any): string {
        if (!slot || !slot.nbt) return ''
        return (slot.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
    }
    
    function getSlotLore(slot: any): string[] {
        if (!slot || !slot.nbt) return []
        const loreData = (slot.nbt as any)?.value?.display?.value?.Lore?.value?.value
        if (!loreData || !Array.isArray(loreData)) return []
        return loreData.map((line: any) => removeMinecraftColorCodes(line.toString()))
    }
    
    // BUG 4 FIX: Helper to detect claimable (sold/ended) auctions vs active auctions
    function isClaimableAuction(slot: any): boolean {
        if (!slot || !slot.nbt) return false
        const lore = getSlotLore(slot)
        if (!lore || lore.length === 0) return false
        
        const loreText = lore.join(' ').toLowerCase()
        
        // MUST have one of these to be claimable
        const claimableIndicators = ['sold', 'ended', 'expired', 'click to claim', 'claim your']
        const hasClaimable = claimableIndicators.some(indicator => loreText.includes(indicator))
        
        // Must NOT have these — these indicate active auctions
        const activeIndicators = ['ends in', 'buy it now', 'starting bid']
        const isActive = activeIndicators.some(indicator => loreText.includes(indicator))
        
        return hasClaimable && !isActive
    }
    
    function findSlotWithName(win: any, searchName: string): number {
        for (let i = 0; i < win.slots.length; i++) {
            const slot = win.slots[i]
            const name = removeMinecraftColorCodes(getSlotName(slot))
            if (name && name.includes(searchName)) return i
        }
        return -1
    }
    
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
    
    try {
        // Open /ah window
        bot.chat('/ah')
        const ahOpened = await waitForNewWindow(bot, 5000)
        if (!ahOpened || !bot.currentWindow) {
            log('[Startup] /ah window did not open', 'warn')
            return false
        }
        
        // BUG 2 FIX: Poll until slots are populated
        await sleep(300)
        let pollAttempts = 0
        while (pollAttempts < 20) { // max 2 seconds
            if (!bot.currentWindow) break
            let hasItems = false
            for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                const slot = bot.currentWindow.slots[i]
                if (slot && slot.name && slot.name !== 'air' && slot.name !== 'stained_glass_pane') {
                    const name = removeMinecraftColorCodes(getSlotName(slot))
                    if (name && name === 'Manage Auctions') {
                        hasItems = true
                        break
                    }
                }
            }
            if (hasItems) break
            await sleep(100)
            pollAttempts++
        }
        log(`[Startup] /ah window loaded after ${pollAttempts * 100 + 300}ms`, 'debug')
        
        // Click "Manage Auctions"
        const manageSlot = findSlotWithName(bot.currentWindow, 'Manage Auctions')
        if (manageSlot === -1) {
            log('[Startup] Manage Auctions button not found', 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            return false
        }
        
        // BUG 3 FIX: Create waitForNewWindow promise BEFORE clicking
        const manageWindowPromise = waitForNewWindow(bot, 5000)
        await clickWindow(bot, manageSlot).catch(() => {})
        const manageOpened = await manageWindowPromise
        if (!manageOpened || !bot.currentWindow) {
            log('[Startup] Manage Auctions window did not open', 'warn')
            return false
        }
        
        // BUG 2 FIX: Poll until slots are populated
        await sleep(300)
        pollAttempts = 0
        while (pollAttempts < 20) { // max 2 seconds
            if (!bot.currentWindow) break
            let hasContent = false
            for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                const slot = bot.currentWindow.slots[i]
                if (!slot || !slot.nbt) continue
                const name = removeMinecraftColorCodes(getSlotName(slot))
                if (name && name !== '' && name !== 'Close' && name !== 'Go Back' && 
                    name !== 'Arrow' && !name.includes('stained_glass')) {
                    hasContent = true
                    break
                }
            }
            if (hasContent) break
            await sleep(100)
            pollAttempts++
        }
        log(`[Startup] Manage Auctions window loaded after ${pollAttempts * 100 + 300}ms`, 'debug')
        
        if (!bot.currentWindow) return false
        
        // Now we're in the Manage Auctions window
        // Process all claimable items - re-scan after each claim
        let claimedCount = 0
        
        // Track processed item names to prevent infinite loops on false positives
        const processedItems = new Set<string>()
        // Add iteration limit as safety net
        const MAX_ITERATIONS = 50
        let iterations = 0
        
        while (iterations < MAX_ITERATIONS) {
            iterations++
            if (!bot.currentWindow) break
            
            // BUG 4 FIX: Verify we're still in Manage Auctions
            const currentTitle = getWindowTitle(bot.currentWindow)
            if (!currentTitle || !currentTitle.includes('Manage Auctions')) {
                log(`[Startup] Not in Manage Auctions (title: ${currentTitle}), reopening`, 'warn')
                if (bot.currentWindow) {
                    try {
                        bot.closeWindow(bot.currentWindow)
                    } catch(e) {}
                }
                await sleep(300)
                
                // Reopen /ah → Manage Auctions
                bot.chat('/ah')
                const ahOpened = await waitForNewWindow(bot, 5000)
                if (!ahOpened || !bot.currentWindow) break
                await sleep(300)
                
                // Poll for /ah window slots
                let pollAttempts = 0
                while (pollAttempts < 20) {
                    if (!bot.currentWindow) break
                    let hasItems = false
                    for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                        const slot = bot.currentWindow.slots[i]
                        if (slot && slot.name && slot.name !== 'air') {
                            const name = removeMinecraftColorCodes(getSlotName(slot))
                            if (name && name === 'Manage Auctions') {
                                hasItems = true
                                break
                            }
                        }
                    }
                    if (hasItems) break
                    await sleep(100)
                    pollAttempts++
                }
                
                const manageSlot = findSlotWithName(bot.currentWindow, 'Manage Auctions')
                if (manageSlot === -1) break
                const managePromise = waitForNewWindow(bot, 5000)
                await clickWindow(bot, manageSlot).catch(() => {})
                await managePromise
                await sleep(300)
                if (!bot.currentWindow) break
                continue // restart the scan
            }
            
            // First check for "Claim All" button (highest priority)
            const claimAllSlot = findSlotWithName(bot.currentWindow, 'Claim All')
            if (claimAllSlot !== -1) {
                log('[Startup] Found "Claim All" button, using it', 'info')
                await clickWindow(bot, claimAllSlot).catch(() => {})
                await sleep(800)
                claimedCount++ // Count as one bulk claim
                break // After Claim All, we're done
            }
            
            // BUG 4 FIX: Find the FIRST claimable item (re-scan every iteration) using proper detection
            let foundClaimable = -1
            let foundItemName = ''
            for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                const slot = bot.currentWindow.slots[i]
                if (!slot || !slot.nbt) continue
                const name = removeMinecraftColorCodes(getSlotName(slot))
                
                // Skip navigation items and control buttons
                if (!name || name === 'Close' || name === 'Go Back' || name.includes('Arrow') || 
                    name === 'Create Auction' || name === 'View Bids' || name === 'Past Auctions') continue
                
                // Skip items we've already processed (prevents infinite loops on false positives)
                if (processedItems.has(name)) {
                    log(`[Startup] Skipping already processed item: ${name} at slot ${i}`, 'debug')
                    continue
                }
                
                // BUG 4 FIX: Use isClaimableAuction to distinguish sold from active auctions
                if (isClaimableAuction(slot)) {
                    foundClaimable = i
                    foundItemName = name
                    log(`[Startup] Found claimable: ${name} at slot ${i}`, 'debug')
                    break
                } else {
                    log(`[Startup] Skipping active auction: ${name} at slot ${i}`, 'debug')
                }
            }
            
            if (foundClaimable === -1) {
                log('[Startup] No more claimable auctions found', 'debug')
                break // Nothing left to claim
            }
            
            // Mark this item as processed to prevent re-processing
            processedItems.add(foundItemName)
            log(`[Startup] Processing item: ${foundItemName} (total processed: ${processedItems.size})`, 'debug')
            
            // Click the claimable slot
            const slotName = removeMinecraftColorCodes(getSlotName(bot.currentWindow.slots[foundClaimable]))
            log(`[Startup] Clicking claimable auction "${slotName}" at slot ${foundClaimable}`, 'debug')
            await clickWindow(bot, foundClaimable).catch(() => {})
            await sleep(400)
            
            // BUG 4 FIX: After clicking, check if we accidentally opened an active auction
            if (bot.currentWindow) {
                const title = getWindowTitle(bot.currentWindow)
                
                // BUG 4 FIX: If we opened "BIN Auction View", it's an active auction - close and skip
                if (title && title.includes('BIN Auction View') && !title.includes('Confirm')) {
                    log(`[Startup] Accidentally opened active auction (${slotName}), closing`, 'warn')
                    bot.closeWindow(bot.currentWindow)
                    await sleep(300)
                    
                    // Reopen Manage Auctions and continue
                    bot.chat('/ah')
                    const reopened = await waitForNewWindow(bot, 5000)
                    if (!reopened || !bot.currentWindow) break
                    await sleep(300)
                    
                    // Poll for /ah window slots
                    let pollAttempts = 0
                    while (pollAttempts < 20) {
                        if (!bot.currentWindow) break
                        let hasItems = false
                        for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                            const slot = bot.currentWindow.slots[i]
                            if (slot && slot.name && slot.name !== 'air') {
                                const name = removeMinecraftColorCodes(getSlotName(slot))
                                if (name && name === 'Manage Auctions') {
                                    hasItems = true
                                    break
                                }
                            }
                        }
                        if (hasItems) break
                        await sleep(100)
                        pollAttempts++
                    }
                    
                    const manageSlot2 = findSlotWithName(bot.currentWindow, 'Manage Auctions')
                    if (manageSlot2 === -1) break
                    
                    const managePromise2 = waitForNewWindow(bot, 5000)
                    await clickWindow(bot, manageSlot2).catch(() => {})
                    await managePromise2
                    await sleep(300)
                    
                    // Poll for Manage Auctions window slots
                    pollAttempts = 0
                    while (pollAttempts < 20) {
                        if (!bot.currentWindow) break
                        let hasContent = false
                        for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                            const slot = bot.currentWindow.slots[i]
                            if (!slot || !slot.nbt) continue
                            const name = removeMinecraftColorCodes(getSlotName(slot))
                            if (name && name !== '' && name !== 'Close' && name !== 'Go Back') {
                                hasContent = true
                                break
                            }
                        }
                        if (hasContent) break
                        await sleep(100)
                        pollAttempts++
                    }
                    
                    continue // restart the scan
                }
                
                // Otherwise, this is a detail view for a sold auction - look for claim button
                if (title && (title.includes('Confirm') || title.includes('BIN Auction View') || title.includes('Auction View'))) {
                    log('[Startup] Detail view opened, looking for claim button', 'debug')
                    // This is a detail/confirm view — look for claim button
                    const claimSlot = findSlotWithName(bot.currentWindow, 'Claim')
                    if (claimSlot !== -1) {
                        await clickWindow(bot, claimSlot).catch(() => {})
                        await sleep(400)
                        claimedCount++
                    }
                }
            }
            
            await sleep(300)
            
            // The window should return to the auction list
            // If it closed, reopen to check for more
            if (!bot.currentWindow) {
                log('[Startup] Window closed after claim, reopening to check for more', 'debug')
                bot.chat('/ah')
                const reopened = await waitForNewWindow(bot, 5000)
                if (!reopened || !bot.currentWindow) break
                await sleep(300)
                
                // Poll for /ah window slots
                let pollAttempts = 0
                while (pollAttempts < 20) {
                    if (!bot.currentWindow) break
                    let hasItems = false
                    for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                        const slot = bot.currentWindow.slots[i]
                        if (slot && slot.name && slot.name !== 'air') {
                            const name = removeMinecraftColorCodes(getSlotName(slot))
                            if (name && name === 'Manage Auctions') {
                                hasItems = true
                                break
                            }
                        }
                    }
                    if (hasItems) break
                    await sleep(100)
                    pollAttempts++
                }
                
                const manageSlot2 = findSlotWithName(bot.currentWindow, 'Manage Auctions')
                if (manageSlot2 === -1) break
                
                // Create promise BEFORE clicking
                const managePromise2 = waitForNewWindow(bot, 5000)
                await clickWindow(bot, manageSlot2).catch(() => {})
                const manageOpened2 = await managePromise2
                if (!manageOpened2 || !bot.currentWindow) break
                
                await sleep(300)
                
                // Poll for Manage Auctions window slots
                pollAttempts = 0
                while (pollAttempts < 20) {
                    if (!bot.currentWindow) break
                    let hasContent = false
                    for (let i = 0; i < bot.currentWindow.slots.length; i++) {
                        const slot = bot.currentWindow.slots[i]
                        if (!slot || !slot.nbt) continue
                        const name = removeMinecraftColorCodes(getSlotName(slot))
                        if (name && name !== '' && name !== 'Close' && name !== 'Go Back') {
                            hasContent = true
                            break
                        }
                    }
                    if (hasContent) break
                    await sleep(100)
                    pollAttempts++
                }
            }
        }
        
        if (iterations >= MAX_ITERATIONS) {
            log(`[Startup] Hit max iteration limit (${MAX_ITERATIONS}) while claiming auctions - possible stuck loop prevented`, 'warn')
            printMcChatToConsole('§f[§4BAF§f]: §c[Startup] Auction claim loop limit reached - stopped to prevent hang')
        }
        
        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
        log(`[Startup] Claimed ${claimedCount} sold auction(s), processed ${processedItems.size} item(s)`, 'info')
        return claimedCount > 0
        
    } catch (error) {
        log(`[Startup] Error claiming sold items: ${error}`, 'error')
        if (bot.currentWindow) {
            try { bot.closeWindow(bot.currentWindow) } catch(e) {}
        }
        return false
    }
}

function claimExpiredAuction(bot, slot) {
    return new Promise(resolve => {
        const windowHandler = (window) => {
            let title = getWindowTitle(window)
            if (title == 'BIN Auction View') {
                log('Clicking slot 31, claiming expired auction')
                clickWindow(bot, 31).catch(err => log(`Error claiming expired auction: ${err}`, 'error'))
                clearTimeout(timeout)
                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                bot.closeWindow(window)
                resolve(true)
            }
        }
        
        const timeout = setTimeout(() => {
            log('Claiming expired auction timed out. Removing listener')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            resolve(false)
        }, 5000)
        
        // CRITICAL: Clear all previous windowOpen listeners to prevent conflicts
        bot.removeAllListeners('windowOpen')
        bot.on('windowOpen', windowHandler)
        clickWindow(bot, slot).catch(err => {
            log(`Error clicking expired auction slot: ${err}`, 'error')
            clearTimeout(timeout)
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            resolve(false)
        })
    })
}

/**
 * Claim a filled bazaar order by navigating to Manage Orders
 * 
 * Flow: /bz → click Manage Orders (slot 50) → click filled order items to claim
 */
export async function claimBazaarOrder(bot: MyBot): Promise<boolean> {
    return new Promise((resolve) => {
        if (bot.state) {
            log('Currently busy with something else (' + bot.state + ') -> not claiming bazaar order')
            setTimeout(async () => {
                let result = await claimBazaarOrder(bot)
                resolve(result)
            }, 1000)
            return
        }

        let clickedManageOrders = false

        let timeout = setTimeout(() => {
            log('Bazaar order claiming timed out. Removing lock')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            resolve(false)
        }, 15000)

        const windowHandler = async (window) => {
            await sleep(300)
            let title = getWindowTitle(window)
            log('Bazaar claiming window: ' + title, 'debug')

            // Main bazaar page - click Manage Orders (slot 50)
            if (title.includes('Bazaar') && !clickedManageOrders) {
                clickedManageOrders = true
                await sleep(200)
                clickWindow(bot, 50).catch(err => log(`Error clicking Manage Orders: ${err}`, 'error'))
                return
            }

            // Orders view - find and click filled orders to claim
            if (clickedManageOrders) {
                let claimedAny = false
                for (let i = 0; i < window.slots.length; i++) {
                    const slot = window.slots[i]
                    const name = removeMinecraftColorCodes(
                        (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                    )
                    // Look for claimable orders (BUY or SELL items with claim indicators)
                    if (name && (name.startsWith('BUY ') || name.startsWith('SELL '))) {
                        log(`Clicking bazaar order to claim: slot ${i}, item: ${name}`, 'debug')
                        await clickWindow(bot, i)
                        claimedAny = true
                        await sleep(500)
                        // Click again for partial claims (may fail if already fully claimed)
                        try { await clickWindow(bot, i) } catch (e) { /* already fully claimed */ }
                        await sleep(500)
                    }
                }

                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                clearTimeout(timeout)
                if (claimedAny) {
                    log('Bazaar orders claimed successfully')
                } else {
                    log('No claimable bazaar orders found')
                }
                resolve(claimedAny)
            }
        }

        // CRITICAL: Clear all previous windowOpen listeners to prevent conflicts
        bot.removeAllListeners('windowOpen')
        bot.state = 'claiming'
        bot.on('windowOpen', windowHandler)
        bot.chat('/bz')
    })
}

function setNothingBoughtFor1HourTimeout(wss: WebSocket) {
    if (errorTimeout) {
        clearTimeout(errorTimeout)
    }
    errorTimeout = setTimeout(() => {
        wss.send(
            JSON.stringify({
                type: 'clientError',
                data: 'Nothing bought for 1 hour'
            })
        )
    })
}
