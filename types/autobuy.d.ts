import { Bot } from 'mineflayer'

interface SellData {
    price: number
    slot: number
    duration: number
    itemName: string
    id: string
}

interface TradeData {
    target: string
    slots: number[]
    coins: number
}

interface SwapData {
    profile: string
}

interface Flip {
    id: string
    startingBid: number
    purchaseAt: Date
    itemName: string
    target: number
    finder?: string
    profitPerc?: number
}

interface TextMessageData {
    text: string
    onClick?: string
    hover?: string
}

interface MyBot extends Bot {
    state?: 'purchasing' | 'selling' | 'claiming' | 'gracePeriod' | 'runningSequence'
    lastViewAuctionCommandForPurchase?: string
    privacySettings?: any
}

interface FlipWhitelistedData {
    itemName: string
    reason: string
    finder: string
    price: string
}

interface BazaarFlipRecommendation {
    itemName: string
    itemTag?: string
    amount: number
    pricePerUnit: number
    isBuyOrder: boolean
    totalPrice?: number
}
