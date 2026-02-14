import { log, printMcChatToConsole } from './logger'
import { sendWebhookProfitReport } from './webhookHandler'
import { getBotStartTime } from './BAF'

/**
 * Represents a completed bazaar trade for profit tracking
 */
interface BazaarTrade {
    itemName: string
    buyPrice: number      // Price per unit for buy order
    sellPrice: number     // Price per unit for sell order
    amount: number        // Amount traded
    profit: number        // Calculated profit (with tax deducted)
    completedAt: number   // Timestamp when trade completed
}

// Store all completed trades
let completedTrades: BazaarTrade[] = []

// Store pending buy orders that haven't been matched with sells yet
let pendingBuys: Map<string, { price: number, amount: number, timestamp: number }[]> = new Map()

// Timer for periodic profit reports
let profitReportTimer: NodeJS.Timeout | null = null

// Constants
const PROFIT_REPORT_INTERVAL_MS = 30 * 60 * 1000 // 30 minutes
const BAZAAR_TAX_RATE = 0.0125 // 1.25% tax

/**
 * Record a buy order being placed
 * Stores the order in pending buys to match with future sells
 */
export function recordBuyOrder(itemName: string, pricePerUnit: number, amount: number): void {
    if (!pendingBuys.has(itemName)) {
        pendingBuys.set(itemName, [])
    }
    
    pendingBuys.get(itemName)!.push({
        price: pricePerUnit,
        amount: amount,
        timestamp: Date.now()
    })
    
    log(`[ProfitTracker] Recorded buy order: ${amount}x ${itemName} @ ${pricePerUnit.toFixed(1)} coins`, 'debug')
}

/**
 * Record a sell order being placed and calculate profit
 * Matches with pending buy orders (FIFO) to calculate profit
 */
export function recordSellOrder(itemName: string, pricePerUnit: number, amount: number): void {
    const pending = pendingBuys.get(itemName)
    
    if (!pending || pending.length === 0) {
        log(`[ProfitTracker] No pending buy for ${itemName}, cannot calculate profit for sell`, 'debug')
        return
    }
    
    let remainingAmount = amount
    let totalBuyCost = 0
    let matchedAmount = 0
    
    // Match with pending buys (FIFO - first in, first out)
    while (remainingAmount > 0 && pending.length > 0) {
        const buyOrder = pending[0]
        const matchAmount = Math.min(remainingAmount, buyOrder.amount)
        
        totalBuyCost += buyOrder.price * matchAmount
        matchedAmount += matchAmount
        remainingAmount -= matchAmount
        buyOrder.amount -= matchAmount
        
        // Remove buy order if fully matched
        if (buyOrder.amount <= 0) {
            pending.shift()
        }
    }
    
    if (matchedAmount > 0) {
        // Calculate profit: (sell revenue - buy cost) - tax on sell revenue
        const sellRevenue = pricePerUnit * matchedAmount
        const buyCost = totalBuyCost
        const tax = sellRevenue * BAZAAR_TAX_RATE
        const profit = sellRevenue - buyCost - tax
        
        const trade: BazaarTrade = {
            itemName: itemName,
            buyPrice: buyCost / matchedAmount,  // Average buy price per unit
            sellPrice: pricePerUnit,
            amount: matchedAmount,
            profit: profit,
            completedAt: Date.now()
        }
        
        completedTrades.push(trade)
        
        log(`[ProfitTracker] Recorded trade: ${matchedAmount}x ${itemName}, profit: ${profit.toFixed(0)} coins`, 'info')
        printMcChatToConsole(`§f[§4BAF§f]: §7[ProfitTracker] Trade complete: §e${matchedAmount}x ${itemName}§7, profit: §${profit >= 0 ? 'a+' : 'c'}${profit.toFixed(0)} coins`)
    }
    
    // Clean up empty pending buy list
    if (pending.length === 0) {
        pendingBuys.delete(itemName)
    }
}

/**
 * Remove a cancelled order from pending buys
 * This prevents cancelled orders from being matched with future sell orders
 */
export function removeCancelledOrder(itemName: string, isBuyOrder: boolean, pricePerUnit: number, amount: number): void {
    // Only remove buy orders from pending buys (sell orders aren't tracked as pending)
    if (!isBuyOrder) {
        log(`[ProfitTracker] Sell order cancelled for ${itemName}, no pending buy to remove`, 'debug')
        return
    }
    
    const pending = pendingBuys.get(itemName)
    
    if (!pending || pending.length === 0) {
        log(`[ProfitTracker] No pending buys found for ${itemName} to remove`, 'debug')
        return
    }
    
    // Find and remove matching buy order(s)
    let remainingAmount = amount
    let removedAmount = 0
    
    // Remove from pending buys (FIFO - remove oldest first to match recordSellOrder behavior)
    for (let i = 0; i < pending.length && remainingAmount > 0; i++) {
        const buyOrder = pending[i]
        
        // Match by price (with small tolerance for floating point comparison)
        const priceTolerance = 0.01
        if (Math.abs(buyOrder.price - pricePerUnit) <= priceTolerance) {
            const removeAmount = Math.min(remainingAmount, buyOrder.amount)
            
            buyOrder.amount -= removeAmount
            remainingAmount -= removeAmount
            removedAmount += removeAmount
            
            // Remove buy order if fully consumed
            if (buyOrder.amount <= 0) {
                pending.splice(i, 1)
                i-- // Adjust index after removal
            }
        }
    }
    
    // Clean up empty pending buy list
    if (pending.length === 0) {
        pendingBuys.delete(itemName)
    }
    
    if (removedAmount > 0) {
        log(`[ProfitTracker] Removed cancelled buy order: ${removedAmount}x ${itemName} @ ${pricePerUnit.toFixed(1)} coins`, 'debug')
    } else {
        log(`[ProfitTracker] Could not find matching buy order to remove for ${itemName}`, 'debug')
    }
}

/**
 * Get total profit across all completed trades
 */
export function getTotalProfit(): number {
    return completedTrades.reduce((sum, trade) => sum + trade.profit, 0)
}

/**
 * Get number of completed trades
 */
export function getTradeCount(): number {
    return completedTrades.length
}

/**
 * Get detailed profit statistics
 */
export function getProfitStats(): {
    totalProfit: number
    tradeCount: number
    averageProfit: number
    profitPerHour: number
    uptime: number
} {
    const totalProfit = getTotalProfit()
    const tradeCount = getTradeCount()
    const averageProfit = tradeCount > 0 ? totalProfit / tradeCount : 0
    
    const uptime = Date.now() - getBotStartTime()
    const uptimeHours = uptime / (1000 * 60 * 60)
    const profitPerHour = uptimeHours > 0 ? totalProfit / uptimeHours : 0
    
    return {
        totalProfit,
        tradeCount,
        averageProfit,
        profitPerHour,
        uptime
    }
}

/**
 * Format uptime as human-readable string
 */
export function formatUptime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)
    
    if (days > 0) {
        return `${days}d ${hours % 24}h ${minutes % 60}m`
    } else if (hours > 0) {
        return `${hours}h ${minutes % 60}m`
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`
    } else {
        return `${seconds}s`
    }
}

/**
 * Start the periodic profit report timer
 * Sends a webhook every 30 minutes with profit stats
 */
export function startProfitReportTimer(): void {
    if (profitReportTimer) {
        log('[ProfitTracker] Timer already running', 'debug')
        return
    }
    
    log('[ProfitTracker] Starting profit report timer (30 minute interval)', 'info')
    printMcChatToConsole('§f[§4BAF§f]: §a[ProfitTracker] Profit reporting enabled (every 30 minutes)')
    
    // Send initial report after 30 minutes
    profitReportTimer = setInterval(() => {
        const stats = getProfitStats()
        sendWebhookProfitReport(stats)
    }, PROFIT_REPORT_INTERVAL_MS)
}

/**
 * Stop the periodic profit report timer
 */
export function stopProfitReportTimer(): void {
    if (profitReportTimer) {
        clearInterval(profitReportTimer)
        profitReportTimer = null
        log('[ProfitTracker] Profit report timer stopped', 'info')
    }
}

/**
 * Get list of recent trades (last N trades)
 */
export function getRecentTrades(count: number = 10): BazaarTrade[] {
    return completedTrades.slice(-count)
}
