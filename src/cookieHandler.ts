import { MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getSlotLore, sleep, betterOnce } from './utils'
import { getCurrentPurse } from './BAF'
import { clickAndWaitForWindow } from './bazaarHelpers'

// Helper logging functions to match the provided code style
const logmc = printMcChatToConsole
const debug = (msg: string, ...args: any[]) => log(`[DEBUG] ${msg} ${args.join(' ')}`, 'debug')
const error = (msg: string, ...args: any[]) => log(`[ERROR] ${msg} ${args.join(' ')}`, 'error')

const COOKIE_PRICE_API = 'https://api.hypixel.net/v2/skyblock/bazaar'
const DEFAULT_COOKIE_PRICE = 5000000 // 5M coins fallback
const MAX_COOKIE_PRICE = 20000000 // 20M coins maximum

// Timing constants for cookie consumption
const EQUIP_DELAY_MS = 250 // Delay after equipping item
const CONSUME_DELAY_MS = 500 // Delay after consuming item
const INVENTORY_UPDATE_DELAY_MS = 1500 // Delay for item to appear in inventory after purchase (increased from 500ms)
const STORAGE_OPERATION_DELAY_MS = 500 // Delay for storage window operations

// Track cookie time globally
let cookieTime: number = 0

/**
 * Add helper methods to the bot for cookie handling
 */
export function addCookieHelpers(bot: MyBot) {
    // betterClick - maps to existing clickWindow
    if (!bot.betterClick) {
        bot.betterClick = async (slot: number) => {
            return clickWindow(bot, slot)
        }
    }
    
    // betterWindowClose - closes the current window
    if (!bot.betterWindowClose) {
        bot.betterWindowClose = () => {
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
        }
    }
    
    // getPurse - gets the current purse balance
    if (!bot.getPurse) {
        bot.getPurse = () => {
            return getPurse(bot)
        }
    }
}

// Extend MyBot interface with cookie helper methods
declare module '../types/autobuy' {
    interface MyBot {
        betterClick?: (slot: number) => Promise<void>
        betterWindowClose?: () => void
        getPurse?: () => number
    }
}

/**
 * Gets the current bazaar price of a booster cookie
 */
async function getCookiePrice(): Promise<number> {
    try {
        const axios = require('axios')
        const response = await axios.get(COOKIE_PRICE_API)
        const cookieData = response.data.products['BOOSTER_COOKIE']
        
        if (cookieData && cookieData.quick_status) {
            // Use buy price (what we pay to insta-buy)
            const price = Math.ceil(cookieData.quick_status.buyPrice)
            log(`Cookie price from API: ${price}`, 'debug')
            return price
        }
        
        log('Could not get cookie price from API', 'warn')
        return DEFAULT_COOKIE_PRICE
    } catch (error) {
        log(`Error fetching cookie price: ${error}`, 'error')
        return DEFAULT_COOKIE_PRICE
    }
}

/**
 * Gets the player's current purse balance
 * Now uses the centralized getCurrentPurse function from BAF
 */
function getPurse(bot: MyBot): number {
    const purse = getCurrentPurse()
    if (purse > 0) {
        return purse
    }
    
    // Fallback to old method if getCurrentPurse returns 0
    if (!bot.scoreboard || !bot.scoreboard.sidebar || !bot.scoreboard.sidebar.items) {
        return 0
    }
    
    const purseItem = bot.scoreboard.sidebar.items.find(item => {
        const text = item.displayName.getText(null)
        return text.includes('Purse:') || text.includes('Piggy:')
    })
    
    if (!purseItem) {
        return 0
    }
    
    const text = purseItem.displayName.getText(null)
    const match = text.match(/[\d,]+/)
    if (match) {
        return parseInt(match[0].replace(/,/g, ''))
    }
    
    return 0
}

/**
 * Checks cookie duration and automatically buys/consumes if needed
 * Called when the bot joins SkyBlock
 */
export async function checkAndBuyCookie(bot: MyBot): Promise<void> {
    // Add cookie helpers to bot
    addCookieHelpers(bot)
    
    const autoCookieHours = getConfigProperty('AUTO_COOKIE')
    
    // If AUTO_COOKIE is 0 or not set, skip
    if (!autoCookieHours || autoCookieHours <= 0) {
        log('Auto cookie is disabled', 'debug')
        return
    }
    
    try {
        log('Checking booster cookie status...', 'info')
        
        // Open SkyBlock menu to check cookie
        bot.chat('/sbmenu')
        
        // Wait for window to open
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for SkyBlock menu'))
            }, 10000)
            
            const handler = () => {
                clearTimeout(timeout)
                bot.removeListener('windowOpen', handler)
                resolve()
            }
            
            bot.once('windowOpen', handler)
        })
        
        await sleep(500)
        
        if (!bot.currentWindow) {
            log('Could not open SkyBlock menu', 'warn')
            return
        }
        
        // Check slot 51 for cookie info (booster cookie buff indicator)
        const cookieSlot = bot.currentWindow.slots[51]
        if (!cookieSlot) {
            log('Cookie slot not found in SkyBlock menu', 'warn')
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            return
        }
        
        const lore = getSlotLore(cookieSlot)
        if (!lore || lore.length === 0) {
            log('Could not read cookie lore', 'warn')
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            return
        }
        
        // Find the duration line
        const durationLine = lore.find(line => line.toLowerCase().includes('duration'))
        if (!durationLine) {
            log('Cookie duration not found in lore', 'warn')
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            return
        }
        
        // Parse the cookie time remaining
        // Format examples: "Duration: 3d 5h", "Duration: 23h 45m", "Duration: 1h 30m"
        const cookieTimeSeconds = parseCookieDuration(durationLine)
        const cookieTimeHours = cookieTimeSeconds / 3600
        
        log(`Cookie time remaining: ${Math.round(cookieTimeHours)}h (${cookieTimeSeconds}s)`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §3Cookie time remaining: ${Math.round(cookieTimeHours)} hours`)
        
        // Close the menu
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        
        await sleep(500)
        
        // Check if we need to buy a cookie
        // Standard logic: buy when running low (time <= threshold)
        if (cookieTimeHours > autoCookieHours) {
            log(`Cookie time ${Math.round(cookieTimeHours)}h is > threshold ${autoCookieHours}h, not buying`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §aNot buying cookie - ${Math.round(cookieTimeHours)}h remaining`)
            return
        }
        
        // Need to buy a cookie
        log(`Cookie time ${Math.round(cookieTimeHours)}h is <= threshold ${autoCookieHours}h, buying cookie`, 'info')
        await buyCookie(bot, cookieTimeSeconds)
        
    } catch (error) {
        log(`Error checking/buying cookie: ${error}`, 'error')
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
    }
}

/**
 * Parses cookie duration from lore text
 * Returns duration in seconds
 */
function parseCookieDuration(durationText: string): number {
    // Remove color codes and extract numbers
    const cleaned = durationText.replace(/§[0-9a-fk-or]/gi, '')
    
    let totalSeconds = 0
    
    // Match days (e.g., "3d")
    const daysMatch = cleaned.match(/(\d+)d/)
    if (daysMatch) {
        totalSeconds += parseInt(daysMatch[1]) * 86400
    }
    
    // Match hours (e.g., "5h")
    const hoursMatch = cleaned.match(/(\d+)h/)
    if (hoursMatch) {
        totalSeconds += parseInt(hoursMatch[1]) * 3600
    }
    
    // Match minutes (e.g., "30m")
    const minutesMatch = cleaned.match(/(\d+)m/)
    if (minutesMatch) {
        totalSeconds += parseInt(minutesMatch[1]) * 60
    }
    
    return totalSeconds
}

/**
 * Tries to find and consume a cookie from player inventory
 * @param bot The bot instance
 * @returns Promise that resolves to true if cookie was found and consumed, false if not found
 */
async function consumeCookieFromInventory(bot: MyBot): Promise<boolean> {
    try {
        debug('Checking player inventory for cookie')
        
        // Ensure no window is open to allow clean inventory access
        if (bot.currentWindow) {
            debug('Closing open window to ensure clean inventory access')
            bot.betterWindowClose()
            await sleep(250)
        }
        
        // Get all items in player inventory
        const inventoryItems = bot.inventory.items()
        debug(`Found ${inventoryItems.length} items in inventory`)
        
        // Log all item names for debugging
        if (inventoryItems.length > 0) {
            const itemNames = inventoryItems.map(item => `${item.name}(slot:${item.slot})`).join(', ')
            debug(`Inventory items: ${itemNames}`)
        }
        
        // Search for cookie in inventory
        let cookieItem = null
        for (const item of inventoryItems) {
            // Check by item name (booster cookies have item name 'cookie')
            if (item.name === 'cookie') {
                cookieItem = item
                debug(`Found cookie in inventory slot ${item.slot}`)
                break
            }
            
            // Check by display name in NBT
            if (item.nbt?.value) {
                try {
                    const nbtValue = item.nbt.value as any
                    if (nbtValue.display?.value?.Name?.value) {
                        const displayName = nbtValue.display.value.Name.value.toString().toLowerCase()
                        if (displayName.includes('booster cookie')) {
                            cookieItem = item
                            debug(`Found cookie by display name in inventory slot ${item.slot}`)
                            break
                        }
                    }
                } catch (e) {
                    // Skip items with invalid NBT
                }
            }
        }
        
        if (!cookieItem) {
            debug('Cookie not found in player inventory')
            return false
        }
        
        debug(`Attempting to equip and consume cookie from slot ${cookieItem.slot}`)
        
        // Equip the cookie to hand
        await bot.equip(cookieItem, 'hand')
        debug('Cookie equipped to hand')
        await sleep(EQUIP_DELAY_MS)
        
        // Activate/consume the item
        debug('Activating cookie with right-click')
        bot.activateItem()
        await sleep(CONSUME_DELAY_MS) // Give time for consumption
        
        debug('Cookie consumption command sent')
        return true
    } catch (error) {
        debug(`consumeCookieFromInventory error:`, error)
        return false
    }
}

/**
 * Finds a cookie in storage and prepares it for consumption
 * @param bot The bot instance
 * @param itemId The item ID to search for (e.g., 'COOKIE' for booster cookie)
 * @returns Promise that resolves when the item is found and ready to be clicked
 */
async function getItemAndMove(bot: MyBot, itemId: string): Promise<void> {
    return new Promise(async (resolve, reject) => {
        try {
            // Open storage first
            bot.chat('/storage')
            
            // Wait for storage window to open
            await betterOnce(bot, 'windowOpen')
            
            await sleep(250)
            
            if (!bot.currentWindow) {
                throw new Error('No window open after /storage')
            }
            
            // Search for the cookie in all slots
            let cookieSlot = null
            for (const slot of bot.currentWindow.slots) {
                if (slot) {
                    // Check by item name (booster cookies have item name 'cookie')
                    if (slot.name === 'cookie') {
                        cookieSlot = slot.slot
                        debug(`Found ${itemId} in slot ${cookieSlot}`)
                        break
                    }
                    
                    // Check by display name in NBT
                    if (slot.nbt?.value) {
                        try {
                            const nbtValue = slot.nbt.value as any
                            if (nbtValue.display?.value?.Name?.value) {
                                const displayName = nbtValue.display.value.Name.value.toString().toLowerCase()
                                if (displayName.includes('booster cookie')) {
                                    cookieSlot = slot.slot
                                    debug(`Found ${itemId} by display name in slot ${cookieSlot}`)
                                    break
                                }
                            }
                        } catch (e) {
                            // Skip slots with invalid NBT
                        }
                    }
                }
            }
            
            if (!cookieSlot) {
                throw new Error(`Could not find ${itemId} in window`)
            }
            
            // Click on the cookie to open it
            await bot.betterClick(cookieSlot)
            debug(`Clicked ${itemId} in slot ${cookieSlot}`)
            resolve()
        } catch (error) {
            debug(`getItemAndMove error:`, error)
            reject(error)
        }
    })
}

/**
 * Buys and consumes a booster cookie - Implementation from problem statement
 */
async function buyCookie(bot: MyBot, time: number | null = null): Promise<string> {
    return new Promise(async (resolve, reject) => {
        try {
            // Ensure helpers are initialized
            addCookieHelpers(bot)
            
            const autoCookie = getConfigProperty('AUTO_COOKIE') * 3600 // Convert hours to seconds
            
            // Standard logic: don't buy when time > threshold, buy when time <= threshold
            if (time && time > autoCookie) {
                logmc(`§6[§bTPM§6]§3 Not buying a cookie because you have ${Math.round(time / 3600)}h`)
                resolve(`Enough time`)
            } else {
                const price = await getCookiePrice()

                if (price > MAX_COOKIE_PRICE || bot.getPurse() < price * 2) {
                    logmc(`§6[§bTPM§6]§c Cookie costs ${price} so not buying :(`)
                    resolve(`Cookie expensive :(`)
                } else {
                    bot.chat(`/bz booster cookie`)
                    await betterOnce(bot, 'windowOpen')
                    
                    // Click slot 11 (cookie item) and wait for product window
                    const clickedCookie = await clickAndWaitForWindow(bot, 11, 2000, 2)
                    if (!clickedCookie) {
                        throw new Error('Failed to open cookie product window')
                    }
                    await sleep(250)
                    
                    // Click slot 10 (buy instantly) and wait for confirm window
                    const clickedBuy = await clickAndWaitForWindow(bot, 10, 2000, 2)
                    if (!clickedBuy) {
                        throw new Error('Failed to open buy confirmation window')
                    }
                    await sleep(250)
                    
                    // Click slot 10 (confirm) to buy the cookie
                    await clickWindow(bot, 10)
                    
                    await sleep(250) // Give time for purchase to process
                    
                    try {
                        // Check for full inv
                        await betterOnce(bot, "message", (message) => {
                            let text = message.getText(null)
                            debug("cookie text", text)
                            return text.includes("One or more items didn't fit in your inventory")
                        }, 3000) // 3 second timeout for message
                        logmc(`§6[§bTPM§6]§c Your inv is full so I can't eat this cookie. You have one in your stash now`)
                        resolve(`Full inv :(`)
                        bot.betterWindowClose()
                    } catch (e) {
                        // If no message for full inv then cookie went to inventory
                        debug(`cookie error (probably not an actual error)`, e)
                        bot.betterWindowClose()
                        
                        // Wait a bit for the item to appear in inventory
                        await sleep(INVENTORY_UPDATE_DELAY_MS)
                        
                        // Try to consume from inventory first (normal case)
                        debug('Attempting to consume cookie from inventory')
                        const consumedFromInventory = await consumeCookieFromInventory(bot)
                        
                        if (!consumedFromInventory) {
                            // If not in inventory, try storage as fallback
                            debug('Cookie not in inventory, trying storage fallback')
                            try {
                                await getItemAndMove(bot, 'COOKIE')
                                await sleep(STORAGE_OPERATION_DELAY_MS) // Wait for window to open/update
                                
                                // Try to consume from inventory again (cookie might have been moved)
                                const consumedAfterStorage = await consumeCookieFromInventory(bot)
                                if (!consumedAfterStorage) {
                                    debug('Failed to consume cookie from storage, trying direct click')
                                    // As a last resort, try clicking slot 11 (cookie item position in storage window)
                                    if (bot.currentWindow) {
                                        await bot.betterClick(11)
                                        debug("Clicked slot 11 to consume cookie")
                                        await sleep(STORAGE_OPERATION_DELAY_MS)
                                    }
                                }
                                bot.betterWindowClose()
                            } catch (storageError) {
                                debug(`Storage fallback failed: ${storageError}`)
                                bot.betterWindowClose()
                                // Continue anyway - cookie might still be consumed
                            }
                        }
                        
                        const timeInHours = time ? Math.round(time / 3600) : 0
                        const newTimeInHours = time ? Math.round((time + 4 * 86400) / 3600) : Math.round((4 * 86400) / 3600)
                        logmc(`§6[§bTPM§6]§3 Automatically ate a booster cookie cause you had ${timeInHours} hours left. Now you have ${newTimeInHours} hours`)
                        cookieTime += 4 * 86400 // Add 4 days in seconds
                        resolve(`Cookie bought and consumed successfully`)
                    }
                }
            }
        } catch (e) {
            error(`Error buying cookie: `, e)
            bot.betterWindowClose()
            // No need to change state because it'll safely go back to getting ready
            resolve(`Failed to buy cookie`)
        }
    })
}
