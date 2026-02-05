# WebSocket Testing Documentation

## Connection Details
- **URL**: `wss://sky.coflnet.com/modsocket`
- **Protocol**: WebSocket Secure (WSS)

## Test Commands

### Command 1: Get Bazaar Flips
```json
{
    "type": "getbazaarflips",
    "data": ""
}
```

### Command 2: Get Bazaar (Alternative)
```json
{
    "type": "getbazaar",
    "data": ""
}
```

## Expected Response Format

Based on the `parseBazaarFlipJson()` function in `bazaarFlipHandler.ts`, the server is expected to respond with JSON data in one of these formats:

### Format 1: Single Recommendation
```json
{
    "type": "getbazaarflips",
    "data": {
        "itemName": "Enchanted Coal",
        "amount": 71680,
        "pricePerUnit": 2.8,
        "totalPrice": 200704,
        "isBuyOrder": true
    }
}
```

### Format 2: Multiple Recommendations (Array)
```json
{
    "type": "getbazaarflips",
    "data": [
        {
            "itemName": "Enchanted Coal",
            "amount": 71680,
            "pricePerUnit": 2.8,
            "totalPrice": 200704,
            "isBuyOrder": true
        },
        {
            "itemName": "Cindershade",
            "amount": 4,
            "pricePerUnit": 265000,
            "totalPrice": 1060000,
            "isBuyOrder": true
        }
    ]
}
```

### Alternative JSON Field Names Supported

The parser in `parseBazaarFlipJson()` supports multiple field name variations:

- **Item Name**: `itemName`, `item`, or `name`
- **Amount**: `amount`, `count`, or `quantity`
- **Price Per Unit**: `pricePerUnit`, `price`, or `unitPrice`
- **Total Price**: `totalPrice` (or calculated as `pricePerUnit * amount`)
- **Order Type**: 
  - `isBuyOrder`: boolean (true/false)
  - `type`: string ("buy"/"sell")
  - `orderType`: string ("buy"/"sell")

### Alternative Format Examples

```json
{
    "item": "Enchanted Coal",
    "count": 71680,
    "price": 2.8,
    "type": "buy"
}
```

```json
{
    "name": "Cindershade",
    "quantity": 4,
    "unitPrice": 265000,
    "orderType": "sell"
}
```

## How the Bot Processes Bazaar Flips

When the bot receives a bazaar flip recommendation:

1. **Parsing**: The JSON is parsed by `parseBazaarFlipJson()` to extract:
   - Item name
   - Amount to buy/sell
   - Price per unit
   - Whether it's a buy order or sell offer

2. **Validation**: Checks if:
   - Bazaar flips are enabled (`ENABLE_BAZAAR_FLIPS` config)
   - Bot is not busy with another operation
   - Bazaar flips are not paused

3. **Execution**: Opens bazaar for the item and:
   - Clicks slot 19 (Buy Order) or 20 (Sell Offer)
   - Clicks slot 13 to enter custom amount
   - Types amount in chat
   - Clicks slot 13 to enter custom price
   - Types price in chat
   - Clicks slot 11 to confirm

## Testing Without Network Access

Since the WebSocket connection requires network access to `sky.coflnet.com`, here's a sample test script:

```javascript
// test-websocket.js
const WebSocket = require('ws');
const ws = new WebSocket('wss://sky.coflnet.com/modsocket');

ws.on('open', () => {
    console.log('Connected!');
    
    // Send getbazaarflips command
    ws.send(JSON.stringify({
        type: 'getbazaarflips',
        data: JSON.stringify('')
    }));
});

ws.on('message', (data) => {
    console.log('Received:', data.toString());
    const parsed = JSON.parse(data);
    
    if (parsed.type === 'getbazaarflips') {
        console.log('Bazaar flip data:', parsed.data);
    }
});
```

## Fix Applied

The fix changes how `/cofl getbazaarflips` is sent to the server:

**Before (BAF.ts line 332-333):**
```typescript
wss.send(JSON.stringify({
    type: 'chat',
    data: JSON.stringify('/cofl getbazaarflips')
}))
```

**After:**
```typescript
wss.send(JSON.stringify({
    type: 'getbazaarflips',
    data: JSON.stringify('')
}))
```

This ensures the command is sent directly to the WebSocket with the proper type, not as a chat message. This matches the behavior of other `/cofl` commands in `consoleHandler.ts`.

## Message Flow

1. User enables `ENABLE_BAZAAR_FLIPS` in config
2. Bot joins Skyblock and reaches island
3. Bot automatically sends `getbazaarflips` command via WebSocket
4. Server responds with bazaar flip recommendations
5. Bot processes each recommendation and places orders
6. User can manually send `/cofl getbazaarflips` via console

## Slot Numbers Reference

Based on `bazaarFlipHandler.ts` implementation:

| GUI | Slot | Purpose |
|-----|------|---------|
| Bazaar ➜ ItemName | 19 | Create Buy Order |
| Bazaar ➜ ItemName | 20 | Create Sell Offer |
| How many do you want to... | 13 | Custom Amount Input |
| How much do you want to pay/be paid | 13 | Custom Price Input |
| Confirm... | 11 | Confirm Button |
