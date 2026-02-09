import { Flip, FlipWhitelistedData, MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, isSkin, numberWithThousandsSeparators, removeMinecraftColorCodes, sleep } from './utils'
import { trackFlipPurchase } from './flipTracker'

// Constants for window interaction
const CONFIRM_RETRY_DELAY = 100
const WINDOW_CONFIRM_TIMEOUT_MS = 5000 // Maximum time to wait for confirm window to close
const BED_SPAM_MAX_FAILED_CLICKS = 5 // Max failed clicks before stopping bed spam
const WINDOW_INTERACTION_DELAY = 500
const MINEFLAYER_WINDOW_POPULATE_DELAY = 300 // Time for mineflayer to populate bot.currentWindow after open_window packet

// Window title constants
const WINDOW_TITLE_CONFIRM_PURCHASE = '{"italic":false,"extra":[{"text":"Confirm Purchase"}],"text":""}'
const WINDOW_TITLE_BIN_AUCTION_VIEW = '{"italic":false,"extra":[{"text":"BIN Auction View"}],"text":""}'

let currentFlip: Flip | null = null
let actionCounter = 1
let fromCoflSocket = false
let purchaseStartTime: number | null = null // Track when BIN Auction View opens for timing

/**
 * Waits for an item to load in a slot - TPM+ pattern
 * @param bot The bot instance
 * @param slotIndex The slot number to check
 * @param checkName Whether to check if item is potato and return null
 * @returns The item in the slot or null if not found/potato
 */
async function itemLoad(bot: MyBot, slotIndex: number, checkName: boolean = false): Promise<any> {
    try {
        // Wait for slot to populate with polling
        let attempts = 0
        const maxAttempts = 50 // ~50ms timeout total (50 attempts × 1ms) for fast purchasing
        
        while (attempts < maxAttempts) {
            const item = bot.currentWindow?.slots[slotIndex]
            if (item && item.name) {
                // Check if we should skip potato items
                if (checkName && item.name === "potato") {
                    log("Skipping potato item...", 'debug')
                    return null
                }
                
                log(`Loaded item: ${item.name}`, 'debug')
                return item
            }
            
            // Wait 1ms between checks
            await sleep(1)
            attempts++
        }
        
        // Item not found after timeout
        throw new Error("Item not found.")
    } catch (error) {
        log(`Error loading item: ${error}`, 'error')
        return null
    }
}

/**
 * Sends a confirmClick packet for faster window confirmation
 */
function confirmClick(bot: MyBot, windowId: number) {
    bot._client.write('transaction', {
        windowId: windowId,
        action: actionCounter,
        accepted: true
    })
    actionCounter++
}

/**
 * Clicks a slot using low-level packets for faster response
 * Mouse button 2 = middle click, mode 3 = special inventory interaction
 */
function clickSlot(bot: MyBot, slot: number, windowId: number, itemId: number) {
    bot._client.write('window_click', {
        windowId: windowId,
        slot: slot,
        mouseButton: 2, // Middle click
        mode: 3, // Special inventory interaction mode
        item: { "blockId": itemId },
        action: actionCounter
    })
    actionCounter++
}



export async function flipHandler(bot: MyBot, flip: Flip) {
    // Check if AH flips are enabled in config
    if (!getConfigProperty('ENABLE_AH_FLIPS')) {
        log('AH flips are disabled in config', 'debug')
        return
    }

    flip.purchaseAt = new Date(flip.purchaseAt)
    currentFlip = flip // Store current flip for tracking

    if (bot.state) {
        setTimeout(() => {
            flipHandler(bot, flip)
        }, 1100)
        return
    }
    
    // Note: Do NOT use bot.removeAllListeners('windowOpen') as it breaks mineflayer's internal handler
    // The flipHandler uses bot._client.on('open_window') for low-level protocol handling
    // and properly cleans up its specific listener when done
    
    bot.state = 'purchasing'
    let timeout = setTimeout(() => {
        if (bot.state === 'purchasing') {
            log("Resetting 'bot.state === purchasing' lock")
            bot.state = null
            if ((bot as any)._bafOpenWindowHandler) {
                bot._client.removeListener('open_window', (bot as any)._bafOpenWindowHandler)
                ;(bot as any)._bafOpenWindowHandler = null
            }
        }
    }, 10000)
    let isBed = flip.purchaseAt.getTime() > new Date().getTime()

    bot.lastViewAuctionCommandForPurchase = `/viewauction ${flip.id}`
    bot.chat(bot.lastViewAuctionCommandForPurchase)

    printMcChatToConsole(
        `§f[§4BAF§f]: §fTrying to purchase flip${isBed ? ' (Bed)' : ''}: ${flip.itemName} §for ${numberWithThousandsSeparators(
            flip.startingBid
        )} coins (Target: ${numberWithThousandsSeparators(flip.target)})`
    )

    // Store flip data for access in open_window handler
    fromCoflSocket = true
    
    await useRegularPurchase(bot, flip, isBed)
    clearTimeout(timeout)
}

function useRegularPurchase(bot: MyBot, flip: Flip, isBed: boolean) {
    return new Promise<void>((resolve, reject) => {
        let firstGui: number
        let handledBinAuction = false
        
        // Remove only our previous handler to prevent stacking (not mineflayer's internal handlers)
        if ((bot as any)._bafOpenWindowHandler) {
            bot._client.removeListener('open_window', (bot as any)._bafOpenWindowHandler)
        }
        
        const openWindowHandler = async (window) => {
            try {
                const windowID = window.windowId
                const windowName = window.windowTitle
                log(`Got new window ${windowName}, windowId: ${windowID}, fromCoflSocket: ${fromCoflSocket}`, 'debug')
                
                // Wait for mineflayer to populate bot.currentWindow
                await sleep(MINEFLAYER_WINDOW_POPULATE_DELAY)
                if (!bot.currentWindow) {
                    log(`bot.currentWindow is null after delay for window ${windowName} (ID: ${windowID}), skipping`, 'warn')
                    return
                }
                
                if (windowName === WINDOW_TITLE_BIN_AUCTION_VIEW) {
                    // Skip if we already handled this window type
                    if (handledBinAuction) {
                        log('Already handled BIN Auction View, ignoring duplicate', 'debug')
                        return
                    }
                    handledBinAuction = true
                    
                    // Send confirm click packet for faster response
                    confirmClick(bot, windowID)
                    
                    // Reset fromCoflSocket flag
                    fromCoflSocket = false
                    
                    firstGui = Date.now()
                    purchaseStartTime = firstGui // Also set global for message handler access
                    
                    // Wait for item to load in slot 31 - TPM+ pattern
                    let item = (await itemLoad(bot, 31, false))?.name
                    
                    if (item === 'gold_nugget') {
                        // Skip logic: Click slot 31 and slot 11 in same tick for sub-90ms purchases
                        // Both clicks use the same windowID - the server queues the second click and 
                        // processes it when the Confirm Purchase window opens (which happens server-side
                        // after the first click). This eliminates client-side window detection delay.
                        
                        // Send purchase click (slot 31 = Buy Item Right Now button)
                        clickSlot(bot, 31, windowID, 371) // 371 = gold nugget
                        printMcChatToConsole(`§f[§4BAF§f]: §e[Click] Slot 31 | Item: Buy Item Right Now`)
                        
                        // Send second click on slot 31 (required for successful purchase)
                        // Double-click pattern ensures the purchase command is reliably processed by the server
                        clickSlot(bot, 31, windowID, 371) // 371 = gold nugget
                        
                        // Immediately send confirm click (slot 11 = Confirm button in next window)
                        // Note: "Unknown" matches expected log output format from problem statement
                        clickSlot(bot, 11, windowID, 159) // 159 = green stained hardened clay (confirm)
                        printMcChatToConsole(`§f[§4BAF§f]: §e[Click] Slot 11 | Item: Unknown`)
                    }
                    
                    // Handle different item types
                    switch (item) {
                        case "gold_nugget":
                            // Skip logic: Already clicked both slot 31 and 11, clean up and exit
                            // Note: purchaseStartTime NOT cleared here - message handler will clear it and display timing
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                        case "bed":
                            printMcChatToConsole(`§f[§4BAF§f]: §6Found a bed!`)
                            await initBedSpam(bot)
                            break
                        case null:
                        case undefined:
                        case "potato":
                            printMcChatToConsole(`§f[§4BAF§f]: §cPotatoed :(`)
                            if (bot.currentWindow) {
                                bot.closeWindow(bot.currentWindow)
                            }
                            purchaseStartTime = null
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                        case "feather":
                            // Double check for potato or gold_block
                            // Wait a bit for the item to change, then check again
                            await sleep(50)
                            const secondItem = (await itemLoad(bot, 31, true))?.name
                            if (secondItem === 'potato' || secondItem === null) {
                                printMcChatToConsole(`§f[§4BAF§f]: §cPotatoed :(`)
                                if (bot.currentWindow) {
                                    bot.closeWindow(bot.currentWindow)
                                }
                                purchaseStartTime = null
                                bot._client.removeListener('open_window', openWindowHandler)
                                ;(bot as any)._bafOpenWindowHandler = null
                                bot.state = null
                                resolve()
                                return
                            } else if (secondItem !== 'gold_block') {
                                log(`Found unexpected item on second check: ${secondItem}`, 'debug')
                                if (bot.currentWindow) {
                                    bot.closeWindow(bot.currentWindow)
                                }
                                purchaseStartTime = null
                                bot._client.removeListener('open_window', openWindowHandler)
                                ;(bot as any)._bafOpenWindowHandler = null
                                bot.state = null
                                resolve()
                                return
                            }
                            // Fall through to gold_block case
                        case "gold_block":
                            // Claim sold item
                            clickWindow(bot, 31).catch(err => log(`Error clicking claim slot: ${err}`, 'error'))
                            purchaseStartTime = null
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                        case "poisonous_potato":
                            printMcChatToConsole(`§f[§4BAF§f]: §cToo poor to buy it :(`)
                            if (bot.currentWindow) {
                                bot.closeWindow(bot.currentWindow)
                            }
                            purchaseStartTime = null
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                        case "stained_glass_pane":
                            // Handle edge cases - just close window for now
                            if (bot.currentWindow) {
                                bot.closeWindow(bot.currentWindow)
                            }
                            purchaseStartTime = null
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                        default:
                            log(`Unexpected item found in slot 31: ${item}`, 'warn')
                            if (bot.currentWindow) {
                                bot.closeWindow(bot.currentWindow)
                            }
                            purchaseStartTime = null
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                    }
                }
                
                await sleep(WINDOW_INTERACTION_DELAY)
            } catch (error) {
                log(`Error in flip window handler: ${error}`, 'error')
                purchaseStartTime = null
                bot._client.removeListener('open_window', openWindowHandler)
                ;(bot as any)._bafOpenWindowHandler = null
                bot.state = null
                resolve()
            }
        }
        
        // Store handler reference for proper cleanup
        ;(bot as any)._bafOpenWindowHandler = openWindowHandler
        bot._client.on('open_window', openWindowHandler)
    })
}

/**
 * Handles bed spam clicking for bed flips
 */
/**
 * Bed spam prevention - TPM+ pattern
 * Simple interval checking slot 31 for gold_nugget
 */
async function initBedSpam(bot: MyBot) {
    const clickInterval = getConfigProperty('BED_SPAM_CLICK_DELAY') || 100
    log("Starting bed spam prevention...", 'debug')

    let failedClicks = 0

    const bedSpamInterval = setInterval(() => {
        const currentWindow = bot.currentWindow
        if (!currentWindow || failedClicks >= BED_SPAM_MAX_FAILED_CLICKS) {
            clearInterval(bedSpamInterval)
            log("Stopped bed spam prevention.", 'debug')
            return
        }

        const slotName = currentWindow.slots[31]?.name
        if (slotName === "gold_nugget") {
            clickWindow(bot, 31).catch(err => log(`Error clicking bed slot: ${err}`, 'error'))
        } else {
            failedClicks++
        }
    }, clickInterval)
}

// Stores the last 3 whitelist messages so add it to the webhook message for purchased flips
let whitelistObjects: FlipWhitelistedData[] = []
export function onItemWhitelistedMessage(text: string) {
    let chatMessage = removeMinecraftColorCodes(text)
    let itemName = chatMessage.split(' for ')[0]
    let price = chatMessage.split(' for ')[1].split(' matched your Whitelist entry: ')[0]
    let secondPart = chatMessage.split(' matched your Whitelist entry: ')[1]
    let reason = secondPart.split('\n')[0].trim()
    let finder = secondPart.split('Found by ')[1]

    whitelistObjects.unshift({
        itemName: itemName,
        reason: reason,
        finder: finder,
        price: price
    })

    if (whitelistObjects.length > 3) {
        whitelistObjects.pop()
    }
}

export function getWhitelistedData(itemName: string, price: string): FlipWhitelistedData {
    return whitelistObjects.find(x => x.itemName === itemName && x.price === price)
}

export function getCurrentFlip(): Flip | null {
    return currentFlip
}

export function clearCurrentFlip(): void {
    currentFlip = null
}

export function getPurchaseStartTime(): number | null {
    return purchaseStartTime
}

export function clearPurchaseStartTime(): void {
    purchaseStartTime = null
}
