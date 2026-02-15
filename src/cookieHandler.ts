import { MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getSlotLore, sleep, betterOnce } from './utils'
import { getCurrentPurse } from './BAF'

const COOKIE_PRICE_API = 'https://api.hypixel.net/v2/skyblock/bazaar'
const DEFAULT_COOKIE_PRICE = 5000000 // 5M coins fallback
const MAX_COOKIE_PRICE = 20000000 // 20M coins maximum

// Track cookie time globally
let cookieTime: number = 0

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
        if (cookieTimeHours <= autoCookieHours) {
            log(`Cookie time ${Math.round(cookieTimeHours)}h is <= threshold ${autoCookieHours}h, not buying`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §aNot buying cookie - ${Math.round(cookieTimeHours)}h remaining`)
            return
        }
        
        // Need to buy a cookie
        log(`Cookie time ${Math.round(cookieTimeHours)}h is > threshold ${autoCookieHours}h, buying cookie`, 'info')
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
 * Finds a cookie in storage and prepares it for consumption
 * @param bot The bot instance
 * @param itemId The item ID to search for (e.g., 'COOKIE' for booster cookie)
 * @returns Promise that resolves when the item is found and ready to be clicked
 */
async function getItemAndMove(bot: MyBot, itemId: string): Promise<void> {
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
                    log(`[getItemAndMove] Found ${itemId} in slot ${cookieSlot}`, 'debug')
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
                                log(`[getItemAndMove] Found ${itemId} by display name in slot ${cookieSlot}`, 'debug')
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
        await clickWindow(bot, cookieSlot)
        log(`[getItemAndMove] Clicked ${itemId} in slot ${cookieSlot}`, 'debug')
    } catch (error) {
        log(`[getItemAndMove] Error: ${error}`, 'error')
        throw error
    }
}

/**
 * Buys and consumes a booster cookie - Updated implementation based on problem statement
 */
async function buyCookie(bot: MyBot, currentCookieTime: number): Promise<void> {
    try {
        const autoCookie = getConfigProperty('AUTO_COOKIE') * 3600 // Convert hours to seconds
        
        // Check if we already have enough cookie time
        if (currentCookieTime && currentCookieTime <= autoCookie) {
            printMcChatToConsole(`§f[§4BAF§f]: §3Not buying a cookie because you have ${Math.round(currentCookieTime / 3600)}h`)
            log(`Not buying cookie - have ${Math.round(currentCookieTime / 3600)}h remaining`, 'info')
            return
        }
        
        const price = await getCookiePrice()
        const purse = getPurse(bot)
        
        log(`Cookie price: ${price}, Purse: ${purse}`, 'info')
        
        // Check if cookie is too expensive or not enough coins
        if (price > MAX_COOKIE_PRICE || purse < price * 2) {
            printMcChatToConsole(`§f[§4BAF§f]: §cCookie costs ${Math.round(price / 1000000)}M so not buying :(`)
            log(`Cookie expensive or insufficient funds: price=${price}, purse=${purse}`, 'warn')
            return
        }
        
        // Start buying the cookie
        log('Opening bazaar to buy cookie...', 'info')
        bot.chat('/bz booster cookie')
        await betterOnce(bot, 'windowOpen')
        
        // Click on cookie item (slot 11)
        await clickWindow(bot, 11)
        await betterOnce(bot, 'windowOpen')
        
        await sleep(250)
        
        // Click "Buy Instantly" button (slot 10)
        await clickWindow(bot, 10)
        await betterOnce(bot, 'windowOpen')
        
        await sleep(250)
        
        // Confirm purchase (slot 10 again)
        await clickWindow(bot, 10)
        
        try {
            // Check for full inventory message
            await betterOnce(bot, 'message', (message) => {
                let text = message.getText(null)
                log(`[Cookie] Message received: ${text}`, 'debug')
                // Use includes for more flexible matching
                return text.includes("One or more items didn't fit in your inventory")
            }, 3000)
            
            printMcChatToConsole(`§f[§4BAF§f]: §cYour inv is full so I can't eat this cookie. You have one in your stash now`)
            log('Inventory full, cookie in stash', 'warn')
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            return
        } catch (e) {
            // No full inventory message - cookie was bought successfully
            log(`[Cookie] No full inventory error (this is good): ${e}`, 'debug')
            
            // Close any open windows
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            
            await sleep(500)
            
            // Call getItemAndMove to open storage and click the cookie
            await getItemAndMove(bot, 'COOKIE')
            
            // Wait for the cookie consumption window to open
            await betterOnce(bot, 'windowOpen')
            
            // Click slot 11 to consume the cookie (this is the "Consume" button in the cookie GUI)
            await clickWindow(bot, 11)
            log('[Cookie] Activated cookie', 'debug')
            
            // Close window (just to be safe)
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            
            const newCookieTimeHours = Math.round((currentCookieTime + 4 * 86400) / 3600)
            const currentHours = Math.round(currentCookieTime / 3600)
            
            printMcChatToConsole(`§f[§4BAF§f]: §aAutomatically bought and consumed booster cookie!`)
            printMcChatToConsole(`§f[§4BAF§f]: §3Cookie time: ${currentHours}h → ${newCookieTimeHours}h`)
            log(`Successfully bought and consumed cookie. Time: ${currentHours}h → ${newCookieTimeHours}h`, 'info')
            
            // Update global cookie time (4 days = 4 * 86400 seconds)
            cookieTime += 4 * 86400
        }
    } catch (e) {
        log(`Error buying cookie: ${e}`, 'error')
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
    }
}
