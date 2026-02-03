import { Flip, FlipWhitelistedData, MyBot } from '../types/autobuy'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, isSkin, numberWithThousandsSeparators, removeMinecraftColorCodes, sleep } from './utils'

export async function flipHandler(bot: MyBot, flip: Flip) {
    // Check if AH flips are enabled in config
    if (!getConfigProperty('ENABLE_AH_FLIPS')) {
        log('AH flips are disabled in config', 'debug')
        return
    }

    flip.purchaseAt = new Date(flip.purchaseAt)

    if (bot.state) {
        setTimeout(() => {
            flipHandler(bot, flip)
        }, 1100)
        return
    }
    bot.state = 'purchasing'
    let timeout = setTimeout(() => {
        if (bot.state === 'purchasing') {
            log("Resetting 'bot.state === purchasing' lock")
            bot.state = null
            bot.removeAllListeners('windowOpen')
        }
    }, 10000)
    let isBed = flip.purchaseAt.getTime() > new Date().getTime()

    bot.lastViewAuctionCommandForPurchase = `/viewauction ${flip.id}`
    bot.chat(bot.lastViewAuctionCommandForPurchase)

    printMcChatToConsole(
        `§f[§4BAF§f]: §fTrying to purchase flip${isBed ? ' (Bed)' : ''}: ${flip.itemName} §for ${numberWithThousandsSeparators(
            flip.startingBid
        )} coins (Target: ${numberWithThousandsSeparators(flip.target)})`
    )

    await useRegularPurchase(bot, flip, isBed)
    clearTimeout(timeout)
}

function useRegularPurchase(bot: MyBot, flip: Flip, isBed: boolean) {
    // Track if skip was used for this specific flip (scoped to avoid race conditions)
    let recentlySkipped = false

    return new Promise<void>((resolve, reject) => {
        bot.addListener('windowOpen', async window => {
            await sleep(getConfigProperty('FLIP_ACTION_DELAY'))
            let title = getWindowTitle(window)
            if (title.toString().includes('BIN Auction View')) {
                // Calculate profit
                const profit = flip.target - flip.startingBid

                // Get skip settings
                const skipSettings = getConfigProperty('SKIP')
                const useSkipAlways = skipSettings.ALWAYS
                const skipMinProfit = skipSettings.MIN_PROFIT
                const skipUser = skipSettings.USER_FINDER
                const skipSkins = skipSettings.SKINS
                const skipMinPercent = skipSettings.PROFIT_PERCENTAGE
                const skipMinPrice = skipSettings.MIN_PRICE

                // Validate FLIP_ACTION_DELAY if ALWAYS skip is enabled
                if (useSkipAlways && getConfigProperty('FLIP_ACTION_DELAY') < 150) {
                    printMcChatToConsole(
                        '§f[§4BAF§f]: §cWarning: SKIP.ALWAYS requires FLIP_ACTION_DELAY >= 150ms. Using skip may cause issues with current delay of ' +
                            getConfigProperty('FLIP_ACTION_DELAY') +
                            'ms'
                    )
                }

                // Check skip conditions
                const finderCheck = flip.finder === 'USER' && skipUser
                const skinCheck = isSkin(flip.itemName) && skipSkins
                const profitCheck = profit > skipMinProfit
                const percentCheck = (flip.profitPerc || 0) > skipMinPercent
                const priceCheck = flip.startingBid > skipMinPrice

                // Determine if we should use skip - ALWAYS takes precedence, otherwise check other conditions
                const useSkipOnFlip = useSkipAlways || profitCheck || skinCheck || finderCheck || percentCheck || priceCheck

                let multipleBedClicksDelay = getConfigProperty('BED_MULTIPLE_CLICKS_DELAY')
                let delayUntilBuyStart = isBed
                    ? flip.purchaseAt.getTime() - new Date().getTime() - (multipleBedClicksDelay > 0 ? multipleBedClicksDelay : 0)
                    : flip.purchaseAt.getTime() - new Date().getTime()
                await sleep(delayUntilBuyStart)

                if (isBed && getConfigProperty('BED_MULTIPLE_CLICKS_DELAY') > 0) {
                    for (let i = 0; i < 3; i++) {
                        clickWindow(bot, 31)
                        await sleep(getConfigProperty('BED_MULTIPLE_CLICKS_DELAY'))
                    }
                } else {
                    clickWindow(bot, 31)
                }

                // If skip should be used, click the skip button (slot 11)
                if (useSkipOnFlip) {
                    recentlySkipped = true
                    // Small delay to ensure the BIN purchase click is registered before skip
                    await sleep(50)
                    clickWindow(bot, 11)

                    // Log the skip reason
                    if (useSkipAlways) {
                        printMcChatToConsole('§f[§4BAF§f]: §cUsed skip because you have skip always enabled in config')
                    } else {
                        let skipReasons = []
                        if (finderCheck) skipReasons.push('it was a user flip')
                        if (profitCheck) skipReasons.push('profit was over ' + numberWithThousandsSeparators(skipMinProfit))
                        if (skinCheck) skipReasons.push('it was a skin')
                        if (percentCheck) skipReasons.push('profit percentage was over ' + skipMinPercent + '%')
                        if (priceCheck) skipReasons.push('price was over ' + numberWithThousandsSeparators(skipMinPrice))
                        printMcChatToConsole(
                            `§f[§4BAF§f]: §aUsed skip because ${skipReasons.join(' and ')}. You can change this in your config`
                        )
                    }
                }
            }
            if (title.toString().includes('Confirm Purchase')) {
                // Only click confirm if we didn't skip
                if (!recentlySkipped) {
                    clickWindow(bot, 11)
                }
                bot.removeAllListeners('windowOpen')
                bot.state = null
                resolve()
                return
            }
        })
    })
}

// Stores the last 3 whitelist messages so add it to the webhook message for purchased flips
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
