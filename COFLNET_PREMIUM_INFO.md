# Coflnet Premium Info Extraction

## Overview

The bot now extracts and displays Coflnet premium information in the starting webhook. This includes:
- **Premium Tier** (e.g., "Premium", "Premium+", "Premium Plus")
- **Expiration Date** (e.g., "2026-Feb-10 08:55 UTC")
- **Connection ID** (e.g., "74e0d17ae2929ab12e2f97bc50f4c3da")

## Message Sources

Coflnet sends this information through websocket messages during connection:

### Premium Tier & Expiration
**Message Type:** `writeToChat`
```json
{
  "type": "writeToChat",
  "data": {
    "text": "[Coflnet]: Hello argamer1014 (tre********@****l.com) \\nYou have Premium until 2026-Feb-10 08:55 UTC",
    "onClick": null,
    "hover": "That is in 0d 2h 2m 30s"
  }
}
```

**Regex Pattern:** `/You have (.+?) until (.+?)(?:\\n|$)/`
- Captures the tier name (e.g., "Premium", "Premium+")
- Captures the expiration date/time

### Connection ID
**Message Type:** `chatMessage`
```json
{
  "type": "chatMessage",
  "data": [
    {"text": "[Coflnet]: ", "onClick": null, "hover": null},
    {"text": "Your connection id is 74e0d17ae2929ab12e2f97bc50f4c3da, copy that if you encounter an error", "onClick": null, "hover": null}
  ]
}
```

**Regex Pattern:** `/Your connection id is ([a-f0-9]{32})/`
- Captures the 32-character hexadecimal connection ID

## Implementation

### Storage (BAF.ts)
```typescript
// Module-level variables to store Coflnet info
let coflnetPremiumTier: string | null = null
let coflnetPremiumExpires: string | null = null
let coflnetConnectionId: string | null = null
```

### Parsing Logic (BAF.ts - onWebsocketMessage)

#### For writeToChat messages:
```typescript
case 'writeToChat':
    // Extract Coflnet premium tier and expiration date
    const premiumMatch = data.text.match(/You have (.+?) until (.+?)(?:\\n|$)/)
    if (premiumMatch) {
        coflnetPremiumTier = premiumMatch[1].trim()
        coflnetPremiumExpires = premiumMatch[2].trim()
        log(`[Coflnet] Premium: ${coflnetPremiumTier} until ${coflnetPremiumExpires}`, 'info')
    }
    // ... rest of handler
    break
```

#### For chatMessage messages:
```typescript
case 'chatMessage':
    for (let da of [...(data as TextMessageData[])]) {
        // Extract Coflnet connection ID
        const connectionIdMatch = da.text.match(/Your connection id is ([a-f0-9]{32})/)
        if (connectionIdMatch) {
            coflnetConnectionId = connectionIdMatch[1]
            log(`[Coflnet] Connection ID: ${coflnetConnectionId}`, 'info')
        }
        // ... rest of handler
    }
    break
```

### Export Function (BAF.ts)
```typescript
/**
 * Get stored Coflnet premium information
 * Returns null values if not yet received from Coflnet
 */
export function getCoflnetPremiumInfo() {
    return {
        tier: coflnetPremiumTier,
        expires: coflnetPremiumExpires,
        connectionId: coflnetConnectionId
    }
}
```

### Webhook Display (webhookHandler.ts)

```typescript
export function sendWebhookInitialized() {
    // ... setup code ...
    
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
                color: 0x00ff88,
                fields: fields.length > 0 ? fields : undefined,
                footer: {
                    text: `BAF - ${ingameName}`,
                    icon_url: `https://mc-heads.net/avatar/${ingameName}/32.png`
                }
            }
        ]
    })
}
```

## Webhook Display Format

The starting webhook now shows:

```
✓ Started BAF

AH Flips: ✅ | Bazaar Flips: ✅
[relative timestamp]

**Coflnet Premium** expires 2026-Feb-10 08:55 UTC

Connection ID
`74e0d17ae2929ab12e2f97bc50f4c3da`

───────────────────────
BAF - YourMinecraftName
```

### Connection ID Formatting

The connection ID is displayed using Discord's inline code formatting (`` `id` ``). This provides several benefits:

1. **Visual Distinction**: The monospace font makes it stand out
2. **Easy Selection**: Double-clicking the ID selects only the ID text
3. **Copy-Friendly**: Users can quickly copy just the ID for support tickets
4. **No Line Breaks**: The entire ID stays on one line

## Edge Cases

### Missing Information

If Coflnet messages haven't been received yet when the webhook is sent:
- The premium tier and expiration won't be shown in the description
- The Connection ID field won't be added to the embed
- This is normal during initial connection; the info will be available for the next restart

### Partial Information

If only some information is received:
- Premium tier and expiration are only shown if both are present
- Connection ID is shown independently if available

### Premium Tier Variations

The regex pattern handles various tier names:
- "Premium" → Basic premium tier
- "Premium+" → Premium plus tier
- "Premium Plus" → Alternative naming
- Any other tier names Coflnet might introduce

## Testing

To verify the implementation:

1. **Check logs** when connecting to Coflnet:
   ```
   [Coflnet] Premium: Premium until 2026-Feb-10 08:55 UTC
   [Coflnet] Connection ID: 74e0d17ae2929ab12e2f97bc50f4c3da
   ```

2. **Verify webhook** displays all three pieces of information

3. **Test double-click selection** on the connection ID in Discord

## Future Enhancements

Possible improvements:
- Store the premium expiration as a timestamp for countdown display
- Add a warning if premium is expiring soon
- Color-code the embed based on premium tier
- Add a link to manage premium subscription
