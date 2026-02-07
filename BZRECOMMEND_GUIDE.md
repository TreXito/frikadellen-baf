# BAF bzRecommend Automation Guide

## Overview

BAF automatically handles bzRecommend messages from Coflnet and places bazaar orders with the same logic as manual trading.

## Quick Start

### 1. Configure BAF

In your `config.toml`, ensure:
```toml
ENABLE_BAZAAR_FLIPS = true
```

### 2. Run BAF

```bash
npm install
npm start
# Or use the pre-built executable
./BAF-v2.0.1-linux
```

### 3. Authentication

- Enter your Minecraft username when prompted
- Follow the authentication link to connect your account
- BAF will join Hypixel and teleport to your island

### 4. Automatic Trading

BAF will now automatically:
- Receive bzRecommend messages from Coflnet
- Parse order details (item, amount, price, buy/sell)
- Navigate the bazaar GUI
- Place orders automatically

## How It Works

### bzRecommend Message Format

Coflnet sends messages like:
```json
{
  "type": "bzRecommend",
  "data": {
    "itemName": "Flawed Peridot Gemstone",
    "itemTag": "FLAWED_PERIDOT_GEM",
    "price": 3054.1,
    "amount": 64,
    "isSell": false
  }
}
```

**Important**: The `price` field is the **TOTAL price** for all items, not per-unit!

### Automated Process

1. **Parse**: Extract item name, amount, calculate per-unit price
2. **Navigate**: `/bz <itemName>` to open bazaar
3. **Select**: Click on the item in search results
4. **Order Type**: Click "Create Buy Order" or "Create Sell Offer"
5. **Amount**: Enter custom amount (buy orders only)
6. **Price**: Enter custom price per unit
7. **Confirm**: Click confirm to place order

### Buy Order Example

```
Received: bzRecommend for 64x Flawed Peridot Gemstone at 3054.1 total
→ Per unit: 47.72 coins
→ Opens /bz Flawed Peridot Gemstone
→ Clicks item → Create Buy Order
→ Custom Amount: 64
→ Custom Price: 47.7
→ Confirm
✓ Order placed!
```

### Sell Offer Example

```
Received: bzRecommend for 64x Flawed Peridot Gemstone at 85428 total
→ Per unit: 1334.8 coins
→ Opens /bz Flawed Peridot Gemstone
→ Clicks item → Create Sell Offer
→ Custom Price: 1334.8 (no amount screen for sell offers)
→ Confirm
✓ Offer placed!
```

## Monitoring

### Console Output

Watch for these messages:
```
[INFO] Received bzRecommend message: {...}
[INFO] Successfully parsed bzRecommend: 64x Flawed Peridot Gemstone at 47.7 coins (BUY)
[INFO] Starting bazaar flip order placement for 64x Flawed Peridot Gemstone
[BAF]: Placing buy order for 64x Flawed Peridot Gemstone at 47.7 coins each (total: 3054)
[BAF]: Successfully placed bazaar order!
```

### Warning Messages

If orders aren't being placed, check for:
```
[WARN] Bazaar flips are disabled in config
[WARN] Bazaar flips are paused due to incoming AH flip
[INFO] Bot is busy (state: purchasing), will retry in 1100ms
```

## Configuration Tips

### Enable Bazaar Flips Only

```toml
ENABLE_AH_FLIPS = false
ENABLE_BAZAAR_FLIPS = true
```

### Both AH and Bazaar Flips

```toml
ENABLE_AH_FLIPS = true
ENABLE_BAZAAR_FLIPS = true
```

Note: Bazaar flips are automatically paused when an AH flip is incoming to avoid conflicts.

## Troubleshooting

### Orders Not Being Placed

1. **Check config**: Verify `ENABLE_BAZAAR_FLIPS = true`
2. **Check logs**: Look for warning messages about disabled/paused flips
3. **Check connection**: Ensure BAF connected to Coflnet websocket
4. **Check bot state**: If bot is stuck, restart BAF

### Wrong Prices

- BAF automatically calculates per-unit from total price
- Formula: `pricePerUnit = totalPrice / amount`
- Check logs to see calculated per-unit price

### GUI Navigation Issues

- BAF uses slot content detection (not titles) for reliability
- Works with both English and other languages
- Handles both buy orders and sell offers correctly

## Advanced

### Manual Testing

You can manually trigger bzRecommend handling by:
1. Running BAF with debug logging enabled
2. Sending a test bzRecommend via websocket
3. Or using `/cofl getbazaarflips` command in console

### Logging Levels

- **INFO**: bzRecommend received, parsed, order placement started/completed
- **DEBUG**: GUI navigation steps, slot detection, sign writing
- **WARN**: Config disabled, paused, bot busy
- **ERROR**: Parsing failures, GUI automation errors

## Safety Features

- ✅ Bot state locking prevents concurrent operations
- ✅ 20-second timeout for stuck operations
- ✅ Automatic retry when bot is busy
- ✅ Graceful error handling and logging
- ✅ Pausing when AH flips are incoming

## Performance

- Orders typically complete in 2-3 seconds
- Handles rapid bzRecommend messages by queuing
- Retries automatically with 1.1 second delay if busy

## Support

If you encounter issues:
1. Check the console logs for error messages
2. Verify your config.toml settings
3. Ensure you have an active Booster Cookie
4. Check that you have coins in your purse (not bank)
5. Report issues with full logs to the Discord server
