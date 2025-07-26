const fs = require("fs");
const TelegramBot = require("node-telegram-bot-api");
const path = require("path");

// Import the game coordinator
const gameCoordinator = require("./gameCoordinator");

// Your bot token and admin ID
const token = "7844745835:AAHPQ6omh7DHzQlfSPBFJW8_7rqce9h0hek"; // Replace with your bot token
const bot = new TelegramBot(token, { polling: true });

// const ADMIN_ID = 5622408740; // Replace with your Telegram Admin ID
const PLAYER_DATA_FILE = "players.json";
const ADMIN_ID = 6720248984;
let maxSlots = 0;
let registrationOpen = false;
let registeredPlayers = []; // This array will be passed to gameCoordinator and updated
let gameChatId = -1002586678117; // New: To store the main group chat ID where the game is initiated


const eliminatedPlayerSpam = new Map();
const SPAM_THRESHOLD = 3; // Number of messages before considering it spam
const SPAM_INTERVAL_MS = 10000; // Time window for spam detection (10 seconds)


if (fs.existsSync(PLAYER_DATA_FILE)) {
    try {
        registeredPlayers = JSON.parse(fs.readFileSync(PLAYER_DATA_FILE));
        console.log("Loaded existing players from players.json");
    } catch (e) {
        console.error("❌ Failed to load players.json:", e);
        registeredPlayers = []; // Reset if corrupted
        fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2)); // Create empty
    }
} else {
    fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2)); // Create empty if not exists
}

// ✅ /start command to begin registration (only in group chat by admin)
bot.onText(/\/start (\d+)/, async (msg, match) => {
    // Ensure this command is only used in a group and by the admin
    if (msg.chat.type === 'private') {
        return bot.sendMessage(msg.chat.id, "⚠️ The /start command must be used in a group chat to initiate a game.").catch(console.error);
    }

    if (msg.from.id !== ADMIN_ID) {
        return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start the game!").catch(console.error);
    }

    maxSlots = parseInt(match[1]);
    if (isNaN(maxSlots) || maxSlots <= 0) {
        return bot.sendMessage(msg.chat.id, "⚠️ Please provide a valid number of slots (e.g., /start 10).").catch(console.error);
    }

    // Store the chat ID of the group where the game is started
    gameChatId = msg.chat.id;

    registeredPlayers = []; // Clear players for a new game
    registrationOpen = true;

    fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2)); // Clear player data file

    const instructions = `
🎮 *Welcome to Squid Game Registration!*

- 👥 Max slots: *${maxSlots}*
- 🕒 You have *5 minutes* to register.
- 🟢 To join, *DM me* (\@squiidgamee\\_bot) with the command: *\/join\*
- ✅ Registration will automatically close once all the slots are filled.

Get ready, players! 💥
    `;

    const imgPath = path.join(__dirname, "images", "start.jpg");
    // Ensure the image file exists before sending
    if (fs.existsSync(imgPath)) {
        await bot.sendPhoto(msg.chat.id, fs.createReadStream(imgPath), {
            caption: instructions,
            parse_mode: "Markdown"
        }).catch(console.error);
    } else {
        await bot.sendMessage(msg.chat.id, instructions, { parse_mode: "Markdown" }).catch(console.error);
        console.warn(`Image not found at ${imgPath}. Sending text instructions only.`);
    }

    // Auto-close registration after 2 minutes
    setTimeout(async () => {
        if (registrationOpen) {
            registrationOpen = false;
            await bot.sendMessage(gameChatId, "⏰ Time's up! Registration closed.").catch(console.error);
            if (registeredPlayers.length > 0) {
                // Automatically start the game flow via the coordinator
                await gameCoordinator.startGameFlow(
                    bot,
                    gameChatId, // Use the stored gameChatId
                    registeredPlayers,
                    ADMIN_ID,
                    PLAYER_DATA_FILE,
                    eliminatedPlayerSpam, // Pass the spam map
                    SPAM_THRESHOLD,     // Pass spam constants
                    SPAM_INTERVAL_MS
                );
            } else {
                await bot.sendMessage(gameChatId, "😢 No players joined. Game canceled.").catch(console.error);
                gameChatId = null; // Reset gameChatId if game canceled
            }
        }
    }, 2 * 60 * 1000); // 2 minutes
});
// ✅ /join command (now primarily handled in private chat)
bot.onText(/\/join/, async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
    const userChatId = msg.chat.id; // This is the user's private chat ID

    // Check if registration is open and a game has been started in a group
    if (!registrationOpen || gameChatId === null) {
        return bot.sendMessage(userChatId, "❌ Registration is not currently open for a game. Please wait for a host to start one in a group chat.").catch(console.error);
    }

    // Prevent joining from the group chat directly
    if (userChatId === gameChatId) {
        return bot.sendMessage(userChatId, "⚠️ Please send the `/join` command to me in a *private chat* to register!").catch(console.error);
    }

    if (registeredPlayers.find(p => p.id === userId)) {
        return bot.sendMessage(userChatId, `⚠️ ${username}, you already joined!`).catch(console.error);
    }
    if (registeredPlayers.length >= maxSlots) {
        // Inform the user in DM and the group chat
        await bot.sendMessage(userChatId, "❌ All slots are filled!").catch(console.error);
        return bot.sendMessage(gameChatId, `⚠️ ${username} tried to join, but all slots are now full!`).catch(console.error);
    }

    registeredPlayers.push({
        id: userId,
        username,
        status: "alive", // Initial status for all players
        progress: 0,    // Game-specific progress (e.g., for Red Light, Green Light)
        stopped: false,  // Game-specific state
        isRunning: false, // Game-specific state
        runStartTime: null, // Game-specific state
        hasMoved: false  // Game-specific state
    });

    fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));

    // Construct the game chat link. For supergroups, Telegram links are typically https://t.me/c/CHAT_ID_WITHOUT_PREFIX
    // We remove the '-100' prefix from the gameChatId.
    const gameRoomLink = gameChatId ? `https://t.me/c/${String(gameChatId).substring(4)}` : 'the game group chat';

    // Confirm to the user in their private chat, including the game room link
    await bot.sendMessage(userChatId, `✅ You have successfully joined the game! Good luck, ${username}! 🔺\n\nJoin the game room here: ${gameRoomLink}`).catch(console.error);

    // Announce in the main game group chat
    await bot.sendMessage(gameChatId, `✅ *${username}* joined the game! (${registeredPlayers.length}/${maxSlots} players)`, { parse_mode: "Markdown" }).catch(console.error);

    if (registeredPlayers.length === maxSlots) {
        registrationOpen = false;
        await bot.sendMessage(gameChatId, "🎉 All slots are full! Registration is now closed.").catch(console.error);
        // Automatically start the game flow via the coordinator
        await gameCoordinator.startGameFlow(
            bot,
            gameChatId, // Use the stored gameChatId
            registeredPlayers,
            ADMIN_ID,
            PLAYER_DATA_FILE,
            eliminatedPlayerSpam,
            SPAM_THRESHOLD,
            SPAM_INTERVAL_MS
        );
    }
});

// Any other message handler for eliminated player spam can remain the same
// as it would check against the eliminatedPlayerSpam map which is passed around.
// For example:
bot.on('message', async (msg) => {
    const userId = msg.from.id;
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

    // We only want to process messages from non-commands and not from the bot itself
    if (msg.text && msg.text.startsWith('/') || msg.from.is_bot) {
        return;
    }

    // Check if the message is from an eliminated player trying to spam
    // This assumes `eliminatedPlayerSpam` map is managed correctly
    // by the game modules and the coordinator.
    // For a robust solution, the `eliminatedPlayerSpam` map should probably be
    // passed to the `gameCoordinator` and potentially managed there or within
    // the individual game modules as players are eliminated.
    // For now, we assume this map gets updated correctly.

    // A simple check: if the player is in the `eliminatedPlayerSpam` map.
    // The `gameCoordinator` needs to add players to this map when they are eliminated.
    // Ensure that `gameCoordinator.onGameEnded` or the game modules update `eliminatedPlayerSpam` map.

    // Here, we check the global `eliminatedPlayerSpam` map that's also used by the coordinator.
    // When a player is eliminated, the `gameCoordinator` (or the game module) needs to add them to this map.
    const playerInGame = registeredPlayers.find(p => p.id === userId);

    if (playerInGame && playerInGame.status === 'eliminated') {
        const spamData = eliminatedPlayerSpam.get(userId);
        if (!spamData) {
            // This player was eliminated but not yet in the spam map, initialize
            eliminatedPlayerSpam.set(userId, { timestamps: [Date.now()], warned: false });
            return; // Allow first message
        }

        const currentTime = Date.now();
        spamData.timestamps.push(currentTime);
        spamData.timestamps = spamData.timestamps.filter(ts => currentTime - ts < SPAM_INTERVAL_MS);

        if (spamData.timestamps.length >= SPAM_THRESHOLD) {
            console.log(`🚫 SPAM detected from eliminated player ${username} (${userId})`);
            if (!spamData.warned) {
                await bot.sendMessage(msg.chat.id, `🚫 *${username}*, you have been eliminated and are spamming the chat. Further messages may be ignored.`, { parse_mode: "Markdown" }).catch(console.error);
                spamData.warned = true;
            }
            // Optionally, you can delete their message here if the bot has admin rights
            // bot.deleteMessage(msg.chat.id, msg.message_id).catch(console.error);
        }
        eliminatedPlayerSpam.set(userId, spamData);
    }
});


// ✅ /stopgame command (Admin only) - NEW COMMAND
bot.onText(/\/stopgame/, async (msg) => {
    if (msg.from.id !== ADMIN_ID) {
        return bot.sendMessage(msg.chat.id, "⚠️ Only the host can stop the game!").catch(console.error);
    }

    // Call the stopGame function from gameCoordinator
    const gameWasActive = await gameCoordinator.stopGame(bot, msg.chat.id);

    // Reset index.js specific states and player data file regardless if game was active
    registrationOpen = false;
    maxSlots = 0;
    registeredPlayers = []; // Clear local array
    eliminatedPlayerSpam.clear(); // Clear spam map
    gameChatId = null; // Reset game chat ID

    // Clear the player data file
    try {
        fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2));
        console.log("Player data file cleared.");
    } catch (e) {
        console.error("❌ Failed to clear players.json:", e);
    }

    if (gameWasActive) {
        await bot.sendMessage(msg.chat.id, "✅ Game stopped and all data reset. Ready for a new game.").catch(console.error);
    } else {
        await bot.sendMessage(msg.chat.id, "✅ Game state and all data reset (no active game was running). Ready for a new game.").catch(console.error);
    }
});
bot.onText(/\/removebuttons/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Optional: Add admin check if only admin should be able to remove buttons
    // if (userId !== adminId) {
    //     return bot.sendMessage(chatId, "🚫 You don't have permission to remove buttons.");
    // }

    try {
        await bot.sendMessage(chatId, "Custom keyboard removed.", {
            reply_markup: {
                remove_keyboard: true // This is the key property
            }
        });
        console.log(`Custom keyboard removed for chat ${chatId}`);
    } catch (error) {
        console.error(`Error removing keyboard for chat ${chatId}:`, error);
        await bot.sendMessage(chatId, "An error occurred while trying to remove the keyboard.").catch(console.error);
    }
});

// ✅ /reset command (Admin only) - Existing command, keep for full reset
bot.onText(/\/reset/, (msg) => {
    if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can reset!").catch(console.error);

    registeredPlayers = [];
    maxSlots = 0;
    registrationOpen = false;
    eliminatedPlayerSpam.clear(); // Clear spam map
    gameChatId = null; // Reset game chat ID

    // Clear the player data file
    if (fs.existsSync(PLAYER_DATA_FILE)) {
        fs.unlinkSync(PLAYER_DATA_FILE);
    }
    fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2)); // Recreate empty file

    // In a more complex scenario, you might also want to call a reset on the gameCoordinator
    // directly if it holds other persistent states not covered by `stopGame`.
    // For this setup, calling `stopGame` (which calls `resetGameInternal`) from `/stopgame`
    // is sufficient for game-specific resets.
    // For `/reset`, we just reset everything locally in index.js and ensure player.json is empty.

    bot.sendMessage(msg.chat.id, "♻️ All game data reset. Ready for a new game.").catch(console.error);
});

// Start polling for messages
console.log("Telegram bot polling started...");