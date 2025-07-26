const path = require("path");
const fs = require("fs");

// Module-scoped variables for Game 1 state
let game1Started = false;
let game1Phase = "waiting"; // "waiting", "red", "green"
let game1Timeout = null; // Stores the setTimeout ID for game end
let game1Interval = null; // Stores the setInterval ID for light changes
let game1EndTime = null; // Timestamp for when Game 1 should end

// References to external dependencies passed in startGame
let currentBotInstance = null;
let currentChatId = null;
let currentRegisteredPlayers = [];
let currentAdminId = null;
let currentPlayerDataFile = null;
let gameEndCallback = null; // Callback to notify game coordinator

// Separate spam maps for different scenarios
let eliminatedPlayerSpamMap = null; // Reference to the spam map from index.js for *eliminated* players

// Separate map for tracking specific invalid command spam for alive players
const invalidCommandSpamMap = new Map();
let spamThreshold = null;
let spamIntervalMs = null;

// --- Game Mechanics Constants ---
const REQUIRED_RUN_DURATION_MS = 5 * 1000; // 60 seconds to reach 100%
const PROGRESS_PER_MS = 100 / REQUIRED_RUN_DURATION_MS; // Progress per millisecond

/**
 * Sends the RUN/STOP reply keyboard buttons to the chat.
 * @param {number} chatId - The ID of the chat.
 */
async function sendGameButtons(chatId) {
    try {
        await currentBotInstance.sendMessage(chatId, "Game Controls Sent", { // Use a single space as the message text
            reply_markup: {
                keyboard: [
                    [{ text: "🟢 RUN" }, { text: "🔴 STOP" }]
                ],
                resize_keyboard: true,
                one_time_keyboard: false
            }
        });
    } catch (err) {
        console.error(`❌ Failed to send game buttons to chat ${chatId}:`, err.message);
        currentBotInstance.sendMessage(chatId, `⚠️ Error sending game buttons: ${err.message}`).catch(console.error);
    }
}

/**
 * Mutes a player in the chat by restricting their ability to send messages.
 * @param {number} chatId - The ID of the chat.
 * @param {number} userId - The ID of the user to mute.
 * @param {string} username - The username for logging/messages.
 */
async function mutePlayer(chatId, userId, username) {
    try {
        const chatMember = await currentBotInstance.getChatMember(chatId, userId);

        if (chatMember.status === 'creator' || chatMember.status === 'administrator') {
            console.warn(`⚠️ Skipping mute for ${username} (ID: ${userId}) because they are a chat ${chatMember.status}.`);
            await currentBotInstance.sendMessage(chatId, `⚠️ Cannot mute ${username}. They are a chat ${chatMember.status}.`).catch(console.error);
            return;
        }

        await currentBotInstance.restrictChatMember(chatId, userId, {
            can_send_messages: false,
            can_send_audios: false,
            can_send_documents: false,
            can_send_photos: false,
            can_send_videos: false,
            can_send_video_notes: false,
            can_send_voice_notes: false,
            can_send_polls: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            can_change_info: false,
            can_invite_users: false,
            can_pin_messages: false,
            can_manage_topics: false
        });
        console.log(`🔇 Muted ${username} (ID: ${userId}) in chat ${chatId}`);
        const muteConfirmMsg = await currentBotInstance.sendMessage(chatId, `🔇 ${username} has been muted due to elimination.`, { disable_notification: true }).catch(console.error);
        if (muteConfirmMsg) {
            setTimeout(() => {
                currentBotInstance.deleteMessage(chatId, muteConfirmMsg.message_id).catch(err => { /* Do not log routine message deletion errors */ });
            }, 5000);
        }
    } catch (err) {
        console.error(`❌ Failed to mute ${username} (ID: ${userId}) in chat ${chatId}:`, err.message);
        const errorMessage = err.response && err.response.description ? err.response.description : err.message;
        if (errorMessage.includes("not enough rights")) {
            await currentBotInstance.sendMessage(chatId, `⚠️ Failed to mute ${username}. Make sure the bot is an admin with 'Restrict members' permission!`).catch(console.error);
        } else if (errorMessage.includes("can't remove chat owner") || errorMessage.includes("user is an administrator of the chat")) {
            await currentBotInstance.sendMessage(chatId, `⚠️ Failed to mute ${username}. They are a chat owner or administrator.`).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(chatId, `⚠️ An unexpected error occurred while muting ${username}: ${errorMessage}`).catch(console.error);
        }
    }
}

/**
 * Safely sends a message that replies to another message, handling potential "message not found" errors.
 * @param {number} chatId The ID of the chat.
 * @param {string} text The text of the message.
 * @param {object} options Options for sendMessage, including reply_to_message_id.
 * @param {boolean} temporary If true, the bot's message will be deleted after 7 seconds.
 */
async function sendReplyMessageSafe(chatId, text, options = {}, temporary = false) {
    try {
        const sentMessage = await currentBotInstance.sendMessage(chatId, text, options);
        if (temporary && sentMessage) {
            setTimeout(() => {
                currentBotInstance.deleteMessage(chatId, sentMessage.message_id).catch(err => {
                    // Only log if it's a critical error, not "message to delete not found"
                    if (!err.message.includes("message to delete not found") && !err.message.includes("message can't be deleted")) {
                        console.error(`Error deleting temporary bot message ${sentMessage.message_id}:`, err.message);
                    }
                });
            }, 7000);
        }
        return sentMessage;
    } catch (err) {
        // Log the error only if it's not the "message to be replied not found" error
        if (!err.message.includes("message to be replied not found")) {
            console.error(`❌ Failed to send reply message to chat ${chatId}:`, err.message);
        } else {
            // If the original message was deleted, send the message without reply_to_message_id
            console.warn(`⚠️ Original message to reply to not found. Sending message without reply for chat ${chatId}.`);
            try {
                const fallbackMessage = await currentBotInstance.sendMessage(chatId, text, {
                    parse_mode: options.parse_mode,
                    disable_notification: options.disable_notification // Keep other options
                });
                if (temporary && fallbackMessage) {
                    setTimeout(() => {
                        currentBotInstance.deleteMessage(chatId, fallbackMessage.message_id).catch(err => {
                            if (!err.message.includes("message to delete not found") && !err.message.includes("message can't be deleted")) {
                                console.error(`Error deleting fallback temporary bot message ${fallbackMessage.message_id}:`, err.message);
                            }
                        });
                    }, 7000);
                }
                return fallbackMessage;
            } catch (fallbackErr) {
                console.error(`❌ Failed to send fallback message to chat ${chatId}:`, fallbackErr.message);
            }
        }
        return null;
    }
}


/**
 * Handles spam attempts from ELIMINATED players.
 * Deletes the player's message if spamming threshold is met.
 * This is specifically for when eliminated players try to talk.
 * @param {number} userId - The ID of the user.
 * @param {number} chatId - The ID of the chat.
 * @param {number} messageId - The ID of the message to potentially delete.
 * @param {string} username - The username of the player for logging.
 * @returns {Promise<boolean>} True if the message was deleted due to spam, false otherwise.
 */
async function handleEliminatedPlayerSpam(userId, chatId, messageId, username) {
    let spamData = eliminatedPlayerSpamMap.get(userId);
    const currentTime = Date.now();

    if (!spamData || (currentTime - spamData.lastMsgTime > spamIntervalMs)) {
        spamData = { count: 1, lastMsgTime: currentTime };
    } else {
        spamData.count++;
        spamData.lastMsgTime = currentTime;
    }

    eliminatedPlayerSpamMap.set(userId, spamData);

    if (spamData.count >= spamThreshold) {
        try {
            await currentBotInstance.deleteMessage(chatId, messageId);
            console.warn(`🗑️ Deleted spam message from ELIMINATED player ${username} (ID: ${userId})`);
            spamData.count = 1;
            spamData.lastMsgTime = Date.now();
            eliminatedPlayerSpamMap.set(userId, spamData);
            return true;
        } catch (error) {
            // Silent delete error
            return false;
        }
    }
    return false;
}

/**
 * Handles spam attempts from ALIVE players specifically when their action
 * results in an "invalid state" reply from the bot (e.g., "already running", "not running").
 * It decides whether to delete the player's message and/or suppress the bot's reply.
 * @param {number} userId - The ID of the user.
 * @param {number} chatId - The ID of the chat.
 * @param {number} playerMessageId - The ID of the player's message to potentially delete.
 * @param {string} username - The username of the player for logging.
 * @returns {Promise<object>} An object with `shouldDeletePlayerMessage` (boolean) and `shouldSuppressBotReply` (boolean).
 */
async function handleInvalidActionSpam(userId, chatId, playerMessageId, username) {
    let spamData = invalidCommandSpamMap.get(userId);
    const currentTime = Date.now();

    let shouldDeletePlayerMessage = false;
    let shouldSuppressBotReply = false;

    if (!spamData || (currentTime - spamData.lastMsgTime > spamIntervalMs)) {
        spamData = { count: 1, lastMsgTime: currentTime };
        shouldSuppressBotReply = false;
    } else {
        spamData.count++;
        spamData.lastMsgTime = currentTime;

        if (spamData.count >= spamThreshold) {
            shouldDeletePlayerMessage = true;
            shouldSuppressBotReply = true;
        }
    }

    invalidCommandSpamMap.set(userId, spamData);

    if (shouldDeletePlayerMessage) {
        try {
            await currentBotInstance.deleteMessage(chatId, playerMessageId);
            console.warn(`🗑️ Deleted invalid action spam message from ${username} (ID: ${userId})`);
        } catch (error) {
            // Silent delete error
        }
    }

    return { shouldDeletePlayerMessage, shouldSuppressBotReply };
}

/**
 * FIXED: Safely kicks a single player with comprehensive error handling and validation
 * @param {number} chatId - The chat ID
 * @param {Object} playerData - Player object with id, username, and progress
 * @returns {Promise<boolean>} - Returns true if kick was successful, false otherwise
 */
async function kickSinglePlayer(chatId, playerData) {
    try {
        // Validate player data structure
        if (!playerData || typeof playerData !== 'object') {
            console.error(`❌ Invalid player data object:`, playerData);
            return false;
        }

        // Extract and validate player ID
        let userId;
        if (typeof playerData.id === 'string') {
            userId = parseInt(playerData.id);
        } else if (typeof playerData.id === 'number') {
            userId = playerData.id;
        } else {
            console.error(`❌ Invalid or missing user ID for player:`, playerData);
            return false;
        }

        if (isNaN(userId) || userId <= 0) {
            console.error(`❌ Invalid user ID after parsing: ${userId} for player:`, playerData);
            return false;
        }

        const username = playerData.username || `User_${userId}`;

        console.log(`[DEBUG] Starting kick process for ${username} (ID: ${userId})`);

        // Check if user exists in chat and get their status
        let chatMember;
        try {
            chatMember = await currentBotInstance.getChatMember(chatId, userId);
            console.log(`[DEBUG] Chat member status for ${username}: ${chatMember.status}`);
        } catch (memberError) {
            console.error(`❌ Failed to get chat member info for ${username} (ID: ${userId}):`, memberError.message);

            // If user not found in chat, they might have already left
            if (memberError.message.includes("user not found") || memberError.message.includes("participant not found")) {
                console.log(`ℹ️ User ${username} (ID: ${userId}) not found in chat - they may have already left`);
                return true; // Consider this a success since they're not in the chat
            }
            return false;
        }

        // Don't try to kick admins or creators
        if (chatMember.status === 'creator' || chatMember.status === 'administrator') {
            console.warn(`⚠️ Skipping kick for ${username} (ID: ${userId}) - they are a chat ${chatMember.status}`);
            await currentBotInstance.sendMessage(chatId, `⚠️ Cannot kick ${username}. They are a chat ${chatMember.status}.`).catch(console.error);
            return true; // Not really successful, but we handled it appropriately
        }

        // Check if user has already left or been kicked
        if (chatMember.status === 'left' || chatMember.status === 'kicked') {
            console.log(`ℹ️ User ${username} (ID: ${userId}) has already ${chatMember.status} the chat`);
            return true; // They're already gone
        }

        // Get bot's permissions
        let botMember;
        try {
            const botId = (await currentBotInstance.getMe()).id;
            botMember = await currentBotInstance.getChatMember(chatId, botId);
            console.log(`[DEBUG] Bot permissions - can_restrict_members: ${botMember.can_restrict_members}`);
        } catch (botError) {
            console.error(`❌ Failed to get bot member info:`, botError.message);
            return false;
        }

        // Check if bot has the required permissions
        if (!botMember.can_restrict_members) {
            console.warn(`❌ Bot does not have 'Ban users' permission in chat ${chatId}. Cannot kick ${username}.`);
            await currentBotInstance.sendMessage(chatId, `⚠️ Failed to kick ${username}. Bot needs 'Ban users' permission!`).catch(console.error);
            return false;
        }

        // First, try to unrestrict the user (in case they were muted)
        try {
            await currentBotInstance.restrictChatMember(chatId, userId, {
                can_send_messages: true, can_send_audios: true, can_send_documents: true,
                can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
                can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
                can_add_web_page_previews: true, can_change_info: true, can_invite_users: true,
                can_pin_messages: true, can_manage_topics: true
            });
            console.log(`[DEBUG] Successfully unrestricted ${username} before kick`);
        } catch (unrestrictError) {
            console.warn(`⚠️ Could not unrestrict ${username} (ID: ${userId}) before kicking: ${unrestrictError.message}`);
            // Continue with kick attempt even if unrestrict fails
        }

        // Now attempt to kick the user
        try {
            await currentBotInstance.banChatMember(chatId, userId);
            console.log(`💀 Successfully kicked ${username} (ID: ${userId}) from chat ${chatId}`);
            return true;
        } catch (banError) {
            console.error(`❌ Failed to ban/kick ${username} (ID: ${userId}):`, banError.message);

            const errorMessage = banError.response && banError.response.description ? banError.response.description : banError.message;

            if (errorMessage.includes("not enough rights")) {
                await currentBotInstance.sendMessage(chatId, `⚠️ Failed to kick ${username}. Bot needs 'Ban users' permission!`).catch(console.error);
            } else if (errorMessage.includes("can't remove chat owner") || errorMessage.includes("user is an administrator")) {
                await currentBotInstance.sendMessage(chatId, `⚠️ Cannot kick ${username}. They are a chat administrator.`).catch(console.error);
            } else if (errorMessage.includes("user not found")) {
                console.log(`ℹ️ User ${username} not found during kick - they may have already left`);
                return true; // They're not in the chat anymore
            } else {
                await currentBotInstance.sendMessage(chatId, `⚠️ Unexpected error kicking ${username}: ${errorMessage}`).catch(console.error);
            }
            return false;
        }

    } catch (generalError) {
        console.error(`❌ General error in kickSinglePlayer for player:`, playerData, generalError);
        return false;
    }
}

/**
 * Ends Game 1, calculates results, removes keyboard, and kicks eliminated players.
 * @param {number} chatId - The ID of the chat where the game is running.
 */
async function endGame1(chatId) {
    const totalParticipantsInGame1 = currentRegisteredPlayers.filter(p => p.status === "alive").length;

    currentRegisteredPlayers.forEach(p => {
        if (p.status === "alive" && p.progress < 100) {
            p.status = "eliminated";
        }
    });

    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    const survivors = currentRegisteredPlayers.filter(p => p.status === "alive");

    // FIXED: Create a safer copy of eliminated players with better validation
    const eliminatedForKicking = currentRegisteredPlayers
        .filter(p => p.status === "eliminated")
        .map(p => {
            // Ensure we have valid data for each eliminated player
            const playerData = {
                id: p.id,
                username: p.username || `User_${p.id}`,
                progress: p.progress || 0
            };

            // Validate the data before returning
            if (!playerData.id || (typeof playerData.id !== 'number' && typeof playerData.id !== 'string')) {
                console.error(`❌ Invalid player data found during elimination mapping:`, p);
                return null; // This will be filtered out below
            }

            return playerData;
        })
        .filter(p => p !== null); // Remove any null entries from invalid data

    console.log(`[DEBUG] Prepared ${eliminatedForKicking.length} players for kicking:`, eliminatedForKicking.map(p => `${p.username}(${p.id})`));

    eliminatedPlayerSpamMap.clear();
    invalidCommandSpamMap.clear();

    try {
        await currentBotInstance.sendMessage(chatId, "Game has ended. Removing game controls.", {
            reply_markup: {
                remove_keyboard: true
            }
        });
    } catch (e) {
        console.warn(`⚠️ Failed to remove reply keyboard:`, e);
    }

    let resultMsg = `🏁✨ <b>Game 1 has ended!</b> ✨🏁\n\n`;
    resultMsg += `👥 Total Participants: <b>${totalParticipantsInGame1}</b>\n`;
    resultMsg += `✅ Survivors: <b>${survivors.length}</b>\n`;
    resultMsg += `💀 Eliminated: <b>${eliminatedForKicking.length}</b>\n\n`;
    resultMsg += `✅ Survivors:\n${survivors.map(p => `• ${p.username}`).join('\n') || "None"}\n\n`;
    resultMsg += `💀 Eliminated:\n${eliminatedForKicking.map(p => `• ${p.username} (Progress: ${Math.floor(p.progress)}%)`).join('\n') || "None"}`;

    await currentBotInstance.sendMessage(chatId, resultMsg, { parse_mode: "HTML" }).catch(console.error);

    if (eliminatedForKicking.length === 0) {
        const gif = path.resolve(__dirname, "..", "..", "gifs", "goodwork.gif");
        if (fs.existsSync(gif)) {
            await currentBotInstance.sendMessage(chatId, "🎉 No one was eliminated! Great job everyone!").catch(console.error);
            await currentBotInstance.sendAnimation(chatId, fs.createReadStream(gif)).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(chatId, "🎉 No one was eliminated! Great job everyone! (GIF not found)").catch(console.error);
        }
    } else {
        const gif = path.resolve(__dirname, "..", "..", "gifs", "bye.gif");
        if (fs.existsSync(gif)) {
            await currentBotInstance.sendAnimation(chatId, fs.createReadStream(gif)).catch(console.error);
        }
        await currentBotInstance.sendMessage(chatId, "⚠️ 💀 Eliminated players will be kicked in 10 seconds!").catch(console.error);

        await new Promise(resolve => setTimeout(resolve, 10000));

        // FIXED: Use the new kickSinglePlayer function with better error handling
        let kickedCount = 0;
        let failedKicks = 0;

        console.log(`[DEBUG] Starting kick process for ${eliminatedForKicking.length} players`);

        for (const playerData of eliminatedForKicking) {
            console.log(`[DEBUG] Processing kick for player:`, playerData);

            const kickResult = await kickSinglePlayer(chatId, playerData);

            if (kickResult) {
                kickedCount++;
            } else {
                failedKicks++;
            }

            // Add a small delay between kicks to avoid hitting rate limits
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        await currentBotInstance.sendMessage(chatId,
            `🏁✅ <b>Eliminations completed!</b>\n\n` +
            `👥 Remaining Survivors: <b>${survivors.length}</b>\n` +
            `💀 Successfully Kicked: <b>${kickedCount}</b>\n` +
            `⚠️ Failed Kicks: <b>${failedKicks}</b>`,
            { parse_mode: "HTML" }
        ).catch(console.error);

        const gif2 = path.resolve(__dirname, "..", "..", "gifs", "falling-money-squid-game.gif");
        if (fs.existsSync(gif2)) {
            await currentBotInstance.sendAnimation(chatId, fs.createReadStream(gif2)).catch(console.error);
        }
    }

    if (gameEndCallback) {
        gameEndCallback(currentRegisteredPlayers);
    }
}

/**
 * Initializes and starts Game 1 (Red Light, Green Light).
 * This function is called by the game coordinator.
 * @param {TelegramBot} bot - The Telegram bot instance.
 * @param {number} chatId - The ID of the chat where the game is played.
 * @param {Array<Object>} players - The array of registered players.
 * @param {number} adminId - The ID of the admin.
 * @param {string} playerDataFile - Path to the player data file.
 * @param {Function} onGameEnd - Callback function to call when the game ends,
 * it receives the updated players array.
 * @param {Map} spamMap - Map for tracking spam from eliminated players.
 * @param {number} sThreshold - Constant for spam threshold.
 * @param {number} sIntervalMs - Constant for spam interval.
 */
async function startGame(bot, chatId, players, adminId, playerDataFile, onGameEnd, spamMap, sThreshold, sIntervalMs) {
    currentBotInstance = bot;
    currentChatId = chatId;
    currentRegisteredPlayers = players;
    currentAdminId = adminId;
    currentPlayerDataFile = playerDataFile;
    gameEndCallback = onGameEnd;
    eliminatedPlayerSpamMap = spamMap;
    spamThreshold = sThreshold;
    spamIntervalMs = sIntervalMs;

    game1Started = false;
    game1Phase = "waiting";
    if (game1Timeout) clearTimeout(game1Timeout);
    if (game1Interval) clearInterval(game1Interval);
    game1Timeout = null;
    game1Interval = null;
    game1EndTime = null;

    invalidCommandSpamMap.clear();

    const alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");
    if (alivePlayers.length === 0) {
        await currentBotInstance.sendMessage(chatId, "⚠️ No alive players to start Game 1. Ending round.").catch(console.error);
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
        return;
    }

    currentRegisteredPlayers.forEach(p => {
        if (p.status === "alive") {
            p.progress = 0;
            p.stopped = false;
            p.isRunning = false;
            p.runStartTime = null;
            p.hasMoved = false;
        }
        // When game starts, unrestrict previously eliminated players
        if (p.status === "eliminated") {
            currentBotInstance.restrictChatMember(chatId, p.id, {
                can_send_messages: true, can_send_audios: true, can_send_documents: true,
                can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
                can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
                can_add_web_page_previews: true, can_change_info: true, can_invite_users: true,
                can_pin_messages: true, can_manage_topics: true
            }).catch(err => console.warn(`Could not unrestrict player ${p.username} (ID: ${p.id}) during game start: ${err.message}`));
        }
    });
    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    const instructions = `
🎮 Game 1: Red Light, Green Light

- ⏱️ You have 5 minutes to finish the game. \n
- 🟢 Green Light: click the RUN button to move forward.
- 🔴 Red Light: click the STOP to freeze before the red light.\n
- ❌ If you fail to stop before Red Light, or if you move during Red Light, you will be eliminated immediately.\n
- 💯 Your goal is to reach 100% progress to survive.
- ⚠️ You have 1 minute to prepare\n
Best of luck, players! 💚❤️
`;

    const instructionsImgPath = path.resolve(__dirname, "..", "..", "images", "game1.jpg");
    if (fs.existsSync(instructionsImgPath)) {
        await currentBotInstance.sendPhoto(chatId, fs.createReadStream(instructionsImgPath), {
            caption: instructions,
            parse_mode: "Markdown"
        }).catch(console.error);
    } else {
        await currentBotInstance.sendMessage(chatId, instructions, { parse_mode: "Markdown" }).catch(console.error);
        console.warn(`Image not found at ${instructionsImgPath}. Sending text instructions only.`);
    }

    game1Phase = "waiting";
    game1Started = false;

    setTimeout(async () => {
        game1Phase = "red";
        game1Started = true;
        game1EndTime = Date.now() + 1 * 60 * 1000;

        await sendGameButtons(chatId);


        game1Interval = setInterval(async () => {
            const remainingMs = game1EndTime - Date.now();
            const mins = Math.floor(remainingMs / 60000);
            const secs = Math.floor((remainingMs % 60000) / 1000);

            if (remainingMs <= 0) {
                clearInterval(game1Interval);
                clearTimeout(game1Timeout);
                game1Interval = null;
                game1Timeout = null;
                game1Started = false;
                await endGame1(chatId);
                return;
            }

            if (game1Phase === "green") {
                game1Phase = "red";

                const redImgPath = path.resolve(__dirname, "..", "..", "images", "red.jpg");
                if (fs.existsSync(redImgPath)) {
                    await currentBotInstance.sendPhoto(chatId, fs.createReadStream(redImgPath)).catch(console.error);
                }
                await currentBotInstance.sendMessage(chatId, `🔴 Red Light! Stop!\n⏰ Remaining Time: ${mins}m ${secs}s`).catch(console.error);

                for (const p of currentRegisteredPlayers) {
                    if (p.status === "alive" && p.isRunning && p.progress < 100) {
                        p.status = "eliminated";
                        p.isRunning = false;
                        p.runStartTime = null;

                        let progressMsg = `💀 <b>${p.username}</b> didn't stop in time and was eliminated!\n`;
                        progressMsg += `💔 Final progress: <b>${Math.floor(p.progress)}%</b>`;
                        // Use sendReplyMessageSafe for elimination messages
                        await sendReplyMessageSafe(chatId, progressMsg, { parse_mode: "HTML" }, false); // Not temporary
                        await mutePlayer(chatId, p.id, p.username);
                    }
                }
                fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

            } else {
                game1Phase = "green";

                const greenImgPath = path.resolve(__dirname, "..", "..", "images", "green.jpg");
                if (fs.existsSync(greenImgPath)) {
                    await currentBotInstance.sendPhoto(chatId, fs.createReadStream(greenImgPath)).catch(console.error);
                }
                await currentBotInstance.sendMessage(chatId, `🟢 Green Light! Run!\n⏰ Remaining Time: ${mins}m ${secs}s`).catch(console.error);

                currentRegisteredPlayers.forEach(p => {
                    if (p.status === "alive") {
                        p.stopped = false;
                        p.isRunning = false;
                        p.runStartTime = null;
                    }
                });
            }
        }, Math.floor(Math.random() * 15000) + 15000);

        game1Timeout = setTimeout(() => {
            clearInterval(game1Interval);
            clearTimeout(game1Timeout);
            game1Interval = null;
            game1Timeout = null;
            game1Started = false;
            endGame1(chatId);
        }, 1 * 60 * 1000);

        await currentBotInstance.sendMessage(chatId, "🏁 Wait for *GREEN* light to MOVE!", { parse_mode: "Markdown" }).catch(console.error);
    }, 60 * 1000);

    currentBotInstance.onText(/🟢 RUN/, async (msg) => {
        if (msg.chat.id !== currentChatId || !game1Started) return;

        const userId = msg.from.id;
        const username = msg.from.first_name || msg.from.username;
        const player = currentRegisteredPlayers.find(p => p.id === userId);
        const chatId = msg.chat.id;

        // --- Handle players NOT in the game or ELIMINATED early ---
        if (!player) {
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            await sendReplyMessageSafe(chatId, `⛔ ${username}, you are not a registered player in this game.`, { reply_to_message_id: msg.message_id }, true);
            return;
        }

        if (player.status === "eliminated") {
            const isSpamDeleted = await handleEliminatedPlayerSpam(userId, chatId, msg.message_id, username);
            if (isSpamDeleted) {
                return;
            }
            await sendReplyMessageSafe(chatId, `💀 ${username}, you are eliminated and cannot move.`, { reply_to_message_id: msg.message_id }, true);
            return;
        }
        // --- END NEW HANDLING ---


        const { shouldDeletePlayerMessage, shouldSuppressBotReply } = await handleInvalidActionSpam(userId, chatId, msg.message_id, username);

        // --- INVALID ACTIONS ---
        if (game1Phase === "waiting") {
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            if (!shouldSuppressBotReply) {
                await sendReplyMessageSafe(chatId, "⛔ Wait for the game to start!", { reply_to_message_id: msg.message_id }, true);
            }
            return;
        }

        if (player.progress >= 100) {
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            if (!shouldSuppressBotReply) {
                await sendReplyMessageSafe(chatId, "✅ You've already reached 100% progress and are safe!", { reply_to_message_id: msg.message_id }, true);
            }
            return;
        }

        if (game1Phase !== "green") { // Player moved during Red Light
            player.status = "eliminated";
            player.isRunning = false;
            player.runStartTime = null;

            fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
            await sendReplyMessageSafe(chatId, `💀 <b>${player.username}</b> moved during Red Light and was eliminated!`, { parse_mode: "HTML", reply_to_message_id: msg.message_id }, false);
            await mutePlayer(chatId, player.id, player.username);
            return;
        }

        if (player.isRunning) { // Prevent double-running
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            if (!shouldSuppressBotReply) {
                await sendReplyMessageSafe(chatId, "⚠️ You're already running!", { reply_to_message_id: msg.message_id }, true);
            }
            return;
        }

        // --- VALID RUN ACTION ---
        invalidCommandSpamMap.delete(userId);

        player.isRunning = true;
        player.runStartTime = Date.now();
        player.hasMoved = true;

        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
        await sendReplyMessageSafe(chatId, `🏃 ${username} started running!`, { reply_to_message_id: msg.message_id }, false);
    });

    currentBotInstance.onText(/🔴 STOP/, async (msg) => {
        if (msg.chat.id !== currentChatId || !game1Started) return;

        const userId = msg.from.id;
        const username = msg.from.first_name || msg.from.username;
        const player = currentRegisteredPlayers.find(p => p.id === userId);
        const chatId = msg.chat.id;

        // --- Handle players NOT in the game or ELIMINATED early ---
        if (!player) {
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            await sendReplyMessageSafe(chatId, `⛔ ${username}, you are not a registered player in this game.`, { reply_to_message_id: msg.message_id }, true);
            return;
        }

        if (player.status === "eliminated") {
            const isSpamDeleted = await handleEliminatedPlayerSpam(userId, chatId, msg.message_id, username);
            if (isSpamDeleted) {
                return;
            }
            await sendReplyMessageSafe(chatId, `💀 ${username}, you are eliminated and cannot move.`, { reply_to_message_id: msg.message_id }, true);
            return;
        }
        // --- END NEW HANDLING ---

        const { shouldDeletePlayerMessage, shouldSuppressBotReply } = await handleInvalidActionSpam(userId, chatId, msg.message_id, username);

        // --- INVALID ACTIONS ---
        if (game1Phase === "waiting") {
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            if (!shouldSuppressBotReply) {
                await sendReplyMessageSafe(chatId, "⛔ Wait for the game to start!", { reply_to_message_id: msg.message_id }, true);
            }
            return;
        }

        if (player.progress >= 100) {
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            if (!shouldSuppressBotReply) {
                await sendReplyMessageSafe(chatId, "✅ You've already reached finish line and are safe!", { reply_to_message_id: msg.message_id }, true);
            }
            return;
        }

        if (!player.isRunning) { // Player trying to stop while not running
            try { await currentBotInstance.deleteMessage(chatId, msg.message_id); } catch (e) { /* silent delete error */ }
            if (!shouldSuppressBotReply) {
                await sendReplyMessageSafe(chatId, "⚠️ You are not running to stop!", { reply_to_message_id: msg.message_id }, true);
            }
            return;
        }

        // --- VALID STOP ACTION ---
        invalidCommandSpamMap.delete(userId);

        if (player.runStartTime) {
            const runDuration = Date.now() - player.runStartTime;
            // Calculate progress based on the fixed rate for 45 seconds to 100%
            const progressGained = runDuration * PROGRESS_PER_MS;
            player.progress = Math.min(100, player.progress + progressGained);
        }

        player.isRunning = false;
        player.runStartTime = null;

        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
        await sendReplyMessageSafe(chatId, `🛑 ${username} stopped! Your current progress: ${Math.floor(player.progress)}%`, { reply_to_message_id: msg.message_id }, false);

        if (player.progress >= 100) {
            player.status = "alive";
            fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
            await sendReplyMessageSafe(chatId, `🎉 Congratulations, <b>${player.username}</b>! You reached finish line! you are safe for the first round!`, { parse_mode: "HTML" }, false);
        }
    });
}


module.exports = {
    startGame,
    endGame1,
};