# Test Scenarios for Command Queue System

## Scenario 1: Cookie Check Doesn't Interrupt Bazaar Flip

**Setup:**
1. Bot joins SkyBlock
2. Queue initializes
3. Bazaar flip recommendation arrives
4. Cookie check triggers 20 seconds after spawn

**Expected Behavior:**
1. Bazaar flip is queued with NORMAL priority
2. Cookie check is queued with LOW priority
3. Bazaar flip executes first (higher priority)
4. Cookie check executes after bazaar flip completes
5. No timeout errors occur

**Validation:**
- Check logs for `[CommandQueue] Executing:` messages
- Verify bazaar flip completes without "timed out" errors
- Confirm cookie check executes after bazaar flip (check timestamps)
- Look for `[CommandQueue] Completed:` messages showing execution times

**Log Pattern to Look For:**
```
[CommandQueue] Queued: Bazaar BUY: 64x Item (priority: NORMAL, queue depth: 1)
[CommandQueue] Queued: Cookie Check (priority: LOW, queue depth: 2)
[CommandQueue] Executing: Bazaar BUY: 64x Item (priority: NORMAL, waited: XXms)
[BazaarDebug] ===== STARTING BAZAAR FLIP ORDER =====
[CommandQueue] Completed: Bazaar BUY: 64x Item (took XXXXms)
[CommandQueue] Executing: Cookie Check (priority: LOW, waited: XXms)
```

---

## Scenario 2: Order Manager Doesn't Interrupt Active Operations

**Setup:**
1. Bot has an active bazaar flip in progress
2. Order manager's periodic check timer fires (every 120s)
3. Order manager finds a stale order to cancel

**Expected Behavior:**
1. Active bazaar flip is executing
2. Order manager queues the cancel operation with LOW priority
3. Bazaar flip completes without interruption
4. Cancel operation executes after flip completes

**Validation:**
- Bazaar flip logs show no interruptions
- Order cancel operation is queued, not executed immediately
- Both operations complete successfully

**Log Pattern to Look For:**
```
[CommandQueue] Executing: Bazaar BUY: 64x Item (priority: NORMAL, waited: XXms)
[OrderManager] Found 1 stale order(s) to cancel
[CommandQueue] Queued: Cancel Order: Item Name (priority: LOW, queue depth: 1)
[CommandQueue] Completed: Bazaar BUY: 64x Item (took XXXXms)
[CommandQueue] Executing: Cancel Order: Item Name (priority: LOW, waited: XXms)
```

---

## Scenario 3: Multiple Bazaar Flips Queue Properly

**Setup:**
1. Bot receives multiple bazaar flip recommendations in quick succession
2. Each flip recommendation arrives before the previous one completes

**Expected Behavior:**
1. First flip is queued and starts executing
2. Second and third flips are queued behind it
3. Flips execute sequentially in FIFO order
4. Each flip completes before the next starts

**Validation:**
- Check queue depth increases with each new flip
- Verify execution order matches queueing order
- No concurrent bazaar operations

**Log Pattern to Look For:**
```
[CommandQueue] Queued: Bazaar BUY: 64x Item1 (priority: NORMAL, queue depth: 1)
[CommandQueue] Queued: Bazaar BUY: 32x Item2 (priority: NORMAL, queue depth: 2)
[CommandQueue] Queued: Bazaar BUY: 128x Item3 (priority: NORMAL, queue depth: 3)
[CommandQueue] Executing: Bazaar BUY: 64x Item1 (priority: NORMAL, waited: XXms)
[CommandQueue] Completed: Bazaar BUY: 64x Item1 (took XXXXms)
[CommandQueue] Executing: Bazaar BUY: 32x Item2 (priority: NORMAL, waited: XXms)
[CommandQueue] Completed: Bazaar BUY: 32x Item2 (took XXXXms)
[CommandQueue] Executing: Bazaar BUY: 128x Item3 (priority: NORMAL, waited: XXms)
```

---

## Scenario 4: Priority Order Respected

**Setup:**
1. Queue multiple operations with different priorities:
   - LOW: Cookie Check
   - NORMAL: Bazaar Flip
   - LOW: Order Cancel
   - NORMAL: Another Bazaar Flip

**Expected Behavior:**
1. Commands execute in priority order (NORMAL before LOW)
2. Within same priority, FIFO order is maintained

**Expected Execution Order:**
1. Bazaar Flip (NORMAL) - first in queue
2. Another Bazaar Flip (NORMAL) - second NORMAL command
3. Cookie Check (LOW) - first LOW command
4. Order Cancel (LOW) - second LOW command

**Validation:**
- Check execution order in logs
- Verify all NORMAL priority commands execute before LOW priority

---

## Scenario 5: Timeout Handling

**Setup:**
1. Simulate a bazaar flip that hangs (doesn't complete)
2. Wait for 30-second timeout

**Expected Behavior:**
1. Command starts executing
2. After 30 seconds, timeout triggers
3. Bot state is reset
4. Next queued command executes

**Validation:**
- Check for timeout error in logs
- Verify bot state is reset to null
- Confirm next command executes despite timeout

**Log Pattern to Look For:**
```
[CommandQueue] Executing: Bazaar BUY: 64x Item (priority: NORMAL, waited: XXms)
[CommandQueue] ERROR in Bazaar BUY: 64x Item: Command execution timeout (took 30000ms)
[CommandQueue] Resetting bot state from "bazaar" to null after error
[CommandQueue] Executing: Next Command (priority: XXX, waited: XXms)
```

---

## Scenario 6: Queue Status Commands

**Setup:**
1. Queue several operations
2. Check queue status while operations are pending

**Commands to Test:**
```
/baf queue
/baf clearqueue
```

**Expected Output for `/baf queue`:**
```
[BAF]: ━━━━━━━ Command Queue Status ━━━━━━━
[BAF]: Queue depth: 3
[BAF]: Processing: Yes
[BAF]: Queued commands:
[BAF]:   1. Bazaar BUY: 64x Item1 (NORMAL)
[BAF]:   2. Cookie Check (LOW)
[BAF]:   3. Cancel Order: Item2 (LOW)
[BAF]: ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Expected Output for `/baf clearqueue`:**
```
[BAF]: Command queue cleared
```

---

## Debugging Tips

1. **Enable Debug Logging**: Check logs for all `[CommandQueue]` prefixed messages
2. **Monitor Queue Depth**: If depth grows beyond 10, investigate why operations aren't completing
3. **Check Wait Times**: Long wait times indicate queue bottleneck
4. **Watch for Timeouts**: Repeated timeouts suggest underlying issues in operation logic

## Success Criteria

✅ No "bazaar order timed out" errors when multiple operations occur  
✅ Cookie checks execute without interrupting bazaar flips  
✅ Order manager operations execute after active flips complete  
✅ Multiple flips execute sequentially without conflicts  
✅ Queue depth warnings appear when queue grows large  
✅ Commands execute in correct priority order  
✅ Failed operations don't block the queue  
