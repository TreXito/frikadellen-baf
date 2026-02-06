import { log } from './logger'
import { getConfigProperty } from './configHelper'

interface AccountSwitchConfig {
    username: string
    duration: number // in minutes
}

let switchingTimer: NodeJS.Timeout | null = null
let currentAccountIndex = 0
let accountConfigs: AccountSwitchConfig[] = []
let onSwitchCallback: ((username: string) => void) | null = null

/**
 * Parses the ACCOUNTS and AUTO_SWITCHING config to create account switching schedule
 * ACCOUNTS format: "user1,user2,user3"
 * AUTO_SWITCHING format: "user1:8,user2:8,user3:8" (username:minutes)
 */
export function initAccountSwitcher(onSwitch: (username: string) => void): boolean {
    const accounts = getConfigProperty('ACCOUNTS')
    const autoSwitching = getConfigProperty('AUTO_SWITCHING')
    
    // If either is not configured, account switching is disabled
    if (!accounts || !autoSwitching) {
        log('Account switching not configured', 'info')
        return false
    }
    
    try {
        // Parse AUTO_SWITCHING string
        const switchPairs = autoSwitching.split(',').map(pair => pair.trim())
        accountConfigs = []
        
        for (const pair of switchPairs) {
            const parts = pair.split(':')
            if (parts.length !== 2) {
                log(`Invalid AUTO_SWITCHING format: ${pair}. Expected format: "username:minutes"`, 'error')
                return false
            }
            
            const username = parts[0].trim()
            const duration = parseInt(parts[1].trim())
            
            if (isNaN(duration) || duration <= 0) {
                log(`Invalid duration for ${username}: ${parts[1]}. Must be a positive number.`, 'error')
                return false
            }
            
            accountConfigs.push({ username, duration })
        }
        
        if (accountConfigs.length === 0) {
            log('No valid account configurations found', 'warn')
            return false
        }
        
        onSwitchCallback = onSwitch
        currentAccountIndex = 0
        
        log(`Account switching initialized with ${accountConfigs.length} accounts`, 'info')
        accountConfigs.forEach((config, i) => {
            log(`  Account ${i + 1}: ${config.username} for ${config.duration} minutes`, 'info')
        })
        
        // Schedule the first switch
        scheduleNextSwitch()
        return true
    } catch (error) {
        log(`Error initializing account switcher: ${error}`, 'error')
        return false
    }
}

/**
 * Schedules the next account switch based on the current account's duration
 */
function scheduleNextSwitch() {
    if (accountConfigs.length === 0 || !onSwitchCallback) {
        return
    }
    
    // Clear any existing timer
    if (switchingTimer) {
        clearTimeout(switchingTimer)
    }
    
    const currentConfig = accountConfigs[currentAccountIndex]
    const delayMs = currentConfig.duration * 60 * 1000 // Convert minutes to milliseconds
    
    log(`Next account switch in ${currentConfig.duration} minutes to account: ${accountConfigs[(currentAccountIndex + 1) % accountConfigs.length].username}`, 'info')
    
    switchingTimer = setTimeout(() => {
        performSwitch()
    }, delayMs)
}

/**
 * Performs the actual account switch
 */
function performSwitch() {
    if (accountConfigs.length === 0 || !onSwitchCallback) {
        return
    }
    
    // Move to next account
    currentAccountIndex = (currentAccountIndex + 1) % accountConfigs.length
    const nextAccount = accountConfigs[currentAccountIndex]
    
    log(`Switching to account: ${nextAccount.username}`, 'info')
    
    // Call the callback to trigger the switch
    onSwitchCallback(nextAccount.username)
    
    // Schedule the next switch
    scheduleNextSwitch()
}

/**
 * Gets the current active account username
 */
export function getCurrentAccount(): string | null {
    if (accountConfigs.length === 0) {
        return null
    }
    return accountConfigs[currentAccountIndex].username
}

/**
 * Stops the account switcher
 */
export function stopAccountSwitcher() {
    if (switchingTimer) {
        clearTimeout(switchingTimer)
        switchingTimer = null
    }
    log('Account switcher stopped', 'info')
}

/**
 * Manually triggers a switch to the next account
 */
export function switchToNextAccount() {
    if (accountConfigs.length === 0 || !onSwitchCallback) {
        log('Account switching not initialized', 'warn')
        return
    }
    
    // Cancel current timer and perform switch immediately
    if (switchingTimer) {
        clearTimeout(switchingTimer)
    }
    
    performSwitch()
}
