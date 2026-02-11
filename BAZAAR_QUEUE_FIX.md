# Bazaar Order Cancellation and Queue System Fix

This document describes the fixes implemented for two critical bugs in the bazaar order management and command queue system.

## Bug 1: Order Cancellation Window Handling

### Problem
When clicking an order in the "Manage Orders" window, the same window updates in-place without firing a new `open_window` event. The previous implementation incorrectly tried to listen for a new window event, which never fired.

### Solution
The implementation already correctly handled this by:
1. Clicking the order slot in Manage Orders
2. Waiting `WINDOW_UPDATE_DELAY_MS` (now 600ms) for the window to update
3. Polling `bot.currentWindow` directly via `processOrderDetails()`

**Key changes:**
- Changed `WINDOW_UPDATE_DELAY_MS` from 800ms to 600ms (line 46)
- Updated cancel button detection to use `findSlotWithName(currentWindow, 'Cancel Order')` instead of hard-coding slot 13 (line 632)
- This makes the code more robust to handle different window states

### Flow
```
Step 1: /bz → NEW window (open_window event) → Bazaar page
Step 2: Click "Manage Orders" → NEW window (open_window event) → Manage Orders list
Step 3: Click order slot → SAME window updates (NO open_window event)
Step 4: Wait 600ms → Poll bot.currentWindow
Step 5: Claim items if present
Step 6: Find and click Cancel Order button via findSlotWithName
Step 7: Done
```

## Bug 2: Bazaar Command Queue System

### Problem
1. Bazaar operations blocked each other because they all set `bot.state`
2. AH flips couldn't interrupt bazaar operations efficiently
3. Interrupted bazaar operations were lost instead of being re-queued

### Solution
Implemented an **interruptible command queue system**:

#### 1. Command Priority Levels
```typescript
CRITICAL = 1  // AH flips (via interruption)
HIGH = 2      // Reserved for future high-priority ops
NORMAL = 3    // Bazaar flips, sellbz
LOW = 4       // Order cancellation, claiming, maintenance
```

#### 2. Interruptible Flag
All bazaar operations now have `interruptible: true`:
- Bazaar flip placement (`bazaarFlipHandler.ts:251`)
- Order cancellation (`bazaarOrderManager.ts:364`)
- Order claiming (`bazaarOrderManager.ts:391`)
- Sell bazaar command (`sellBazaar.ts:486`)

#### 3. Interruption Mechanism
When an AH flip arrives:
1. `flipHandler` checks `canInterruptCurrentCommand()`
2. If current command is interruptible, calls `interruptCurrentCommand(bot)`
3. This:
   - Aborts the current bazaar operation
   - Re-queues the interrupted command with updated timestamp
   - Resets `bot.state` to null
   - Resets queue processing flags
4. AH flip proceeds immediately with `bot.state = 'purchasing'`

#### 4. Queue Processing
The command queue now:
- Blocks only when `bot.state === 'purchasing'` (AH flip in progress)
- Allows bazaar operations to queue without blocking each other
- Processes commands in priority order
- Tracks `currentCommand` for interruption support

### Files Modified

1. **src/commandQueue.ts**
   - Added `interruptible?: boolean` to `QueuedCommand` interface
   - Added `currentCommand` tracking
   - Implemented `canInterruptCurrentCommand()`
   - Implemented `interruptCurrentCommand(bot)` 
   - Updated `processQueue()` to check `bot.state === 'purchasing'`
   - Updated priority levels

2. **src/flipHandler.ts**
   - Added interruption check before waiting on busy state
   - Calls `interruptCurrentCommand()` if possible
   - Otherwise waits and retries

3. **src/bazaarFlipHandler.ts**
   - Added `interruptible: true` to bazaar flip enqueue

4. **src/bazaarOrderManager.ts**
   - Changed `WINDOW_UPDATE_DELAY_MS` to 600ms
   - Use `findSlotWithName()` for Cancel Order button
   - Added `interruptible: true` to cancel and claim operations

5. **src/sellBazaar.ts**
   - Added `interruptible: true` to sellbz command

## Testing Scenarios

### Scenario 1: Normal Order Cancellation
1. Bot has stale order
2. Timer triggers cancellation
3. Cancellation queued with LOW priority
4. Queue processes cancellation
5. Opens Manage Orders, clicks order
6. Waits 600ms
7. Finds and clicks "Cancel Order" button via findSlotWithName
8. Success

### Scenario 2: AH Flip Interrupts Bazaar Operation
1. Bazaar flip executing (bot.state = 'bazaar')
2. AH flip arrives via flipHandler
3. flipHandler checks canInterruptCurrentCommand() → true
4. Calls interruptCurrentCommand(bot)
5. Bazaar operation aborted and re-queued
6. AH flip proceeds with bot.state = 'purchasing'
7. Queue blocks until AH flip completes
8. Bazaar operation resumes from queue

### Scenario 3: Multiple Bazaar Operations Queue
1. Three bazaar flips arrive rapidly
2. All enqueued with NORMAL priority
3. First flip executes (bot.state = 'bazaar')
4. Second and third remain in queue
5. No blocking - they wait their turn
6. Each completes sequentially

### Scenario 4: Bazaar Operations During AH Flip
1. AH flip in progress (bot.state = 'purchasing')
2. Bazaar flip arrives
3. Gets queued with NORMAL priority
4. Queue processor sees bot.state = 'purchasing'
5. Waits (200ms sleep loop)
6. AH flip completes, sets bot.state = null
7. Queue resumes, processes bazaar flip

## Key Design Principles

1. **Only `bot.state = 'purchasing'` blocks everything** - This is the CRITICAL state for time-sensitive AH flips
2. **Bazaar operations are interruptible** - They can be aborted and re-queued without losing work
3. **Priority-based execution** - Higher priority commands can interrupt lower priority ones
4. **Automatic re-queuing** - Interrupted commands are automatically re-queued to ensure completion
5. **Queue-based coordination** - All bazaar operations use the command queue for proper ordering

## Benefits

1. **No more blocking between bazaar operations** - They can queue and execute sequentially
2. **AH flips always prioritized** - Time-sensitive flips never miss their window
3. **No lost work** - Interrupted operations are re-queued automatically
4. **Better resource utilization** - Operations queue instead of being dropped
5. **Cleaner state management** - Single point of control via command queue
6. **More robust cancellation** - Dynamic button detection instead of hard-coded slots
