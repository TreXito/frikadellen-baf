import { MyBot } from '../types/autobuy'
import { log } from './logger'
import { clickWindow, sleep, removeMinecraftColorCodes } from './utils'
import { areAHFlipsPending } from './bazaarFlipPauser'

/**
 * Helper to get slot name from NBT data
 */
export function getSlotName(slot: any): string {
    if (!slot || !slot.nbt) return ''
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
 * BUG 1: Find item in search results with exact match priority
 * Returns slot index or -1 if not found
 * Logs all available items if no exact match found
 */
export function findItemInSearchResults(window: any, itemName: string): number {
    const cleanTarget = removeMinecraftColorCodes(itemName).replace(/[☘☂✪◆❤]/g, '').toLowerCase().trim()
    
    let bestSlot = -1
    let bestScore = 0
    const allSlotNames: string[] = []
    
    for (let i = 0; i < window.slots.length; i++) {
        const slot = window.slots[i]
        if (!slot || !slot.nbt) continue
        const slotName = removeMinecraftColorCodes(getSlotName(slot)).replace(/[☘☂✪◆❤]/g, '').toLowerCase().trim()
        
        if (!slotName || slotName === '' || slotName === 'close') continue
        
        // Track all slot names for logging
        allSlotNames.push(slotName)
        
        // Exact match — return immediately
        if (slotName === cleanTarget) {
            log(`[BAF] Found exact match for "${itemName}" at slot ${i}`, 'info')
            return i
        }
    }
    
    // BUG 1: If no exact match found, log the mismatch and return -1
    if (bestSlot === -1) {
        log(`[BAF] No exact match for "${itemName}" in search results — found: [${allSlotNames.join(', ')}]`, 'warn')
    }
    
    return bestSlot
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
        if (areAHFlipsPending()) return false
        
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
        if (areAHFlipsPending()) return false
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
        if (areAHFlipsPending()) return false
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
export async function clickAndWaitForSign(bot: MyBot, slot: number, value: string, timeout = 300, maxRetries = 2): Promise<boolean> {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
        if (areAHFlipsPending()) return false
        
        // Register sign handler BEFORE clicking
        const signPromise = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
                bot._client.removeListener('open_sign_entity', handler)
                resolve(false)
            }, timeout)
            
            const handler = ({ location }: any) => {
                clearTimeout(timer)
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
            await sleep(50)
        }
    }
    return false
}
