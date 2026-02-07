# Bazaar Slot Mod for Minecraft 1.8.9

## Overview
This mod is designed to help measure slot numbers and GUI names for bazaar operations in Hypixel Skyblock.

## Features
- Logs all GUI names when chest interfaces are opened
- Tracks slot numbers when items are clicked
- Periodically logs all slots in bazaar-related GUIs
- Creates a log file at `.minecraft/bazaar_slot_info.log`

## Installation
1. Download the compiled JAR file
2. Place it in your `.minecraft/mods` folder
3. Launch Minecraft 1.8.9 with Forge installed

## How to Build
Since ForgeGradle requires network access to download dependencies, you'll need to build this on a machine with internet access:

1. Install JDK 8 (**required** - ForgeGradle 2.1 does not work with newer Java versions)
2. Set JAVA_HOME to point to your JDK 8 installation
3. Run `./gradlew setupDecompWorkspace` (or `gradlew.bat setupDecompWorkspace` on Windows)
4. Run `./gradlew build` (or `gradlew.bat build` on Windows)
5. The compiled JAR will be in `build/libs/`

**Note**: The Gradle wrapper has been configured to use Gradle 4.10.3, which is compatible with ForgeGradle 2.1-SNAPSHOT. Do not upgrade to Gradle 9.x or newer as they are incompatible.

## Slot Numbers Found

Based on the bazaarFlipHandler.ts implementation, here are the key slot numbers:

### Bazaar Main View (Title: "Bazaar ➜ ItemName")
- Slot 19: Create Buy Order button
- Slot 20: Create Sell Offer button

### Amount Selection (Title: "How many do you want to...")
- Slot 13: Custom amount input

### Price Selection (Title: "How much do you want to pay/be paid")
- Slot 13: Custom price input

### Confirmation (Title: "Confirm...")
- Slot 11: Confirm button

## Log Output Format
The mod logs entries in the following format:
```
[2024-01-01 12:00:00] GUI Opened: Bazaar ➜ Enchanted Coal
[2024-01-01 12:00:00]   Inventory Size: 54 slots
[2024-01-01 12:00:01] Clicked Slot: 19 | Item: Create Buy Order | GUI: Bazaar ➜ Enchanted Coal
[2024-01-01 12:00:02] GUI Opened: How many do you want to buy?
[2024-01-01 12:00:03] Clicked Slot: 13 | Item: Custom Amount | GUI: How many do you want to buy?
```

## Source Code
The complete source code is included in this directory:
- `src/main/java/com/trexito/bazaarslotmod/BazaarSlotMod.java` - Main mod class
- `src/main/resources/mcmod.info` - Mod metadata
- `build.gradle` - Build configuration

## Technical Details
The mod uses Forge event handlers to:
1. `GuiScreenEvent.InitGuiEvent` - Detect when GUIs are opened
2. `GuiScreenEvent.MouseInputEvent.Pre` - Track mouse clicks on slots
3. `TickEvent.ClientTickEvent` - Periodically log slot contents for bazaar GUIs

All functionality is client-side only and does not modify game behavior.
