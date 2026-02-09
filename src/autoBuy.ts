// AutoBuy class - EXACT implementation from problem statement  
// DO NOT MODIFY CORE LOGIC - changes may lead to bans

import { Flip, FlipWhitelistedData, MyBot } from '../types/autobuy'
import { clickWindow, getWindowTitle, sleep, removeMinecraftColorCodes } from './utils'
import { getConfigProperty } from './configHelper'

// Extend MyBot interface with AutoBuy helper methods
declare module '../types/autobuy' {
    interface MyBot {
        betterClick?: (slot: number) => Promise<void>
        getWindowName?: () => string
        sleepMs?: (ms: number) => Promise<void>
        waitForTicks?: (ticks: number) => Promise<void>
        waitForSlotLoad?: (slot: number) => Promise<any>
    }
}

// Helper methods to bridge AutoBuy class with existing bot implementation
// These map the AutoBuy expected methods to the existing codebase methods WITHOUT changing logic
export function addAutoBuyHelpers(bot: MyBot) {
    // betterClick - maps to existing clickWindow
    bot.betterClick = async (slot: number) => {
        return clickWindow(bot, slot)
    }

    // getWindowName - maps to existing getWindowTitle
    bot.getWindowName = () => {
        return getWindowTitle(bot.currentWindow)
    }

    // sleepMs - maps to existing sleep utility (renamed to avoid conflict with mineflayer's sleep in bed)
    bot.sleepMs = (ms: number) => {
        return sleep(ms)
    }

    // waitForTicks - converts ticks to ms (1 tick = 50ms in Minecraft)
    bot.waitForTicks = async (ticks: number) => {
        return sleep(ticks * 50)
    }

    // waitForSlotLoad - waits for a slot to have an item
    bot.waitForSlotLoad = async (slot: number) => {
        return new Promise((resolve) => {
            let index = 1
            let found = false
            const delay = getConfigProperty('FLIP_ACTION_DELAY') || 150

            const interval = setInterval(() => {
                const check = bot.currentWindow?.slots[slot]
                if (check !== null && check !== undefined) {
                    clearInterval(interval)
                    found = true
                    resolve(check)
                }
                index++
            }, 1)

            setTimeout(() => {
                if (found) return
                clearInterval(interval)
                resolve(null)
            }, delay * 3)
        })
    }
}

// EXACT AutoBuy class logic from problem statement - DO NOT MODIFY
class AutoBuy {
    private bot: MyBot
    private webhook: any
    private socket: any
    private username: string
    private state: any
    private relist: any
    private bank: any

    // Recent auction info
    private recentProfit: number = 0
    private recentPercent: number = 0
    private recentFinder: number = 0
    private recentPrice: number = 0
    private recentlySkipped: boolean = false
    private recentName: string | null = null
    private currentOpen: string | null = null

    // Bed spam protection
    private currentlyTimingBed: boolean = false

    constructor(bot: MyBot, webhook: any, socket: any, username: string, state: any, relist: any, bank: any) {
        this.bot = bot
        this.webhook = webhook
        this.socket = socket
        this.username = username
        this.state = state
        this.relist = relist
        this.bank = bank

        // Start handlers
        this.flipHandler()
        this.initQueue()
    }

    flipHandler() {
        const bot = this.bot
        const state = this.state

        this.socket.on("flip", (data: any) => {
            const auctionId = data.id
            const itemName = data.itemName
            const profit = data.target - data.startingBid

            console.log(`[AutoBuy] Flip found: ${itemName} with ${profit} profit.`)

            if (!bot.currentWindow) {
                bot.chat(`/viewauction ${auctionId}`)
            } else {
                state.queueAdd({
                    finder: data.finder,
                    profit: profit,
                    itemName: itemName,
                    auctionID: auctionId,
                    startingBid: data.startingBid,
                }, "buying", 0)
            }
        })
    }

    initQueue() {
        const delay = this.state.config.delayBetweenClicks || 3
        console.log(`[AutoBuy] Queue initialized with a delay of ${delay}ms`)

        setInterval(() => {
            const currentTask = this.state.getHighest()
            if (!currentTask) return

            switch (currentTask.state) {
                case "buying":
                    this.openExternalFlip(
                        currentTask.action.auctionID,
                        currentTask.action.profit,
                        currentTask.action.finder,
                        currentTask.action.itemName
                    )
                    break
                case "claiming":
                    this.bot.chat(currentTask.action)
                    break
                case "listing":
                    this.relist.listAuction(
                        currentTask.action.auctionID,
                        currentTask.action.price,
                        currentTask.action.profit,
                        currentTask.action.itemName
                    )
                    break
                default:
                    console.log(`[AutoBuy] Unknown task state: ${currentTask.state}`)
            }

            this.state.queueRemove()
        }, delay)
    }

    initBedSpam() {
        const clickInterval = this.state.config.clickDelay || 100
        console.log("[AutoBuy] Starting bed spam prevention...")

        let failedClicks = 0

        const bedSpamInterval = setInterval(() => {
            const currentWindow = this.bot.currentWindow
            if (!currentWindow || failedClicks >= 5) {
                clearInterval(bedSpamInterval)
                console.log("[AutoBuy] Stopped bed spam prevention.")
                return
            }

            const slotName = currentWindow.slots[31]?.name
            if (slotName === "gold_nugget") {
                this.bot.betterClick(31)
            } else {
                failedClicks++
            }
        }, clickInterval)
    }

    async itemLoad(slotIndex: number, checkName: boolean = false) {
        try {
            const item = await this.bot.waitForSlotLoad(slotIndex)
            if (!item) throw new Error("Item not found.")

            if (checkName && item.name === "potato") {
                console.log("[AutoBuy] Skipping potato item...")
                return null
            }

            console.log(`[AutoBuy] Loaded item: ${item.name}`)
            return item
        } catch (error) {
            console.error("[AutoBuy] Error loading item:", error)
            return null
        }
    }

    async validateAndConfirmFlip() {
        const windowName = this.bot.getWindowName()
        if (windowName !== "Confirm Purchase") {
            console.log("[AutoBuy] Not a purchase confirmation window.")
            return
        }

        console.log("[AutoBuy] Confirming flip purchase...")
        await this.bot.betterClick(11)

        let confirmWindow: string
        do {
            confirmWindow = this.bot.getWindowName()
            await this.bot.sleepMs(100)
        } while (confirmWindow === "Confirm Purchase")

        console.log("[AutoBuy] Purchase confirmed.")
    }

    sendDiscordNotification(flipData: any) {
        const message = {
            title: "Flip Found!",
            description: `${flipData.itemName} for ${flipData.startingBid} ➡️ ${flipData.targetPrice}`,
            color: 0x00ff00,
            footer: {
                text: "AutoBuy Bot",
            },
        }

        this.webhook.send(message)
        console.log("[AutoBuy] Discord notification sent.")
    }

    async timeBed(bedTime: number, auctionID: string) {
        console.log(`[AutoBuy] Timing bed for auction: ${auctionID}`)

        const startTime = Date.now()
        await this.bot.waitForTicks(5)

        let attempts = 0
        while (attempts < 3) {
            const responseTime = await this.clickPing()
            console.log(`[AutoBuy] Response time: ${responseTime}ms`)
            attempts++
        }

        const endTime = Date.now()
        const totalTime = endTime - startTime
        console.log(`[AutoBuy] Total time for bed: ${totalTime}ms`)

        if (totalTime < bedTime) {
            console.log("[AutoBuy] Timing successful!")
            await this.bot.waitForTicks(bedTime - totalTime)
            await this.bot.betterClick(31)
        } else {
            console.log("[AutoBuy] Bed timing failed.")
        }
    }

    async clickPing() {
        const startTime = Date.now()
        await this.bot.betterClick(31)
        const endTime = Date.now()

        const responseTime = endTime - startTime
        console.log(`[AutoBuy] Click response time: ${responseTime}ms`)

        return responseTime
    }

    isGracePeriodMessage(message: string) {
        const graceMessage = "This BIN sale is still in its grace period!"
        return message.includes(graceMessage)
    }

    sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    async openExternalFlip(auctionID: string, profit: number, finder: string, itemName: string) {
        console.log(`[AutoBuy] Opening external flip: ${itemName}`)
        
        if (this.bot.state) {
            console.log('[AutoBuy] Bot is busy, cannot open flip')
            return
        }

        console.log(`[AutoBuy] Trying to purchase flip: ${itemName} with ${profit} profit`)

        this.bot.chat(`/viewauction ${auctionID}`)
    }
}

// Stores the last 3 whitelist messages so we can add it to the webhook message for purchased flips
let whitelistObjects: FlipWhitelistedData[] = []

export function onItemWhitelistedMessage(text: string) {
    let chatMessage = removeMinecraftColorCodes(text)
    let itemName = chatMessage.split(' for ')[0]
    let price = chatMessage.split(' for ')[1].split(' matched your Whitelist entry: ')[0]
    let secondPart = chatMessage.split(' matched your Whitelist entry: ')[1]
    let reason = secondPart.split('\n')[0].trim()
    let finder = secondPart.split('Found by ')[1]

    whitelistObjects.unshift({
        itemName: itemName,
        reason: reason,
        finder: finder,
        price: price
    })

    if (whitelistObjects.length > 3) {
        whitelistObjects.pop()
    }
}

export function getWhitelistedData(itemName: string, price: string): FlipWhitelistedData {
    return whitelistObjects.find(x => x.itemName === itemName && x.price === price)
}

export { AutoBuy }
