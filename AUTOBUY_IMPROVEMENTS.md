# Autobuy Improvements - TPM-rewrite Integration

## Overview
This document describes the improvements made to the frikadellen-baf autobuy mechanism by applying architectural patterns from the TPM-rewrite implementation.

## Key Improvements

### 1. Window Event Handling
**Before:** Used mineflayer's `windowOpen` event
**After:** Uses low-level `open_window` packet listener from `bot._client`

**Benefits:**
- More reliable window detection
- Faster response time
- Better handling of edge cases

### 2. Item Detection with Polling
**Before:** Relied on timing assumptions for item loading
**After:** Implemented `itemLoad()` function that polls slot 31 every 1ms

**Benefits:**
- Handles race conditions and delayed item loading
- 3x delay timeout failsafe prevents infinite loops
- Robust detection of all item types

### 3. Comprehensive Item Type Handling
Added handlers for all possible items in slot 31:

| Item | Scenario | Action |
|------|----------|--------|
| `gold_nugget` | Normal purchase button | Click to purchase, check skip conditions |
| `bed` | Bed flip (timed auction) | Initiate bed spam or multiple clicks |
| `potato` | Failed purchase (potatoed) | Close window, log failure |
| `feather` | Delayed loading | Double-check for potato or gold_block |
| `gold_block` | Sold item to claim | Click to claim |
| `poisonous_potato` | Insufficient funds | Close window, log "too poor" |
| `stained_glass_pane` | Edge cases | Close window |

### 4. Skip Logic Improvements
**Before:** Skip checked AFTER clicking purchase
**After:** Skip checked BEFORE clicking purchase

**Benefits:**
- Prevents unwanted purchase packets from being sent
- Uses `clickSlot()` for skip button in next window
- Cleaner skip reason logging with helper functions

### 5. Packet Optimization
Added `confirmClick()` function that sends transaction packet:
```typescript
bot._client.write('transaction', {
    windowId: windowID,
    action: actionCounter,
    accepted: true
})
```

**Benefits:**
- Faster window confirmation
- Reduced latency in purchase flow

### 6. Bed Spam Functionality
Added two modes for bed flips:

**Bed Spam Mode** (`BED_SPAM: true`):
- Continuous clicking with configurable delay
- Monitors for window/item changes
- Automatic cleanup on success/failure
- 5-second timeout failsafe

**Multiple Click Mode** (`BED_SPAM: false`):
- Fixed number of clicks (3 or 5)
- Delay between clicks from config
- More predictable behavior

## Configuration Changes

### New Config Options

```toml
# Enable continuous bed spam clicking instead of fixed number of clicks
# More aggressive but may be more effective
BED_SPAM = false

# Delay in milliseconds between each click when BED_SPAM is enabled
# Lower values = faster clicking (minimum: 1ms)
BED_SPAM_CLICK_DELAY = 5
```

### Existing Config Enhanced

The `SKIP` section now properly validates that `FLIP_ACTION_DELAY >= 150ms` when `SKIP.ALWAYS = true`, with improved warning messages.

## Code Quality Improvements

### Constants Extracted
All magic numbers replaced with named constants:
- `CONFIRM_RETRY_DELAY = 50` - Delay between confirm attempts
- `MAX_CONFIRM_ATTEMPTS = 5` - Maximum confirm retry attempts
- `MAX_UNDEFINED_COUNT = 5` - Undefined items threshold for bed spam
- `BED_SPAM_TIMEOUT_MS = 5000` - Failsafe timeout for bed spam
- `BED_CLICKS_WITH_DELAY = 5` - Clicks when delay configured
- `BED_CLICKS_DEFAULT = 3` - Default bed clicks
- `BED_CLICK_DELAY_FALLBACK = 3` - Fallback delay between clicks
- `WINDOW_INTERACTION_DELAY = 500` - General window interaction delay

### Helper Functions
Extracted reusable logic into focused functions:

1. **`itemLoad(bot, slot, alreadyLoaded)`** - Polls window slot for item with timeout
2. **`confirmClick(bot, windowId)`** - Sends confirmation transaction packet
3. **`clickSlot(bot, slot, windowId, itemId)`** - Low-level slot clicking with packets
4. **`shouldSkipFlip(flip, profit)`** - Determines if flip should be skipped
5. **`logSkipReason(flip, profit)`** - Logs why a flip was skipped
6. **`initBedSpam(bot, flip, isBed)`** - Handles bed spam logic

## Testing Results

### TypeScript Compilation
✅ **PASSED** - No compilation errors

### Code Review
✅ **PASSED** - 2 rounds of review, all issues addressed:
- Removed duplicate code in `itemLoad()`
- Extracted magic numbers to constants
- Fixed duplicate `getConfigProperty()` calls
- Fixed `undefinedCount` increment bug
- Improved warning messages with current values

### Security Scan (CodeQL)
✅ **PASSED** - No security vulnerabilities detected

## Migration Notes

### Backward Compatibility
- All existing functionality preserved
- Queue system unchanged (as requested)
- Configuration backward compatible with defaults
- No breaking changes to public APIs

### New Behavior
Users will notice:
1. More reliable flip purchases
2. Better handling of "potatoed" scenarios
3. Improved bed flip timing
4. More informative skip messages
5. Faster window confirmations

## Performance Impact

### Positive Impacts
- Faster purchase confirmations (transaction packet)
- More reliable item detection (polling)
- Reduced failed purchases (potato detection)

### Potential Concerns
- Slightly higher CPU usage from item polling (1ms intervals)
- Mitigated by 3x delay timeout (typically 300-450ms max)

## Future Enhancements

Potential areas for future improvement:
1. Add metrics/statistics for flip success rates
2. Make item detection timeout configurable
3. Add support for queue system (if needed in future)
4. Optimize polling interval based on performance
5. Add support for auction claiming with coop fraud detection

## References

- TPM-rewrite AutoBuy.js: `/tmp/TPM-rewrite/TPM-bot/AutoBuy.js`
- Original implementation: `src/flipHandler.ts` (pre-changes)
- Configuration: `src/configHelper.ts`
- Type definitions: `types/autobuy.d.ts`, `types/config.d.ts`

## Commits

1. `7777d2c` - Implement TPM-style autobuy with improved window handling and item detection
2. `3e345a2` - Refactor flipHandler: extract helper functions and use named constants
3. `bedbdbd` - Fix code review issues: avoid duplicate config calls and fix undefinedCount logic

Total changes: 3 files, +357 lines, -67 lines
