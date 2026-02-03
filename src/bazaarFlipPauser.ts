import { log, printMcChatToConsole } from './logger'

// State management for bazaar flip pausing
let bazaarFlipsPaused = false
let pauseTimeoutHandle: NodeJS.Timeout | null = null

const PAUSE_DURATION_MS = 40000 // 40 seconds total pause around AH flip

/**
 * Check if bazaar flips are currently paused due to incoming AH flip
 */
export function areBazaarFlipsPaused(): boolean {
    return bazaarFlipsPaused
}

/**
 * Pause bazaar flips for AH flip window (40 seconds)
 * Called when AH flip message is detected
 * Only pauses if both bazaar flips and AH flips are enabled
 */
export function pauseBazaarFlips(): void {
    if (bazaarFlipsPaused) {
        // Already paused, clear existing timer and restart
        if (pauseTimeoutHandle) {
            clearTimeout(pauseTimeoutHandle)
        }
    }

    bazaarFlipsPaused = true
    printMcChatToConsole('§f[§4BAF§f]: §eAH Flips incoming, pausing bazaar flips')
    log('Bazaar flips paused for AH flip window', 'info')

    // Resume after 40 seconds
    pauseTimeoutHandle = setTimeout(() => {
        resumeBazaarFlips()
    }, PAUSE_DURATION_MS)
}

/**
 * Resume bazaar flips after AH flip window
 */
export function resumeBazaarFlips(): void {
    if (!bazaarFlipsPaused) {
        return
    }

    bazaarFlipsPaused = false
    pauseTimeoutHandle = null
    printMcChatToConsole('§f[§4BAF§f]: §acontinuing bazaar flips now')
    log('Bazaar flips resumed', 'info')
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
