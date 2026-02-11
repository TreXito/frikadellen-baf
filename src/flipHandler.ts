import { Flip, FlipWhitelistedData, MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, isSkin, numberWithThousandsSeparators, removeMinecraftColorCodes, sleep } from './utils'
import { trackFlipPurchase } from './flipTracker'

// Constants for window interaction
const BED_SPAM_MAX_FAILED_CLICKS = 5 // Max failed clicks before stopping bed spam

let currentFlip: Flip | null = null
let actionCounter = 1
let fromCoflSocket = false
let recentlySkipped = false
let purchaseStartTime: number | null = null // Track when BIN Auction View opens for timing

/**
 * Determines whether a flip should use the skip (pre-click) optimization
 */
function shouldSkipFlip(flip: Flip, profit: number): boolean {
    const skipConfig = getConfigProperty('SKIP')
    if (!skipConfig) return false

    if (skipConfig.ALWAYS) return true
    if (skipConfig.MIN_PROFIT && profit >= skipConfig.MIN_PROFIT) return true
    if (skipConfig.USER_FINDER && flip.finder === 'USER') return true
    if (skipConfig.SKINS && isSkin(flip.itemName)) return true
    if (skipConfig.PROFIT_PERCENTAGE && flip.profitPerc && flip.profitPerc >= skipConfig.PROFIT_PERCENTAGE) return true
    if (skipConfig.MIN_PRICE && flip.startingBid >= skipConfig.MIN_PRICE) return true

    return false
}

/**
 * Logs the reason a flip was skipped for debugging
 */
function logSkipReason(flip: Flip, profit: number) {
    const skipConfig = getConfigProperty('SKIP')
    if (!skipConfig) return

    let reason = 'Unknown'
    if (skipConfig.ALWAYS) reason = 'ALWAYS'
    else if (skipConfig.MIN_PROFIT && profit >= skipConfig.MIN_PROFIT) reason = `MIN_PROFIT (${profit} >= ${skipConfig.MIN_PROFIT})`
    else if (skipConfig.USER_FINDER && flip.finder === 'USER') reason = 'USER_FINDER'
    else if (skipConfig.SKINS && isSkin(flip.itemName)) reason = 'SKINS'
    else if (skipConfig.PROFIT_PERCENTAGE && flip.profitPerc && flip.profitPerc >= skipConfig.PROFIT_PERCENTAGE) reason = `PROFIT_PERCENTAGE (${flip.profitPerc} >= ${skipConfig.PROFIT_PERCENTAGE})`
    else if (skipConfig.MIN_PRICE && flip.startingBid >= skipConfig.MIN_PRICE) reason = `MIN_PRICE (${flip.startingBid} >= ${skipConfig.MIN_PRICE})`

    printMcChatToConsole(`§f[§4BAF§f]: §aSkipping confirm — reason: ${reason}`)
    log(`Skip reason for ${flip.itemName}: ${reason}`, 'debug')
}

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
        const maxAttempts = 100 // ~100ms timeout total
        
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
    return new Promise<void>((resolve) => {
        let firstGui: number

        // Remove previous handler if exists to prevent stacking
        if ((bot as any)._bafOpenWindowHandler) {
            bot._client.removeListener('open_window', (bot as any)._bafOpenWindowHandler)
        }

        const openWindowHandler = async (window) => {
            try {
                const windowID = window.windowId
                const nextWindowID = windowID === 100 ? 1 : windowID + 1
                const windowName = window.windowTitle

                // CRITICAL: Send confirmClick for EVERY window, BEFORE any processing
                confirmClick(bot, windowID)

            // ============ BIN Auction View ============
            if (windowName === '{"italic":false,"extra":[{"text":"BIN Auction View"}],"text":""}') {

                // Calculate skip conditions BEFORE clicking anything
                const profit = flip.target - flip.startingBid
                const useSkipOnFlip = shouldSkipFlip(flip, profit) && fromCoflSocket
                fromCoflSocket = false

                firstGui = Date.now()
                purchaseStartTime = Date.now()

                // Wait for item to load in slot 31
                let item = (await itemLoad(bot, 31))?.name

                if (item === 'gold_nugget') {
                    // Send low-level click packet for slot 31
                    clickSlot(bot, 31, windowID, 371)
                    // Redundant click in case first packet was lost
                    clickWindow(bot, 31).catch(() => {})

                    if (useSkipOnFlip) {
                        // SKIP: pre-click Confirm (slot 11) on the NEXT window in the same tick
                        // This works because window IDs are sequential
                        clickSlot(bot, 11, nextWindowID, 159)
                        recentlySkipped = true
                        logSkipReason(flip, profit)
                        // RETURN here — do NOT fall through to switch
                        // The open_window listener stays active and will handle
                        // Confirm Purchase when it arrives
                        return
                    }
                }

                // Only reached if skip was NOT used
                recentlySkipped = false

                switch (item) {
                    case 'gold_nugget':
                        // Already clicked slot 31 above
                        // Do NOTHING here — just wait for Confirm Purchase window
                        // Do NOT set state to null, do NOT clean up listener
                        break
                    case 'bed':
                        printMcChatToConsole('§f[§4BAF§f]: §6Found a bed!')
                        await initBedSpam(bot, flip, isBed)
                        break
                    case null:
                    case undefined:
                    case 'potato':
                        printMcChatToConsole('§f[§4BAF§f]: §cPotatoed :(')
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        cleanup()
                        return
                    case 'feather':
                        // Double-check: wait for slot to change
                        const secondItem = (await itemLoad(bot, 31, true))?.name
                        if (secondItem === 'potato') {
                            printMcChatToConsole('§f[§4BAF§f]: §cPotatoed :(')
                            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                            cleanup()
                            return
                        } else if (secondItem !== 'gold_block') {
                            log(`Found unexpected item on second check: ${secondItem}`, 'debug')
                            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                            cleanup()
                            return
                        }
                        // Fall through to gold_block
                    case 'gold_block':
                        // Sold auction — claim it
                        clickWindow(bot, 31).catch(() => {})
                        cleanup()
                        return
                    case 'poisonous_potato':
                        printMcChatToConsole('§f[§4BAF§f]: §cToo poor to buy it :(')
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        cleanup()
                        return
                    case 'stained_glass_pane':
                        // Edge case — just close
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        cleanup()
                        return
                    default:
                        log(`Unexpected item in slot 31: ${item}`, 'warn')
                        if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                        cleanup()
                        return
                }

            // ============ Confirm Purchase ============
            } else if (windowName === '{"italic":false,"extra":[{"text":"Confirm Purchase"}],"text":""}') {

                // NO delay here — speed is everything

                const confirmAt = Date.now() - firstGui
                printMcChatToConsole(`§f[§4BAF§f]: §3Confirm at ${confirmAt}ms`)

                // First click: only if we didn't pre-click via skip
                if (!recentlySkipped) {
                    clickWindow(bot, 11).catch(() => {})
                }

                // Wait ~150ms (3 ticks)
                await sleep(150)

                // Safety retry loop: runs REGARDLESS of recentlySkipped
                // If skip pre-click worked, window is already gone and loop doesn't execute
                // If skip pre-click failed (packet lost), this catches it
                while (bot.currentWindow && getWindowTitle(bot.currentWindow) === 'Confirm Purchase') {
                    clickWindow(bot, 11).catch(() => {})
                    await sleep(250) // 5 ticks
                }

                cleanup()
                return

            // ============ Auction View (non-BIN, failsafe) ============
            } else if (windowName === '{"italic":false,"extra":[{"text":"Auction View"}],"text":""}') {
                printMcChatToConsole('§f[§4BAF§f]: §cPlease turn off normal auctions!')
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
                cleanup()
                return
            }
            } catch (error) {
                log(`Error in flip window handler: ${error}`, 'error')
                cleanup()
            }
        }

        function cleanup() {
            bot._client.removeListener('open_window', openWindowHandler)
            ;(bot as any)._bafOpenWindowHandler = null
            bot.state = null
            resolve()
        }

        // Store reference for cleanup
        ;(bot as any)._bafOpenWindowHandler = openWindowHandler
        bot._client.on('open_window', openWindowHandler)

        // NOW send the command — listener is guaranteed to be active
        bot.chat(`/viewauction ${flip.id}`)
    })
}

/**
 * Bed spam prevention - TPM+ pattern
 * Simple interval checking slot 31 for gold_nugget
 */
async function initBedSpam(bot: MyBot, flip: Flip, isBed: boolean) {
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
