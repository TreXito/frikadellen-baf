// State manager for AutoBuy queue system
import { getConfigProperty } from './configHelper'
import { log } from './logger'

interface QueueItem {
    state: 'buying' | 'claiming' | 'listing'
    action: any
    priority: number
}

export class StateManager {
    private queue: QueueItem[] = []
    public config: any

    constructor() {
        this.config = {
            delayBetweenClicks: getConfigProperty('FLIP_ACTION_DELAY') || 3,
            clickDelay: getConfigProperty('BED_SPAM_CLICK_DELAY') || 100
        }
    }

    queueAdd(action: any, state: 'buying' | 'claiming' | 'listing', priority: number) {
        this.queue.push({ state, action, priority })
        // Sort immediately after adding to maintain sorted order
        this.queue.sort((a, b) => b.priority - a.priority)
        log(`[StateManager] Added ${state} task to queue (priority: ${priority})`, 'debug')
    }

    getHighest(): QueueItem | null {
        if (this.queue.length === 0) return null
        // Queue is already sorted by priority (highest first)
        return this.queue[0]
    }

    queueRemove() {
        if (this.queue.length > 0) {
            // Remove the first element (highest priority)
            this.queue.shift()
        }
    }

    getQueueLength(): number {
        return this.queue.length
    }
}
