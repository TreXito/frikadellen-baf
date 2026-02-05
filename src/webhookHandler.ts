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
        content: '',
        embeds: [
            {
                title: '🚀 BAF Connection Initialized',
                description: '**Best Auto Flipper is now online and ready to flip!**',
                color: 0x00ff88, // Bright green
                fields: [
                    { 
                        name: '👤 Connected As', 
                        value: `\`\`\`fix\n${ingameName}\n\`\`\``, 
                        inline: true 
                    },
                    {
                        name: '⏰ Started At',
                        value: `<t:${(Date.now() / 1000).toFixed(0)}:F>`,
                        inline: true
                    },
                    {
                        name: '📊 Status',
                        value: '```yaml\nOnline and Active\n```',
                        inline: false
                    }
                ],
                thumbnail: { url: `https://mc-heads.net/avatar/${ingameName}/600.png` },
                footer: {
                    text: 'BAF • Best Auto Flipper',
                    icon_url: 'https://mc-heads.net/avatar/Steve/32.png'
                },
                timestamp: new Date().toISOString()
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
    const profitPercent = flip && flip.target > 0 ? ((profit / buyPrice) * 100).toFixed(1) : '0'
    
    let webhookData: any = {
        embeds: [
            {
                title: '🛒 Item Purchased Successfully',
                description: `**${itemName}**`,
                color: 0x3498db, // Professional blue
                fields: [
                    {
                        name: '💰 Purchase Price',
                        value: `\`\`\`fix\n${numberWithThousandsSeparators(buyPrice)} coins\n\`\`\``,
                        inline: true
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName}`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                },
                timestamp: new Date().toISOString()
            }
        ]
    }

    if (flip && flip.target) {
        webhookData.embeds[0].fields.push({
            name: '🎯 Target Price',
            value: `\`\`\`fix\n${numberWithThousandsSeparators(flip.target)} coins\n\`\`\``,
            inline: true
        })
        webhookData.embeds[0].fields.push({
            name: '📈 Expected Profit',
            value: `\`\`\`diff\n${profitStr} coins (${profitPercent}%)\n\`\`\``,
            inline: true
        })
    }

    if (whitelistedData) {
        webhookData.embeds[0].fields.push({
            name: '⭐ Whitelist Match',
            value: `\`\`\`yaml\n${whitelistedData.reason}\n\`\`\``,
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
    
    // Use gradient colors - green for profit, red for loss
    const color = profit >= 0 ? 0x2ecc71 : 0xe74c3c
    const statusEmoji = profit >= 0 ? '✅' : '❌'
    
    const webhookData: any = {
        embeds: [
            {
                title: `${statusEmoji} Item Sold ${profit >= 0 ? '(Profit)' : '(Loss)'}`,
                description: `**${itemName}**`,
                color: color,
                fields: [
                    {
                        name: '👤 Buyer',
                        value: `\`\`\`\n${purchasedBy}\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💵 Sale Price',
                        value: `\`\`\`fix\n${numberWithThousandsSeparators(sellPrice)} coins\n\`\`\``,
                        inline: true
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName}`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                },
                timestamp: new Date().toISOString()
            }
        ]
    }
    
    if (flipData) {
        webhookData.embeds[0].fields.push({
            name: '💰 Net Profit',
            value: profit >= 0 
                ? `\`\`\`diff\n+ ${profitStr} coins\n\`\`\`` 
                : `\`\`\`diff\n- ${profitStr.replace('-', '')} coins\n\`\`\``,
            inline: true
        })
        webhookData.embeds[0].fields.push({
            name: '⏱️ Time to Sell',
            value: `\`\`\`\n${timeToSell}\n\`\`\``,
            inline: true
        })
        
        // Add ROI percentage
        const roi = ((profit / flipData.buyPrice) * 100).toFixed(1)
        webhookData.embeds[0].fields.push({
            name: '📊 ROI',
            value: `\`\`\`${roi}%\`\`\``,
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
                title: '📋 Item Listed on Auction House',
                description: `**${itemName}**`,
                color: 0x9b59b6, // Purple for listing
                fields: [
                    {
                        name: '💵 List Price',
                        value: `\`\`\`fix\n${price} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '⏰ Duration',
                        value: `\`\`\`\n${duration} hours\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '📅 Expires',
                        value: `<t:${Math.floor((Date.now() + duration * 3600000) / 1000)}:R>`,
                        inline: true
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName}`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                },
                timestamp: new Date().toISOString()
            }
        ]
    })
}
