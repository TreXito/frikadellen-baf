import { log, printMcChatToConsole } from './logger'
import { BazaarFlipRecommendation, MyBot } from '../types/autobuy'
import { abortOrderManagement } from './bazaarOrderManager'

// State management for bazaar flip pausing
let bazaarFlipsPaused = false
let pauseTimeoutHandle: NodeJS.Timeout | null = null
let queuedBazaarFlips: Array<{ bot: MyBot, recommendation: BazaarFlipRecommendation }> = []

// BUG 3: AH flips pending flag
let ahFlipsPending = false
let ahFlipsPendingTimeout: NodeJS.Timeout | null = null

const PAUSE_DURATION_MS = 20000 // 20 seconds - pause starts when "flips in 10 seconds" appears, resumes 20 seconds after
const AH_FLIP_PENDING_TIMEOUT_MS = 30000 // 30 seconds - clear ahFlipsPending after this time

/**
 * Check if bazaar flips are currently paused due to incoming AH flip
 */
export function areBazaarFlipsPaused(): boolean {
    return bazaarFlipsPaused
}

/**
 * BUG 3: Check if AH flips are pending (incoming)
 * This flag is set immediately when "flips in 10 seconds" is detected
 * and cleared after purchase or 30s timeout
 */
export function areAHFlipsPending(): boolean {
    return ahFlipsPending
}

/**
 * BUG 3: Set the AH flips pending flag
 * Called when AH flip message is detected
 */
export function setAHFlipsPending(): void {
    ahFlipsPending = true
    log('[BAF] AH flips pending flag set', 'info')
    
    // Clear existing timeout
    if (ahFlipsPendingTimeout) {
        clearTimeout(ahFlipsPendingTimeout)
    }
    
    // Auto-clear after 30 seconds if not cleared manually
    ahFlipsPendingTimeout = setTimeout(() => {
        ahFlipsPending = false
        log('[BAF] AH flips pending flag cleared (30s timeout)', 'info')
    }, AH_FLIP_PENDING_TIMEOUT_MS)
}

/**
 * BUG 3: Clear the AH flips pending flag
 * Called after AH flip purchase completes
 */
export function clearAHFlipsPending(): void {
    ahFlipsPending = false
    
    if (ahFlipsPendingTimeout) {
        clearTimeout(ahFlipsPendingTimeout)
        ahFlipsPendingTimeout = null
    }
    
    log('[BAF] AH flips pending flag cleared', 'info')
}

/**
 * Pause bazaar flips for AH flip window (20 seconds)
 * Called when AH flip message is detected (e.g., "flips in 10 seconds")
 * Resumes 20 seconds after the message appears
 * Only pauses if both bazaar flips and AH flips are enabled
 */
export function pauseBazaarFlips(bot?: MyBot): void {
    if (bazaarFlipsPaused) {
        // Already paused, clear existing timer and restart
        if (pauseTimeoutHandle) {
            clearTimeout(pauseTimeoutHandle)
        }
    }

    // BUG 3: Set ahFlipsPending flag immediately
    setAHFlipsPending()

    // Abort any active order management to prioritize AH flips
    // Pass false to skip abort if critical order management is in progress (cancel+re-list)
    if (bot) {
        abortOrderManagement(bot, false) // false = non-forced abort, respects critical operations
    }

    bazaarFlipsPaused = true
    printMcChatToConsole('§f[§4BAF§f]: §eAH Flips incoming, pausing bazaar flips')
    log('Bazaar flips paused for AH flip window', 'info')

    // Resume after 20 seconds
    pauseTimeoutHandle = setTimeout(() => {
        resumeBazaarFlips()
    }, PAUSE_DURATION_MS)
}

/**
 * Resume bazaar flips after AH flip window
 * Processes any queued bazaar flips that came in during the pause
 */
export function resumeBazaarFlips(): void {
    if (!bazaarFlipsPaused) {
        return
    }

    bazaarFlipsPaused = false
    pauseTimeoutHandle = null
    
    const queueSize = queuedBazaarFlips.length
    if (queueSize > 0) {
        printMcChatToConsole(`§f[§4BAF§f]: §acontinuing bazaar flips now (processing ${queueSize} queued flip${queueSize > 1 ? 's' : ''})`)
        log(`Bazaar flips resumed - processing ${queueSize} queued flip(s)`, 'info')
        processQueuedBazaarFlips()
    } else {
        printMcChatToConsole('§f[§4BAF§f]: §acontinuing bazaar flips now')
        log('Bazaar flips resumed', 'info')
    }
}

/**
 * Check if a message indicates an incoming AH flip and pause bazaar flips if needed
 * Only pauses if both bazaar flips and AH flips are enabled
 * @param message The message text to check
 * @param bot The Minecraft bot instance (optional, used to abort order management)
 */
export function checkAndPauseForAHFlip(message: string, enableBazaarFlips: boolean, enableAHFlips: boolean, bot?: MyBot): void {
    // BUG FIX #3: Don't pause during startup phase
    if (bot && bot.state === 'startup') {
        return
    }
    
    if (isAHFlipIncomingMessage(message)) {
        log('Detected AH flip incoming message', 'info')
        if (enableBazaarFlips && enableAHFlips) {
            pauseBazaarFlips(bot)
        }
    }
}

/**
 * Detect if a message indicates an incoming AH flip
 * Looks for patterns like "flips in 10 seconds", "flip in X seconds", etc.
 */
export function isAHFlipIncomingMessage(message: string): boolean {
    const lowerMessage = message.toLowerCase()
    
    // Common patterns for AH flip notifications
    const patterns = [
        /flip.*in.*\d+.*second/i,  // "flip in 10 seconds", "flips in 5 seconds"
        /\d+.*second.*flip/i,      // "10 seconds until flip"
        /incoming.*flip/i,         // "incoming flip"
        /flip.*incoming/i          // "flip incoming"
    ]

    return patterns.some(pattern => pattern.test(lowerMessage))
}

/**
 * Queue a bazaar flip recommendation to be processed when bazaar flips resume
 * Called when a bazaar flip comes in while bazaar flips are paused
 * @param bot The Minecraft bot instance
 * @param recommendation The bazaar flip recommendation to queue
 */
export function queueBazaarFlip(bot: MyBot, recommendation: BazaarFlipRecommendation): void {
    queuedBazaarFlips.push({ bot, recommendation })
    log(`[BazaarDebug] Queued bazaar flip: ${recommendation.amount}x ${recommendation.itemName} (${queuedBazaarFlips.length} in queue)`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §eQueued bazaar flip: ${recommendation.amount}x ${recommendation.itemName} §7(${queuedBazaarFlips.length} in queue)`)
}

/**
 * Process all queued bazaar flips
 * Called when bazaar flips resume after being paused
 * Flips are processed in FIFO order (first in, first out)
 */
function processQueuedBazaarFlips(): void {
    // Import here to avoid circular dependency
    const { handleBazaarFlipRecommendation } = require('./bazaarFlipHandler')
    
    // Clear the queue first to avoid race condition where new flips arrive during processing
    const flipsToProcess = queuedBazaarFlips
    queuedBazaarFlips = []
    
    log(`[BazaarDebug] Processing ${flipsToProcess.length} queued bazaar flip(s)`, 'info')
    
    // Process each queued flip in order
    for (const { bot, recommendation } of flipsToProcess) {
        log(`[BazaarDebug] Processing queued flip: ${recommendation.amount}x ${recommendation.itemName}`, 'info')
        handleBazaarFlipRecommendation(bot, recommendation)
    }
}
