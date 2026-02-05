interface SESSIONS {
    [key: string]: ColfSession
}

interface SkipSettings {
    ALWAYS: boolean
    MIN_PROFIT: number
    USER_FINDER: boolean
    SKINS: boolean
    PROFIT_PERCENTAGE: number
    MIN_PRICE: number
}

interface Config {
    INGAME_NAME: string
    WEBHOOK_URL: string
    FLIP_ACTION_DELAY: number
    USE_COFL_CHAT: boolean
    ENABLE_CONSOLE_INPUT: boolean
    SESSIONS: SESSIONS
    WEBSOCKET_URL: string
    BED_MULTIPLE_CLICKS_DELAY: number
    BED_SPAM: boolean
    BED_SPAM_CLICK_DELAY: number
    ENABLE_BAZAAR_FLIPS: boolean
    ENABLE_AH_FLIPS: boolean
    WEB_GUI_PORT: number
    WEB_GUI_PASSWORD: string
    SKIP: SkipSettings
}

interface ColfSession {
    id: string
    expires: Date
}
