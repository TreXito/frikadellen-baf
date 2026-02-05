package com.trexito.bazaarslotmod;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.inventory.GuiChest;
import net.minecraft.inventory.Container;
import net.minecraft.inventory.ContainerChest;
import net.minecraft.inventory.IInventory;
import net.minecraftforge.client.event.GuiScreenEvent;
import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.fml.common.Mod;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import net.minecraftforge.fml.common.eventhandler.SubscribeEvent;
import net.minecraftforge.fml.common.gameevent.TickEvent;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;

@Mod(modid = BazaarSlotMod.MODID, version = BazaarSlotMod.VERSION, clientSideOnly = true)
public class BazaarSlotMod {
    public static final String MODID = "bazaarslotmod";
    public static final String VERSION = "1.0";
    
    private File logFile;
    private int tickCounter = 0;
    private String lastGuiName = "";
    
    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        MinecraftForge.EVENT_BUS.register(this);
        
        // Create log file in the game directory
        File gameDir = Minecraft.getMinecraft().mcDataDir;
        logFile = new File(gameDir, "bazaar_slot_info.log");
        
        logToFile("BazaarSlotMod initialized!");
        logToFile("This mod logs GUI names and slot numbers for bazaar operations.");
        logToFile("-----------------------------------------------------------");
    }
    
    @SubscribeEvent
    public void onGuiOpen(GuiScreenEvent.InitGuiEvent event) {
        if (event.gui instanceof GuiChest) {
            GuiChest guiChest = (GuiChest) event.gui;
            Container container = guiChest.inventorySlots;
            
            if (container instanceof ContainerChest) {
                ContainerChest containerChest = (ContainerChest) container;
                IInventory lowerChestInventory = containerChest.getLowerChestInventory();
                String guiName = lowerChestInventory.getDisplayName().getUnformattedText();
                
                // Only log if GUI name changed
                if (!guiName.equals(lastGuiName)) {
                    lastGuiName = guiName;
                    logToFile("GUI Opened: " + guiName);
                    logToFile("  Inventory Size: " + lowerChestInventory.getSizeInventory() + " slots");
                }
            }
        }
    }
    
    @SubscribeEvent
    public void onMouseClick(GuiScreenEvent.MouseInputEvent.Pre event) {
        if (event.gui instanceof GuiChest) {
            GuiChest guiChest = (GuiChest) event.gui;
            Container container = guiChest.inventorySlots;
            
            if (container instanceof ContainerChest) {
                ContainerChest containerChest = (ContainerChest) container;
                IInventory lowerChestInventory = containerChest.getLowerChestInventory();
                String guiName = lowerChestInventory.getDisplayName().getUnformattedText();
                
                // Get mouse position and calculate slot
                int mouseX = org.lwjgl.input.Mouse.getEventX() * guiChest.width / Minecraft.getMinecraft().displayWidth;
                int mouseY = guiChest.height - org.lwjgl.input.Mouse.getEventY() * guiChest.height / Minecraft.getMinecraft().displayHeight - 1;
                
                net.minecraft.inventory.Slot slotUnderMouse = guiChest.getSlotUnderMouse();
                if (slotUnderMouse != null && org.lwjgl.input.Mouse.getEventButtonState()) {
                    int slotNumber = slotUnderMouse.slotNumber;
                    String itemName = "Empty";
                    
                    if (slotUnderMouse.getHasStack()) {
                        itemName = slotUnderMouse.getStack().getDisplayName();
                    }
                    
                    logToFile("Clicked Slot: " + slotNumber + " | Item: " + itemName + " | GUI: " + guiName);
                }
            }
        }
    }
    
    @SubscribeEvent
    public void onClientTick(TickEvent.ClientTickEvent event) {
        if (event.phase == TickEvent.Phase.END) {
            tickCounter++;
            
            // Every 5 seconds (100 ticks), check current GUI
            if (tickCounter >= 100) {
                tickCounter = 0;
                
                Minecraft mc = Minecraft.getMinecraft();
                if (mc.currentScreen instanceof GuiChest) {
                    GuiChest guiChest = (GuiChest) mc.currentScreen;
                    Container container = guiChest.inventorySlots;
                    
                    if (container instanceof ContainerChest) {
                        ContainerChest containerChest = (ContainerChest) container;
                        IInventory lowerChestInventory = containerChest.getLowerChestInventory();
                        String guiName = lowerChestInventory.getDisplayName().getUnformattedText();
                        
                        // Log all slots for bazaar-related GUIs
                        if (guiName.contains("Bazaar") || guiName.contains("How many") || 
                            guiName.contains("How much") || guiName.contains("Confirm")) {
                            logToFile("=== Current GUI: " + guiName + " ===");
                            
                            for (int i = 0; i < lowerChestInventory.getSizeInventory(); i++) {
                                net.minecraft.item.ItemStack stack = lowerChestInventory.getStackInSlot(i);
                                if (stack != null) {
                                    String itemName = stack.getDisplayName();
                                    logToFile("  Slot " + i + ": " + itemName);
                                }
                            }
                            logToFile("=== End of GUI slots ===");
                        }
                    }
                }
            }
        }
    }
    
    private void logToFile(String message) {
        try {
            FileWriter writer = new FileWriter(logFile, true);
            String timestamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date());
            writer.write("[" + timestamp + "] " + message + "\n");
            writer.close();
            
            // Also print to console
            System.out.println("[BazaarSlotMod] " + message);
        } catch (IOException e) {
            System.err.println("Failed to write to log file: " + e.getMessage());
        }
    }
}
