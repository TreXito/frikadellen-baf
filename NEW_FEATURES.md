# New Features Added

## 1. Fix for "Confirm at 62ms" Repeating Bug

### Issue
The bot was receiving multiple "Confirm Purchase" window events and printing "Confirm at 62ms" repeatedly, eventually causing crashes.

### Solution
Added duplicate window handling prevention by introducing flags:
- `handledBinAuction`: Prevents processing the BIN Auction View window multiple times
- `handledConfirm`: Prevents processing the Confirm Purchase window multiple times

These flags ensure each window type is only processed once per flip attempt, preventing the repetitive messages and subsequent crashes.

## 2. Proxy Support

### Configuration
Add the following fields to your `config.toml`:

```toml
PROXY_ENABLED = false
PROXY = ""
PROXY_USERNAME = ""
PROXY_PASSWORD = ""
```

### Usage
1. Set `PROXY_ENABLED = true` to enable proxy support
2. Set `PROXY` to your proxy server in the format `IP:port` (e.g., `"127.0.0.1:8080"` or `"proxy.example.com:1080"`)
3. Optionally set `PROXY_USERNAME` and `PROXY_PASSWORD` for authenticated proxies

### Example
```toml
PROXY_ENABLED = true
PROXY = "127.0.0.1:8080"
PROXY_USERNAME = "myuser"
PROXY_PASSWORD = "mypassword"
```

### Technical Details
- Uses SOCKS5 proxy protocol
- Requires the `socks` npm package (automatically installed)
- Supports both authenticated and unauthenticated proxies

## 3. Automatic Account Switching

### Configuration
Add the following fields to your `config.toml`:

```toml
ACCOUNTS = ""
AUTO_SWITCHING = ""
```

### Usage
1. Set `ACCOUNTS` to a comma-separated list of Minecraft usernames (e.g., `"user1,user2,user3"`)
2. Set `AUTO_SWITCHING` to define time allocation for each account in the format `username:minutes` (e.g., `"user1:8,user2:8,user3:8"`)

The bot will automatically switch between accounts based on the time allocation. After the specified time for an account expires, it will disconnect and reconnect with the next account in the rotation.

### Example
```toml
ACCOUNTS = "PlayerOne,PlayerTwo,PlayerThree"
AUTO_SWITCHING = "PlayerOne:8,PlayerTwo:8,PlayerThree:8"
```

This configuration will:
- Use PlayerOne for 8 minutes
- Switch to PlayerTwo for 8 minutes
- Switch to PlayerThree for 8 minutes
- Repeat the cycle

### Notes
- The username in `AUTO_SWITCHING` must match the username in `ACCOUNTS`
- Time is specified in minutes
- The bot will automatically reconnect when switching accounts
- Account switching is logged for transparency

## Technical Implementation

### New Files
- `src/accountSwitcher.ts`: Manages account switching timer and logic
- `src/proxyHelper.ts`: Parses and validates proxy configuration

### Modified Files
- `src/BAF.ts`: Integrated proxy support and account switching
- `src/flipHandler.ts`: Fixed duplicate window handling bug
- `src/configHelper.ts`: Added new configuration fields with comments
- `types/config.d.ts`: Updated Config interface with new fields
- `package.json`: Added `socks` dependency for proxy support

## Testing

All changes have been:
- Successfully compiled with TypeScript
- Tested for proper configuration parsing
- Verified for correct proxy format validation (IP:port)
- Verified for correct account switching format validation (username:minutes)

## Backwards Compatibility

All new features are optional and disabled by default. Existing configurations will continue to work without any changes. The new configuration fields are automatically added to existing config files with default values.
