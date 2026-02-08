import { Flip, FlipWhitelistedData, MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, isSkin, numberWithThousandsSeparators, removeMinecraftColorCodes, sleep } from './utils'
import { trackFlipPurchase } from './flipTracker'

// Constants for window interaction
const CONFIRM_RETRY_DELAY = 100
const WINDOW_CONFIRM_TIMEOUT_MS = 5000 // Maximum time to wait for confirm window to close
const MAX_UNDEFINED_COUNT = 5
const BED_SPAM_TIMEOUT_MS = 5000
const BED_CLICKS_WITH_DELAY = 5
const BED_CLICKS_DEFAULT = 3
const BED_CLICK_DELAY_FALLBACK = 3
const WINDOW_INTERACTION_DELAY = 500
const MINEFLAYER_WINDOW_POPULATE_DELAY = 300 // Time for mineflayer to populate bot.currentWindow after open_window packet

let currentFlip: Flip | null = null
let actionCounter = 1
let fromCoflSocket = false
let recentlySkipped = false

/**
 * Polls the window slot to wait for an item to load
 * @param bot The bot instance
 * @param slot The slot number to check
 * @param alreadyLoaded Whether to wait for a change in the slot (for feather double-check)
 * @returns The item in the slot or null if timeout
 */
async function itemLoad(bot: MyBot, slot: number, alreadyLoaded: boolean = false): Promise<any> {
    return new Promise((resolve) => {
        let index = 1
        let found = false
        const first = bot.currentWindow?.slots[slot]?.name
        const delay = getConfigProperty('FLIP_ACTION_DELAY') || 150
        
        const checkCondition = alreadyLoaded 
            ? (check: any) => check?.name !== first
            : (check: any) => check !== null && check !== undefined
        
        const interval = setInterval(() => {
            const check = bot.currentWindow?.slots[slot]
            if (checkCondition(check)) {
                clearInterval(interval)
                found = true
                resolve(check)
                log(`Found ${check?.name} on index ${index}`, 'debug')
            }
            index++
        }, 1)

        setTimeout(() => {
            if (found) return
            log(`Failed to find an item in slot ${slot}`, 'debug')
            clearInterval(interval)
            resolve(null)
        }, delay * 3)
    })
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

/**
 * Determines if a flip should be skipped based on configuration
 */
function shouldSkipFlip(flip: Flip, profit: number): boolean {
    const skipSettings = getConfigProperty('SKIP')
    const useSkipAlways = skipSettings.ALWAYS
    const skipMinProfit = skipSettings.MIN_PROFIT
    const skipUser = skipSettings.USER_FINDER
    const skipSkins = skipSettings.SKINS
    const skipMinPercent = skipSettings.PROFIT_PERCENTAGE
    const skipMinPrice = skipSettings.MIN_PRICE

    const finderCheck = flip.finder === 'USER' && skipUser
    const skinCheck = isSkin(flip.itemName) && skipSkins
    const profitCheck = profit > skipMinProfit
    const percentCheck = (flip.profitPerc || 0) > skipMinPercent
    const priceCheck = flip.startingBid > skipMinPrice

    return useSkipAlways || profitCheck || skinCheck || finderCheck || percentCheck || priceCheck
}

/**
 * Logs the reason for skipping a flip
 */
function logSkipReason(flip: Flip, profit: number) {
    const skipSettings = getConfigProperty('SKIP')
    const useSkipAlways = skipSettings.ALWAYS
    
    if (useSkipAlways) {
        printMcChatToConsole('§f[§4BAF§f]: §cUsed skip because you have skip always enabled in config')
        return
    }
    
    let skipReasons = []
    if (flip.finder === 'USER' && skipSettings.USER_FINDER) {
        skipReasons.push('it was a user flip')
    }
    if (profit > skipSettings.MIN_PROFIT) {
        skipReasons.push('profit was over ' + numberWithThousandsSeparators(skipSettings.MIN_PROFIT))
    }
    if (isSkin(flip.itemName) && skipSettings.SKINS) {
        skipReasons.push('it was a skin')
    }
    if ((flip.profitPerc || 0) > skipSettings.PROFIT_PERCENTAGE) {
        skipReasons.push('profit percentage was over ' + skipSettings.PROFIT_PERCENTAGE + '%')
    }
    if (flip.startingBid > skipSettings.MIN_PRICE) {
        skipReasons.push('price was over ' + numberWithThousandsSeparators(skipSettings.MIN_PRICE))
    }
    
    printMcChatToConsole(`§f[§4BAF§f]: §aUsed skip because ${skipReasons.join(' and ')}`)
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
    recentlySkipped = false
    
    await useRegularPurchase(bot, flip, isBed)
    clearTimeout(timeout)
}

function useRegularPurchase(bot: MyBot, flip: Flip, isBed: boolean) {
    return new Promise<void>((resolve, reject) => {
        let firstGui: number
        let handledBinAuction = false
        let handledConfirm = false
        
        // Remove only our previous handler to prevent stacking (not mineflayer's internal handlers)
        if ((bot as any)._bafOpenWindowHandler) {
            bot._client.removeListener('open_window', (bot as any)._bafOpenWindowHandler)
        }
        
        const openWindowHandler = async (window) => {
            try {
                const windowID = window.windowId
                const windowName = window.windowTitle
                log(`Got new window ${windowName}, windowId: ${windowID}, fromCoflSocket: ${fromCoflSocket}`, 'debug')
                
                // Only delay for BIN Auction View where we need bot.currentWindow populated
                // Do NOT delay for Confirm Purchase — speed is critical there
                if (windowName !== '{"italic":false,"extra":[{"text":"Confirm Purchase"}],"text":""}') {
                    await sleep(MINEFLAYER_WINDOW_POPULATE_DELAY) // Wait for mineflayer to populate bot.currentWindow
                    if (!bot.currentWindow) {
                        log(`bot.currentWindow is null after delay for window ${windowName} (ID: ${windowID}), skipping`, 'warn')
                        return
                    }
                }
                
                if (windowName === '{"italic":false,"extra":[{"text":"BIN Auction View"}],"text":""}') {
                    // Skip if we already handled this window type
                    if (handledBinAuction) {
                        log('Already handled BIN Auction View, ignoring duplicate', 'debug')
                        return
                    }
                    handledBinAuction = true
                    
                    // Send confirm click packet for faster response
                    confirmClick(bot, windowID)
                    
                    // Calculate profit and check skip conditions
                    const profit = flip.target - flip.startingBid
                    const skipSettings = getConfigProperty('SKIP')
                    const useSkipAlways = skipSettings.ALWAYS
                    const currentDelay = getConfigProperty('FLIP_ACTION_DELAY')

                    // Validate FLIP_ACTION_DELAY if ALWAYS skip is enabled
                    if (useSkipAlways && currentDelay < 150) {
                        printMcChatToConsole(
                            `§f[§4BAF§f]: §cWarning: SKIP.ALWAYS requires FLIP_ACTION_DELAY >= 150ms (current: ${currentDelay}ms)`
                        )
                    }

                    // Determine if we should use skip - checked BEFORE clicking
                    const useSkipOnFlip = shouldSkipFlip(flip, profit) && fromCoflSocket
                    
                    // Reset fromCoflSocket flag
                    fromCoflSocket = false
                    
                    firstGui = Date.now()
                    
                    // Wait for item to load in slot 31
                    let item = (await itemLoad(bot, 31))?.name
                    
                    if (item === 'gold_nugget') {
                        // Click on gold nugget first
                        clickSlot(bot, 31, windowID, 371)
                        clickWindow(bot, 31).catch(err => log(`Error clicking slot 31: ${err}`, 'error'))
                        
                        // If skip should be used, set flag to skip in next window
                        if (useSkipOnFlip) {
                            recentlySkipped = true
                            logSkipReason(flip, profit)
                            return
                        }
                    }
                    
                    recentlySkipped = false
                    
                    // Handle different item types
                    switch (item) {
                        case "gold_nugget":
                            // Already handled above (clicked slot 31), just wait for Confirm Purchase window
                            break
                        case "bed":
                            printMcChatToConsole(`§f[§4BAF§f]: §6Found a bed!`)
                            await initBedSpam(bot, flip, isBed)
                            break
                        case null:
                        case undefined:
                        case "potato":
                            printMcChatToConsole(`§f[§4BAF§f]: §cPotatoed :(`)
                            if (bot.currentWindow) {
                                bot.closeWindow(bot.currentWindow)
                            }
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                        case "feather":
                            // Double check for potato or gold_block
                            const secondItem = (await itemLoad(bot, 31, true))?.name
                            if (secondItem === 'potato') {
                                printMcChatToConsole(`§f[§4BAF§f]: §cPotatoed :(`)
                                if (bot.currentWindow) {
                                    bot.closeWindow(bot.currentWindow)
                                }
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
                            bot._client.removeListener('open_window', openWindowHandler)
                            ;(bot as any)._bafOpenWindowHandler = null
                            bot.state = null
                            resolve()
                            return
                    }
                } else if (windowName === '{"italic":false,"extra":[{"text":"Confirm Purchase"}],"text":""}') {
                    // Skip if we already handled this window type
                    if (handledConfirm) {
                        log('Already handled Confirm Purchase, ignoring duplicate', 'debug')
                        return
                    }
                    handledConfirm = true
                    
                    // Send confirm click packet for faster response
                    confirmClick(bot, windowID)
                    
                    const confirmAt = Date.now() - firstGui
                    printMcChatToConsole(`§f[§4BAF§f]: §3Confirm at ${confirmAt}ms`)
                    
                    // Only click confirm if we didn't skip
                    if (!recentlySkipped) {
                        // Immediately click slot 11 without any delay for fastest confirm time
                        clickWindow(bot, 11).catch(err => log(`Error clicking confirm slot: ${err}`, 'error'))
                        
                        // Wait for window to change before cleanup (like TPM-rewrite)
                        // Keep clicking until the window closes to ensure the click registers
                        await sleep(CONFIRM_RETRY_DELAY)
                        const confirmStartTime = Date.now()
                        while (getWindowTitle(bot.currentWindow) === 'Confirm Purchase') {
                            // Timeout protection to prevent infinite loop
                            if (Date.now() - confirmStartTime > WINDOW_CONFIRM_TIMEOUT_MS) {
                                log('Confirm window timeout - closing window', 'warn')
                                if (bot.currentWindow) {
                                    bot.closeWindow(bot.currentWindow)
                                }
                                break
                            }
                            clickWindow(bot, 11).catch(err => log(`Error clicking confirm slot: ${err}`, 'error'))
                            await sleep(CONFIRM_RETRY_DELAY)
                        }
                    } else {
                        // Close the window to cancel the purchase when skipping
                        if (bot.currentWindow) {
                            bot.closeWindow(bot.currentWindow)
                        }
                    }
                    
                    bot._client.removeListener('open_window', openWindowHandler)
                    ;(bot as any)._bafOpenWindowHandler = null
                    bot.state = null
                    resolve()
                    return
                }
                
                await sleep(WINDOW_INTERACTION_DELAY)
            } catch (error) {
                log(`Error in flip window handler: ${error}`, 'error')
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
async function initBedSpam(bot: MyBot, flip: Flip, isBed: boolean) {
    const clickDelay = getConfigProperty('BED_SPAM_CLICK_DELAY') || 5
    const multipleBedClicksDelay = getConfigProperty('BED_MULTIPLE_CLICKS_DELAY') || 0
    const bedSpam = getConfigProperty('BED_SPAM') || false
    
    let delayUntilBuyStart = isBed
        ? flip.purchaseAt.getTime() - new Date().getTime() - (multipleBedClicksDelay > 0 ? multipleBedClicksDelay : 0)
        : 0
    
    if (delayUntilBuyStart > 0) {
        await sleep(delayUntilBuyStart)
    }
    
    if (bedSpam) {
        // Continuous bed spam until window changes or item changes
        let undefinedCount = 0
        const bedSpamInterval = setInterval(() => {
            const window = bot.currentWindow
            const item = window?.slots[31]?.name
            
            if (item === undefined) {
                undefinedCount++
                if (undefinedCount >= MAX_UNDEFINED_COUNT) {
                    clearInterval(bedSpamInterval)
                    log('Clearing bed spam due to undefined count', 'debug')
                }
                return
            }
            
            if (item === "gold_nugget") {
                clickWindow(bot, 31).catch(err => log(`Error clicking bed: ${err}`, 'error'))
                return
            } else if (item === "potato") {
                if (bot.currentWindow) {
                    bot.closeWindow(bot.currentWindow)
                }
                bot.state = null
                clearInterval(bedSpamInterval)
                return
            }
            
            if (getWindowTitle(window) !== 'BIN Auction View' || item !== 'bed') {
                clearInterval(bedSpamInterval)
                log('Clearing bed spam', 'debug')
                return
            }
            
            clickWindow(bot, 31).catch(err => log(`Error clicking bed: ${err}`, 'error'))
        }, clickDelay)
        
        // Failsafe timeout
        setTimeout(() => {
            clearInterval(bedSpamInterval)
            if (getWindowTitle(bot.currentWindow) === 'BIN Auction View' && bot.state === 'purchasing') {
                if (bot.currentWindow) {
                    bot.closeWindow(bot.currentWindow)
                }
                bot.state = null
                printMcChatToConsole('§f[§4BAF§f]: §cBed timing failed, aborted auction')
            }
        }, BED_SPAM_TIMEOUT_MS)
    } else {
        // Multiple click approach
        const clicks = multipleBedClicksDelay > 0 ? BED_CLICKS_WITH_DELAY : BED_CLICKS_DEFAULT
        for (let i = 0; i < clicks; i++) {
            if (getWindowTitle(bot.currentWindow) === 'BIN Auction View') {
                clickWindow(bot, 31).catch(err => log(`Error clicking bed: ${err}`, 'error'))
                log(`Bed click ${i + 1}`, 'debug')
                await sleep(multipleBedClicksDelay || BED_CLICK_DELAY_FALLBACK)
            } else {
                break
            }
        }
    }
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
