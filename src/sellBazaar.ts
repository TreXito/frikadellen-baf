import { MyBot } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { enqueueCommand, CommandPriority } from './commandQueue'

// Constants
const OPERATION_TIMEOUT_MS = 20000
const ITEM_SELL_DELAY_MS = 500
const MINEFLAYER_WINDOW_PROCESS_DELAY_MS = 300
const MAX_CLAIM_ATTEMPTS = 3
const CLAIM_DELAY_MS = 300
const BAZAAR_FIRST_RESULT_SLOT = 11

// Sign text format constants (for custom price entry)
const SIGN_TEXT_LINE2 = '{"italic":false,"extra":["^^^^^^^^^^^^^^^"],"text":""}'
const SIGN_TEXT_LINE3 = '{"italic":false,"extra":[""],"text":""}'
const SIGN_TEXT_LINE4 = '{"italic":false,"extra":[""],"text":""}'

/**
 * Represents a bazaar item to sell
 */
interface BazaarItemToSell {
    itemTag: string          // Internal ID like "ENCHANTED_ROTTEN_FLESH"
    displayName: string      // Display name like "Enchanted Rotten Flesh"
    amount: number          // Total count
    pricePerUnit: number    // Calculated sell price
    totalValue: number      // amount * pricePerUnit
}

/**
 * Bazaar snapshot from Coflnet API
 */
interface BazaarSnapshot {
    sellPrice: number
    buyPrice: number
    sellOrders: Array<{ amount: number; pricePerUnit: number; orders: number }>
    buyOrders: Array<{ amount: number; pricePerUnit: number; orders: number }>
}

/**
 * Execute the sell bazaar command
 * This scans inventory, fetches prices, claims orders, and creates sell offers
 */
export async function executeSellBazaar(bot: MyBot): Promise<void> {
    // Check bot state
    if (bot.state) {
        printMcChatToConsole(`§f[§4BAF§f]: §c[SellBZ] Bot is busy (${bot.state}), try again later`)
        log(`[SellBZ] Bot is busy (state: ${bot.state}), cannot execute`, 'warn')
        return
    }

    log('[SellBZ] Starting sell bazaar command', 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §e[SellBZ] Starting bazaar sell process...`)

    bot.state = 'sellbz'
    
    try {
        // Step 1: Scan inventory for bazaar items
        printMcChatToConsole(`§f[§4BAF§f]: §7[SellBZ] Scanning inventory...`)
        const items = scanInventoryForBazaarItems(bot)
        
        if (items.length === 0) {
            printMcChatToConsole(`§f[§4BAF§f]: §c[SellBZ] No bazaar items found in inventory`)
            log('[SellBZ] No bazaar items found', 'info')
            return
        }

        log(`[SellBZ] Found ${items.length} unique bazaar item types`, 'info')

        // Step 2: Fetch prices from Coflnet API
        printMcChatToConsole(`§f[§4BAF§f]: §7[SellBZ] Fetching prices from Coflnet API...`)
        const itemsWithPrices = await fetchPricesForItems(items)

        if (itemsWithPrices.length === 0) {
            printMcChatToConsole(`§f[§4BAF§f]: §c[SellBZ] No valid items with prices found`)
            log('[SellBZ] No valid items with prices', 'info')
            return
        }

        // Log summary before starting
        printMcChatToConsole(`§f[§4BAF§f]: §a[SellBZ] Found ${itemsWithPrices.length} bazaar items to sell:`)
        let totalEstimatedValue = 0
        for (const item of itemsWithPrices) {
            printMcChatToConsole(
                `§f[§4BAF§f]: §7  - §e${item.amount}x ${item.displayName} §7@ §6${item.pricePerUnit.toFixed(1)}§7 coins each (total: §6${item.totalValue.toFixed(1)}§7)`
            )
            totalEstimatedValue += item.totalValue
        }
        printMcChatToConsole(`§f[§4BAF§f]: §7[SellBZ] Starting sell process...`)

        // Step 3: Claim outstanding orders first
        printMcChatToConsole(`§f[§4BAF§f]: §7[SellBZ] Claiming outstanding orders...`)
        await claimOutstandingOrders(bot)

        // Step 4: Create sell offers for each item
        let successCount = 0
        for (let i = 0; i < itemsWithPrices.length; i++) {
            const item = itemsWithPrices[i]
            printMcChatToConsole(
                `§f[§4BAF§f]: §7[SellBZ] [${i + 1}/${itemsWithPrices.length}] Selling §e${item.displayName}§7...`
            )
            
            try {
                await createSellOffer(bot, item)
                successCount++
                
                // Wait between items to avoid rate limits
                if (i < itemsWithPrices.length - 1) {
                    await sleep(ITEM_SELL_DELAY_MS)
                }
            } catch (error) {
                log(`[SellBZ] Failed to sell ${item.displayName}: ${error}`, 'error')
                printMcChatToConsole(`§f[§4BAF§f]: §c[SellBZ] Failed to sell ${item.displayName}: ${error}`)
                // Continue to next item
            }
        }

        // Final summary
        printMcChatToConsole(`§f[§4BAF§f]: §a[SellBZ] Placed ${successCount} sell offers. Total estimated value: §6${totalEstimatedValue.toFixed(1)}§a coins`)
        log(`[SellBZ] Completed: ${successCount}/${itemsWithPrices.length} offers placed`, 'info')

    } catch (error) {
        log(`[SellBZ] Error during sell bazaar: ${error}`, 'error')
        printMcChatToConsole(`§f[§4BAF§f]: §c[SellBZ] Error: ${error}`)
    } finally {
        bot.state = null
    }
}

/**
 * Scan inventory for items with SkyBlock IDs (bazaar items)
 */
function scanInventoryForBazaarItems(bot: MyBot): Array<{ itemTag: string; displayName: string; amount: number }> {
    const items = bot.inventory.items()
    const itemMap = new Map<string, { displayName: string; amount: number }>()

    for (const item of items) {
        if (!item || !item.nbt) continue

        // Extract SkyBlock ID from ExtraAttributes
        const itemTag = (item.nbt as any)?.value?.ExtraAttributes?.value?.id?.value
        if (!itemTag) continue // Skip non-SkyBlock items

        // Extract display name
        let displayName = (item.nbt as any)?.value?.display?.value?.Name?.value
        if (displayName) {
            displayName = removeMinecraftColorCodes(displayName)
        } else {
            displayName = itemTag // Fallback to item tag
        }

        // Group by item tag and sum amounts
        const existing = itemMap.get(itemTag)
        if (existing) {
            existing.amount += item.count
        } else {
            itemMap.set(itemTag, { displayName, amount: item.count })
        }
    }

    // Convert map to array
    const result: Array<{ itemTag: string; displayName: string; amount: number }> = []
    for (const [itemTag, data] of itemMap.entries()) {
        result.push({
            itemTag,
            displayName: data.displayName,
            amount: data.amount
        })
        log(`[SellBZ] Found: ${data.amount}x ${data.displayName} (${itemTag})`, 'debug')
    }

    return result
}

/**
 * Fetch prices from Coflnet API for all items
 */
async function fetchPricesForItems(
    items: Array<{ itemTag: string; displayName: string; amount: number }>
): Promise<BazaarItemToSell[]> {
    // Fetch all prices concurrently
    const pricePromises = items.map(async item => {
        try {
            const response = await fetch(`https://sky.coflnet.com/api/bazaar/${item.itemTag}/snapshot`)
            if (!response.ok) {
                log(`[SellBZ] API error for ${item.itemTag}: ${response.status} ${response.statusText}`, 'warn')
                return null
            }

            const data = await response.json() as BazaarSnapshot
            
            // Calculate sell price: undercut current lowest sell offer by 0.1
            let pricePerUnit = data.sellPrice > 0 ? data.sellPrice - 0.1 : data.buyPrice
            
            // If both are 0, skip this item
            if (pricePerUnit <= 0) {
                log(`[SellBZ] No valid price for ${item.itemTag}, skipping`, 'warn')
                return null
            }

            const totalValue = pricePerUnit * item.amount

            log(
                `[SellBZ] ${item.displayName}: sellPrice=${data.sellPrice}, buyPrice=${data.buyPrice}, calculated=${pricePerUnit.toFixed(1)}`,
                'debug'
            )

            return {
                itemTag: item.itemTag,
                displayName: item.displayName,
                amount: item.amount,
                pricePerUnit,
                totalValue
            } as BazaarItemToSell
        } catch (error) {
            log(`[SellBZ] Failed to fetch price for ${item.itemTag}: ${error}`, 'error')
            return null
        }
    })

    const results = await Promise.all(pricePromises)
    return results.filter(item => item !== null) as BazaarItemToSell[]
}

/**
 * Claim all outstanding orders/offers from Manage Orders
 */
async function claimOutstandingOrders(bot: MyBot): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let currentStep = 'initial'
        let hasClaimedAnything = false

        const timeout = setTimeout(() => {
            log('[SellBZ] Claim timeout', 'warn')
            bot._client.removeListener('open_window', windowListener)
            resolve() // Don't fail, just continue
        }, OPERATION_TIMEOUT_MS)

        const windowListener = async (packet) => {
            await sleep(MINEFLAYER_WINDOW_PROCESS_DELAY_MS)

            const window = bot.currentWindow
            if (!window) return

            const title = getWindowTitle(window)
            log(`[SellBZ] Claim window: ${title}, step: ${currentStep}`, 'debug')

            try {
                // Step 1: Click Manage Orders button
                if (title.includes('Bazaar') && currentStep === 'initial') {
                    currentStep = 'clickManageOrders'
                    const manageOrdersSlot = findSlotWithName(window, 'Manage Orders')
                    if (manageOrdersSlot === -1) {
                        log('[SellBZ] Manage Orders button not found', 'warn')
                        bot._client.removeListener('open_window', windowListener)
                        clearTimeout(timeout)
                        resolve()
                        return
                    }
                    log('[SellBZ] Clicking Manage Orders', 'debug')
                    await sleep(200)
                    await clickWindow(bot, manageOrdersSlot).catch(() => {})
                    return
                }

                // Step 2: In Manage Orders, look for claimable items
                if (currentStep === 'clickManageOrders') {
                    currentStep = 'claimItems'
                    
                    // Find all claimable slots (items with "BUY" or "SELL" in name)
                    const claimableSlots: number[] = []
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        if (!slot) continue

                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )

                        if (name && (name.startsWith('BUY ') || name.startsWith('SELL '))) {
                            // Check if it has claimable items by looking at the lore
                            const lore = (slot?.nbt as any)?.value?.display?.value?.Lore?.value?.value
                            if (lore) {
                                const loreText = lore
                                    .map((line: any) => removeMinecraftColorCodes(line.toString()))
                                    .join('\n')
                                
                                // If lore contains "Filled", it's claimable
                                if (loreText.includes('Filled') || loreText.includes('filled')) {
                                    claimableSlots.push(i)
                                }
                            }
                        }
                    }

                    if (claimableSlots.length === 0) {
                        log('[SellBZ] No claimable orders found', 'info')
                        bot._client.removeListener('open_window', windowListener)
                        clearTimeout(timeout)
                        resolve()
                        return
                    }

                    log(`[SellBZ] Found ${claimableSlots.length} claimable orders, claiming...`, 'info')
                    
                    // Claim each slot (click multiple times)
                    for (const slot of claimableSlots) {
                        for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
                            await sleep(CLAIM_DELAY_MS)
                            await clickWindow(bot, slot).catch(() => {})
                        }
                        hasClaimedAnything = true
                    }

                    // Done claiming
                    log('[SellBZ] Finished claiming orders', 'info')
                    bot._client.removeListener('open_window', windowListener)
                    clearTimeout(timeout)
                    resolve()
                }
            } catch (error) {
                log(`[SellBZ] Error in claim window handler: ${error}`, 'error')
                bot._client.removeListener('open_window', windowListener)
                clearTimeout(timeout)
                resolve() // Don't fail, just continue
            }
        }

        bot._client.on('open_window', windowListener)
        bot.chat('/bz')
    })
}

/**
 * Create a sell offer for a single item
 */
async function createSellOffer(bot: MyBot, item: BazaarItemToSell): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let currentStep = 'initial'

        const timeout = setTimeout(() => {
            bot._client.removeListener('open_window', windowListener)
            reject(new Error(`Timeout at step: ${currentStep}`))
        }, OPERATION_TIMEOUT_MS)

        const windowListener = async (packet) => {
            await sleep(MINEFLAYER_WINDOW_PROCESS_DELAY_MS)

            const window = bot.currentWindow
            if (!window) return

            const title = getWindowTitle(window)
            log(`[SellBZ] Sell window: ${title}, step: ${currentStep}`, 'debug')

            try {
                // Check if we're on the item detail page (has "Create Sell Offer" button)
                const hasSellOfferButton = findSlotWithName(window, 'Create Sell Offer') !== -1

                if (hasSellOfferButton && currentStep !== 'clickSellOffer') {
                    currentStep = 'clickSellOffer'
                    const sellOfferSlot = findSlotWithName(window, 'Create Sell Offer')
                    log(`[SellBZ] Clicking Create Sell Offer (slot ${sellOfferSlot})`, 'debug')
                    await sleep(200)
                    await clickWindow(bot, sellOfferSlot).catch(() => {})
                    return
                }

                // Search results page
                if (title.includes('Bazaar') && currentStep === 'initial') {
                    currentStep = 'searchResults'
                    
                    // Find the item in search results
                    let itemSlot = -1
                    for (let i = 0; i < window.slots.length; i++) {
                        const slot = window.slots[i]
                        const name = removeMinecraftColorCodes(
                            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                        )
                        if (name && name.toLowerCase().includes(item.displayName.toLowerCase())) {
                            itemSlot = i
                            break
                        }
                    }

                    if (itemSlot === -1) {
                        itemSlot = BAZAAR_FIRST_RESULT_SLOT // Fallback to first result slot
                    }

                    log(`[SellBZ] Clicking item at slot ${itemSlot}`, 'debug')
                    await sleep(200)
                    await clickWindow(bot, itemSlot).catch(() => {})
                    return
                }

                // Price selection page (no amount page for sell offers)
                if (findSlotWithName(window, 'Custom Price') !== -1) {
                    currentStep = 'setPrice'
                    const customPriceSlot = findSlotWithName(window, 'Custom Price')
                    log(`[SellBZ] Setting price to ${item.pricePerUnit.toFixed(1)}`, 'debug')

                    // Register sign handler BEFORE clicking
                    bot._client.once('open_sign_entity', ({ location }) => {
                        log(`[SellBZ] Sign opened, writing price: ${item.pricePerUnit.toFixed(1)}`, 'debug')
                        bot._client.write('update_sign', {
                            location: { x: location.x, y: location.y, z: location.z },
                            text1: `"${item.pricePerUnit.toFixed(1)}"`,
                            text2: SIGN_TEXT_LINE2,
                            text3: SIGN_TEXT_LINE3,
                            text4: SIGN_TEXT_LINE4
                        })
                    })

                    await sleep(200)
                    await clickWindow(bot, customPriceSlot).catch(() => {})
                    return
                }

                // Confirmation page
                if (currentStep === 'setPrice') {
                    currentStep = 'confirm'
                    log('[SellBZ] Confirming sell offer at slot 13', 'debug')
                    await sleep(200)
                    await clickWindow(bot, 13).catch(() => {})
                    
                    bot._client.removeListener('open_window', windowListener)
                    clearTimeout(timeout)
                    await sleep(500)
                    resolve()
                }
            } catch (error) {
                log(`[SellBZ] Error in sell window handler: ${error}`, 'error')
                bot._client.removeListener('open_window', windowListener)
                clearTimeout(timeout)
                reject(error)
            }
        }

        bot._client.on('open_window', windowListener)

        // Open bazaar for this item
        log(`[SellBZ] Opening bazaar with: /bz ${item.displayName}`, 'debug')
        bot.chat(`/bz ${item.displayName}`)
    })
}

/**
 * Helper: Find a slot by display name substring
 */
function findSlotWithName(window: any, searchName: string): number {
    for (let i = 0; i < window.slots.length; i++) {
        const slot = window.slots[i]
        if (!slot) continue

        const name = removeMinecraftColorCodes(
            (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
        )
        // Strip special characters like ☘ for matching
        const cleanName = name.replace(/[☘]/g, '').trim()
        const cleanSearch = searchName.replace(/[☘]/g, '').trim()
        
        if (cleanName && cleanName.includes(cleanSearch)) {
            return i
        }
    }
    return -1
}

/**
 * Handle the /baf sellbz command
 */
export function handleSellBazaarCommand(bot: MyBot): void {
    // Check if bot is busy
    if (bot.state) {
        printMcChatToConsole(`§f[§4BAF§f]: §c[SellBZ] Bot is busy (${bot.state}), try again later`)
        log(`[SellBZ] Bot is busy (state: ${bot.state})`, 'warn')
        return
    }

    // Enqueue the command with NORMAL priority and mark as interruptible
    enqueueCommand(
        'Sell Bazaar Items',
        CommandPriority.NORMAL,
        async () => {
            await executeSellBazaar(bot)
        },
        true // interruptible - can be interrupted by AH flips
    )

    printMcChatToConsole(`§f[§4BAF§f]: §7[SellBZ] Command queued`)
    log('[SellBZ] Sell bazaar command queued', 'info')
}
