# Command Queue System

## Overview

The command queue system ensures that all bot operations execute in a controlled, sequential manner to prevent conflicts and interruptions. This solves the issue where multiple operations (bazaar flips, cookie checks, order management) would compete for resources and interfere with each other.

## Priority Levels

Commands are queued with different priority levels:

1. **CRITICAL (1)**: Emergency operations, AFK responses
2. **HIGH (2)**: Auction house flips (time-sensitive)
3. **NORMAL (3)**: Bazaar flips
4. **LOW (4)**: Cookie checks, order management, maintenance tasks

Higher priority commands execute first. Within the same priority level, commands execute in FIFO (first-in, first-out) order.

## How It Works

1. **Initialization**: The queue system starts immediately after joining SkyBlock
2. **Command Queueing**: Instead of executing immediately, operations are added to the queue
3. **Sequential Processing**: The queue processor executes one command at a time
4. **State Management**: The bot's state is checked before executing each command
5. **Error Handling**: Failed commands don't block the queue; the next command proceeds

## Command Flow

### Before Queue System (Chaotic)
```
[Cookie Check] ──┐
                 ├──> Try to open /sbmenu (CONFLICT!)
[Bazaar Flip]  ──┤
                 ├──> Try to open /bz (CONFLICT!)
[Order Manager]──┘
```

### After Queue System (Organized)
```
Queue: [Cookie Check (LOW)] → [Bazaar Flip (NORMAL)] → [Order Cancel (LOW)]
         ↓
    Execute one at a time
         ↓
    Wait for completion
         ↓
    Next command
```

## Commands

### Check Queue Status
```
/baf queue
```
Shows:
- Number of commands in queue
- Whether a command is currently processing
- List of queued commands with their priorities

### Clear Queue (Emergency)
```
/baf clearqueue
```
Removes all queued commands. Use only in emergencies when the queue is stuck.

## Integration Points

### Bazaar Flips
- When a bazaar flip recommendation arrives, it's queued with NORMAL priority
- The flip executes when the bot is idle and all higher-priority tasks are done

### Cookie Checks
- Automatic cookie checks are queued with LOW priority after joining SkyBlock
- They won't interrupt active bazaar operations

### Order Management
- Order cancellation and claiming are queued with LOW priority
- The periodic check runs on schedule, but actual operations go through the queue

## Technical Details

### Queue Processing
- Commands execute sequentially with a 200ms delay between operations
- Each command has a 30-second timeout to prevent infinite hangs
- If a command times out or fails, the bot state is reset and the next command proceeds

### State Checking
- The queue processor checks `bot.state` before executing commands
- During grace period (`bot.state === 'gracePeriod'`), no commands execute
- Commands set `bot.state` during execution to prevent conflicts

### Error Recovery
- Failed commands log errors and clear the bot state
- The queue continues processing remaining commands
- Timeouts are handled gracefully without blocking the queue

## Benefits

1. **No More Conflicts**: Commands no longer interrupt each other
2. **Predictable Order**: High-priority tasks always execute first
3. **Better Debugging**: Clear logs show what's executing and what's queued
4. **Resilient**: Failed operations don't block the entire system
5. **Scalable**: Easy to add new operations with appropriate priorities

## Monitoring

The queue logs provide visibility into operation timing:
- Command queuing: Shows when commands are added
- Command execution: Shows when commands start and their priority
- Command completion: Shows execution duration
- Queue warnings: Alerts when queue depth exceeds 5 commands

Example log output:
```
[CommandQueue] Queued: Bazaar BUY: 64x Flawed Jade Gemstone (priority: NORMAL, queue depth: 1)
[CommandQueue] Executing: Bazaar BUY: 64x Flawed Jade Gemstone (priority: NORMAL, waited: 50ms)
[CommandQueue] Completed: Bazaar BUY: 64x Flawed Jade Gemstone (took 3241ms)
```
