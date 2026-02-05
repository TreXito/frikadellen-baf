import readline from 'readline'
import { getConfigProperty } from './configHelper'
import { MyBot } from '../types/autobuy'
import { changeWebsocketURL, getCurrentWebsocket } from './BAF'
import { claimPurchased } from './ingameMessageHandler'
import { printMcChatToConsole } from './logger'
import { sleep } from './utils'

let consoleSetupFinished = false

export function setupConsoleInterface(bot: MyBot) {
    if (!getConfigProperty('ENABLE_CONSOLE_INPUT') || consoleSetupFinished) {
        return
    }
    consoleSetupFinished = true

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    })

    rl.on('line', async input => {
        let ws = await getCurrentWebsocket()
        let lowercaseInput = input.toLowerCase()
        // Route all /cofl and /baf commands to the handler (including single-word commands)
        if (lowercaseInput?.startsWith('/cofl') || lowercaseInput?.startsWith('/baf')) {
            handleCommand(bot, input)
            return
        }
        // All other slash commands go to Minecraft chat
        if (input?.startsWith('/')) {
            bot.chat(input)
            return
        }
        // Non-command messages go to the websocket
        ws.send(
            JSON.stringify({
                type: 'chat',
                data: JSON.stringify(input)
            })
        )
    })
}

export async function handleCommand(bot: MyBot, data: string, fromServer: boolean = false) {
    let wss = await getCurrentWebsocket()
    let lowercaseInput = data.toLowerCase()
    
    // Check if this is a /cofl or /baf command
    if (lowercaseInput?.startsWith('/cofl') || lowercaseInput?.startsWith('/baf')) {
        let splits = data.split(' ')
        let prefix = splits.shift() // remove /cofl or /baf and store it
        let command = splits.shift()

        // Handle locally-processed commands that require a subcommand
        if (command === 'connect') {
            changeWebsocketURL(splits[0])
            return
        }
        if (command === 'forceClaim') {
            printMcChatToConsole(`§f[§4BAF§f]: §fForce claiming...`)
            let canStillClaim = true
            while (canStillClaim) {
                try {
                    canStillClaim = await claimPurchased(bot, false)
                    await sleep(1000)
                } catch (e) {
                    canStillClaim = false
                    printMcChatToConsole(`§f[§4BAF§f]: §fRan into error while claiming. Please check your logs or report this to the developer.`)
                }
            }
            printMcChatToConsole(`§f[§4BAF§f]: §fFinished claiming.`)
            return
        }

        // Only send to websocket if this command originated from user input (not from server)
        // This prevents infinite loops where server sends 'execute' -> client sends back 'execute' -> etc
        if (!fromServer) {
            // For commands with a subcommand (e.g., /cofl getbazaarflips), send with the command as the type
            if (command) {
                // Send the command to the websocket with the command name as the type
                // and any remaining arguments as the data
                wss.send(
                    JSON.stringify({
                        type: command,
                        data: `"${splits.join(' ')}"`
                    })
                )
            } else {
                // For bare /cofl or /baf commands without arguments, send as chat
                // This allows the server to handle them appropriately
                wss.send(
                    JSON.stringify({
                        type: 'chat',
                        data: JSON.stringify('')
                    })
                )
            }
        }
    } else {
        // For non-cofl/baf commands sent via 'execute' websocket message, send to game chat
        bot.chat(data)
    }
}
