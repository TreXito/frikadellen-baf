import { getConfigProperty } from './configHelper'
import { log } from './logger'

export interface ProxyConfig {
    host: string
    port: number
    username?: string
    password?: string
}

/**
 * Parses the proxy configuration from config
 * PROXY format: "IP:port" or "hostname:port"
 * Returns null if proxy is disabled or not configured
 */
export function getProxyConfig(): ProxyConfig | null {
    const proxyEnabled = getConfigProperty('PROXY_ENABLED')
    
    if (!proxyEnabled) {
        return null
    }
    
    const proxyString = getConfigProperty('PROXY')
    
    if (!proxyString) {
        log('PROXY_ENABLED is true but PROXY is not configured', 'warn')
        return null
    }
    
    try {
        const parts = proxyString.split(':')
        
        if (parts.length !== 2) {
            log(`Invalid PROXY format: ${proxyString}. Expected format: "IP:port"`, 'error')
            return null
        }
        
        const host = parts[0].trim()
        const port = parseInt(parts[1].trim())
        
        if (!host || isNaN(port) || port <= 0 || port > 65535) {
            log(`Invalid PROXY configuration: host="${host}", port="${port}"`, 'error')
            return null
        }
        
        const username = getConfigProperty('PROXY_USERNAME')
        const password = getConfigProperty('PROXY_PASSWORD')
        
        const config: ProxyConfig = { host, port }
        
        if (username) {
            config.username = username
        }
        
        if (password) {
            config.password = password
        }
        
        log(`Proxy configured: ${host}:${port}${username ? ' (with auth)' : ''}`, 'info')
        
        return config
    } catch (error) {
        log(`Error parsing proxy configuration: ${error}`, 'error')
        return null
    }
}
