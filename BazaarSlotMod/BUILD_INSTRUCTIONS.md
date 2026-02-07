# Building the BazaarSlotMod

This directory contains the source code for the Minecraft 1.8.9 Forge mod that logs slot numbers and GUI names for bazaar operations.

## Why No Pre-Built JAR?

The mod cannot be built in the CI environment because:
1. ForgeGradle requires network access to download Minecraft and Forge dependencies
2. The build environment has restricted network access
3. Building a Forge mod requires downloading ~100MB+ of dependencies

## How to Build the Mod

### Prerequisites
- Java Development Kit (JDK) 8 (**required** - newer Java versions will not work)
- Internet connection
- At least 2GB of free RAM

### Build Steps

1. **Clone this directory** to a machine with internet access

2. **Navigate to the BazaarSlotMod directory**
   ```bash
   cd BazaarSlotMod
   ```

3. **Ensure you're using Java 8**
   
   Set JAVA_HOME to point to JDK 8:
   - **Windows**: `set JAVA_HOME=C:\Program Files\Java\jdk1.8.0_XXX`
   - **Linux/Mac**: `export JAVA_HOME=/path/to/jdk8`
   
   Verify Java version:
   ```bash
   java -version
   ```
   Should show version 1.8.x

4. **Setup the Forge workspace** (first time only)
   ```bash
   ./gradlew setupDecompWorkspace
   ```
   This will download Minecraft and Forge sources (~100MB+). It may take 5-10 minutes.

5. **Build the mod**
   ```bash
   ./gradlew build
   ```

6. **Locate the JAR file**
   The compiled mod will be at:
   ```
   build/libs/BazaarSlotMod-1.0.jar
   ```

7. **Install the mod**
   - Copy the JAR file to your `.minecraft/mods` folder
   - Launch Minecraft 1.8.9 with Forge installed
   - The mod will create a log file at `.minecraft/bazaar_slot_info.log`

## Alternative: Use Online Build Services

If you don't have a build environment, you can use:
- GitHub Actions (with proper internet access configured)
- GitLab CI
- A VPS or cloud server with internet access

## What the Mod Does

Once installed, the mod will:
1. Log every GUI that opens (especially bazaar-related GUIs)
2. Log slot numbers when you click on items
3. Periodically log all slots in bazaar interfaces
4. Write everything to `.minecraft/bazaar_slot_info.log`

This helps you verify the slot numbers used in the main BAF application are correct.

## Slot Numbers Already Known

Based on the existing `bazaarFlipHandler.ts` code, we already know these slot numbers:

| GUI Title | Slot | Purpose |
|-----------|------|---------|
| Bazaar ➜ [Item] | 19 | Create Buy Order |
| Bazaar ➜ [Item] | 20 | Create Sell Offer |
| How many do you want to... | 13 | Custom amount input |
| How much do you want to pay/be paid | 13 | Custom price input |
| Confirm... | 11 | Confirm button |

The mod serves to **verify** these numbers and help diagnose any issues if the bazaar GUI changes in the future.

## Testing the Mod

1. Join Hypixel Skyblock
2. Run `/bz` to open the bazaar
3. Navigate through a buy order (click item, create buy order, enter amount, enter price, confirm)
4. Check `.minecraft/bazaar_slot_info.log` to see all the logged information
5. Compare the slot numbers in the log with the numbers used in the BAF code

## Source Files

- `src/main/java/com/trexito/bazaarslotmod/BazaarSlotMod.java` - Main mod class
- `src/main/resources/mcmod.info` - Mod metadata
- `build.gradle` - Gradle build configuration
- `gradle.properties` - Gradle settings

## Troubleshooting

**Problem**: Build fails with `Convention.getPlugins()` error
- **Solution**: This has been fixed. Make sure you're using Gradle 4.10.3 (configured in gradle-wrapper.properties) and Java 8.

**Problem**: Build fails with "Could not determine java version from 'XX'"
- **Solution**: You must use Java 8. Set JAVA_HOME to point to JDK 8 and ensure `java -version` shows 1.8.x

**Problem**: Build fails with "Could not resolve ForgeGradle"
- **Solution**: Ensure you have internet access and the Maven repository is reachable

**Problem**: Out of memory error during build
- **Solution**: Increase heap size in `gradle.properties`:
  ```
  org.gradle.jvmargs=-Xmx3G
  ```

**Problem**: Mod doesn't load in Minecraft
- **Solution**: Ensure you're using Minecraft 1.8.9 with Forge 11.15.1.2318 or similar

**Problem**: No log file created
- **Solution**: Check the Forge mods list to confirm the mod loaded. Check the Minecraft log for errors.

## Questions?

If you have questions about building or using this mod, please open an issue in the main repository.
