import { MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getSlotLore, sleep } from './utils'

const COOKIE_PRICE_API = 'https://api.hypixel.net/v2/skyblock/bazaar'

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
        return 5000000 // Default fallback price
    } catch (error) {
        log(`Error fetching cookie price: ${error}`, 'error')
        return 5000000 // Default fallback price
    }
}

/**
 * Gets the player's current purse balance
 */
function getPurse(bot: MyBot): number {
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
        if (cookieTimeHours >= autoCookieHours) {
            log(`Cookie time ${Math.round(cookieTimeHours)}h is >= threshold ${autoCookieHours}h, not buying`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §aNot buying cookie - ${Math.round(cookieTimeHours)}h remaining`)
            return
        }
        
        // Need to buy a cookie
        log(`Cookie time ${Math.round(cookieTimeHours)}h is < threshold ${autoCookieHours}h, buying cookie`, 'info')
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
 * Buys and consumes a booster cookie
 */
async function buyCookie(bot: MyBot, currentCookieTime: number): Promise<void> {
    try {
        const price = await getCookiePrice()
        const purse = getPurse(bot)
        
        log(`Cookie price: ${price}, Purse: ${purse}`, 'info')
        
        // Check if cookie is too expensive or we don't have enough coins
        if (price > 20000000) {
            printMcChatToConsole(`§f[§4BAF§f]: §cCookie costs ${Math.round(price / 1000000)}M - too expensive, not buying`)
            log('Cookie too expensive, not buying', 'warn')
            return
        }
        
        if (purse < price * 2) {
            printMcChatToConsole(`§f[§4BAF§f]: §cNot enough coins to buy cookie (need ${Math.round(price / 1000000)}M, have ${Math.round(purse / 1000000)}M)`)
            log('Not enough coins to buy cookie', 'warn')
            return
        }
        
        // Buy the cookie from bazaar
        log('Opening bazaar to buy cookie...', 'info')
        bot.chat('/bz booster cookie')
        
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for bazaar'))
            }, 10000)
            
            const handler = () => {
                clearTimeout(timeout)
                bot.removeListener('windowOpen', handler)
                resolve()
            }
            
            bot.once('windowOpen', handler)
        })
        
        await sleep(500)
        
        // Click on cookie (slot 11 - center item in bazaar)
        log('Clicking on cookie item...', 'debug')
        clickWindow(bot, 11).catch(err => log(`Error clicking cookie: ${err}`, 'error'))
        
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for cookie details'))
            }, 10000)
            
            const handler = () => {
                clearTimeout(timeout)
                bot.removeListener('windowOpen', handler)
                resolve()
            }
            
            bot.once('windowOpen', handler)
        })
        
        await sleep(500)
        
        // Click "Buy Instantly" button (slot 10)
        log('Clicking Buy Instantly...', 'debug')
        clickWindow(bot, 10).catch(err => log(`Error clicking buy instantly: ${err}`, 'error'))
        
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for purchase confirmation'))
            }, 10000)
            
            const handler = () => {
                clearTimeout(timeout)
                bot.removeListener('windowOpen', handler)
                resolve()
            }
            
            bot.once('windowOpen', handler)
        })
        
        await sleep(500)
        
        // Confirm purchase (slot 10 again)
        log('Confirming cookie purchase...', 'debug')
        clickWindow(bot, 10).catch(err => log(`Error confirming purchase: ${err}`, 'error'))
        
        // Wait for purchase to complete
        await sleep(2000)
        
        // Check for full inventory message
        let inventoryFull = false
        const messageHandler = (message: any) => {
            const text = message.getText(null)
            if (text.includes("One or more items didn't fit in your inventory")) {
                inventoryFull = true
            }
        }
        
        bot.on('message', messageHandler)
        await sleep(1000)
        bot.removeListener('message', messageHandler)
        
        if (inventoryFull) {
            printMcChatToConsole(`§f[§4BAF§f]: §cYour inventory is full, cookie is in stash`)
            log('Inventory full, cookie in stash', 'warn')
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            return
        }
        
        // Close any open windows
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        
        await sleep(1000)
        
        // Open storage to find and consume the cookie
        log('Opening storage to consume cookie...', 'info')
        bot.chat('/storage')
        
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for storage'))
            }, 10000)
            
            const handler = () => {
                clearTimeout(timeout)
                bot.removeListener('windowOpen', handler)
                resolve()
            }
            
            bot.once('windowOpen', handler)
        })
        
        await sleep(500)
        
        // Find the cookie in the storage (look for item named "booster_cookie")
        if (!bot.currentWindow) {
            log('Storage window not available', 'error')
            return
        }
        
        let cookieSlot = null
        for (const slot of bot.currentWindow.slots) {
            if (slot && slot.name === 'cookie') {
                cookieSlot = slot.slot
                break
            }
        }
        
        if (!cookieSlot) {
            log('Could not find cookie in storage', 'warn')
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
            return
        }
        
        // Click on the cookie to activate it
        log(`Clicking cookie in slot ${cookieSlot}...`, 'debug')
        clickWindow(bot, cookieSlot).catch(err => log(`Error clicking cookie: ${err}`, 'error'))
        
        await sleep(1000)
        
        // Close storage
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        
        const newCookieTimeHours = Math.round((currentCookieTime + 4 * 86400) / 3600)
        const currentHours = Math.round(currentCookieTime / 3600)
        
        printMcChatToConsole(`§f[§4BAF§f]: §aAutomatically bought and consumed booster cookie!`)
        printMcChatToConsole(`§f[§4BAF§f]: §3Cookie time: ${currentHours}h → ${newCookieTimeHours}h`)
        log(`Successfully bought and consumed cookie. Time: ${currentHours}h → ${newCookieTimeHours}h`, 'info')
        
    } catch (error) {
        log(`Error buying cookie: ${error}`, 'error')
        printMcChatToConsole(`§f[§4BAF§f]: §cError buying cookie: ${error}`)
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
    }
}
