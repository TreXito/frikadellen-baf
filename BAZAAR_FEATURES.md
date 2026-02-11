# Bazaar Features Implementation

This document describes the six major bazaar features implemented to enhance the bot's order management capabilities.

## Feature 1: Correct Order Cancellation Flow

### Problem
The order cancellation flow was not properly handling the actual Hypixel behavior where clicking an order in Manage Orders updates the current window instead of opening a new window.

### Solution
Updated `processOrderDetails()` in `bazaarOrderManager.ts` to:
- Wait 500ms after clicking an order slot for the window to update
- Check `bot.currentWindow` directly instead of listening for new window events
- Click the order slot again if there are claims to make (for partially filled orders)
- Find the Cancel Order button at slot 13 after all claims are processed
- Only cancel orders that are NOT fully filled (determined from lore data)

### Implementation Details
- `WINDOW_UPDATE_DELAY_MS = 800ms` - wait time for window to refresh
- Cancel button is always at slot 13 according to Hypixel logs
- Flow: `/bz` → Manage Orders → Click order → Claim (if needed) → Click again → Cancel (if not fully filled)

## Feature 2: Order Details from Item Lore

### Problem
The bot had no visibility into whether an order was partially filled, fully filled, or unfilled, leading to unnecessary cancellation attempts.

### Solution
Added lore parsing to extract detailed order information:
- Fill status (e.g., "Filled: 26/64 (40.6%)")
- Total amount ordered
- Price per unit
- Whether the order is fully filled (100%)

### Implementation Details
- `parseLoreForOrderDetails()` function extracts fill data using regex patterns
- `BazaarOrderRecord` interface extended with lore-based fields:
  - `filled`: number of items filled
  - `totalAmount`: total items ordered
  - `fillPercentage`: percentage filled (0-100)
  - `isFullyFilled`: boolean flag for 100% filled orders
- Fully filled orders are skipped during cancellation checks
- Used in `discoverExistingOrders()` to properly track startup orders

## Feature 3: Order Slot Limits

### Problem
Hypixel limits players to 14 total orders with a maximum of 7 buy orders. The bot was not checking these limits before attempting to place orders.

### Solution
Added order counting and validation before placing new orders:
- `getOrderCounts()` function returns `{totalOrders, buyOrders}`
- Checks in `handleBazaarFlipRecommendation()`:
  - Reject if total orders ≥ 14
  - Reject buy orders if buy orders ≥ 7
  - Log appropriate warning messages

### Implementation Details
```typescript
// Check order slot limits (14 total, 7 buy orders max)
const { totalOrders, buyOrders } = getOrderCounts()

if (totalOrders >= 14) {
    log('[BAF]: Cannot place order - 14/14 order slots used', 'warn')
    return
}

if (recommendation.isBuyOrder && buyOrders >= 7) {
    log('[BAF]: Cannot place buy order - 7/7 buy order slots used', 'warn')
    return
}
```

### Future Enhancement
Could trigger an automatic claim/cancel cycle to free up slots when limits are reached.

## Feature 4: Daily Sell Limit Detection

### Problem
Hypixel has a daily limit on the total value of items that can be sold via the bazaar. When reached, the bot should stop placing sell offers but can still place buy orders.

### Solution
Added chat message detection for the daily limit notification:
- Listen for: `[Bazaar] You reached the daily limit in items value that you may sell on the bazaar!`
- Set `bazaarDailyLimitReached` flag when detected
- Automatically reset after 24 hours
- Skip sell offers when limit is active (buy orders still allowed)

### Implementation Details
- Detection in `ingameMessageHandler.ts`
- `isBazaarDailyLimitReached()` exported function for checking status
- Checked in `handleBazaarFlipRecommendation()` before placing sell offers
- 24-hour auto-reset timer using `setTimeout()`

## Feature 5: Auto-Request Bazaar Flips

### Problem
The bot needed to manually request bazaar flip recommendations. For optimal operation, it should automatically request new flips periodically.

### Solution
Implemented automatic bazaar flip requests every 5 minutes:
- Starts after the startup workflow completes
- Sends `/cofl getbazaarflips` via websocket
- Only requests when bot is idle (`bot.state === null`) and flips are enabled
- Can be stopped via `stopBazaarFlipRequests()` function

### Implementation Details
```typescript
function startBazaarFlipRequests(wss: WebSocket): void {
    bazaarFlipRequestInterval = setInterval(() => {
        if (getConfigProperty('ENABLE_BAZAAR_FLIPS') && bot.state === null) {
            wss.send(JSON.stringify({
                type: 'getbazaarflips',
                data: JSON.stringify('')
            }))
        }
    }, 5 * 60 * 1000) // 5 minutes
}
```

## Feature 6: Scoreboard Purse Parsing

### Problem
The bot had no awareness of the player's current purse balance, making it impossible to check if the bot could afford an order or cookie before attempting to purchase.

### Solution
Parse the purse amount from scoreboard data:
- Extract from scoreboard lines like `Purse: 1,151,612,206` or `Purse: 1,151,612,206 (+5)`
- Store in module-level variable `currentPurse`
- Export `getCurrentPurse()` for use in other modules
- Parse whenever scoreboard is uploaded

### Implementation Details
```typescript
function parsePurseFromScoreboard(scoreboardLines: string[]): void {
    for (const line of scoreboardLines) {
        const cleanLine = removeMinecraftColorCodes(line)
        if (cleanLine.includes('Purse:')) {
            const match = cleanLine.match(/Purse:\s*([\d,]+)/)
            if (match) {
                const purseStr = match[1].replace(/,/g, '')
                currentPurse = parseInt(purseStr, 10)
            }
            break
        }
    }
}
```

### Usage
- Affordability check in `handleBazaarFlipRecommendation()` before placing orders
- Can be used in `checkAndBuyCookie()` to verify the bot can afford a cookie
- Updated whenever scoreboard data is uploaded to Coflnet

## Configuration

No new configuration options were added. All features work with existing config:
- `ENABLE_BAZAAR_FLIPS`: Controls bazaar flip functionality
- `BAZAAR_ORDER_CANCEL_MINUTES`: Time before cancelling unfilled orders (default: 10)
- `BAZAAR_ORDER_CHECK_INTERVAL_SECONDS`: Order check frequency (default: 120)

## Files Modified

1. **src/BAF.ts**
   - Added `currentPurse` tracking variable
   - Added `parsePurseFromScoreboard()` function
   - Added `getCurrentPurse()` export
   - Added `startBazaarFlipRequests()` and `stopBazaarFlipRequests()` functions
   - Integrated purse parsing into `onScoreboardChanged()`
   - Start auto-request timer in `runStartupWorkflow()`

2. **src/bazaarOrderManager.ts**
   - Extended `BazaarOrderRecord` interface with lore fields
   - Added `parseLoreForOrderDetails()` function
   - Added `getOrderCounts()` export function
   - Updated `discoverExistingOrders()` to parse lore
   - Updated `processOrderDetails()` to handle claim-then-cancel flow correctly
   - Updated `checkOrders()` to skip fully filled orders

3. **src/bazaarFlipHandler.ts**
   - Added imports for `isBazaarDailyLimitReached()` and `getCurrentPurse()`
   - Added order slot limit checks in `handleBazaarFlipRecommendation()`
   - Added daily sell limit check
   - Added purse affordability check

4. **src/ingameMessageHandler.ts**
   - Added `bazaarDailyLimitReached` flag and reset timer
   - Added daily limit detection in message handler
   - Added `isBazaarDailyLimitReached()` export function

## Testing Recommendations

1. **Feature 1 (Cancel Flow)**
   - Place a partially filled order and verify it claims then cancels
   - Place a fully filled order and verify it only claims (no cancel attempt)
   - Place an unfilled order and verify it cancels without claiming

2. **Feature 2 (Lore Parsing)**
   - Check logs during `discoverExistingOrders()` to see fill percentages
   - Verify fully filled orders (100%) are not cancelled

3. **Feature 3 (Slot Limits)**
   - Create 14 active orders and verify new orders are rejected
   - Create 7 buy orders and verify new buy orders are rejected

4. **Feature 4 (Daily Limit)**
   - Manually trigger the daily limit message (if possible in test env)
   - Verify sell offers are blocked but buy orders still work
   - Check that limit resets after 24 hours

5. **Feature 5 (Auto-Request)**
   - Monitor logs to see bazaar flip requests every 5 minutes
   - Verify requests only happen when bot is idle
   - Check that requests stop when bazaar flips are disabled

6. **Feature 6 (Purse Parsing)**
   - Check logs after joining SkyBlock to see purse amount
   - Verify orders are rejected when purse is insufficient
   - Test with different purse amounts (rich and poor accounts)

## Known Limitations

1. **Slot Limit Handling**: When limits are reached, the bot logs a warning but doesn't automatically trigger a claim/cancel cycle to free up slots. This could be added as a future enhancement.

2. **Daily Limit Reset**: The 24-hour reset is based on when the limit is detected, not on Hypixel's actual daily reset time. This means the first reset may be inaccurate by a few hours.

3. **Purse Updates**: The purse is only updated when the scoreboard is re-uploaded. If the purse changes during operation (from selling items, etc.), it may not be reflected immediately.

4. **Lore Format Changes**: If Hypixel changes the lore format for orders, the parsing regex may need to be updated.

## Future Enhancements

1. Auto-trigger claim/cancel cycle when order slots are full
2. More sophisticated purse tracking (update on every transaction)
3. Configurable auto-request interval (currently fixed at 5 minutes)
4. Daily limit reset based on Hypixel's actual reset time
5. More detailed analytics on order fill rates and profitability
