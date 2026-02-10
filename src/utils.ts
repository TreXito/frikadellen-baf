export async function clickWindow(bot, slot: number) {
    try {
        // Import log function inline to avoid circular dependencies
        const { log, printMcChatToConsole } = require('./logger')
        
        // Get item name at this slot for better debugging
        let itemName = 'Unknown'
        if (bot.currentWindow && bot.currentWindow.slots[slot]) {
            const slotItem = bot.currentWindow.slots[slot]
            if (slotItem && slotItem.nbt) {
                const displayName = (slotItem.nbt as any)?.value?.display?.value?.Name?.value?.toString()
                if (displayName) {
                    itemName = removeMinecraftColorCodes(displayName)
                }
            }
            if (itemName === 'Unknown' && slotItem) {
                itemName = slotItem.name || 'Air'
            }
        }
        
        log(`[BazaarDebug] Clicking slot ${slot} | Item: ${itemName} | Window: ${bot.currentWindow ? getWindowTitle(bot.currentWindow) : 'None'}`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7[Click] Slot §b${slot}§7 | Item: §e${itemName}`)
        
        return await bot.clickWindow(slot, 0, 0)
    } catch (error) {
        // Import log function inline to avoid circular dependencies
        const { log } = require('./logger')
        log(`Error clicking window slot ${slot}: ${error}`, 'error')
        throw error
    }
}

export async function sleep(ms: number): Promise<void> {
    return await new Promise(resolve => setTimeout(resolve, ms))
}

export function getWindowTitle(window) {
    if (window.title) {
        let parsed = JSON.parse(window.title)
        return parsed.extra ? parsed['extra'][0]['text'] : parsed.translate
    }
    if (window.windowTitle) {
        return JSON.parse(window.windowTitle)['extra'][0]['text']
    }
    return ''
}

export function numberWithThousandsSeparators(number?: number): string {
    if (!number) {
        return '0'
    }
    var parts = number.toString().split('.')
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    return parts.join('.')
}

export function isCoflChatMessage(message: string) {
    return removeMinecraftColorCodes(message).startsWith('[Chat]')
}

export function removeMinecraftColorCodes(text: string) {
    return text?.replace(/§[0-9a-fk-or]/gi, '')
}

export function isSkin(itemName: string): boolean {
    const lowerName = itemName?.toLowerCase() || ''
    return lowerName.includes('skin') || lowerName.includes('✦')
}

export function formatInventoryForUpload(inventory: any): any[] {
    // Format inventory items to include display names like SkyCrypt does
    const formattedItems = inventory.items().map((item: any) => {
        if (!item) return null
        
        const itemData: any = {
            type: item.type,
            count: item.count,
            metadata: item.metadata,
            slot: item.slot
        }
        
        // Extract display name from NBT if available
        try {
            if (item.nbt?.value?.display?.value?.Name?.value) {
                itemData.displayName = removeMinecraftColorCodes(item.nbt.value.display.value.Name.value)
            }
            
            // Extract lore from NBT if available
            if (item.nbt?.value?.display?.value?.Lore?.value?.value) {
                itemData.lore = item.nbt.value.display.value.Lore.value.value.map((line: string) => 
                    removeMinecraftColorCodes(line)
                )
            }
            
            // Extract extra attributes for SkyBlock items
            if (item.nbt?.value?.ExtraAttributes?.value) {
                const extraAttrs = item.nbt.value.ExtraAttributes.value
                itemData.extraAttributes = {}
                
                // Include common SkyBlock attributes
                if (extraAttrs.id?.value) itemData.extraAttributes.id = extraAttrs.id.value
                if (extraAttrs.uuid?.value) itemData.extraAttributes.uuid = extraAttrs.uuid.value
                if (extraAttrs.timestamp?.value) itemData.extraAttributes.timestamp = extraAttrs.timestamp.value
                if (extraAttrs.rarity_upgrades?.value !== undefined) itemData.extraAttributes.rarity_upgrades = extraAttrs.rarity_upgrades.value
            }
        } catch (e) {
            // If NBT parsing fails, just use basic item data
            // Import log function inline to avoid circular dependencies
            const { log } = require('./logger')
            log(`Warning: Failed to parse NBT data for item ${item.type}: ${e}`, 'debug')
        }
        
        return itemData
    }).filter((item: any) => item !== null)
    
    return formattedItems
}

/**
 * Extracts lore from a slot item
 * @param slot The slot item to extract lore from
 * @returns Array of lore lines or empty array if no lore
 */
export function getSlotLore(slot: any): string[] {
    if (!slot || !slot.nbt) return []
    
    try {
        const lore = slot.nbt.value?.display?.value?.Lore?.value?.value
        if (lore && Array.isArray(lore)) {
            return lore.map((line: string) => line.toString())
        }
    } catch (e) {
        // Import log function inline to avoid circular dependencies
        const { log } = require('./logger')
        log(`Failed to parse lore from slot: ${e}`, 'debug')
    }
    
    return []
}

/**
 * Calculates the auction house fee based on the sale/target price
 * @param price The sale or target price of the item
 * @returns The auction house fee amount
 * 
 * Fee structure:
 * - 1% for items smaller than 10m
 * - 2% for items smaller than 100m
 * - 2.5% for items over 100m
 */
export function calculateAuctionHouseFee(price: number): number {
    if (price < 10_000_000) {
        return price * 0.01 // 1%
    } else if (price < 100_000_000) {
        return price * 0.02 // 2%
    } else {
        return price * 0.025 // 2.5%
    }
}
