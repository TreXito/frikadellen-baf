import { MyBot } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'
import { areAHFlipsPending } from './bazaarFlipPauser'

/**
 * Priority levels for queued commands
 * Lower numbers = higher priority
 */
export enum CommandPriority {
    CRITICAL = 1, // Emergency operations, AFK responses (AH flips achieve priority via interruption)
    HIGH = 2,     // Cookie checks, order management
    NORMAL = 3,   // Bazaar flips
    LOW = 4       // Maintenance
}

/**
 * Represents a queued command
 */
interface QueuedCommand {
    id: string
    name: string
    priority: CommandPriority
    execute: () => Promise<void>
    queuedAt: number
    interruptible?: boolean // If true, can be interrupted by higher priority commands
}

// Command queue with priority ordering
let commandQueue: QueuedCommand[] = []

// Flag to track if queue is currently processing
let isProcessing = false

// Currently executing command (for interruption support)
let currentCommand: QueuedCommand | null = null

// Global command counter for unique IDs
let commandIdCounter = 0

// Flag to track if queue is initialized
let queueInitialized = false

// Constants for bazaar queue management
const MAX_BAZAAR_QUEUE_SIZE = 3
const BAZAAR_RECOMMENDATION_MAX_AGE_MS = 60000 // 60 seconds

/**
 * Initialize the command queue system
 * Must be called before any commands are queued
 */
export function initCommandQueue(bot: MyBot): void {
    if (queueInitialized) {
        log('[CommandQueue] Already initialized', 'debug')
        return
    }
    
    queueInitialized = true
    log('[CommandQueue] Initialized command queue system', 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[CommandQueue] Command queue initialized`)
    
    // Start queue processor
    processQueue(bot)
}

/**
 * Add a command to the queue
 * @param name Human-readable name for logging
 * @param priority Priority level (lower = higher priority)
 * @param execute Async function to execute
 * @param interruptible If true, can be interrupted by higher priority commands
 * @param itemName Optional item name for duplicate checking (bazaar operations)
 * @returns Command ID for tracking, or null if rejected
 */
export function enqueueCommand(
    name: string,
    priority: CommandPriority,
    execute: () => Promise<void>,
    interruptible: boolean = false,
    itemName?: string
): string | null {
    // Queue limit check only for NORMAL priority bazaar commands (buy orders)
    // HIGH priority bazaar commands (sell offers) bypass the queue limit
    if (priority === CommandPriority.NORMAL && name.startsWith('Bazaar ')) {
        // Count existing bazaar commands in queue
        const bazaarCommandCount = commandQueue.filter(cmd => 
            cmd.priority === CommandPriority.NORMAL && cmd.name.startsWith('Bazaar ')
        ).length
        
        if (bazaarCommandCount >= MAX_BAZAAR_QUEUE_SIZE) {
            log(`[BAF] Bazaar queue full (${bazaarCommandCount}/${MAX_BAZAAR_QUEUE_SIZE}), skipping buy order: ${name}`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §c[BAF] Bazaar queue full, skipping buy order`)
            return null
        }
        
        // BUG 2: Check for duplicate items in queue
        if (itemName) {
            const duplicateInQueue = commandQueue.some(cmd => 
                cmd.priority === CommandPriority.NORMAL && 
                cmd.name.startsWith('Bazaar ') && 
                cmd.name.includes(itemName)
            )
            
            if (duplicateInQueue) {
                log(`[BAF] Already have order/queue entry for ${itemName}, skipping`, 'info')
                printMcChatToConsole(`§f[§4BAF§f]: §e[BAF] Already queued: ${itemName}`)
                return null
            }
        }
    }
    
    // HIGH priority bazaar commands (sell offers) skip queue limit checks entirely
    // They always get queued since they free up inventory space
    
    commandIdCounter++
    const id = `cmd_${commandIdCounter}`
    
    const command: QueuedCommand = {
        id,
        name,
        priority,
        execute,
        queuedAt: Date.now(),
        interruptible
    }
    
    // Insert command in priority order (lower priority value = higher actual priority)
    // Within same priority, maintain FIFO order
    let insertIndex = commandQueue.length
    for (let i = 0; i < commandQueue.length; i++) {
        if (commandQueue[i].priority > priority) {
            insertIndex = i
            break
        }
    }
    
    commandQueue.splice(insertIndex, 0, command)
    
    const queueDepth = commandQueue.length
    const priorityName = CommandPriority[priority]
    log(`[CommandQueue] Queued: ${name} (priority: ${priorityName}, interruptible: ${interruptible}, queue depth: ${queueDepth})`, 'info')
    
    if (queueDepth > 5) {
        log(`[CommandQueue] WARNING: Queue depth is ${queueDepth}, commands may be delayed`, 'warn')
        printMcChatToConsole(`§f[§4BAF§f]: §e[CommandQueue] ${queueDepth} commands in queue`)
    }
    
    return id
}

/**
 * Process commands from the queue
 * Automatically runs continuously, processing one command at a time
 */
async function processQueue(bot: MyBot): Promise<void> {
    // Run continuously
    while (true) {
        if (commandQueue.length === 0) {
            // No commands to process, wait and check again
            await sleep(100)
            continue
        }
        
        if (isProcessing) {
            // Already processing a command, wait
            await sleep(100)
            continue
        }
        
        // Check if bot is in grace period
        if (bot.state === 'gracePeriod') {
            // Don't process commands during grace period
            await sleep(500)
            continue
        }
        
        // Check if bot is in purchasing state (AH flip in progress)
        // This is the ONLY state that should block everything
        if (bot.state === 'purchasing') {
            // Wait for AH flip to complete
            await sleep(200)
            continue
        }
        
        // BUG 3: Pause queue while AH flips are pending
        if (areAHFlipsPending()) {
            // Don't process any commands while AH flip is incoming
            await sleep(200)
            continue
        }
        
        // Get next command (highest priority first)
        const command = commandQueue.shift()
        if (!command) {
            continue
        }
        
        // BUG 2: Drop stale bazaar recommendations
        const queueTime = Date.now() - command.queuedAt
        if (command.priority === CommandPriority.NORMAL && command.name.startsWith('Bazaar ') && queueTime > BAZAAR_RECOMMENDATION_MAX_AGE_MS) {
            const queueTimeSeconds = Math.floor(queueTime / 1000)
            const itemMatch = command.name.match(/Bazaar \w+: \d+x (.+)/)
            const itemName = itemMatch ? itemMatch[1] : 'unknown'
            log(`[BAF] Dropping stale bazaar recommendation for ${itemName} (queued ${queueTimeSeconds}s ago)`, 'info')
            printMcChatToConsole(`§f[§4BAF§f]: §e[BAF] Dropped stale order for ${itemName} (${queueTimeSeconds}s old)`)
            continue
        }
        
        isProcessing = true
        currentCommand = command
        const startTime = Date.now()
        const priorityName = CommandPriority[command.priority]
        const waitTime = startTime - command.queuedAt
        
        log(`[CommandQueue] Executing: ${command.name} (priority: ${priorityName}, waited: ${waitTime}ms, interruptible: ${command.interruptible})`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7[CommandQueue] Executing: §e${command.name}`)
        
        try {
            // Set a timeout for the command execution
            const timeoutMs = 30000 // 30 seconds max per command
            const timeoutPromise = new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('Command execution timeout')), timeoutMs)
            })
            
            // Race between command execution and timeout
            await Promise.race([
                command.execute(),
                timeoutPromise
            ])
            
            const duration = Date.now() - startTime
            log(`[CommandQueue] Completed: ${command.name} (took ${duration}ms)`, 'info')
        } catch (error) {
            const duration = Date.now() - startTime
            log(`[CommandQueue] ERROR in ${command.name}: ${error} (took ${duration}ms)`, 'error')
            printMcChatToConsole(`§f[§4BAF§f]: §c[CommandQueue] Error: ${command.name} failed`)
            
            // Reset bot state if it got stuck (won't execute if state is already null)
            // Note: bot.state may have been changed by command.execute() before the error
            const currentState = bot.state as MyBot['state']
            if (currentState !== null && currentState !== undefined && currentState !== 'purchasing') {
                log(`[CommandQueue] Resetting bot state from "${currentState}" to null after error`, 'warn')
                bot.state = null
            }
        } finally {
            isProcessing = false
            currentCommand = null
            
            // Small delay between commands to avoid overwhelming the server
            await sleep(200)
        }
    }
}

/**
 * Get current queue status
 */
export function getQueueStatus(): { depth: number; processing: boolean; commands: string[] } {
    return {
        depth: commandQueue.length,
        processing: isProcessing,
        commands: commandQueue.map(cmd => `${cmd.name} (${CommandPriority[cmd.priority]})`)
    }
}

/**
 * Check if a critical operation needs to interrupt the current command
 * Used by AH flip handler to check if it should interrupt a bazaar operation
 * @returns true if current command can be interrupted
 */
export function canInterruptCurrentCommand(): boolean {
    if (!currentCommand) return true
    if (!isProcessing) return true
    return currentCommand.interruptible === true
}

/**
 * Interrupt the current command and re-queue it
 * Used when a higher priority operation (AH flip) needs to run immediately
 * @param bot The bot instance to reset state
 * @returns true if a command was interrupted
 */
export function interruptCurrentCommand(bot: MyBot): boolean {
    if (!currentCommand || !isProcessing) {
        log('[CommandQueue] No command to interrupt', 'debug')
        return false
    }
    
    if (!currentCommand.interruptible) {
        log(`[CommandQueue] Current command "${currentCommand.name}" is not interruptible`, 'debug')
        return false
    }
    
    log(`[CommandQueue] Interrupting: ${currentCommand.name} for higher priority operation`, 'warn')
    printMcChatToConsole(`§f[§4BAF§f]: §e[CommandQueue] Interrupting: §c${currentCommand.name}`)
    
    // BUG 3: Close any open window
    if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow)
    }
    
    // Abort any active order management
    const { abortOrderManagement } = require('./bazaarOrderManager')
    abortOrderManagement(bot)
    
    // BUG 3: Re-queue the interrupted command at the FRONT (before same or lower priority)
    const requeued: QueuedCommand = {
        ...currentCommand,
        queuedAt: Date.now()
    }
    
    // Insert at the FRONT of the queue (at position 0)
    // This ensures interrupted operations are processed immediately after the AH flip
    commandQueue.unshift(requeued)
    
    log(`[CommandQueue] Re-queued interrupted command at FRONT: ${requeued.name}`, 'info')
    printMcChatToConsole(`§f[§4BAF§f]: §7[CommandQueue] Re-queued at FRONT: §e${requeued.name}`)
    
    // Reset processing flag to allow new command to start
    isProcessing = false
    currentCommand = null
    
    // BUG 3: Reset bot state
    if (bot.state && bot.state !== 'purchasing') {
        log(`[CommandQueue] Resetting bot state from "${bot.state}" to null after interruption`, 'info')
        bot.state = null
    }
    
    return true
}

/**
 * Clear all queued commands (emergency use only)
 */
export function clearQueue(): void {
    const count = commandQueue.length
    commandQueue = []
    log(`[CommandQueue] Cleared ${count} queued command(s)`, 'warn')
    printMcChatToConsole(`§f[§4BAF§f]: §e[CommandQueue] Cleared ${count} command(s)`)
}

/**
 * Helper sleep function
 */
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
