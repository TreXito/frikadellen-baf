import { Flip } from '../types/autobuy'

// Store active flips with purchase time
const activeFlips: Map<string, FlipData> = new Map()

interface FlipData {
    flip: Flip
    purchaseTime: number
    itemName: string
    buyPrice: number
    auctionId: string
}

export function trackFlipPurchase(itemName: string, buyPrice: number, flip: Flip): void {
    activeFlips.set(itemName, {
        flip,
        purchaseTime: Date.now(),
        itemName,
        buyPrice,
        auctionId: flip.id
    })
}

export function getFlipData(itemName: string): FlipData | undefined {
    return activeFlips.get(itemName)
}

export function removeFlipData(itemName: string): void {
    activeFlips.delete(itemName)
}

export function calculateProfit(flipData: FlipData, sellPrice: number): number {
    return sellPrice - flipData.buyPrice
}

export function calculateTimeToSell(flipData: FlipData): number {
    return Date.now() - flipData.purchaseTime
}

export function formatTimeToSell(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`
    } else {
        return `${seconds}s`
    }
}
