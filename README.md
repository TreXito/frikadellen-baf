Join the official Discord server:
https://www.discord.gg/eYRBsaECzY

# BAF

BAF (Bazaar Auction Flipper) for Hypixel Skyblock
Note: This code is a headless (no user interface) Minecraft client and has features sending custom packages to the server to compete with other macroers. This is against the Hypixel Terms of Service.
Hypixel currently doesn't ban for doing so but has all the rights to start doing it without notice so use this with caution.

## Releases

Pre-built executables for Windows, Linux, and macOS are available in the [releases section](https://github.com/TreXito/frikadellen-baf/releases). Download the latest release for your operating system.

### For Maintainers: Creating a Release

To create a new release with pre-built executables:

1. Update the version in `package.json`
2. Create and push a version tag (with or without `v` prefix):
   ```bash
   git tag v2.0.1  # or just 2.0.1
   git push origin v2.0.1
   ```
3. The GitHub Actions workflow will automatically:
   - Build executables for Windows, Linux, and macOS
   - Create a GitHub release with the tag name
   - Upload all executables and start scripts to the release

The workflow accepts tags in these formats:
- `v*` (e.g., `v2.0.1`, `v1.0`)
- `[0-9]*` (any tag starting with a digit, e.g., `2.0.1`, `1.0`)

## Is this bannable

Yes, it is against the TOS of Hypixel, so don't use it if you don't want to risk that.

## Is this a RAT

No, you can check the code yourself. The bot itself doesn't touch your credentials it uses the authentication API of mineflayer to handle that.
As far as I am aware mineflayer only stores the credentials in `.minecraft/nmp-cache`. So if you want to connect a different account or remove the stored credentials for some other reason, remove this folder. (https://github.com/PrismarineJS/mineflayer/discussions/2392)

## Requirements

-   The bot teleports you to your island. You need an active Booster Cookie to purchase auctions outside of the hub.
-   The bot does not take money out of your bank, so make sure to have coins in your purse
-   Purchased flips may stay in the inventory for a bit before being relisted. Make sure to have some space so you don't fill up your inventory after a few flips.

## Getting Started

### Executable

For Windows there is a PowerShell-Script "BAF.ps1". This script automatically downloads/updates and starts the newest version from GitHub and saves it at `%appdata$/BAF`. Created files like the config and log file are also stored there. You can execute it by double clicking the cmd file or right-clicking the .ps1 and click "Run with PowerShell". You need to have Node.js installed for the Windows version.

You can also paste this command into the PowerShell to run the script: `Invoke-Expression (New-Object System.Net.WebClient).DownloadString("https://raw.githubusercontent.com/TreXito/frikadellen-baf/main/start_script/BAF.ps1`. This command downloads the Script and executes it.

Tutorial on how to open PowerShell: https://www.youtube.com/watch?v=aLwq9AggFw8&t=1s

For Mac/Linux just execute the corresponding files as usual.

### Node

To run or build the code, you need Node and npm.

-   To run it just execute `npm install` followed by `npm run start`<br/><br/>
-   To build the executables the following command for the following OS:
    -   Windows: `npm run build-executables-win`
    -   Linux: `npm run build-executables-linux`
    -   macOS: `npm run build-executables-macos`

NOTE: You only need this if you want to build the code yourself. If you are using a executable, you can ignore the node steps.

### Linux

To execute BAF on Linux use the following (and follow the input requests)

```bash
version=v2.0.1
wget -c https://github.com/TreXito/frikadellen-baf/releases/download/$version/BAF-$version-linux
chmod +x BAF-$version-linux
./BAF-$version-linux
```

## How does it work

-   On the first start, enter your Ingame name. This is needed for the authentication
-   Connect your Minecraft account by posting the link the bot gives you into your browser
-   After you are authenticated, the bot should join Hypixel and teleports itself to your island
-   After that, it automatically buys and sells flips
-   => Profit

## Configuration

The bot creates a config.toml file after the first start. This file contains configuration properties for the bot. Currently, only the ingame username is stored, so you don't need to enter it every time. I may add more configurations in the future. The Cofl configurations apply as normal.
<br/> NOTE: The mod uses the Median price (minus a bit to sell faster) to auto-sell

### Skip Configuration

The bot now supports automatically skipping the confirmation dialog on certain flips to buy them faster. This feature is inspired by TPM-rewrite's autobuy skip functionality.

In your `config.toml`, you can configure the `[SKIP]` section with the following options:

- `ALWAYS` - Set to `true` to always skip confirmation on all flips (requires `FLIP_ACTION_DELAY >= 150`)
- `MIN_PROFIT` - Skip confirmation if the profit is above this value (in coins, default: 1000000)
- `USER_FINDER` - Set to `true` to skip confirmation on flips found by USER
- `SKINS` - Set to `true` to skip confirmation on skin items
- `PROFIT_PERCENTAGE` - Skip confirmation if profit percentage is above this value (default: 50)
- `MIN_PRICE` - Skip confirmation if the starting bid is above this value (in coins, default: 10000000)

Example configuration:
```toml
[SKIP]
ALWAYS = false
MIN_PROFIT = 1000000
USER_FINDER = false
SKINS = true
PROFIT_PERCENTAGE = 50
MIN_PRICE = 10000000
```

When skip is used, the bot will automatically click the green checkmark in the BIN Auction View window to skip the confirmation dialog, allowing for faster purchases.

### Proxy Configuration

The bot supports SOCKS5 proxy connections. In your `config.toml`, you can configure proxy settings:

- `PROXY_ENABLED` - Set to `true` to enable proxy usage (default: `false`)
- `PROXY` - Proxy server in `IP:port` format (e.g., `"127.0.0.1:8080"`)
- `PROXY_USERNAME` - Optional username for proxy authentication
- `PROXY_PASSWORD` - Optional password for proxy authentication

Example configuration:
```toml
PROXY_ENABLED = true
PROXY = "127.0.0.1:8080"
PROXY_USERNAME = "myuser"
PROXY_PASSWORD = "mypassword"
```

### Automatic Account Switching

The bot supports automatic account switching to rotate between multiple accounts over time. In your `config.toml`, configure:

- `ACCOUNTS` - Comma-separated list of Minecraft usernames (e.g., `"user1,user2,user3"`)
- `AUTO_SWITCHING` - Time allocation for each account in minutes, format: `"username:minutes"` (e.g., `"user1:8,user2:8,user3:8"`)

Example configuration:
```toml
ACCOUNTS = "PlayerOne,PlayerTwo,PlayerThree"
AUTO_SWITCHING = "PlayerOne:8,PlayerTwo:8,PlayerThree:8"
```

This will use PlayerOne for 8 minutes, then switch to PlayerTwo for 8 minutes, then PlayerThree for 8 minutes, and repeat the cycle. The bot will automatically disconnect and reconnect with the next account when the time expires.

## System Requirements

-   Any operating system
-   500MB of RAM
-   1 core of your CPU
-   Stable ping, preferably under 200ms - it measures your ping and sends actions ahead of time to arrive as close on time as possible
-   **Some paid plan from sky.coflnet.com**

## Webhook

You can add a Webhook URL into your `config.toml` to get different notifications (init, selling, purchasing, relisting).
Just add the line `WEBHOOK_URL = "YOUR_URL"` into your config. Make sure to place it above the sessions part (will be created automatically on your first start).

## Logging

If there is something wrong with the bot and you plan to report it, please add your log file
