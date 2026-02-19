import { MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getSlotLore, sleep } from './utils'
import { getCurrentPurse } from './BAF'

const COOKIE_PRICE_API = 'https://api.hypixel.net/v2/skyblock/bazaar'
const DEFAULT_COOKIE_PRICE = 5000000 // 5M coins fallback
const MAX_COOKIE_PRICE = 20000000 // 20M coins maximum

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
        
        // Check if cookie is too expensive
        if (price > MAX_COOKIE_PRICE) {
            printMcChatToConsole(`§f[§4BAF§f]: §cCookie costs ${Math.round(price / 1000000)}M - too expensive, not buying`)
            log('Cookie too expensive, not buying', 'warn')
            return
        }
        
        // Check affordability based on actual cookie price
        if (purse < price * 1.5) {
            printMcChatToConsole(`§f[§4BAF§f]: §c[AutoCookie] Not enough coins to buy cookie (need ${Math.round(price / 1000000)}M, have ${Math.round(purse / 1000000)}M)`)
            log('[AutoCookie] Not enough coins to buy cookie', 'warn')
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
        
        // Wait for purchase to complete and inventory to update
        await sleep(2000)
        
        // Close any open windows
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        
        await sleep(1000)
        
        // First, try to find the cookie in the player's inventory
        log('Looking for cookie in inventory...', 'debug')
        let cookieFound = false
        
        const inventoryItems = bot.inventory.items()
        for (const item of inventoryItems) {
            if (item.name === 'cookie') {
                log(`Found cookie in inventory slot ${item.slot}`, 'debug')
                cookieFound = true
                
                // Consume the cookie from inventory
                try {
                    log('Consuming cookie from inventory...', 'info')
                    
                    // Equip the cookie to the hotbar
                    await bot.equip(item, 'hand')
                    await sleep(500)
                    
                    // Right-click to open the cookie GUI
                    bot.activateItem()
                    await sleep(1000)
                    
                    // Wait for the cookie GUI to open
                    if (bot.currentWindow) {
                        log('Cookie GUI opened, looking for consume button...', 'debug')
                        
                        // The consume button is typically in slot 11
                        await sleep(500)
                        clickWindow(bot, 11).catch(err => log(`Error clicking consume button: ${err}`, 'error'))
                        await sleep(1000)
                        
                        // Close the window
                        if (bot.currentWindow) {
                            bot.closeWindow(bot.currentWindow)
                        }
                    }
                    
                    const newCookieTimeHours = Math.round((currentCookieTime + 4 * 86400) / 3600)
                    const currentHours = Math.round(currentCookieTime / 3600)
                    
                    printMcChatToConsole(`§f[§4BAF§f]: §aAutomatically bought and consumed booster cookie!`)
                    printMcChatToConsole(`§f[§4BAF§f]: §3Cookie time: ${currentHours}h → ${newCookieTimeHours}h`)
                    log(`Successfully bought and consumed cookie. Time: ${currentHours}h → ${newCookieTimeHours}h`, 'info')
                    return
                } catch (err) {
                    log(`Error consuming cookie from inventory: ${err}`, 'error')
                    // Fall through to storage method
                }
                
                break
            }
        }
        
        // If cookie not found in inventory, check if it went to storage
        if (!cookieFound) {
            log('Cookie not in inventory, checking storage...', 'info')
            
            // Open storage to find and consume the cookie
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
            
            // Find the cookie in the storage
            if (!bot.currentWindow) {
                log('Storage window not available', 'error')
                return
            }
            
            let cookieSlot = null
            for (const slot of bot.currentWindow.slots) {
                if (slot && slot.name === 'cookie') {
                    cookieSlot = slot.slot
                    log(`Found cookie in storage slot ${cookieSlot}`, 'debug')
                    break
                }
            }
            
            if (!cookieSlot) {
                // Try looking at display names if the item name check failed
                for (const slot of bot.currentWindow.slots) {
                    if (slot && slot.nbt?.value) {
                        try {
                            const nbtValue = slot.nbt.value as any
                            if (nbtValue.display?.value?.Name?.value) {
                                const displayName = nbtValue.display.value.Name.value.toString().toLowerCase()
                                if (displayName.includes('booster cookie')) {
                                    cookieSlot = slot.slot
                                    log(`Found cookie by display name in slot ${cookieSlot}`, 'debug')
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
                log('Could not find cookie in storage either', 'warn')
                printMcChatToConsole(`§f[§4BAF§f]: §cCookie purchased but could not be found to consume`)
                if (bot.currentWindow) {
                    bot.closeWindow(bot.currentWindow)
                }
                return
            }
            
            // Click on the cookie in storage to open its detail view
            log(`Clicking cookie in storage slot ${cookieSlot}...`, 'debug')
            clickWindow(bot, cookieSlot).catch(err => log(`Error clicking cookie in storage: ${err}`, 'error'))
            
            await sleep(1000)
            
            // The cookie detail window should now be open
            // Click slot 11 to consume it directly from storage
            if (bot.currentWindow) {
                log('Consuming cookie from storage detail view...', 'debug')
                clickWindow(bot, 11).catch(err => log(`Error clicking consume in storage: ${err}`, 'error'))
                await sleep(1000)
            }
            
            // Close storage
            if (bot.currentWindow) {
                bot.closeWindow(bot.currentWindow)
            }
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
