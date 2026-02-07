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
        let itemName: string
        let amount: number
        let pricePerUnit: number
        let totalPrice: number | undefined
        let isBuyOrder: boolean

        // Try to extract item name (could be 'itemName', 'item', or 'name')
        itemName = data.itemName || data.item || data.name
        if (!itemName) {
            log('Missing item name in bazaar flip JSON data', 'error')
            return null
        }

        // Try to extract amount (could be 'amount', 'count', 'quantity')
        amount = parseInt(data.amount || data.count || data.quantity)
        if (!amount || isNaN(amount)) {
            log('Missing or invalid amount in bazaar flip JSON data', 'error')
            return null
        }

        // Extract price - handle different field names and meanings
        // 'pricePerUnit' / 'unitPrice' are per-unit prices
        // 'price' from bzRecommend is the TOTAL price for the whole order
        if (data.pricePerUnit || data.unitPrice) {
            pricePerUnit = parseFloat(data.pricePerUnit || data.unitPrice)
            if (!pricePerUnit || isNaN(pricePerUnit)) {
                log('Missing or invalid price in bazaar flip JSON data', 'error')
                return null
            }
            totalPrice = data.totalPrice ? parseFloat(data.totalPrice) : pricePerUnit * amount
        } else if (data.price) {
            // 'price' field is the TOTAL price (e.g., bzRecommend sends total)
            totalPrice = parseFloat(data.price)
            if (!totalPrice || isNaN(totalPrice)) {
                log('Missing or invalid price in bazaar flip JSON data', 'error')
                return null
            }
            pricePerUnit = totalPrice / amount
        } else {
            log('Missing price in bazaar flip JSON data', 'error')
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

        return {
            itemName,
            itemTag: data.itemTag || undefined,
            amount,
            pricePerUnit,
            totalPrice,
            isBuyOrder
        }
    } catch (error) {
        log(`Error parsing bazaar flip JSON data: ${error}`, 'error')
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
        log('Bazaar flips are disabled in config', 'debug')
        return
    }

    // Check if bazaar flips are paused due to incoming AH flip
    if (areBazaarFlipsPaused()) {
        log('Bazaar flips are paused due to incoming AH flip', 'debug')
        return
    }

    if (bot.state) {
        setTimeout(() => {
            handleBazaarFlipRecommendation(bot, recommendation)
        }, RETRY_DELAY_MS)
        return
    }

    bot.state = 'purchasing'
    let operationTimeout = setTimeout(() => {
        if (bot.state === 'purchasing') {
            log("Resetting 'bot.state === purchasing' lock in bazaar flip")
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
        const orderPromise = placeBazaarOrder(bot, itemName, amount, pricePerUnit, isBuyOrder)
        
        // Small delay to ensure Node.js event loop has processed the listener registration
        // This guarantees the listener is active before the window opens
        await sleep(100)
        
        // Open bazaar for the item - the listener is now ready to catch this event
        bot.chat(`/bz ${itemName}`)

        await orderPromise
        
        printMcChatToConsole(`§f[§4BAF§f]: §aSuccessfully placed bazaar order!`)
    } catch (error) {
        log(`Error handling bazaar flip: ${error}`, 'error')
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
        
        const windowListener = async (window) => {
            await sleep(300)
            let title = getWindowTitle(window)
            log(`Bazaar window opened: ${title}, current step: ${currentStep}`, 'debug')

            try {
                // Handle bazaar pages (search results or item detail)
                if (title.includes('Bazaar') && currentStep !== 'selectOrderType') {
                    // Check if this is the item detail page by looking for order creation buttons
                    let hasOrderButton = findSlotWithName(window, 'Create Buy Order') !== -1 ||
                                         findSlotWithName(window, 'Create Sell Offer') !== -1
                    
                    if (hasOrderButton) {
                        // Item detail page - click Create Buy Order (slot 15) or Create Sell Offer (slot 16)
                        log(`On item detail page, clicking ${isBuyOrder ? 'Create Buy Order (slot 15)' : 'Create Sell Offer (slot 16)'}`, 'debug')
                        currentStep = 'selectOrderType'
                        const slotToClick = isBuyOrder ? 15 : 16
                        await sleep(200)
                        await clickWindow(bot, slotToClick)
                    } else if (currentStep === 'initial') {
                        // Search results page - find and click the matching item
                        log('On search results page, looking for item', 'debug')
                        currentStep = 'searchResults'
                        
                        let itemSlot = -1
                        for (let i = 0; i < window.slots.length; i++) {
                            const slot = window.slots[i]
                            const name = removeMinecraftColorCodes(
                                (slot?.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
                            )
                            if (name && name.toLowerCase().includes(itemName.toLowerCase())) {
                                itemSlot = i
                                break
                            }
                        }
                        
                        if (itemSlot !== -1) {
                            log(`Found item at slot ${itemSlot}`, 'debug')
                        } else {
                            // Fallback to slot 11 (first search result position)
                            itemSlot = 11
                            log(`Item not found by name, using fallback slot ${itemSlot}`, 'debug')
                        }
                        await sleep(200)
                        await clickWindow(bot, itemSlot)
                    }
                }
                // Amount screen - detected by "Custom Amount" slot (buy orders only, sell offers skip this)
                else if (findSlotWithName(window, 'Custom Amount') !== -1) {
                    const customAmountSlot = findSlotWithName(window, 'Custom Amount')
                    log(`Setting amount to ${amount}`, 'debug')
                    currentStep = 'setAmount'
                    
                    // Register sign handler BEFORE clicking to avoid race condition
                    bot._client.once('open_sign_entity', ({ location }) => {
                        log(`Sign opened for amount, writing: ${amount}`, 'debug')
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
                    log(`Setting price per unit to ${pricePerUnit}`, 'debug')
                    currentStep = 'setPrice'
                    
                    // Register sign handler BEFORE clicking to avoid race condition
                    bot._client.once('open_sign_entity', ({ location }) => {
                        log(`Sign opened for price, writing: ${pricePerUnit.toFixed(1)}`, 'debug')
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
                    log('Confirming bazaar order', 'debug')
                    currentStep = 'confirm'
                    
                    // Click the confirm button (slot 13)
                    await sleep(200)
                    await clickWindow(bot, 13)
                    
                    // Order placed successfully
                    bot.removeListener('windowOpen', windowListener)
                    await sleep(500)
                    resolve()
                }
            } catch (error) {
                log(`Error in placeBazaarOrder window handler at step ${currentStep}: ${error}`, 'error')
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

