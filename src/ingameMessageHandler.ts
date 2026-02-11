import { MyBot } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { ChatMessage } from 'prismarine-chat'
import { sendWebhookItemPurchased, sendWebhookItemSold } from './webhookHandler'
import { getCurrentWebsocket } from './BAF'
import { getWhitelistedData, getCurrentFlip, clearCurrentFlip, getPurchaseStartTime, clearPurchaseStartTime } from './flipHandler'
import { trackFlipPurchase } from './flipTracker'
import { claimFilledOrders, markOrderClaimed } from './bazaarOrderManager'

// if nothing gets bought for 1 hours, send a report
let errorTimeout
// Track last buyspeed to prevent duplicate timing messages
let oldBuyspeed = -1
// Store buy speed for webhook
let lastBuySpeed = 0

// Feature 4: Bazaar daily sell limit tracking
let bazaarDailyLimitReached = false
let bazaarLimitResetTimer: NodeJS.Timeout | null = null

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
                log('New item sold')
                claimSoldItem(bot)

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
                let isBuyOrder = false
                
                if (text.includes('Buy Order')) {
                    log('Bazaar buy order filled, claiming via order manager', 'info')
                    isBuyOrder = true
                    // Extract item name: "[Bazaar] Your Buy Order for 64x ☘ Flawed Peridot Gemstone was filled!"
                    const match = text.match(/Buy Order for \d+x (.+) was filled!/)
                    if (match) itemName = match[1].trim()
                } else if (text.includes('Sell Offer')) {
                    log('Bazaar sell offer filled, claiming via order manager', 'info')
                    isBuyOrder = false
                    // Extract item name: "[Bazaar] Your Sell Offer for 64x ☘ Flawed Peridot Gemstone was filled!"
                    const match = text.match(/Sell Offer for \d+x (.+) was filled!/)
                    if (match) itemName = match[1].trim()
                } else {
                    log('Bazaar order filled, claiming via order manager', 'info')
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

export async function claimSoldItem(bot: MyBot): Promise<boolean> {
    return new Promise((resolve, reject) => {
        if (bot.state) {
            log('Currently busy with something else (' + bot.state + ') -> not claiming sold item')
            setTimeout(async () => {
                let result = await claimSoldItem(bot)
                resolve(result)
            }, 1000)
            return
        }

        let timeout = setTimeout(() => {
            log('Seems something went wrong while claiming sold item. Removing lock')
            bot.removeListener('windowOpen', windowHandler)
            bot.state = null
            resolve(false)
        }, 10000)

        const windowHandler = async (window) => {
            let title = getWindowTitle(window)
            if (title.toString().includes('Auction House')) {
                // Add a small delay to ensure the window is fully loaded before clicking
                await sleep(300)
                clickWindow(bot, 15).catch(err => {
                    log(`Error clicking manage auctions slot: ${err}`, 'error')
                    // Clean up on error
                    bot.removeListener('windowOpen', windowHandler)
                    bot.state = null
                    clearTimeout(timeout)
                    resolve(false)
                })
            }
            if (title.toString().includes('Manage Auctions')) {
                log('Claiming sold auction...')
                let clickSlot

                for (let i = 0; i < window.slots.length; i++) {
                    const item = window.slots[i] as any
                    
                    // Check for "Claim All" cauldron first (highest priority)
                    if (item && item.name === 'cauldron' && (item.nbt as any).value?.display?.value?.Name?.value?.toString().includes('Claim All')) {
                        log(item)
                        log('Found cauldron to claim all sold auctions -> clicking index ' + item.slot)
                        clickWindow(bot, item.slot).catch(err => log(`Error clicking claim all sold slot: ${err}`, 'error'))
                        clearTimeout(timeout)
                        bot.removeListener('windowOpen', windowHandler)
                        bot.state = null
                        resolve(true)
                        return
                    }
                    
                    // Look for sold items (items with "Sold for" in lore)
                    // Skip expired items - those are handled separately
                    const loreStr = item?.nbt?.value?.display?.value?.Lore ? JSON.stringify(item.nbt.value.display.value.Lore) : ''
                    if (loreStr.includes('Sold for') && !loreStr.includes('Expired!')) {
                        clickSlot = item.slot
                    }
                }

                if (!clickSlot) {
                    log('No sold auctions found')
                    clearTimeout(timeout)
                    bot.removeListener('windowOpen', windowHandler)
                    bot.state = null
                    bot.closeWindow(window)
                    resolve(false)
                    return
                }
                log('Clicking auction to claim, index: ' + clickSlot)
                log(JSON.stringify(window.slots[clickSlot]))

                clickWindow(bot, clickSlot).catch(err => log(`Error clicking sold auction slot: ${err}`, 'error'))
            }
            if (title == 'BIN Auction View') {
                log('Clicking slot 31, claiming purchased auction')
                clickWindow(bot, 31).catch(err => log(`Error claiming sold auction: ${err}`, 'error'))
                clearTimeout(timeout)
                bot.removeListener('windowOpen', windowHandler)
                bot.state = null
                bot.closeWindow(window)
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
