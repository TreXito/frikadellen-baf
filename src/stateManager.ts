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
        log(`[StateManager] Added ${state} task to queue (priority: ${priority})`, 'debug')
    }

    getHighest(): QueueItem | null {
        if (this.queue.length === 0) return null
        // Sort by priority and return highest
        this.queue.sort((a, b) => b.priority - a.priority)
        return this.queue[0]
    }

    queueRemove() {
        if (this.queue.length > 0) {
            this.queue.shift()
        }
    }

    getQueueLength(): number {
        return this.queue.length
    }
}
