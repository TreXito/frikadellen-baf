import { MyBot, BazaarFlipRecommendation } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { getConfigProperty } from './configHelper'
import { areBazaarFlipsPaused } from './bazaarFlipPauser'

// Constants
const RETRY_DELAY_MS = 1100
const OPERATION_TIMEOUT_MS = 20000

/**
 * Parse bazaar flip data from JSON response (from websocket)
 * This handles the structured JSON data sent by the server via bzRecommend messages
 * 
 * The actual bzRecommend format from Coflnet:
 * { itemName: "Flawed Peridot Gemstone", itemTag: "FLAWED_PERIDOT_GEM", price: 3054.1, amount: 64, isSell: false }
 * Where 'price' is the TOTAL price for the order (not per unit)
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
        // 'price' from bzRecommend is the TOTAL price for the whole order
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
            // 'price' field is the TOTAL price (e.g., bzRecommend sends total)
            totalPrice = parseFloat(data.price)
            if (!totalPrice || isNaN(totalPrice)) {
                log('[BazaarDebug] ERROR: Missing or invalid price in bazaar flip JSON data', 'error')
                return null
            }
            pricePerUnit = totalPrice / amount
            log(`[BazaarDebug] Parsed total price from price field: ${totalPrice}`, 'info')
            log(`[BazaarDebug] Calculated price per unit: ${pricePerUnit.toFixed(1)} (${totalPrice} / ${amount})`, 'info')
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
 * 
 * This function:
 * 1. Waits if the bot is busy with another operation
 * 2. Opens the bazaar for the recommended item
 * 3. Places a buy/sell order at the recommended price and amount
 * 4. Confirms the order
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
        log('[BazaarDebug] Bazaar flips are paused due to incoming AH flip', 'warn')
        return
    }

    if (bot.state) {
        log(`[BazaarDebug] Bot is busy (state: ${bot.state}), will retry in ${RETRY_DELAY_MS}ms`, 'info')
        setTimeout(() => {
            handleBazaarFlipRecommendation(bot, recommendation)
        }, RETRY_DELAY_MS)
        return
    }

    log(`[BazaarDebug] ===== STARTING BAZAAR FLIP ORDER =====`, 'info')
    log(`[BazaarDebug] Item: ${recommendation.itemName}`, 'info')
    log(`[BazaarDebug] Amount: ${recommendation.amount}`, 'info')
    log(`[BazaarDebug] Price per unit: ${recommendation.pricePerUnit.toFixed(1)} coins`, 'info')
    log(`[BazaarDebug] Total price: ${recommendation.totalPrice ? recommendation.totalPrice.toFixed(1) : (recommendation.pricePerUnit * recommendation.amount).toFixed(1)} coins`, 'info')
    log(`[BazaarDebug] Order type: ${recommendation.isBuyOrder ? 'BUY' : 'SELL'}`, 'info')
    log(`[BazaarDebug] =====================================`, 'info')
    
    printMcChatToConsole(`§f[§4BAF§f]: §7━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    printMcChatToConsole(`§f[§4BAF§f]: §e${recommendation.isBuyOrder ? '📥 BUY' : '📤 SELL'} ORDER §7- §e${recommendation.itemName}`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Amount: §a${recommendation.amount}x`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Price/unit: §6${recommendation.pricePerUnit.toFixed(1)} coins`)
    printMcChatToConsole(`§f[§4BAF§f]: §7Total: §6${recommendation.totalPrice ? recommendation.totalPrice.toFixed(0) : (recommendation.pricePerUnit * recommendation.amount).toFixed(0)} coins`)
    printMcChatToConsole(`§f[§4BAF§f]: §7━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)

    bot.state = 'purchasing'
    let operationTimeout = setTimeout(() => {
        if (bot.state === 'purchasing') {
            log("[BazaarDebug] Resetting 'bot.state === purchasing' lock in bazaar flip (timeout)")
            bot.state = null
            bot.removeAllListeners('windowOpen')
        }
    }, OPERATION_TIMEOUT_MS)

    try {
        const { itemName, amount, pricePerUnit, totalPrice, isBuyOrder } = recommendation
        const displayTotalPrice = totalPrice ? totalPrice.toFixed(0) : (pricePerUnit * amount).toFixed(0)

        printMcChatToConsole(
            `§f[§4BAF§f]: §fPlacing ${isBuyOrder ? 'buy' : 'sell'} order for ${amount}x ${itemName} at ${pricePerUnit.toFixed(1)} coins each (total: ${displayTotalPrice})`
        )

        // Set up the listener BEFORE opening the bazaar to catch the first window
        // placeBazaarOrder() synchronously registers the windowOpen event listener,
        // then returns a Promise that resolves when the order completes
        log('[BazaarDebug] Setting up window listener for bazaar order placement', 'info')
        const orderPromise = placeBazaarOrder(bot, itemName, amount, pricePerUnit, isBuyOrder)
        
        // Small delay to ensure Node.js event loop has processed the listener registration
        // This guarantees the listener is active before the window opens
        await sleep(100)
        
        // Open bazaar for the item - the listener is now ready to catch this event
        log(`[BazaarDebug] Opening bazaar with command: /bz ${itemName}`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7[Command] Executing §b/bz ${itemName}`)
        bot.chat(`/bz ${itemName}`)

        await orderPromise
        
        log('[BazaarDebug] ===== BAZAAR FLIP ORDER COMPLETED =====', 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §aSuccessfully placed bazaar order!`)
    } catch (error) {
        log(`[BazaarDebug] Error handling bazaar flip: ${error}`, 'error')
        printMcChatToConsole(`§f[§4BAF§f]: §cFailed to place bazaar order: ${error}`)
    } finally {
        clearTimeout(operationTimeout)
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
            
            // Log up to 15 important slots to avoid spam
            const slotsToLog = importantSlots.slice(0, 15)
            slotsToLog.forEach(({ slot, name }) => {
                log(`[BazaarDebug]   Slot ${slot}: ${name}`, 'info')
            })
            
            if (importantSlots.length > 15) {
                log(`[BazaarDebug]   ... and ${importantSlots.length - 15} more slots`, 'info')
            }
            
            log(`[BazaarDebug] === End Window Slots (${importantSlots.length} items) ===`, 'info')
        }
        
        const windowListener = async (window) => {
            await sleep(300)
            let title = getWindowTitle(window)
            log(`[BazaarDebug] Window opened: "${title}" at step: ${currentStep}`, 'info')
            
            // Log all slots in this window for debugging
            logWindowSlots(window, title)

            try {
                // Handle bazaar pages (search results or item detail)
                if (title.includes('Bazaar') && currentStep !== 'selectOrderType') {
                    // Check if this is the item detail page by looking for order creation buttons
                    let hasOrderButton = findSlotWithName(window, 'Create Buy Order') !== -1 ||
                                         findSlotWithName(window, 'Create Sell Offer') !== -1
                    
                    if (hasOrderButton) {
                        // Item detail page - click Create Buy Order (slot 15) or Create Sell Offer (slot 16)
                        const buttonName = isBuyOrder ? 'Create Buy Order' : 'Create Sell Offer'
                        const slotToClick = isBuyOrder ? 15 : 16
                        log(`[BazaarDebug] On item detail page, clicking "${buttonName}" (slot ${slotToClick})`, 'info')
                        printMcChatToConsole(`§f[§4BAF§f]: §7[Action] Clicking §e${buttonName}§7 at slot §b${slotToClick}`)
                        currentStep = 'selectOrderType'
                        await sleep(200)
                        await clickWindow(bot, slotToClick)
                    } else if (currentStep === 'initial') {
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
                        await clickWindow(bot, itemSlot)
                    }
                }
                // Amount screen - detected by "Custom Amount" slot (buy orders only, sell offers skip this)
                else if (findSlotWithName(window, 'Custom Amount') !== -1) {
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
                    await clickWindow(bot, customAmountSlot)
                }
                // Price screen - detected by "Custom Price" slot (works for both buy and sell)
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
                    await clickWindow(bot, customPriceSlot)
                }
                // Confirm screen - detected by title or confirm button presence after price step
                else if (title.includes('Confirm') ||
                         (currentStep === 'setPrice' &&
                          findSlotWithName(window, 'Cancel') !== -1)) {
                    log(`[BazaarDebug] Confirming bazaar ${isBuyOrder ? 'buy' : 'sell'} order at slot 13`, 'info')
                    printMcChatToConsole(`§f[§4BAF§f]: §7[Confirm] Placing ${isBuyOrder ? 'buy' : 'sell'} order at slot §b13`)
                    currentStep = 'confirm'
                    
                    // Click the confirm button (slot 13)
                    await sleep(200)
                    await clickWindow(bot, 13)
                    
                    // Order placed successfully
                    log(`[BazaarDebug] Order placement complete, cleaning up listener`, 'info')
                    bot.removeListener('windowOpen', windowListener)
                    await sleep(500)
                    resolve()
                }
            } catch (error) {
                log(`[BazaarDebug] Error in window handler at step ${currentStep}: ${error}`, 'error')
                printMcChatToConsole(`§f[§4BAF§f]: §c[Error] Failed at step ${currentStep}: ${error}`)
                bot.removeListener('windowOpen', windowListener)
                reject(error)
            }
        }

        bot.addListener('windowOpen', windowListener)

        // Set a timeout for the entire operation
        setTimeout(() => {
            bot.removeListener('windowOpen', windowListener)
            reject(new Error(`Bazaar order placement timed out at step: ${currentStep}`))
        }, 20000)
    })
}

