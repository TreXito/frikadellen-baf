import axios from 'axios'
import { getConfigProperty } from './configHelper'
import { FlipWhitelistedData, Flip } from '../types/autobuy'
import { getFlipData, calculateProfit, formatTimeToSell, removeFlipData } from './flipTracker'

function sendWebhookData(options: Partial<Webhook>): void {
    let data = {
        content: options.content || '',
        avatar_url: options.avatar_url,
        tts: options.tts,
        embeds: options.embeds || [],
        username: options.username || 'BAF'
    }
    axios.post(getConfigProperty('WEBHOOK_URL'), data).catch(err => {
        console.error('Failed to send webhook:', err.message)
    })
}

function isWebhookConfigured() {
    return !!getConfigProperty('WEBHOOK_URL')
}

export function sendWebhookInitialized() {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    sendWebhookData({
        content: 'Initialized Connection',
        embeds: [
            {
                title: 'Initialized Connection',
                fields: [
                    { name: 'Connected as:', value: `\`\`\`${ingameName}\`\`\``, inline: false },
                    {
                        name: 'Started at:',
                        value: `<t:${(Date.now() / 1000).toFixed(0)}:t>`,
                        inline: false
                    }
                ],
                thumbnail: { url: `https://minotar.net/helm/${ingameName}/600.png` }
            }
        ]
    })
}

export function sendWebhookItemPurchased(itemName: string, price: string, whitelistedData: FlipWhitelistedData, flip?: Flip) {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    
    const buyPrice = parseFloat(price.replace(/,/g, ''))
    const profit = flip ? flip.target - buyPrice : 0
    const profitStr = profit > 0 ? `+${numberWithThousandsSeparators(profit)}` : '0'
    
    let webhookData: any = {
        embeds: [
            {
                title: '🛒 Item Purchased',
                color: 0x00ff88, // Green color
                fields: [
                    {
                        name: '📦 Item',
                        value: `\`\`\`${itemName}\`\`\``,
                        inline: true
                    },
                    {
                        name: '💰 Bought for',
                        value: `\`\`\`${numberWithThousandsSeparators(buyPrice)} coins\`\`\``,
                        inline: true
                    }
                ],
                thumbnail: { url: `https://minotar.net/helm/${ingameName}/600.png` },
                timestamp: new Date().toISOString()
            }
        ]
    }

    if (flip && flip.target) {
        webhookData.embeds[0].fields.push({
            name: '🎯 Target Price',
            value: `\`\`\`${numberWithThousandsSeparators(flip.target)} coins\`\`\``,
            inline: true
        })
        webhookData.embeds[0].fields.push({
            name: '💵 Expected Profit',
            value: `\`\`\`${profitStr} coins\`\`\``,
            inline: true
        })
    }

    if (whitelistedData) {
        webhookData.embeds[0].fields.push({
            name: '⭐ Whitelist Match',
            value: `\`\`\`${whitelistedData.reason}\`\`\``,
            inline: false
        })
    }

    sendWebhookData(webhookData)
}

function numberWithThousandsSeparators(num: number): string {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function sendWebhookItemSold(itemName: string, price: string, purchasedBy: string) {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    
    const sellPrice = parseFloat(price.replace(/,/g, ''))
    const flipData = getFlipData(itemName)
    
    let profit = 0
    let timeToSell = ''
    let profitStr = '0'
    
    if (flipData) {
        profit = calculateProfit(flipData, sellPrice)
        timeToSell = formatTimeToSell(Date.now() - flipData.purchaseTime)
        profitStr = profit > 0 ? `+${numberWithThousandsSeparators(profit)}` : `${numberWithThousandsSeparators(profit)}`
        removeFlipData(itemName)
    }
    
    // Use green color for profit, red for loss
    const color = profit >= 0 ? 0x00ff88 : 0xff4444
    
    const webhookData: any = {
        embeds: [
            {
                title: '💸 Item Sold',
                color: color,
                fields: [
                    {
                        name: '👤 Purchased by',
                        value: `\`\`\`${purchasedBy}\`\`\``,
                        inline: true
                    },
                    {
                        name: '📦 Item Sold',
                        value: `\`\`\`${itemName}\`\`\``,
                        inline: true
                    },
                    {
                        name: '💰 Sold for',
                        value: `\`\`\`${numberWithThousandsSeparators(sellPrice)} coins\`\`\``,
                        inline: true
                    }
                ],
                thumbnail: { url: `https://minotar.net/helm/${ingameName}/600.png` },
                timestamp: new Date().toISOString()
            }
        ]
    }
    
    if (flipData) {
        webhookData.embeds[0].fields.push({
            name: '💵 Profit',
            value: `\`\`\`${profitStr} coins\`\`\``,
            inline: true
        })
        webhookData.embeds[0].fields.push({
            name: '⏱️ Time to Sell',
            value: `\`\`\`${timeToSell}\`\`\``,
            inline: true
        })
    }
    
    sendWebhookData(webhookData)
}

export function sendWebhookItemListed(itemName: string, price: string, duration: number) {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    sendWebhookData({
        embeds: [
            {
                title: 'Item Listed',
                fields: [
                    {
                        name: 'Listed Item:',
                        value: `\`\`\`${itemName}\`\`\``,
                        inline: false
                    },
                    {
                        name: 'Item Price:',
                        value: `\`\`\`${price}\`\`\``,
                        inline: false
                    },
                    {
                        name: 'AH Duration:',
                        value: `\`\`\`${duration}h\`\`\``,
                        inline: false
                    }
                ],
                thumbnail: { url: `https://minotar.net/helm/${ingameName}/600.png` }
            }
        ]
    })
}
