// Socket wrapper for AutoBuy - emits flip events from WebSocket messages
const EventEmitter = require('events')

export class SocketWrapper extends EventEmitter {
    private websocket: any

    constructor() {
        super()
    }

    setWebSocket(ws: any) {
        this.websocket = ws
    }

    getWs() {
        return this.websocket
    }

    // Called by BAF.ts when a flip message arrives
    emitFlip(flipData: any) {
        this.emit('flip', flipData)
    }
}
