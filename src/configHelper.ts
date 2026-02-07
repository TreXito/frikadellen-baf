let fs = require('fs')
let path = require('path')
let filePath = path.join((process as any).pkg ? process.argv[0] : process.argv[1], '..', 'config.toml')

var json2toml = require('json2toml')
var toml = require('toml')
let config: Config = {
    INGAME_NAME: '',
    WEBHOOK_URL: '',
    FLIP_ACTION_DELAY: 100,
    ENABLE_CONSOLE_INPUT: true,
    USE_COFL_CHAT: true,
    SESSIONS: {},
    WEBSOCKET_URL: 'wss://sky.coflnet.com/modsocket',
    BED_MULTIPLE_CLICKS_DELAY: 50,
    BED_SPAM: false,
    BED_SPAM_CLICK_DELAY: 5,
    ENABLE_BAZAAR_FLIPS: true,
    ENABLE_AH_FLIPS: true,
    WEB_GUI_PORT: 8080,
    WEB_GUI_PASSWORD: '',
    AUCTION_DURATION_HOURS: 24,
    SKIP: {
        ALWAYS: false,
        MIN_PROFIT: 1000000,
        USER_FINDER: false,
        SKINS: false,
        PROFIT_PERCENTAGE: 50,
        MIN_PRICE: 10000000
    },
    PROXY_ENABLED: false,
    PROXY: undefined,
    PROXY_USERNAME: undefined,
    PROXY_PASSWORD: undefined,
    ACCOUNTS: undefined,
    AUTO_SWITCHING: undefined
}

json2toml({ simple: true })

function removeUndefinedValues(obj: any): any {
    if (obj === null || obj === undefined || typeof obj !== 'object') {
        return obj
    }
    
    if (Array.isArray(obj)) {
        return obj.map(item => removeUndefinedValues(item)).filter(item => item !== undefined)
    }
    
    const cleaned: any = {}
    for (const [key, value] of Object.entries(obj)) {
        if (value !== undefined) {
            if (typeof value === 'object' && value !== null) {
                cleaned[key] = removeUndefinedValues(value)
            } else {
                cleaned[key] = value
            }
        }
    }
    return cleaned
}

export function initConfigHelper() {
    if (fs.existsSync(filePath)) {
        let existingConfig = toml.parse(fs.readFileSync(filePath, { encoding: 'utf8', flag: 'r' }))

        // add new default values to existing config if new property was added in newer version
        let hadChange = false
        Object.keys(config).forEach(key => {
            if (existingConfig[key] === undefined) {
                existingConfig[key] = config[key]
                hadChange = true
            } else if (typeof config[key] === 'object' && !Array.isArray(config[key]) && config[key] !== null && key !== 'SESSIONS') {
                // Recursively merge nested objects (like SKIP settings)
                // SESSIONS is excluded because it stores dynamic session data that shouldn't be overwritten with defaults
                Object.keys(config[key]).forEach(nestedKey => {
                    if (existingConfig[key][nestedKey] === undefined) {
                        existingConfig[key][nestedKey] = config[key][nestedKey]
                        hadChange = true
                    }
                })
            }
        })
        if (hadChange) {
            fs.writeFileSync(filePath, prepareTomlBeforeWrite(json2toml(removeUndefinedValues(existingConfig))))
        }

        config = existingConfig
    }
}

export function updatePersistentConfigProperty(property: keyof Config, value: any) {
    config[property as string] = value
    fs.writeFileSync(filePath, prepareTomlBeforeWrite(json2toml(removeUndefinedValues(config))))
}

export function getConfigProperty(property: keyof Config): any {
    return config[property]
}

function prepareTomlBeforeWrite(tomlString: string): string {
    let lines = tomlString.split('\n')
    let index = lines.findIndex(l => l.startsWith('BED_MULTIPLE_CLICKS_DELAY = '))
    lines.splice(
        index,
        0,
        '# Bed flips are clicked 3 times with this setting. First delay in milliseconds before it should mathematically work. Once exactly at the time and once after the time. Disable it with a value less than 0.'
    )

    // Add comments for BED_SPAM
    let bedSpamIndex = lines.findIndex(l => l.startsWith('BED_SPAM = '))
    if (bedSpamIndex !== -1) {
        lines.splice(
            bedSpamIndex,
            0,
            '# Enable continuous bed spam clicking instead of fixed number of clicks. More aggressive but may be more effective.'
        )
    }

    // Add comments for BED_SPAM_CLICK_DELAY
    let bedSpamDelayIndex = lines.findIndex(l => l.startsWith('BED_SPAM_CLICK_DELAY = '))
    if (bedSpamDelayIndex !== -1) {
        lines.splice(
            bedSpamDelayIndex,
            0,
            '# Delay in milliseconds between each click when BED_SPAM is enabled. Lower values = faster clicking (minimum: 1ms)'
        )
    }

    // Add comments for AUCTION_DURATION_HOURS
    let auctionDurationLineIndex = lines.findIndex(l => l.startsWith('AUCTION_DURATION_HOURS = '))
    if (auctionDurationLineIndex !== -1) {
        lines.splice(
            auctionDurationLineIndex,
            0,
            '',
            '# Duration in hours for listing auctions on the Auction House (default: 24 hours)'
        )
    }

    // Add comments for SKIP section
    let skipIndex = lines.findIndex(l => l.startsWith('[SKIP]'))
    if (skipIndex !== -1) {
        lines.splice(
            skipIndex,
            0,
            '',
            '# Skip configuration - automatically skip confirmation on certain flips',
            '# ALWAYS: Always skip confirmation (requires FLIP_ACTION_DELAY >= 150)',
            '# MIN_PROFIT: Skip if profit is above this value (in coins)',
            '# USER_FINDER: Skip if flip was found by USER',
            '# SKINS: Skip if the item is a skin',
            '# PROFIT_PERCENTAGE: Skip if profit percentage is above this value',
            '# MIN_PRICE: Skip if starting bid is above this value (in coins)'
        )
    }

    // Add comments for proxy settings
    let proxyEnabledIndex = lines.findIndex(l => l.startsWith('PROXY_ENABLED = '))
    if (proxyEnabledIndex !== -1) {
        lines.splice(
            proxyEnabledIndex,
            0,
            '',
            '# Proxy configuration (optional)',
            '# PROXY_ENABLED: Enable or disable proxy usage (true/false)',
            '# PROXY: Proxy server in IP:port format (e.g., "127.0.0.1:8080")',
            '# PROXY_USERNAME: Proxy authentication username (optional)',
            '# PROXY_PASSWORD: Proxy authentication password (optional)'
        )
    }

    // Add comments for account switching
    let accountsIndex = lines.findIndex(l => l.startsWith('ACCOUNTS = '))
    if (accountsIndex !== -1) {
        lines.splice(
            accountsIndex,
            0,
            '',
            '# Automatic account switching (optional)',
            '# ACCOUNTS: Comma-separated list of Minecraft usernames (e.g., "user1,user2,user3")',
            '# AUTO_SWITCHING: Time allocation for each account in minutes (e.g., "user1:8,user2:8,user3:8")',
            '# The bot will automatically switch between accounts based on the time allocation'
        )
    }

    return lines.join('\n')
}
