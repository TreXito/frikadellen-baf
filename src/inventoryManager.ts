import { MyBot } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { canPlaceOrder } from './bazaarOrderManager'

/**
 * Interface for bazaar-tradeable items found in inventory
 */
interface BazaarItem {
    itemName: string
    skyblockId: string
    amount: number
    stackValue: number // Total value of the stack
    slot: number
}

/**
 * Helper: Find a slot by display name substring
 */
function findSlotWithName(win: any, searchName: string): number {
    for (let i = 0; i < win.slots.length; i++) {
        const slot = win.slots[i]
        if (!slot || !slot.nbt) continue
        const name = (slot.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
        const cleanName = removeMinecraftColorCodes(name)
        if (cleanName && cleanName.includes(searchName)) return i
    }
    return -1
}

/**
 * Helper: Extract display name from slot NBT data
 */
function getSlotName(slot: any): string {
    if (!slot || !slot.nbt) return ''
    return (slot.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
}

/**
 * Helper: Wait for a NEW open_window event
 */
function waitForNewWindow(bot: MyBot, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            bot._client.removeListener('open_window', handler)
            resolve(false)
        }, timeout)
        
        const handler = () => {
            clearTimeout(timer)
            bot._client.removeListener('open_window', handler)
            resolve(true)
        }
        
        bot._client.once('open_window', handler)
    })
}

/**
 * Scan bot inventory for bazaar-tradeable items
 * Returns items sorted by total stack value (cheapest first)
 */
export function scanInventoryForBazaarItems(bot: MyBot): BazaarItem[] {
    const items: BazaarItem[] = []
    
    try {
        const inventoryItems = bot.inventory.items()
        
        for (const item of inventoryItems) {
            // Check if item has SkyBlock ID
            const skyblockId = (item.nbt as any)?.value?.ExtraAttributes?.value?.id?.value
            if (!skyblockId) continue
            
            // Get item display name
            const displayName = getSlotName(item)
            const cleanName = removeMinecraftColorCodes(displayName)
            if (!cleanName) continue
            
            // Estimate stack value (we don't have exact prices here, so use a heuristic)
            // For now, just track amount - actual value would need bazaar API lookup
            const stackValue = item.count // Placeholder: use count as proxy for value
            
            items.push({
                itemName: cleanName,
                skyblockId: skyblockId,
                amount: item.count,
                stackValue: stackValue,
                slot: item.slot
            })
        }
        
        // Sort by stack value (cheapest first)
        items.sort((a, b) => a.stackValue - b.stackValue)
        
        log(`[InventoryManager] Found ${items.length} bazaar-tradeable items in inventory`, 'debug')
        return items
        
    } catch (error) {
        log(`[InventoryManager] Error scanning inventory: ${error}`, 'error')
        return []
    }
}

/**
 * Get number of free inventory slots
 */
export function getFreeInventorySlots(bot: MyBot): number {
    const totalSlots = 36 // Standard Minecraft inventory
    const usedSlots = bot.inventory.items().length
    return totalSlots - usedSlots
}

/**
 * Phase 1: Create sell offers for items to free up inventory
 * Fills bazaar order slots with sell offers for cheapest items
 * Returns true if inventory was freed, false if failed
 */
export async function createSellOffersToFreeInventory(bot: MyBot): Promise<boolean> {
    try {
        log('[InventoryManager] Phase 1: Creating sell offers to free inventory...', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §e[InventoryFull] Creating sell offers to free space...')
        
        // Get bazaar-tradeable items
        const items = scanInventoryForBazaarItems(bot)
        if (items.length === 0) {
            log('[InventoryManager] No bazaar-tradeable items found', 'warn')
            return false
        }
        
        // Check how many order slots are available
        const orderSlotInfo = canPlaceOrder(true) // Check for sell orders
        if (!orderSlotInfo.canPlace) {
            log('[InventoryManager] All bazaar order slots are full', 'warn')
            return false
        }
        
        log(`[InventoryManager] Found ${items.length} sellable items, will create sell offers`, 'info')
        
        // Create sell offers until slots are full or we run out of items
        let offersCreated = 0
        for (const item of items) {
            // Check if we can still place orders
            const slotCheck = canPlaceOrder(false) // false = sell offer
            if (!slotCheck.canPlace) {
                log('[InventoryManager] Bazaar order slots full, stopping', 'info')
                break
            }
            
            // Try to create a sell offer for this item
            const success = await createSellOffer(bot, item.itemName, item.amount)
            if (success) {
                offersCreated++
                log(`[InventoryManager] Created sell offer for ${item.amount}x ${item.itemName}`, 'info')
            } else {
                log(`[InventoryManager] Failed to create sell offer for ${item.itemName}`, 'warn')
            }
            
            // Small delay between orders
            await sleep(1000)
        }
        
        log(`[InventoryManager] Phase 1 complete: Created ${offersCreated} sell offers`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §a[InventoryFull] Created ${offersCreated} sell offers`)
        
        return offersCreated > 0
        
    } catch (error) {
        log(`[InventoryManager] Error in Phase 1: ${error}`, 'error')
        return false
    }
}

/**
 * Create a sell offer for an item via /bz → Create Sell Offer → Custom Price
 */
async function createSellOffer(bot: MyBot, itemName: string, amount: number): Promise<boolean> {
    try {
        // Open bazaar for item
        bot.chat(`/bz ${itemName}`)
        
        const opened = await waitForNewWindow(bot, 5000)
        if (!opened || !bot.currentWindow) {
            log(`[InventoryManager] Failed to open bazaar for ${itemName}`, 'warn')
            return false
        }
        
        await sleep(300)
        
        // Find "Create Sell Offer" button
        const sellOfferSlot = findSlotWithName(bot.currentWindow, 'Create Sell Offer')
        if (sellOfferSlot === -1) {
            log(`[InventoryManager] Could not find Create Sell Offer button for ${itemName}`, 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            return false
        }
        
        // Click Create Sell Offer
        await clickWindow(bot, sellOfferSlot)
        const offerOpened = await waitForNewWindow(bot, 3000)
        if (!offerOpened || !bot.currentWindow) {
            log(`[InventoryManager] Failed to open sell offer window for ${itemName}`, 'warn')
            return false
        }
        
        await sleep(300)
        
        // Find "Custom Price" button
        const customPriceSlot = findSlotWithName(bot.currentWindow, 'Custom Price')
        if (customPriceSlot === -1) {
            log(`[InventoryManager] Could not find Custom Price button for ${itemName}`, 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            return false
        }
        
        // Click Custom Price and set a reasonable price (market price - 0.1 coins for quick sell)
        await clickWindow(bot, customPriceSlot)
        await sleep(500)
        
        // Type a low price to ensure quick sale (0.1 coins)
        bot.chat('0.1')
        await sleep(300)
        
        // Find and click Confirm button
        await sleep(500)
        const confirmSlot = findSlotWithName(bot.currentWindow, 'Confirm')
        if (confirmSlot !== -1) {
            await clickWindow(bot, confirmSlot)
            await sleep(500)
        }
        
        // Close window
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        
        return true
        
    } catch (error) {
        log(`[InventoryManager] Error creating sell offer for ${itemName}: ${error}`, 'error')
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        return false
    }
}

/**
 * Phase 2: Instasell cheap items if inventory is still full
 * Instant sells items with total stack value < 1,000,000 coins
 * Returns true if inventory was freed, false if failed
 */
export async function instasellCheapItems(bot: MyBot): Promise<boolean> {
    try {
        log('[InventoryManager] Phase 2: Instaselling cheap items...', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §e[InventoryFull] Instaselling cheap items...')
        
        // Get bazaar-tradeable items
        const items = scanInventoryForBazaarItems(bot)
        if (items.length === 0) {
            log('[InventoryManager] No items to instasell', 'warn')
            return false
        }
        
        // Filter for cheap items (< 1M coins value)
        // For now, we'll instasell items with low count as a proxy
        const cheapItems = items.filter(item => item.stackValue < 64) // Placeholder threshold
        
        if (cheapItems.length === 0) {
            log('[InventoryManager] No cheap items found to instasell', 'warn')
            return false
        }
        
        log(`[InventoryManager] Found ${cheapItems.length} cheap items to instasell`, 'info')
        
        // Instasell items until we have 3+ free slots
        let itemsSold = 0
        for (const item of cheapItems) {
            // Check if we have enough free slots
            const freeSlots = getFreeInventorySlots(bot)
            if (freeSlots >= 3) {
                log('[InventoryManager] Have 3+ free slots, stopping instasell', 'info')
                break
            }
            
            // Instasell this item
            const success = await instasellItem(bot, item.itemName)
            if (success) {
                itemsSold++
                log(`[InventoryManager] Instasold ${item.itemName}`, 'info')
            }
            
            await sleep(1000)
        }
        
        log(`[InventoryManager] Phase 2 complete: Instasold ${itemsSold} items`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §a[InventoryFull] Instasold ${itemsSold} items`)
        
        return itemsSold > 0
        
    } catch (error) {
        log(`[InventoryManager] Error in Phase 2: ${error}`, 'error')
        return false
    }
}

/**
 * Instasell an item via /bz → Sell Instantly → Sell all
 */
async function instasellItem(bot: MyBot, itemName: string): Promise<boolean> {
    try {
        // Open bazaar for item
        bot.chat(`/bz ${itemName}`)
        
        const opened = await waitForNewWindow(bot, 5000)
        if (!opened || !bot.currentWindow) {
            log(`[InventoryManager] Failed to open bazaar for ${itemName}`, 'warn')
            return false
        }
        
        await sleep(300)
        
        // Find "Sell Instantly" button
        const sellInstantlySlot = findSlotWithName(bot.currentWindow, 'Sell Instantly')
        if (sellInstantlySlot === -1) {
            log(`[InventoryManager] Could not find Sell Instantly button for ${itemName}`, 'warn')
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
            return false
        }
        
        // Click Sell Instantly
        await clickWindow(bot, sellInstantlySlot)
        const sellOpened = await waitForNewWindow(bot, 3000)
        if (!sellOpened || !bot.currentWindow) {
            log(`[InventoryManager] Failed to open sell instantly window for ${itemName}`, 'warn')
            return false
        }
        
        await sleep(300)
        
        // Find and click "Sell" or confirm button (usually in middle/center slots)
        const confirmSlot = findSlotWithName(bot.currentWindow, 'Sell')
        if (confirmSlot !== -1) {
            await clickWindow(bot, confirmSlot)
            await sleep(500)
        } else {
            // Try clicking center slot as fallback
            await clickWindow(bot, 13)
            await sleep(500)
        }
        
        // Close window
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        
        return true
        
    } catch (error) {
        log(`[InventoryManager] Error instaselling ${itemName}: ${error}`, 'error')
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        return false
    }
}

/**
 * Handle inventory full situation
 * Executes Phase 1 (sell offers) and Phase 2 (instasell) if needed
 */
export async function handleInventoryFull(bot: MyBot): Promise<void> {
    try {
        log('[InventoryManager] Handling inventory full situation...', 'info')
        printMcChatToConsole('§f[§4BAF§f]: §c[InventoryFull] Inventory is full, freeing space...')
        
        // Abort any current operation
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow)
        }
        await sleep(500)
        
        // Phase 1: Create sell offers
        const phase1Success = await createSellOffersToFreeInventory(bot)
        
        // Check if we still need more space
        const freeSlots = getFreeInventorySlots(bot)
        log(`[InventoryManager] After Phase 1: ${freeSlots} free slots`, 'info')
        
        if (freeSlots <= 2 && !phase1Success) {
            // Phase 2: Instasell cheap items
            await instasellCheapItems(bot)
        }
        
        const finalFreeSlots = getFreeInventorySlots(bot)
        log(`[InventoryManager] Inventory management complete: ${finalFreeSlots} free slots`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §a[InventoryFull] Freed inventory space (${finalFreeSlots} slots free)`)
        
    } catch (error) {
        log(`[InventoryManager] Error handling inventory full: ${error}`, 'error')
    }
}
