# Command Queue System - Implementation Summary

## Problem Statement

The bot was executing commands chaotically, with operations interrupting each other:

```
A Stranger appears on your island at 8, 100, 41! You should go talk to them.
[BAF]: [OrderManager] Started (checking every 120s)
[BAF]: [OrderManager] Checking for existing orders...
[BAF]: [Click] Slot 50 | Item: Manage Orders
[Coflnet]: Alright, you will receive bazaar flips...
[BAF]: [OrderManager] Found 3 existing order(s)
[BAF]: [Websocket] Received bazaar flip recommendation
[BAF]: Queued bazaar flip: 64x Flawed Jade Gemstone (1 in queue)
[BAF]: continuing bazaar flips now (processing 1 queued flip)
[BAF]: ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[BAF]: BUY ORDER - Flawed Jade Gemstone
...
You tipped Bebakasha in Mega Walls!
[BAF]: [Error] Bazaar order timed out - check if /bz command works
[BAF]: Failed to place bazaar order: Error: Bazaar order placement timed out
```

The issue: **"here its just chaos it does x then y, i would say first cookies, then check orders, then make orders so maybe wait with some commands make a proper queue dont interrupt yourself"**

## Solution

Implemented a centralized command queue system that:
1. **Serializes all operations** - only one command executes at a time
2. **Prioritizes operations** - critical tasks execute before maintenance tasks
3. **Prevents conflicts** - no more simultaneous window opening
4. **Provides visibility** - clear logging shows what's queued and executing

## Architecture Changes

### Before (Chaotic Execution)
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Cookie Check   │    │  Bazaar Flip    │    │ Order Manager   │
│  (20s timer)    │    │  (WebSocket)    │    │  (120s timer)   │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                       │
         ├──────────────────────┼───────────────────────┤
         │         CONFLICT!    │                       │
         ▼                      ▼                       ▼
    bot.chat('/sbmenu')    bot.chat('/bz')    bot.chat('/bz')
         │                      │                       │
         └──────────────────────┴───────────────────────┘
                        Window Collision!
                        Listener Pollution!
                        Race Conditions!
```

### After (Organized Queue)
```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Cookie Check   │    │  Bazaar Flip    │    │ Order Manager   │
│  (20s timer)    │    │  (WebSocket)    │    │  (120s timer)   │
└────────┬────────┘    └────────┬────────┘    └────────┬────────┘
         │                      │                       │
         │enqueue(LOW)          │enqueue(NORMAL)        │enqueue(LOW)
         ▼                      ▼                       ▼
    ┌────────────────────────────────────────────────────────┐
    │              Command Queue Processor                   │
    │  Priority: CRITICAL(1) > HIGH(2) > NORMAL(3) > LOW(4) │
    │  FIFO within same priority                             │
    └────────────────────────────────────────────────────────┘
                            │
                            │ Execute one at a time
                            ▼
                     bot.chat(command)
                            │
                            ▼
                    Wait for completion
                            │
                            ▼
                      Next command
```

## Key Components

### 1. Command Queue Module (`src/commandQueue.ts`)
- **Priority-based queue**: Commands execute by priority, FIFO within same level
- **Global state management**: Checks `bot.state` before executing
- **Timeout protection**: 30-second max per command
- **Error recovery**: Failed commands don't block the queue
- **Monitoring**: Queue status and depth tracking

### 2. Priority Levels
```typescript
enum CommandPriority {
    CRITICAL = 1,  // Emergency operations (AFK responses)
    HIGH = 2,      // Auction house flips (time-sensitive)
    NORMAL = 3,    // Bazaar flips
    LOW = 4        // Cookie checks, order management
}
```

### 3. Integration Points

**BAF.ts (Main Bot)**
```typescript
// Initialize queue after joining SkyBlock
initCommandQueue(bot)

// Cookie check now queues instead of executing
enqueueCommand('Cookie Check', CommandPriority.LOW, async () => {
    await checkAndBuyCookie(bot)
})
```

**bazaarFlipHandler.ts**
```typescript
// Bazaar flips queue with NORMAL priority
export async function handleBazaarFlipRecommendation(bot, recommendation) {
    enqueueCommand(
        `Bazaar ${orderType}: ${amount}x ${itemName}`,
        CommandPriority.NORMAL,
        async () => {
            await executeBazaarFlip(bot, recommendation)
        }
    )
}
```

**bazaarOrderManager.ts**
```typescript
// Order operations queue with LOW priority
enqueueCommand(
    `Cancel Order: ${itemName}`,
    CommandPriority.LOW,
    async () => {
        await cancelOrder(bot, order)
    }
)
```

## Benefits

### 1. No More Interruptions
- ✅ Cookie checks wait for active operations to complete
- ✅ Order manager doesn't interrupt bazaar flips
- ✅ Multiple bazaar flips execute sequentially

### 2. Predictable Execution Order
- ✅ High-priority tasks execute first
- ✅ FIFO order within same priority level
- ✅ Clear logging shows execution order

### 3. Better Error Handling
- ✅ Timeout protection prevents infinite hangs
- ✅ Failed operations don't block the queue
- ✅ Bot state automatically resets on error

### 4. Improved Debugging
- ✅ `/baf queue` shows current queue status
- ✅ Detailed logs show wait times and execution duration
- ✅ Warnings when queue depth exceeds 5

### 5. Maintainability
- ✅ Easy to add new operations with proper priorities
- ✅ Centralized operation management
- ✅ Clear separation between queueing and execution

## Migration Guide

### For Adding New Operations

**Old Pattern (DON'T USE):**
```typescript
// Direct execution - can cause conflicts
async function myOperation(bot: MyBot) {
    if (bot.state) {
        setTimeout(() => myOperation(bot), 1000)
        return
    }
    bot.state = 'myOperation'
    // ... do work ...
    bot.state = null
}
```

**New Pattern (USE THIS):**
```typescript
// Queue-based execution
export function requestMyOperation(bot: MyBot) {
    enqueueCommand(
        'My Operation',
        CommandPriority.NORMAL,  // Choose appropriate priority
        async () => {
            await executeMyOperation(bot)
        }
    )
}

async function executeMyOperation(bot: MyBot) {
    bot.state = 'myOperation'
    try {
        // ... do work ...
    } finally {
        bot.state = null
    }
}
```

## Commands

### Check Queue Status
```
/baf queue
```
Shows:
- Queue depth
- Whether processing is active
- List of queued commands with priorities

### Clear Queue (Emergency)
```
/baf clearqueue
```
Removes all queued commands. Use only when queue is stuck.

## Testing

See `TEST_SCENARIOS.md` for comprehensive test scenarios covering:
1. Cookie check doesn't interrupt bazaar flips
2. Order manager doesn't interrupt active operations
3. Multiple bazaar flips queue properly
4. Priority order is respected
5. Timeout handling works correctly
6. Queue status commands work

## Files Changed

1. **src/commandQueue.ts** (NEW) - Core queue implementation
2. **src/BAF.ts** - Initialize queue, enqueue cookie check
3. **src/bazaarFlipHandler.ts** - Enqueue bazaar flips
4. **src/bazaarOrderManager.ts** - Enqueue order operations
5. **src/consoleHandler.ts** - Add queue status commands
6. **COMMAND_QUEUE.md** (NEW) - User documentation
7. **TEST_SCENARIOS.md** (NEW) - Testing guide

## Metrics to Monitor

- **Queue depth**: Should typically be 0-3, warn at 5+
- **Wait times**: Longer waits indicate queue bottleneck
- **Execution times**: Track command completion times
- **Timeout rate**: Should be near zero

## Success Indicators

✅ No more "bazaar order timed out" errors  
✅ Operations complete without interruption  
✅ Queue status shows organized execution  
✅ Logs show clear operation sequence  
✅ Multiple simultaneous triggers don't cause conflicts  

## Future Enhancements

Possible improvements:
- Queue persistence across restarts
- Dynamic priority adjustment based on urgency
- Queue metrics and statistics
- Per-operation timeout configuration
- Cancellable operations
