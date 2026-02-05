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
 * This handles the structured JSON data sent by the server when using `/cofl getbazaarflips`
 * 
 * Expected JSON format examples:
 * - { itemName: "Cindershade", amount: 4, pricePerUnit: 265000, totalPrice: 1060000, isBuyOrder: true }
 * - { item: "Cindershade", count: 4, price: 265000, type: "buy" }
 * 
 * @param data The JSON data from the websocket
 * @returns Parsed recommendation or null if data is invalid
 */
export function parseBazaarFlipJson(data: any): BazaarFlipRecommendation | null {
    try {
        // Handle different possible JSON formats from the server
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

        // Try to extract price per unit (could be 'pricePerUnit', 'price', 'unitPrice')
        pricePerUnit = parseFloat(data.pricePerUnit || data.price || data.unitPrice)
        if (!pricePerUnit || isNaN(pricePerUnit)) {
            log('Missing or invalid price in bazaar flip JSON data', 'error')
            return null
        }

        // Total price might be provided or calculated
        if (data.totalPrice) {
            totalPrice = parseFloat(data.totalPrice)
        } else {
            totalPrice = pricePerUnit * amount
        }

        // Determine if it's a buy or sell order
        // Check 'isBuyOrder', 'type', or 'orderType' fields
        if (typeof data.isBuyOrder === 'boolean') {
            isBuyOrder = data.isBuyOrder
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
        const orderPromise = placeBazaarOrder(bot, amount, pricePerUnit, isBuyOrder)
        
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
 * 1. Main bazaar view for the item (title: "Bazaar ➜ ItemName")
 * 2. Amount selection (title: "How many do you want to...")
 * 3. Price selection (title: "How much do you want to pay/be paid")
 * 4. Confirmation (title: "Confirm...")
 * 
 * @param bot The Minecraft bot instance
 * @param amount Number of items to buy/sell
 * @param pricePerUnit Price per item unit
 * @param isBuyOrder True for buy order, false for sell offer
 * @returns Promise that resolves when the order is placed
 */
function placeBazaarOrder(bot: MyBot, amount: number, pricePerUnit: number, isBuyOrder: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let currentStep = 'initial'
        
        const windowListener = async (window) => {
            await sleep(300)
            let title = getWindowTitle(window)
            log(`Bazaar window opened: ${title}, current step: ${currentStep}`, 'debug')

            try {
                // Step 1: In the main bazaar item view
                if (title.includes('Bazaar ➜')) {
                    log(`Opening ${isBuyOrder ? 'buy' : 'sell'} order interface`, 'debug')
                    currentStep = 'selectOrderType'
                    
                    // Click on Create Buy Order (slot 19) or Create Sell Offer (slot 20)
                    const slotToClick = isBuyOrder ? 19 : 20
                    await sleep(200)
                    await clickWindow(bot, slotToClick)
                }
                // Step 2: Setting the amount
                else if (title.includes('How many do you want to')) {
                    log(`Setting amount to ${amount}`, 'debug')
                    currentStep = 'setAmount'
                    
                    // Click to set custom amount (typically slot 13)
                    await sleep(200)
                    await clickWindow(bot, 13)
                    
                    // Type the amount in chat
                    await sleep(300)
                    bot.chat(amount.toString())
                }
                // Step 3: Setting the price
                else if (title.includes('How much do you want to pay') || title.includes('How much do you want to be paid')) {
                    log(`Setting price per unit to ${pricePerUnit}`, 'debug')
                    currentStep = 'setPrice'
                    
                    // Click to set custom price (typically slot 13)
                    await sleep(200)
                    await clickWindow(bot, 13)
                    
                    // Type the price in chat
                    await sleep(300)
                    bot.chat(pricePerUnit.toFixed(1))
                }
                // Step 4: Confirming the order
                else if (title.includes('Confirm')) {
                    log('Confirming bazaar order', 'debug')
                    currentStep = 'confirm'
                    
                    // Click the confirm button (typically slot 11)
                    await sleep(200)
                    await clickWindow(bot, 11)
                    
                    // Order placed successfully
                    bot.removeAllListeners('windowOpen')
                    await sleep(500)
                    resolve()
                }
            } catch (error) {
                log(`Error in placeBazaarOrder window handler at step ${currentStep}: ${error}`, 'error')
                bot.removeAllListeners('windowOpen')
                reject(error)
            }
        }

        bot.addListener('windowOpen', windowListener)

        // Set a timeout for the entire operation
        setTimeout(() => {
            bot.removeAllListeners('windowOpen')
            reject(new Error(`Bazaar order placement timed out at step: ${currentStep}`))
        }, 20000)
    })
}

