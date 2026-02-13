import { MyBot } from '../types/autobuy'
import { log } from './logger'
import { clickWindow, sleep, removeMinecraftColorCodes, getItemDisplayName } from './utils'

// Constants for fuzzy matching
const MIN_LEVENSHTEIN_DISTANCE = 2 // Minimum Levenshtein distance to allow
const FUZZY_MATCH_THRESHOLD = 0.2 // Allow 20% character difference for fuzzy matching
const MIN_STRING_LENGTH_FOR_FUZZY = 5 // Don't use fuzzy matching for very short strings (< 5 chars)

/**
 * Helper to get slot name from NBT data (BUG 2 FIX - Enhanced)
 * Uses getItemDisplayName() to correctly read SkyBlock display names
 */
export function getSlotName(slot: any): string {
    if (!slot || !slot.nbt) return ''
    
    // Use getItemDisplayName() for consistent NBT name extraction
    const displayName = getItemDisplayName(slot)
    if (displayName && displayName !== 'Unknown') return displayName
    
    // Fallback to direct NBT read if getItemDisplayName() didn't work
    return (slot.nbt as any)?.value?.display?.value?.Name?.value?.toString() || ''
}

/**
 * Helper to find slot by name
 */
export function findSlotWithName(win: any, searchName: string): number {
    for (let i = 0; i < win.slots.length; i++) {
        const slot = win.slots[i]
        const name = removeMinecraftColorCodes(getSlotName(slot))
        if (name && name.includes(searchName)) return i
    }
    return -1
}

/**
 * BUG 1: Find item in search results with exact match priority, then fuzzy fallback
 * Returns slot index or -1 if not found
 * Logs all available items if no exact match found
 */
export function findItemInSearchResults(window: any, itemName: string): number {
    const cleanTarget = removeMinecraftColorCodes(itemName).replace(/[☘☂✪◆❤]/g, '').toLowerCase().trim()
    
    let bestSlot = -1
    let bestScore = 0
    const allSlotNames: string[] = []
    const slotData: Array<{ slot: number, name: string }> = []
    
    // Phase 1: Try exact match (highest priority)
    for (let i = 0; i < window.slots.length; i++) {
        const slot = window.slots[i]
        if (!slot || !slot.nbt) continue
        const slotName = removeMinecraftColorCodes(getSlotName(slot)).replace(/[☘☂✪◆❤]/g, '').toLowerCase().trim()
        
        if (!slotName || slotName === '' || slotName === 'close') continue
        
        // Track all slot names for logging
        allSlotNames.push(slotName)
        slotData.push({ slot: i, name: slotName })
        
        // Exact match — return immediately
        if (slotName === cleanTarget) {
            log(`[BAF] Found exact match for "${itemName}" at slot ${i}`, 'info')
            return i
        }
    }
    
    // Phase 2: Try token-based matching (all words present)
    const targetTokens = cleanTarget.split(/\s+/).filter(t => t.length > 0)
    for (const { slot, name } of slotData) {
        if (targetTokens.every(token => name.includes(token))) {
            log(`[BAF] Found token match for "${itemName}" at slot ${slot} (${name})`, 'info')
            return slot
        }
    }
    
    // Phase 3: Try partial matching (substring containment)
    for (const { slot, name } of slotData) {
        if (name.includes(cleanTarget) || cleanTarget.includes(name)) {
            log(`[BAF] Found partial match for "${itemName}" at slot ${slot} (${name})`, 'info')
            return slot
        }
    }
    
    // Phase 4: Try fuzzy matching with Levenshtein distance (only for strings >= 5 chars)
    if (cleanTarget.length >= MIN_STRING_LENGTH_FOR_FUZZY) {
        const maxDistance = Math.max(MIN_LEVENSHTEIN_DISTANCE, Math.floor(cleanTarget.length * FUZZY_MATCH_THRESHOLD))
        for (const { slot, name } of slotData) {
            const distance = levenshteinDistance(cleanTarget, name)
            if (distance <= maxDistance && (bestSlot === -1 || distance < bestScore)) {
                bestSlot = slot
                bestScore = distance
            }
        }
        
        if (bestSlot !== -1) {
            log(`[BAF] Found fuzzy match for "${itemName}" at slot ${bestSlot} (${slotData.find(s => s.slot === bestSlot)?.name}) with distance ${bestScore}`, 'info')
            return bestSlot
        }
    } else {
        log(`[BAF] Skipping fuzzy match for short string "${itemName}" (length: ${cleanTarget.length})`, 'debug')
    }
    
    // No match found at all
    log(`[BAF] No match for "${itemName}" in search results — found: [${allSlotNames.join(', ')}]`, 'warn')
    return -1
}

/**
 * Calculate Levenshtein distance between two strings
 * Used for fuzzy matching in bazaar search
 */
function levenshteinDistance(a: string, b: string): number {
    if (a.length === 0) return b.length
    if (b.length === 0) return a.length
    
    const matrix: number[][] = []
    
    // Initialize matrix
    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i]
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j
    }
    
    // Fill matrix
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1]
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                )
            }
        }
    }
    
    return matrix[b.length][a.length]
}

/**
 * Helper to wait for a NEW open_window event
 */
export function waitForNewWindow(bot: MyBot, timeout: number): Promise<boolean> {
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
 * Snapshot key slots for change detection
 */
function snapshotSlots(window: any): string[] {
    const snapshot: string[] = []
    for (let i = 0; i < Math.min(54, window.slots.length); i++) {
        const slot = window.slots[i]
        snapshot.push(slot?.name || 'empty')
    }
    return snapshot
}

/**
 * Poll until window slots differ from snapshot
 */
async function waitForWindowChange(bot: MyBot, beforeSlots: string[], timeout: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeout) {
        if (!bot.currentWindow) return true // window closed = changed
        const current = snapshotSlots(bot.currentWindow)
        // Check if any of the first 54 slots changed
        for (let i = 0; i < current.length; i++) {
            if (current[i] !== beforeSlots[i]) return true
        }
        await sleep(50)
    }
    return false
}

/**
 * BUG 2: Click a slot and wait for a NEW window to open.
 * Retries the click if the window doesn't open within timeout.
 */
export async function clickAndWaitForWindow(bot: MyBot, slot: number, timeout = 1000, maxRetries = 2): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const windowPromise = waitForNewWindow(bot, timeout)
        await clickWindow(bot, slot).catch(() => {})
        const opened = await windowPromise
        
        if (opened && bot.currentWindow) return true
        
        if (attempt <= maxRetries) {
            log(`[BAF] Window didn't open after clicking slot ${slot}, retrying (${attempt}/${maxRetries})`, 'debug')
            await sleep(50)
        }
    }
    return false
}

/**
 * BUG 2: Click a slot and wait for the SAME window to update.
 * Detects update by checking if slot contents change.
 * Retries click if nothing changes.
 */
export async function clickAndWaitForUpdate(bot: MyBot, slot: number, timeout = 800, maxRetries = 2): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (!bot.currentWindow) return false
        
        // Snapshot a few key slots to detect changes
        const beforeSlots = snapshotSlots(bot.currentWindow)
        
        await clickWindow(bot, slot).catch(() => {})
        
        // Poll for window content change
        const changed = await waitForWindowChange(bot, beforeSlots, timeout)
        
        if (changed) return true
        
        if (attempt <= maxRetries) {
            log(`[BAF] Window didn't update after clicking slot ${slot}, retrying (${attempt}/${maxRetries})`, 'debug')
            await sleep(50)
        }
    }
    return false
}

/**
 * BUG 2: Find a button by name and click it. Retry finding if not found immediately.
 * Sometimes the window loads slowly and buttons appear after a delay.
 */
export async function findAndClick(bot: MyBot, buttonName: string, opts: {
    waitForNewWindow?: boolean,
    timeout?: number,
    maxRetries?: number
} = {}): Promise<boolean> {
    const { waitForNewWindow: expectNewWindow = false, timeout = 1000, maxRetries = 2 } = opts
    
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (!bot.currentWindow) return false
        
        // Try to find the button — poll briefly if not found
        let slot = -1
        const findStart = Date.now()
        while (slot === -1 && Date.now() - findStart < 600) {
            slot = findSlotWithName(bot.currentWindow, buttonName)
            if (slot === -1) await sleep(50)
        }
        
        if (slot === -1) {
            if (attempt <= maxRetries) {
                log(`[BAF] Button "${buttonName}" not found, retrying (${attempt}/${maxRetries})`, 'debug')
                await sleep(50)
                continue
            }
            log(`[BAF] Button "${buttonName}" not found after ${maxRetries + 1} attempts`, 'warn')
            return false
        }
        
        if (expectNewWindow) {
            const success = await clickAndWaitForWindow(bot, slot, timeout, 0) // don't double-retry
            if (success) return true
        } else {
            const success = await clickAndWaitForUpdate(bot, slot, timeout, 0)
            if (success) return true
        }
        
        if (attempt <= maxRetries) {
            log(`[BAF] Click on "${buttonName}" didn't produce expected result, retrying (${attempt}/${maxRetries})`, 'debug')
            await sleep(50)
        }
    }
    return false
}

/**
 * BUG 2: Register sign listener BEFORE clicking, then click and wait for sign.
 * Retries if sign doesn't open.
 */
export async function clickAndWaitForSign(bot: MyBot, slot: number, value: string, timeout = 600, maxRetries = 3): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        const attemptStartTime = Date.now()
        
        // Register sign handler BEFORE clicking
        const signPromise = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                bot._client.removeListener('open_sign_entity', handler)
                const elapsed = Date.now() - attemptStartTime
                log(`[BAF] Sign timeout after ${elapsed}ms (attempt ${attempt}/${maxRetries + 1})`, 'debug')
                resolve(false)
            }, timeout)
            
            const handler = ({ location }: any) => {
                clearTimeout(timer)
                const elapsed = Date.now() - attemptStartTime
                log(`[BAF] Sign opened successfully in ${elapsed}ms, setting value: ${value}`, 'debug')
                bot._client.write('update_sign', {
                    location,
                    text1: `\"${value}\"`,
                    text2: '{"italic":false,"extra":["^^^^^^^^^^^^^^^"],"text":""}',
                    text3: '{"italic":false,"extra":[""],"text":""}',
                    text4: '{"italic":false,"extra":[""],"text":""}'
                })
                resolve(true)
            }
            
            bot._client.once('open_sign_entity', handler)
        })
        
        await clickWindow(bot, slot).catch(() => {})
        const signed = await signPromise
        
        if (signed) return true
        
        if (attempt <= maxRetries) {
            log(`[BAF] Sign didn't open after clicking slot ${slot}, retrying (${attempt}/${maxRetries})`, 'debug')
            await sleep(100)
        }
    }
    log(`[BAF] Failed to open sign after ${maxRetries + 1} attempts for slot ${slot}`, 'warn')
    return false
}
