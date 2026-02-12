import axios from 'axios'
import { getConfigProperty } from './configHelper'
import { FlipWhitelistedData, Flip } from '../types/autobuy'
import { getFlipData, calculateProfit, formatTimeToSell, removeFlipData } from './flipTracker'
import { getCoflnetPremiumInfo, getCurrentPurse } from './BAF'
import { calculateAuctionHouseFee } from './utils'

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
    let ahEnabled = getConfigProperty('ENABLE_AH_FLIPS')
    let bazaarEnabled = getConfigProperty('ENABLE_BAZAAR_FLIPS')
    
    // Get Coflnet premium info
    const coflnetInfo = getCoflnetPremiumInfo()
    
    let statusParts = [
        `AH Flips: ${ahEnabled ? '✅' : '❌'}`,
        `Bazaar Flips: ${bazaarEnabled ? '✅' : '❌'}`
    ]
    
    // Build description with Coflnet info if available
    let description = `${statusParts.join(' | ')}\n<t:${Math.floor(Date.now() / 1000)}:R>`
    
    // Add Coflnet premium info if available
    if (coflnetInfo.tier && coflnetInfo.expires) {
        description += `\n\n**Coflnet ${coflnetInfo.tier}** expires ${coflnetInfo.expires}`
    }
    
    // Build fields array
    const fields: any[] = []
    
    // Add connection ID as a separate field for easy copying
    if (coflnetInfo.connectionId) {
        fields.push({
            name: 'Connection ID',
            value: `\`${coflnetInfo.connectionId}\``,
            inline: false
        })
    }
    
    sendWebhookData({
        content: '',
        embeds: [
            {
                title: '✓ Started BAF',
                description: description,
                color: 0x00ff88, // Bright green
                fields: fields.length > 0 ? fields : undefined,
                footer: {
                    text: `BAF - ${ingameName}`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}

export function sendWebhookStartupComplete(ordersFound?: number) {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    let ahEnabled = getConfigProperty('ENABLE_AH_FLIPS')
    let bazaarEnabled = getConfigProperty('ENABLE_BAZAAR_FLIPS')
    
    // Get Coflnet premium info
    const coflnetInfo = getCoflnetPremiumInfo()
    
    const fields: any[] = [
        {
            name: '1️⃣ Cookie Check',
            value: '```✓ Complete```',
            inline: true
        },
        {
            name: '2️⃣ Order Discovery',
            value: bazaarEnabled 
                ? `\`\`\`✓ ${ordersFound !== undefined ? `Found ${ordersFound} order(s)` : 'Complete'}\`\`\``
                : '```- Skipped (Bazaar disabled)```',
            inline: true
        },
        {
            name: '3️⃣ Claim Items',
            value: '```✓ Complete```',
            inline: true
        }
    ]
    
    // Add connection ID as a separate field for easy copying
    if (coflnetInfo.connectionId) {
        fields.push({
            name: 'Connection ID',
            value: `\`${coflnetInfo.connectionId}\``,
            inline: false
        })
    }
    
    // Add status info
    let statusParts = [
        `AH Flips: ${ahEnabled ? '✅ Enabled' : '❌ Disabled'}`,
        `Bazaar Flips: ${bazaarEnabled ? '✅ Enabled' : '❌ Disabled'}`
    ]
    
    // Build description with Coflnet info if available
    let description = `Ready to accept flips!\n\n${statusParts.join('\n')}`
    
    // Add Coflnet premium info if available
    if (coflnetInfo.tier && coflnetInfo.expires) {
        description += `\n\n**Coflnet ${coflnetInfo.tier}** expires ${coflnetInfo.expires}`
    }
    
    sendWebhookData({
        content: '',
        embeds: [
            {
                title: '🚀 Startup Workflow Complete',
                description: description,
                color: 0x2ecc71, // Success green
                fields: fields,
                footer: {
                    text: `BAF - ${ingameName}`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                },
                timestamp: new Date().toISOString()
            }
        ]
    })
}

export function sendWebhookItemPurchased(itemName: string, price: string, whitelistedData: FlipWhitelistedData, flip?: Flip, buySpeed?: number) {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    
    const buyPrice = parseFloat(price.replace(/,/g, ''))
    // Fee is calculated based on target price since that's when the item is resold
    const auctionHouseFee = flip ? calculateAuctionHouseFee(flip.target) : 0
    const profit = flip ? flip.target - buyPrice - auctionHouseFee : 0
    const profitStr = profit > 0 ? `+${numberWithThousandsSeparators(profit)}` : '0'
    const profitPercent = flip && flip.target > 0 && buyPrice > 0 ? ((profit / buyPrice) * 100).toFixed(1) : '0'
    
    let webhookData: any = {
        embeds: [
            {
                title: '🛒 Item Purchased Successfully',
                description: `**${itemName}** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: 0x00FF00, // Green for AH flip purchased
                fields: [
                    {
                        name: '💰 Purchase Price',
                        value: `\`\`\`fix\n${formatNumber(buyPrice)} coins\n\`\`\``,
                        inline: true
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName} • Purse: ${formatPurse(purse)} coins`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    }

    if (flip && flip.target) {
        webhookData.embeds[0].fields.push({
            name: '🎯 Target Price',
            value: `\`\`\`fix\n${formatNumber(flip.target)} coins\n\`\`\``,
            inline: true
        })
        webhookData.embeds[0].fields.push({
            name: '📈 Expected Profit',
            value: `\`\`\`diff\n${profit > 0 ? '+' : ''}${formatNumber(profit)} coins (${profitPercent}%)\n\`\`\``,
            inline: true
        })
    }

    // Add buy speed if available
    if (buySpeed && buySpeed > 0) {
        webhookData.embeds[0].fields.push({
            name: '⚡ Buy Speed',
            value: `\`\`\`\n${buySpeed}ms\n\`\`\``,
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

    // Add auction link if flip data is available
    if (flip && flip.id) {
        webhookData.embeds[0].fields.push({
            name: '🔗 Auction Link',
            value: `[View on Coflnet](https://sky.coflnet.com/auction/${flip.id}?refId=9KKPN9)`,
            inline: false
        })
    }

    sendWebhookData(webhookData)
}

function numberWithThousandsSeparators(num: number): string {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Format a number with M/K suffixes for better readability
 * Examples: 4723969.8 -> "4.72M", 50000 -> "50K", 999 -> "999"
 */
function formatNumber(num: number): string {
    if (num >= 1_000_000) {
        return (num / 1_000_000).toFixed(2) + 'M'
    } else if (num >= 1_000) {
        return (num / 1_000).toFixed(2) + 'K'
    } else {
        // For small numbers, preserve decimals if they exist
        return num % 1 === 0 ? num.toFixed(0) : num.toFixed(2)
    }
}

/**
 * Format purse amount with B/M/K suffixes for better readability
 * Examples: 1404040000 -> "1.40b", 96532000 -> "96.53m", 590278 -> "590.3k"
 */
function formatPurse(amount: number): string {
    if (amount >= 1_000_000_000) {
        return `${(amount / 1_000_000_000).toFixed(2)}b`
    } else if (amount >= 1_000_000) {
        return `${(amount / 1_000_000).toFixed(2)}m`
    } else if (amount >= 1_000) {
        return `${(amount / 1_000).toFixed(1)}k`
    }
    return amount.toLocaleString()
}

export function sendWebhookItemSold(itemName: string, price: string, purchasedBy: string) {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    
    const sellPrice = parseFloat(price.replace(/,/g, ''))
    const flipData = getFlipData(itemName)
    
    let profit = 0
    let timeToSell = ''
    let profitStr = '0'
    let auctionId = ''
    
    if (flipData) {
        profit = calculateProfit(flipData, sellPrice)
        timeToSell = formatTimeToSell(Date.now() - flipData.purchaseTime)
        profitStr = profit > 0 ? `+${numberWithThousandsSeparators(profit)}` : `${numberWithThousandsSeparators(profit)}`
        auctionId = flipData.auctionId
        removeFlipData(itemName)
    }
    
    // Use blue for sold items per spec (0x0099FF)
    const color = 0x0099FF
    const statusEmoji = profit >= 0 ? '✅' : '❌'
    
    const webhookData: any = {
        embeds: [
            {
                title: `${statusEmoji} Item Sold ${profit >= 0 ? '(Profit)' : '(Loss)'}`,
                description: `**${itemName}** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: color,
                fields: [
                    {
                        name: '👤 Buyer',
                        value: `\`\`\`\n${purchasedBy}\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💵 Sale Price',
                        value: `\`\`\`fix\n${formatNumber(sellPrice)} coins\n\`\`\``,
                        inline: true
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName} • Purse: ${formatPurse(purse)} coins`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    }
    
    if (flipData) {
        webhookData.embeds[0].fields.push({
            name: '💰 Net Profit',
            value: profit >= 0 
                ? `\`\`\`diff\n+ ${formatNumber(profit)} coins\n\`\`\`` 
                : `\`\`\`diff\n- ${formatNumber(-profit)} coins\n\`\`\``,  // Use -profit to get absolute value
            inline: true
        })
        webhookData.embeds[0].fields.push({
            name: '⏱️ Time to Sell',
            value: `\`\`\`\n${timeToSell}\n\`\`\``,
            inline: true
        })
        
        // Add ROI percentage
        const roi = flipData.buyPrice > 0 ? ((profit / flipData.buyPrice) * 100).toFixed(1) : '0'
        webhookData.embeds[0].fields.push({
            name: '📊 ROI',
            value: `\`\`\`${roi}%\`\`\``,
            inline: true
        })
        
        // Add auction link if auction ID is available
        if (auctionId) {
            webhookData.embeds[0].fields.push({
                name: '🔗 Auction Link',
                value: `[View on Coflnet](https://sky.coflnet.com/auction/${auctionId}?refId=9KKPN9)`,
                inline: false
            })
        }
    }
    
    sendWebhookData(webhookData)
}

export function sendWebhookItemListed(itemName: string, price: string, duration: number) {
    if (!isWebhookConfigured()) {
        return
    }
    let ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    const listPrice = parseFloat(price.replace(/,/g, ''))
    sendWebhookData({
        embeds: [
            {
                title: '📋 Item Listed on Auction House',
                description: `**${itemName}** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: 0x0099FF, // Blue for AH flip listed
                fields: [
                    {
                        name: '💵 List Price',
                        value: `\`\`\`fix\n${formatNumber(listPrice)} coins\n\`\`\``,
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
                    text: `BAF • ${ingameName} • Purse: ${formatPurse(purse)} coins`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}

export function sendWebhookBazaarOrderPlaced(itemName: string, amount: number, pricePerUnit: number, totalPrice: number, isBuyOrder: boolean) {
    if (!isWebhookConfigured()) {
        return
    }
    const ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    
    const orderType = isBuyOrder ? 'Buy Order' : 'Sell Offer'
    const orderEmoji = isBuyOrder ? '🛒' : '🏷️'
    const orderColor = isBuyOrder ? 0x00CCCC : 0xFF9900 // Cyan for buy, orange for sell
    
    sendWebhookData({
        embeds: [
            {
                title: `${orderEmoji} Bazaar ${orderType} Placed`,
                description: `**${itemName}** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: orderColor,
                fields: [
                    {
                        name: '📦 Amount',
                        value: `\`\`\`fix\n${amount}x\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💵 Price per Unit',
                        value: `\`\`\`fix\n${formatNumber(pricePerUnit)} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💰 Total Price',
                        value: `\`\`\`fix\n${formatNumber(totalPrice)} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '📊 Order Type',
                        value: `\`\`\`\n${orderType}\n\`\`\``,
                        inline: false
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName} • Purse: ${formatPurse(purse)} coins`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}

export function sendWebhookBazaarOrderCancelled(
    itemName: string,
    amount: number,
    pricePerUnit: number,
    isBuyOrder: boolean,
    ageMinutes: number,
    filled: number,
    totalAmount: number,
    reason: string = 'Stale order (exceeded time limit)'
) {
    if (!isWebhookConfigured()) {
        return
    }
    const ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    
    const orderType = isBuyOrder ? 'Buy Order' : 'Sell Offer'
    const orderEmoji = '🚫'
    const orderColor = 0x808080 // Gray for cancellation
    const fillPercentage = totalAmount > 0 ? ((filled / totalAmount) * 100).toFixed(1) : '0'
    
    sendWebhookData({
        embeds: [
            {
                title: `${orderEmoji} Bazaar ${orderType} Cancelled`,
                description: `**${itemName}** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: orderColor,
                fields: [
                    {
                        name: '📦 Amount',
                        value: `\`\`\`fix\n${amount}x\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💵 Price per Unit',
                        value: `\`\`\`fix\n${formatNumber(pricePerUnit)} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '⏱️ Order Age',
                        value: `\`\`\`\n${ageMinutes} minutes\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '📊 Fill Status',
                        value: `\`\`\`\n${filled}/${totalAmount} (${fillPercentage}%)\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '📋 Order Type',
                        value: `\`\`\`\n${orderType}\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '❓ Reason',
                        value: `\`\`\`\n${reason}\n\`\`\``,
                        inline: true
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName} • Purse: ${formatPurse(purse)} coins`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}

export function sendWebhookBazaarOrderClaimed(
    itemName: string,
    amount: number,
    pricePerUnit: number,
    isBuyOrder: boolean
) {
    if (!isWebhookConfigured()) {
        return
    }
    const ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    
    const orderType = isBuyOrder ? 'Buy Order' : 'Sell Offer'
    const orderEmoji = '✅'
    const orderColor = isBuyOrder ? 0x66FF66 : 0xFFCC00 // Light green for buy, gold for sell
    const totalValue = amount * pricePerUnit
    
    sendWebhookData({
        embeds: [
            {
                title: `${orderEmoji} Bazaar ${orderType} Claimed`,
                description: `**${itemName}** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: orderColor,
                fields: [
                    {
                        name: '📦 Amount',
                        value: `\`\`\`fix\n${amount}x\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💵 Price per Unit',
                        value: `\`\`\`fix\n${formatNumber(pricePerUnit)} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💰 Total Value',
                        value: `\`\`\`fix\n${formatNumber(totalValue)} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '📊 Order Type',
                        value: `\`\`\`\n${orderType}\n\`\`\``,
                        inline: false
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName} • Purse: ${formatPurse(purse)} coins`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}

/**
 * Send webhook for filled bazaar orders
 * Called when a buy order or sell offer is filled
 */
export function sendWebhookBazaarOrderFilled(
    itemName: string,
    amount: number,
    isBuyOrder: boolean
) {
    if (!isWebhookConfigured()) {
        return
    }
    const ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    
    const orderType = isBuyOrder ? 'Buy Order' : 'Sell Offer'
    const orderEmoji = isBuyOrder ? '✅' : '💰'
    const orderColor = isBuyOrder ? 0x66FF66 : 0xFFCC00 // Light green for buy filled, gold for sell filled
    
    sendWebhookData({
        embeds: [
            {
                title: `${orderEmoji} Bazaar ${orderType} Filled!`,
                description: `**${itemName}** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: orderColor,
                fields: [
                    {
                        name: 'Item',
                        value: itemName,
                        inline: true
                    },
                    {
                        name: 'Amount',
                        value: `${amount}x`,
                        inline: true
                    }
                ],
                thumbnail: { 
                    url: `https://sky.coflnet.com/static/icon/${itemName.replace(/[^a-zA-Z0-9_]/g, '_')}` 
                },
                footer: {
                    text: `BAF • ${ingameName} • Purse: ${formatPurse(purse)} coins`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}

/**
 * Send periodic profit report webhook
 * Shows total profit, trade count, and bot uptime
 */
export function sendWebhookProfitReport(stats: {
    totalProfit: number
    tradeCount: number
    averageProfit: number
    profitPerHour: number
    uptime: number
}): void {
    if (!isWebhookConfigured()) {
        return
    }
    const ingameName = getConfigProperty('INGAME_NAME')
    const purse = getCurrentPurse()
    
    // Helper to format uptime
    const formatUptime = (ms: number): string => {
        const seconds = Math.floor(ms / 1000)
        const minutes = Math.floor(seconds / 60)
        const hours = Math.floor(minutes / 60)
        const days = Math.floor(hours / 24)
        
        if (days > 0) {
            return `${days}d ${hours % 24}h ${minutes % 60}m`
        } else if (hours > 0) {
            return `${hours}h ${minutes % 60}m`
        } else {
            return `${minutes}m`
        }
    }
    
    // Determine color based on profit (green for positive, red for negative, gray for zero)
    let color = 0x808080 // Gray for zero
    if (stats.totalProfit > 0) {
        color = 0x00FF00 // Green for profit
    } else if (stats.totalProfit < 0) {
        color = 0xFF0000 // Red for loss
    }
    
    const profitSign = stats.totalProfit >= 0 ? '+' : ''
    
    sendWebhookData({
        embeds: [
            {
                title: '📊 Bazaar Profit Report',
                description: `**Periodic Report** • <t:${Math.floor(Date.now() / 1000)}:R>`,
                color: color,
                fields: [
                    {
                        name: '💰 Total Profit',
                        value: `\`\`\`diff\n${profitSign}${formatNumber(stats.totalProfit)} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '📈 Profit/Hour',
                        value: `\`\`\`fix\n${formatNumber(stats.profitPerHour)} coins/h\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '🔄 Trades',
                        value: `\`\`\`\n${stats.tradeCount} completed\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '⏱️ Uptime',
                        value: `\`\`\`\n${formatUptime(stats.uptime)}\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '📊 Avg Profit/Trade',
                        value: `\`\`\`fix\n${formatNumber(stats.averageProfit)} coins\n\`\`\``,
                        inline: true
                    },
                    {
                        name: '💵 Current Purse',
                        value: `\`\`\`fix\n${formatPurse(purse)} coins\n\`\`\``,
                        inline: true
                    }
                ],
                footer: {
                    text: `BAF • ${ingameName} • Automated Report`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}
