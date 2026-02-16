import { MyBot, SellData } from '../types/autobuy'
import { getCurrentWebsocket } from './BAF'
import { getConfigProperty } from './configHelper'
import { log, printMcChatToConsole } from './logger'
import { clickWindow, getWindowTitle, numberWithThousandsSeparators, removeMinecraftColorCodes } from './utils'
import { sendWebhookItemListed } from './webhookHandler'

let setPrice = false
let durationSet = false
let retryCount = 0

export async function onWebsocketCreateAuction(bot: MyBot, data: SellData) {
    let ws = await getCurrentWebsocket()
    if (bot.state) {
        log('Currently busy with something else (' + bot.state + ') -> not selling')
        if (retryCount > 10) {
            retryCount = 0
            return
        }
        setTimeout(() => {
            retryCount++
            onWebsocketCreateAuction(bot, data)
        }, 2000)
        return
    }
    bot.state = 'selling'
    log('Selling item...')
    log(data)
    sellItem(data, bot, ws)
}

async function sellItem(data: SellData, bot: MyBot, ws: WebSocket) {
    // Reset state variables at the start of each new auction listing attempt
    // to prevent stale state from previous failed/interrupted listings
    setPrice = false
    durationSet = false
    
    let handler = function (window: any) {
        sellHandler(data, bot, window, ws, () => {
            clearTimeout(timeout)
            bot.removeListener('windowOpen', handler)
        })
    }
    
    let timeout = setTimeout(() => {
        log('Seems something went wrong while selling. Removing lock', 'warn')
        bot.removeListener('windowOpen', handler)
        bot.state = null
        // Reset state variables on timeout to prevent stale state
        setPrice = false
        durationSet = false
    }, 10000)

    // CRITICAL: Clear all previous windowOpen listeners to prevent conflicts
    bot.removeAllListeners('windowOpen')
    bot.on('windowOpen', handler)
    bot.chat('/ah')
}

// Store the reason if the last sell attempt failed
// If it happens again, send a error message to the backend
let previousError

// Default auction duration in hours
const DEFAULT_AUCTION_DURATION_HOURS = 24

async function sellHandler(data: SellData, bot: MyBot, sellWindow, ws: WebSocket, removeEventListenerCallback: Function) {
    let title = getWindowTitle(sellWindow)
    log(title)
    
    // Get configured auction duration once per handler invocation
    const configuredDuration = getConfigProperty('AUCTION_DURATION_HOURS') || DEFAULT_AUCTION_DURATION_HOURS
    if (title.toString().includes('Auction House')) {
        clickWindow(bot, 15).catch(err => log(`Error clicking auction house slot: ${err}`, 'error'))
    }
    if (title == 'Manage Auctions') {
        let clickSlot
        for (let i = 0; i < sellWindow.slots.length; i++) {
            const item = sellWindow.slots[i]
            if (item && item.nbt.value.display.value.Name.value.includes('Create Auction')) {
                if (item && (item.nbt as any).value?.display?.value?.Lore?.value?.value?.toString().includes('You reached the maximum number')) {
                    log('Maximum number of auctions reached -> cant sell')
                    removeEventListenerCallback()
                    bot.state = null
                    setPrice = false
                    durationSet = false
                    return
                }
                clickSlot = item.slot
            }
        }
        clickWindow(bot, clickSlot).catch(err => log(`Error clicking create auction slot: ${err}`, 'error'))
    }
    if (title == 'Create Auction') {
        clickWindow(bot, 48).catch(err => log(`Error clicking BIN auction slot: ${err}`, 'error'))
    }

    if (title == 'Create BIN Auction') {
        if (!setPrice && !durationSet) {
            if (!sellWindow.slots[13].nbt.value.display.value.Name.value.includes('Click an item in your inventory!')) {
                clickWindow(bot, 13).catch(err => log(`Error clicking item selection slot: ${err}`, 'error'))
            }

            // calculate item slot, by calculating the slot index without the chest
            let itemSlot = data.slot - bot.inventory.inventoryStart + sellWindow.inventoryStart
            if (!sellWindow.slots[itemSlot]) {
                if (previousError === 'Slot empty') {
                    ws.send(
                        JSON.stringify({
                            type: 'clientError',
                            data: { data, message: 'createAuction slot empty' }
                        })
                    )
                }
                previousError = 'Slot empty'
                bot.state = null
                setPrice = false
                durationSet = false
                removeEventListenerCallback()
                log('No item at index ' + itemSlot + ' found -> probably already sold', 'warn')
                return
            }

            let id = sellWindow.slots[itemSlot]?.nbt?.value?.ExtraAttributes?.value?.id?.value
            let uuid = sellWindow.slots[itemSlot]?.nbt?.value?.ExtraAttributes?.value?.uuid?.value
            if (data.id !== id && data.id !== uuid) {
                if (previousError === "Item doesn't match") {
                    ws.send(
                        JSON.stringify({
                            type: 'clientError',
                            data: { data, slot: JSON.stringify(sellWindow.slots[itemSlot]), message: 'createAuction item doesnt match' }
                        })
                    )
                }
                previousError = 'Item doesnt match'
                bot.state = null
                setPrice = false
                durationSet = false
                removeEventListenerCallback()
                log('Item at index ' + itemSlot + '" does not match item that is supposed to be sold: "' + data.id + '" -> dont sell', 'warn')
                log(JSON.stringify(sellWindow.slots[itemSlot]))
                return
            }
            previousError = null

            clickWindow(bot, itemSlot).catch(err => log(`Error clicking item slot for sell: ${err}`, 'error'))
            bot._client.once('open_sign_entity', ({ location }) => {
                let price = (data as SellData).price
                const priceFormatted = price.toString()
                log('Price to set ' + priceFormatted)
                bot._client.write('update_sign', {
                    location: {
                        x: location.z,
                        y: location.y,
                        z: location.z
                    },
                    text1: `\"${priceFormatted}\"`,
                    text2: '{"italic":false,"extra":["^^^^^^^^^^^^^^^"],"text":""}',
                    text3: '{"italic":false,"extra":["Your auction"],"text":""}',
                    text4: '{"italic":false,"extra":["starting bid"],"text":""}'
                })
            })
            log('opening pricer')
            clickWindow(bot, 31).catch(err => log(`Error clicking price setter slot: ${err}`, 'error'))
            setPrice = true
        } else if (setPrice && !durationSet) {
            clickWindow(bot, 33).catch(err => log(`Error clicking duration slot: ${err}`, 'error'))
        } else if (setPrice && durationSet) {
            const resetAndTakeOutItem = () => {
                clickWindow(bot, 13).catch(err => log(`Error taking item out: ${err}`, 'error')) // Take the item out of the window
                removeEventListenerCallback()
                setPrice = false
                durationSet = false
                bot.state = null
            }

            try {
                const lore = <string[]>sellWindow.slots[29]?.nbt?.value?.display?.value?.Lore?.value?.value
                let priceLine = lore.find(el => removeMinecraftColorCodes(el).includes('Item price'))
                if (!priceLine) {
                    log('Price not present', 'error')
                    log(sellWindow.slots[29])
                    resetAndTakeOutItem()
                    return
                }
                if (priceLine.startsWith('{')) {
                    let obj = JSON.parse(priceLine)
                    priceLine = obj.extra[1].text.replace(/[,.]/g, '').split(' coins')[0]
                } else {
                    priceLine = removeMinecraftColorCodes(priceLine)

                    priceLine = priceLine.split(': ')[1].split(' coins')[0]
                    priceLine = priceLine.replace(/[,.]/g, '')
                }

                if (Number(priceLine) !== Math.floor(data.price)) {
                    log('Price is not the one that should be there', 'error')
                    log(data)
                    log(sellWindow.slots[29])
                    resetAndTakeOutItem()
                    return
                }
            } catch (e) {
                log('Checking if correct price was set in sellHandler through an error: ' + JSON.stringify(e), 'error')
            }

            clickWindow(bot, 29).catch(err => log(`Error clicking confirm sell slot: ${err}`, 'error'))
        }
    }
    if (title == 'Auction Duration') {
        // Use configured auction duration instead of backend-provided duration
        setAuctionDuration(bot, configuredDuration).then(() => {
            durationSet = true
        })
        clickWindow(bot, 16).catch(err => log(`Error clicking duration confirm slot: ${err}`, 'error'))
    }
    if (title == 'Confirm BIN Auction') {
        clickWindow(bot, 11).catch(err => log(`Error clicking final confirm slot: ${err}`, 'error'))
    }
    if (title == 'BIN Auction View') {
        log('Successfully listed an item')
        removeEventListenerCallback()
        setPrice = false
        durationSet = false
        bot.state = null
        printMcChatToConsole(`§f[§4BAF§f]: §fItem listed: ${data.itemName} §ffor ${numberWithThousandsSeparators(data.price)} coins`)
        sendWebhookItemListed(data.itemName, numberWithThousandsSeparators(data.price), configuredDuration)
        bot.closeWindow(sellWindow)
    }
}

async function setAuctionDuration(bot: MyBot, time: number) {
    log('setAuctionDuration function')
    return new Promise<void>(resolve => {
        bot._client.once('open_sign_entity', ({ location }) => {
            bot._client.write('update_sign', {
                location: {
                    x: location.z,
                    y: location.y,
                    z: location.z
                },
                text1: `\"${Math.floor(time).toString()}\"`,
                text2: '{"italic":false,"extra":["^^^^^^^^^^^^^^^"],"text":""}',
                text3: '{"italic":false,"extra":["Auction"],"text":""}',
                text4: '{"italic":false,"extra":["hours"],"text":""}'
            })
            resolve()
        })
    })
}
