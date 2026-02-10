import { MyBot } from '../types/autobuy'
import { log, printMcChatToConsole } from './logger'

/**
 * Priority levels for queued commands
 * Lower numbers = higher priority
 */
export enum CommandPriority {
    CRITICAL = 1, // Emergency operations, AFK responses
    HIGH = 2,     // Auction house flips (time-sensitive)
    NORMAL = 3,   // Bazaar flips
    LOW = 4       // Cookie checks, order management, maintenance
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
}

// Command queue with priority ordering
let commandQueue: QueuedCommand[] = []

// Flag to track if queue is currently processing
let isProcessing = false

// Global command counter for unique IDs
let commandIdCounter = 0

// Flag to track if queue is initialized
let queueInitialized = false

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
 * @returns Command ID for tracking
 */
export function enqueueCommand(
    name: string,
    priority: CommandPriority,
    execute: () => Promise<void>
): string {
    const id = `cmd_${++commandIdCounter}`
    
    const command: QueuedCommand = {
        id,
        name,
        priority,
        execute,
        queuedAt: Date.now()
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
    log(`[CommandQueue] Queued: ${name} (priority: ${priorityName}, queue depth: ${queueDepth})`, 'info')
    
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
        
        // Get next command (highest priority first)
        const command = commandQueue.shift()
        if (!command) {
            continue
        }
        
        isProcessing = true
        const startTime = Date.now()
        const priorityName = CommandPriority[command.priority]
        const waitTime = startTime - command.queuedAt
        
        log(`[CommandQueue] Executing: ${command.name} (priority: ${priorityName}, waited: ${waitTime}ms)`, 'info')
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
            
            // Reset bot state if it got stuck (but not gracePeriod)
            if (bot.state) {
                log(`[CommandQueue] Resetting bot state from "${bot.state}" to null after error`, 'warn')
                bot.state = null
            }
        } finally {
            isProcessing = false
            
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
