import { MyBot, TradeData } from '../types/autobuy'
import { getCurrentWebsocket } from './BAF'
import { log } from './logger'
import { clickWindow, sleep } from './utils'

export async function tradePerson(bot: MyBot, data: TradeData) {
    let wss = await getCurrentWebsocket()
    let addedCoins = false
    let addedItems = false
    let trading = true
    while (trading) {
        bot.chat('/trade ' + data.target)

        bot.on('message', async msgE => {
            let msg = msgE.getText(null)

            if (msg == 'You cannot trade while the server is lagging!') {
                bot.chat('The server is lagging, give it a second')
                await sleep(5000)
            } else if (msg.startsWith('Cannot find player named')) {
                log('Player is not avaliable to trade with, please rerequest when they are capable of trading')
                trading = false
                return
            } else if (msg == 'You are too far away to trade with that player!') {
                bot.chat('Hey ' + data.target + ' come here so we can trade!')
            } else if (msg.startsWith('You have sent a trade request to ')) {
                log('successfully sent trade, waiting for them to accept')
                
                const tradeWindowHandler = async window => {
                    trading = false

                    log('Trade window opened')
                    if (!addedItems) {
                        for (let slot of data.slots) {
                            slot += 44
                            clickWindow(bot, slot).catch(err => log(`Error clicking trade slot: ${err}`, 'error'))
                            log('Clicked slot ' + slot)
                        }
                        log('Added all items')
                    }
                    if (data.coins > 0 && !addedCoins) {
                        bot._client.once('open_sign_entity', ({ location }) => {
                            let price = data.coins
                            const priceFormatted = price.toString()
                            log('New sign entity')
                            log('price to set ' + priceFormatted)
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
                            addedCoins = true
                        })
                        clickWindow(bot, 36).catch(err => log(`Error clicking coin slot: ${err}`, 'error'))
                    }
                    if (!(data.coins > 0) || addedCoins) {
                        wss.send(JSON.stringify({ type: 'affirmFlip', data: [JSON.stringify(window.slots)] }))
                    }
                    // Clean up listener after trade window is handled
                    bot.removeListener('windowOpen', tradeWindowHandler)
                }
                
                // CRITICAL: Clear all previous windowOpen listeners to prevent conflicts
                bot.removeAllListeners('windowOpen')
                bot.on('windowOpen', tradeWindowHandler)
            }
        })

        await sleep(5000)
    }
}
