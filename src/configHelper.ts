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
    ENABLE_BAZAAR_FLIPS: true,
    ENABLE_AH_FLIPS: true,
    SKIP: {
        ALWAYS: false,
        MIN_PROFIT: 1000000,
        USER_FINDER: false,
        SKINS: false,
        PROFIT_PERCENTAGE: 50,
        MIN_PRICE: 10000000
    }
}

json2toml({ simple: true })

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
            fs.writeFileSync(filePath, prepareTomlBeforeWrite(json2toml(existingConfig)))
        }

        config = existingConfig
    }
}

export function updatePersistentConfigProperty(property: keyof Config, value: any) {
    config[property as string] = value
    fs.writeFileSync(filePath, prepareTomlBeforeWrite(json2toml(config)))
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

    return lines.join('\n')
}
