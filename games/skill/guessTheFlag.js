// games/skill/guessTheFlag.js - Skill Game: Guess the Flag
const fs = require("fs");
const path = require("path");

// Module-scoped variables to hold the context passed from the game coordinator
let currentBotInstance = null;
let currentChatId = null;
let currentRegisteredPlayers = [];
let currentAdminId = null;
let currentPlayerDataFile = null;
let gameEndCallback = null; // Callback to notify the game coordinator when this game ends
let eliminatedPlayerSpamMap = null;
let spamThreshold = null;
let spamIntervalMs = null;

// Game-specific state variables for Guess the Flag
let flagGameActive = false;
let flagCorrectAnswer = "";
let flagActivePlayers = []; // IDs of players currently active in this game round
let flagPrivateAnswers = {}; // { userId: { answer: "COUNTRY", timestamp: Date.now() } }
let flagRoundNumber = 0;
let flagRoundTimeout = null; // Timer for each flag guessing round
// Removed: let dmInteractionGracePeriodTimer = null; // Timer for the initial DM interaction grace period
// Removed: let dmInteractedPlayers = new Set(); // Stores IDs of players who have sent a message to bot's private chat

// Telegram listener IDs to manage their lifecycle
let messageListenerId = null;
let stopGameListenerId = null;

// --- Game Assets Paths (relative to the project root) ---
const FLAG_INTRO_IMAGE_PATH = path.resolve(__dirname, "..", "..", "images", "guess-flag.png");
const BYE_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "bye.gif");
const GOOD_WORK_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "goodwork.gif");
const FALLING_MONEY_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "falling-money-squid-game.gif");

// List of flags and their correct answers
const flagDataList = [
    { country: "PHILIPPINES", file: "philippines.png" },
    { country: "JAPAN", file: "japan.png" },
    { country: "FRANCE", file: "france.png" },
    { country: "GERMANY", file: "germany.png" },
    { country: "BRAZIL", file: "brazil.png" },
    { country: "CANADA", file: "canada.png" },
    { country: "ITALY", file: "italy.png" },
    { country: "AUSTRALIA", file: "australia.png" }
];

/**
 * Gets a random flag from the list.
 * @returns {Object} An object containing country and file name.
 */
function getRandomFlag() {
    const randomIndex = Math.floor(Math.random() * flagDataList.length);
    return flagDataList[randomIndex];
}

// --- Utility Functions (encapsulated within this module) ---

/**
 * Retrieves a player's username from the registeredPlayers array.
 * @param {number} id - The user ID.
 * @returns {string} The username or "Unknown Player".
 */
function getUsernameById(id) {
    const player = currentRegisteredPlayers.find(p => p.id === id);
    if (!player) {
        return "Unknown Player";
    }
    return player.username ? (player.username.startsWith("@") ? player.username : `@${player.username}`) : (player.first_name || "Unknown Player");
}

/**
 * Marks a player's status as "eliminated" in the global player list.
 * @param {number} userId - The ID of the user to eliminate.
 */
async function eliminatePlayer(userId) {
    const p = currentRegisteredPlayers.find(p => p.id === userId);
    if (p) {
        p.status = "eliminated";
        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
    }
}

/**
 * Handles spam attempts from eliminated players.
 * @param {number} userId - The ID of the user.
 * @param {number} messageId - The ID of the message to potentially delete.
 * @param {string} username - The username of the player for logging.
 * @returns {Promise<boolean>} True if the message was deleted due to spam, false otherwise.
 */
async function handleEliminatedPlayerSpam(userId, messageId, username) {
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
            await currentBotInstance.deleteMessage(currentChatId, messageId).catch(console.error);
            console.log(`Deleted spam message from ${username} (ID: ${userId})`);
            spamData.count = 0; // Reset count after deleting to prevent continuous deletion
            eliminatedPlayerSpamMap.set(userId, spamData);
            return true;
        } catch (error) {
            console.error(`Error deleting spam message from ${username} in chat ${currentChatId}:`, error.message);
            spamData.count = 0;
            eliminatedPlayerSpamMap.set(userId, spamData);
            return false;
        }
    }
    return false;
}

/**
 * Mutes a player in the chat by restricting their ability to send messages.
 * @param {number} chatId - The ID of the chat.
 * @param {number} userId - The ID of the user to mute.
 * @param {string} username - The username for logging/messages.
 */
async function mutePlayer(chatId, userId, username) {
    try {
        await currentBotInstance.restrictChatMember(chatId, userId, {
            can_send_messages: false, can_send_audios: false, can_send_documents: false,
            can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
            can_send_polls: false, can_send_other_messages: false,
            can_add_web_page_previews: false, can_change_info: false, can_invite_users: false,
            can_pin_messages: false, can_manage_topics: false
        }).catch(console.error);
        console.log(`Successfully muted ${username} (ID: ${userId}) in chat ${chatId}`);
        const muteConfirmMsg = await currentBotInstance.sendMessage(chatId, `🔇 ${username} has been muted due to elimination.`, { disable_notification: true }).catch(console.error);
        if (muteConfirmMsg) {
            setTimeout(() => {
                currentBotInstance.deleteMessage(chatId, muteConfirmMsg.message_id).catch(err => console.error("Error deleting mute confirmation message:", err.message));
            }, 5000);
        }
    } catch (err) {
        console.error(`❌ Failed to mute ${username} (ID: ${userId}) in chat ${chatId}:`, err.message);
        if (err.response && err.response.statusCode === 400 && err.response.description.includes("not enough rights")) {
            await currentBotInstance.sendMessage(chatId, `⚠️ Failed to mute ${username}. Make sure the bot is an admin with 'Restrict members' permission!`).catch(console.error);
        }
    }
}

/**
 * Kicks a player from the chat.
 * @param {number} chatId - The ID of the chat.
 * @param {number} userId - The ID of the user to kick.
 * @param {string} username - The username for logging/messages.
 */
async function kickPlayer(chatId, userId, username) {
    try {
        await currentBotInstance.banChatMember(chatId, userId).catch(console.error);
        console.log(`Successfully kicked (banned) ${username} (ID: ${userId}) from the group.`);
    } catch (err) {
        console.error(`❌ Failed to kick (ban) ${username} (ID: ${userId}):`, err.message);
        if (err.response && err.response.statusCode === 400 && err.response.description.includes("can't remove chat owner")) {
            await currentBotInstance.sendMessage(chatId, `⚠️ Could not kick ${username} (likely a group owner/admin). Please remove manually.`).catch(console.error);
        } else if (err.response && err.response.statusCode === 400 && err.response.description.includes("not enough rights")) {
            await currentBotInstance.sendMessage(chatId, `⚠️ Failed to kick ${username}. Make sure the bot is an admin with 'Restrict members' permission!`).catch(console.error);
        }
    }
}

/**
 * Locks the group chat by restricting members from sending messages.
 * Requires bot to be admin with 'Restrict members' permission.
 * @param {number} chatId - The ID of the chat to lock.
 */
async function lockGroupChat(chatId) {
    try {
        await currentBotInstance.setChatPermissions(chatId, {
            can_send_messages: false, can_send_audios: false, can_send_documents: false,
            can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
            can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
            can_add_web_page_previews: false, can_change_info: false, can_invite_users: false,
            can_pin_messages: false, can_manage_topics: false
        }).catch(console.error);
        console.log(`Group chat ${chatId} locked.`);
    } catch (error) {
        console.error(`Failed to lock group chat ${chatId}:`, error.message);
        await currentBotInstance.sendMessage(chatId, "⚠️ Failed to lock chat. Bot might lack 'Restrict members' permission.").catch(console.error);
    }
}

/**
 * Unlocks the group chat by allowing members to send messages.
 * Requires bot to be admin with 'Restrict members' permission.
 * @param {number} chatId - The ID of the chat to unlock.
 */
async function unlockGroupChat(chatId) {
    try {
        await currentBotInstance.setChatPermissions(chatId, {
            can_send_messages: true, can_send_audios: true, can_send_documents: true,
            can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
            can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
            can_add_web_page_previews: true, can_change_info: true, can_invite_users: true,
            can_pin_messages: true, can_manage_topics: true
        }).catch(console.error);
        console.log(`Group chat ${chatId} unlocked.`);
    } catch (error) {
        console.error(`Failed to unlock group chat ${chatId}:`, error.message);
        await currentBotInstance.sendMessage(chatId, "⚠️ Failed to unlock chat. Bot might lack 'Restrict members' permission.").catch(console.error);
    }
}


/**
 * Resets all game state variables for Guess the Flag.
 */
function resetFlagGameState() {
    flagGameActive = false;
    flagCorrectAnswer = "";
    flagActivePlayers = [];
    flagPrivateAnswers = {};
    flagRoundNumber = 0;
    if (flagRoundTimeout) clearTimeout(flagRoundTimeout);
    flagRoundTimeout = null;
    // Removed: if (dmInteractionGracePeriodTimer) clearTimeout(dmInteractionGracePeriodTimer);
    // Removed: dmInteractionGracePeriodTimer = null;
    // Removed: dmInteractedPlayers.clear();
    // No need to reset currentRegisteredPlayers here, as it's managed by coordinator
}

/**
 * Starts a new round of the Guess the Flag game.
 * @param {number} groupChatId - The ID of the group chat.
 */
async function startFlagRound(groupChatId) {
    // flagActivePlayers should already contain all alive players at this point
    // Removed: flagActivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive" && dmInteractedPlayers.has(p.id)).map(p => p.id);

    if (flagActivePlayers.length === 0) {
        await currentBotInstance.sendMessage(groupChatId, "😵 NO PLAYERS\n\nNo active players left to continue Guess the Flag. Ending game.", { parse_mode: "HTML" }).catch(console.error);
        finishFlagGame(groupChatId); // End the game if no players left
        return;
    }

    const flagData = getRandomFlag();
    flagCorrectAnswer = flagData.country.toUpperCase();
    flagPrivateAnswers = {}; // Reset private answers for the new round
    flagGameActive = true; // Game is active for guessing

    // Send instructions for the round
    await currentBotInstance.sendMessage(groupChatId,
        `🚨 START ROUND ${flagRoundNumber} 🚨\n\n` +
        `📩 Send your answer *PRIVATELY* to me.\n` +
        `⚠️ *Important:* You only have *ONE TRY*! Typo = OUT!\n\n` +
        `⏰ You have 30 seconds to answer. Good luck!`,
        { parse_mode: "Markdown" }
    ).catch(console.error);

    // Send the flag image after a short delay
    setTimeout(async () => {
        const flagImgPath = path.resolve(__dirname, "..", "..", "images", flagData.file);
        try {
            if (fs.existsSync(flagImgPath)) {
                await currentBotInstance.sendPhoto(groupChatId, fs.createReadStream(flagImgPath), {
                    caption: `🏳️ Guess the flag!`,
                    parse_mode: "HTML"
                }).catch(console.error);
            } else {
                await currentBotInstance.sendMessage(groupChatId, `🏳️ Guess the flag: ${flagData.country}! (Image not found)`, { parse_mode: "HTML" }).catch(console.error);
                console.warn(`Flag image not found at ${flagImgPath}. Sending text only.`);
            }
        } catch (err) {
            console.error(`Error sending flag image for ${flagData.country}:`, err.message);
            await currentBotInstance.sendMessage(groupChatId, `Error sending flag image for ${flagData.country}. Please guess the country name.`, { parse_mode: "HTML" }).catch(console.error);
        }

        // Set timeout for evaluating answers for this round
        if (flagRoundTimeout) clearTimeout(flagRoundTimeout);
        flagRoundTimeout = setTimeout(() => {
            evaluateFlagAnswers(groupChatId);
        }, 30 * 1000); // 30 seconds to answer
    }, 5000); // 5 seconds delay after instructions before showing flag
}

/**
 * Evaluates answers for the current flag round.
 * @param {number} groupChatId - The ID of the group chat.
 */
async function evaluateFlagAnswers(groupChatId) {
    flagGameActive = false; // Stop accepting answers for this round
    if (flagRoundTimeout) clearTimeout(flagRoundTimeout); // Clear round timer

    const survivors = [];
    const eliminatedThisRound = [];

    // Filter players who were active in this round
    const playersInThisRound = currentRegisteredPlayers.filter(p => flagActivePlayers.includes(p.id));

    for (const player of playersInThisRound) {
        if (flagPrivateAnswers[player.id] && flagPrivateAnswers[player.id].answer === flagCorrectAnswer) {
            survivors.push(player.id);
            // Player status remains "alive"
        } else {
            // Player either didn't answer, answered incorrectly, or answered too late
            eliminatedThisRound.push(player.id);
            player.status = "eliminated"; // Mark as eliminated
            await mutePlayer(groupChatId, player.id, getUsernameById(player.id));
        }
    }

    // Update players.json with new statuses
    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    const survivorNames = survivors.map(id => getUsernameById(id)).join(", ") || "None";
    const eliminatedNames = eliminatedThisRound.map(id => getUsernameById(id)).join(", ") || "None";

    await currentBotInstance.sendMessage(groupChatId,
        `🏁 Round ${flagRoundNumber} finished! The correct answer was: <b>${flagCorrectAnswer}</b>\n\n` +
        `✅ Survivors: ${survivorNames}\n` +
        `❌ Eliminated: ${eliminatedNames}`,
        { parse_mode: "HTML" }
    ).catch(console.error);

    if (eliminatedThisRound.length > 0) {
        const eliminationGifPath = BYE_GIF_PATH;
        try {
            if (fs.existsSync(eliminationGifPath)) {
                await currentBotInstance.sendAnimation(groupChatId, fs.createReadStream(eliminationGifPath), {
                    caption: `💀 Eliminated: ${eliminatedNames}\n\n⚠️ They will be kicked in 5 seconds... Say your goodbyes!`
                }).catch(console.error);
            } else {
                console.warn(`GIF not found at ${eliminationGifPath}. Skipping animation.`);
                await currentBotInstance.sendMessage(groupChatId, `💀 Eliminated: ${eliminatedNames}\n\n⚠️ They will be kicked in 5 seconds... Say your goodbyes!`, { parse_mode: "HTML" }).catch(console.error);
            }

            setTimeout(async () => {
                for (const userId of eliminatedThisRound) {
                    await kickPlayer(groupChatId, userId, getUsernameById(userId));
                }
                setTimeout(() => {
                    handleNextFlagRoundOrFinish(groupChatId, survivors);
                }, 5000); // Wait 5 seconds after kicking before proceeding
            }, 5000); // Wait 5 seconds after GIF/message
        } catch (err) {
            console.error("❌ Failed to send elimination GIF or kick message:", err.message);
            handleNextFlagRoundOrFinish(groupChatId, survivors); // Proceed even if GIF/kick fails
        }
    } else {
        const goodWorkGifPath = GOOD_WORK_GIF_PATH;
        try {
            if (fs.existsSync(goodWorkGifPath)) {
                await currentBotInstance.sendAnimation(groupChatId, fs.createReadStream(goodWorkGifPath), {
                    caption: "👏 Amazing! Nobody was eliminated this round!"
                }).catch(console.error);
            } else {
                console.warn(`GIF not found at ${goodWorkGifPath}. Skipping animation.`);
                await currentBotInstance.sendMessage(groupChatId, "👏 Amazing! Nobody was eliminated this round!", { parse_mode: "HTML" }).catch(console.error);
            }
        } catch (err) {
            console.error("❌ Failed to send good work GIF:", err.message);
        }

        setTimeout(() => {
            handleNextFlagRoundOrFinish(groupChatId, survivors);
        }, 5000); // Short delay before next round/finish
    }
}

/**
 * Determines if another round should start or if the game should finish.
 * @param {number} groupChatId - The ID of the group chat.
 * @param {Array<number>} survivors - IDs of players who survived the current round.
 */
async function handleNextFlagRoundOrFinish(groupChatId, survivors) {
    const alivePlayersCount = currentRegisteredPlayers.filter(p => p.status === "alive").length;

    // Game ends if only 1 round has passed and there are survivors, OR if no survivors left
    // For a 2-round game, if round 1 is done, proceed to round 2. If round 2 is done, finish.
    if (flagRoundNumber < 2 && alivePlayersCount > 0) { // Assuming a max of 2 rounds for now
        await currentBotInstance.sendMessage(groupChatId, "⚔️ Next round will start in 30 seconds! Get ready...", { parse_mode: "HTML" }).catch(console.error);
        flagActivePlayers = survivors; // Only survivors participate in next round

        setTimeout(() => {
            flagRoundNumber++;
            startFlagRound(groupChatId);
        }, 30 * 1000); // 30 seconds preparation for next round
    } else {
        finishFlagGame(groupChatId);
    }
}

/**
 * Finalizes and summarizes the Guess the Flag game.
 * @param {number} groupChatId - The ID of the group chat.
 */
async function finishFlagGame(groupChatId) {
    resetFlagGameState(); // Reset all game-specific state variables

    // Remove all listeners specific to this game
    if (messageListenerId) {
        currentBotInstance.removeListener('message', messageListenerId);
        messageListenerId = null;
    }
    if (stopGameListenerId) {
        currentBotInstance.removeTextListener(/\/stopgame7/, stopGameListenerId);
        stopGameListenerId = null;
    }

    // Ensure chat is unlocked
    await unlockGroupChat(groupChatId);

    // Re-read players.json to get the latest status after all eliminations/updates
    let finalPlayers;
    try {
        finalPlayers = JSON.parse(fs.readFileSync(currentPlayerDataFile, 'utf8'));
    } catch (error) {
        console.error("Error reading players.json for final summary:", error.message);
        finalPlayers = currentRegisteredPlayers; // Fallback to in-memory if file read fails
    }

    const totalParticipants = currentRegisteredPlayers.filter(p => p.initialParticipant).length; // Assuming initialParticipant flag
    const survivors = finalPlayers.filter(p => p.status === "alive");
    const eliminated = finalPlayers.filter(p => p.status === "eliminated");

    let msg = `🎉 <b>GUESS THE FLAG GAME COMPLETED!</b> 🎉\n\n`;
    msg += `👥 <b>TOTAL PARTICIPANTS:</b> ${totalParticipants}\n`;
    msg += `✅ <b>SURVIVORS:</b> ${survivors.length}\n`;
    msg += `💀 <b>ELIMINATED:</b> ${eliminated.length}\n\n`;
    msg += `✅ <b>SURVIVORS LIST:</b>\n${survivors.length > 0 ? survivors.map(u => `• ${getUsernameById(u.id)}`).join('\n') : "None"}\n\n`;
    msg += `💀 <b>ELIMINATED LIST:</b>\n${eliminated.length > 0 ? eliminated.map(u => `• ${getUsernameById(u.id)}`).join('\n') : "None"}`;

    await currentBotInstance.sendMessage(groupChatId, msg, { parse_mode: "HTML" }).catch(console.error);

    const moneyGifPath = FALLING_MONEY_GIF_PATH;
    try {
        if (fs.existsSync(moneyGifPath)) {
            await currentBotInstance.sendAnimation(groupChatId, fs.createReadStream(moneyGifPath), {
                caption: ""
            }).catch(console.error);
        } else {
            console.warn(`GIF not found at ${moneyGifPath}. Skipping animation.`);
        }
    } catch (err) {
        console.error("❌ Failed to send falling money GIF:", err.message);
    }

    await currentBotInstance.sendMessage(groupChatId, `🔓 <b>The chat is now UNLOCKED.</b>\n` +
        `⚔️ <b>Prepare yourselves for the next game soon!</b>`, { parse_mode: "HTML" }).catch(console.error);

    // Notify the game coordinator that this game has finished
    if (gameEndCallback) {
        gameEndCallback(currentRegisteredPlayers);
    }
}

/**
 * Starts the Guess the Flag game. This function is called by the game coordinator.
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
    // Assign passed parameters to module-scoped variables
    currentBotInstance = bot;
    currentChatId = chatId;
    currentRegisteredPlayers = players;
    currentAdminId = adminId;
    currentPlayerDataFile = playerDataFile;
    gameEndCallback = onGameEnd;
    eliminatedPlayerSpamMap = spamMap;
    spamThreshold = sThreshold;
    spamIntervalMs = sIntervalMs;

    console.log("Starting Guess the Flag Game (Game 7)...");

    // Reset game state for a new game
    resetFlagGameState();

    // Filter for truly alive players who can participate
    flagActivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive").map(p => p.id);

    if (flagActivePlayers.length === 0) {
        await currentBotInstance.sendMessage(currentChatId, "😵 NO PLAYERS\n\nNo survivors available to play Guess the Flag. Skipping round.", { parse_mode: "HTML" }).catch(console.error);
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
        return;
    }

    flagGameActive = true; // Mark game as active for initial DM interaction

    // Lock the group chat
    await lockGroupChat(currentChatId);

    const botInfo = await currentBotInstance.getMe();
    const botUsername = botInfo.username;

    // Send initial instructions with photo
    try {
        const instructions =
            "🏳️‍🌈 <b>GUESS THE FLAG GAME!</b>\n\n" +
            "This is a test of your world knowledge and speed!\n\n" +
            "🌍 You will see a <b>flag</b> HERE in this group chat.\n\n" +
            "✉️ <b>Send your guess PRIVATELY to me (click on @${botUsername}).</b>\n" +
            "⚠️ <b>Important:</b> You only have <b>ONE TRY</b>! Typo = OUT!\n\n" +
            "⏰ <b>You will have 30 seconds to answer each round after I show the flag.</b>\n\n" +
            "💡 <i>Be quick, be sharp — only the best will survive!</i>\n\n" +
            "🔒 <b>IMPORTANT:</b> The group chat is now LOCKED. You cannot send messages here until Game 7 ends!\n\n" +
            "⚔️ <b>Get ready!</b> The first round will start in 30 seconds...";
            // Removed: "👉 *Players: Click @${botUsername} NOW and type /start in our private chat to prepare!*";

        if (fs.existsSync(FLAG_INTRO_IMAGE_PATH)) {
            await currentBotInstance.sendPhoto(currentChatId, fs.createReadStream(FLAG_INTRO_IMAGE_PATH), {
                caption: instructions,
                parse_mode: "HTML"
            }).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(currentChatId, instructions, { parse_mode: "HTML" }).catch(console.error);
            console.warn(`Image not found at ${FLAG_INTRO_IMAGE_PATH}. Sending text instructions only.`);
        }
    } catch (error) {
        console.error("Error sending game 7 instructions photo:", error.message);
        await currentBotInstance.sendMessage(currentChatId, "💥 MEDIA ERROR\n\nCouldn't load game image.", { parse_mode: "HTML" }).catch(console.error);
    }

    // --- Register Bot Message Handler for DMs (only for private chats) ---
    // This listener handles game answers. Initial DM interaction is assumed from registration.
    messageListenerId = currentBotInstance.on("message", async (msg) => {
        const userId = msg.from.id;
        const text = msg.text ? msg.text.trim() : '';

        // Only handle DMs (private chats)
        if (msg.chat.type !== "private") return;

        // Only process answers if the game is active for guessing AND the player is in flagActivePlayers
        if (!flagGameActive || !flagActivePlayers.includes(userId)) {
            // If game is active but player not in flagActivePlayers, they are eliminated or not part of this round
            const p = currentRegisteredPlayers.find(p => p.id === userId);
            if (p && p.status === 'eliminated') {
                await currentBotInstance.sendMessage(userId, `🚫 NOT IN GAME\n\nYou are eliminated and cannot submit answers.`, { parse_mode: "HTML" }).catch(console.error);
            } else {
                await currentBotInstance.sendMessage(userId, `🚫 NOT IN GAME\n\nThis game is not active for you, or you are not a participant.`, { parse_mode: "HTML" }).catch(console.error);
            }
            return;
        }

        // If player has already answered this round, inform them and ignore
        if (flagPrivateAnswers[userId]) {
            await currentBotInstance.sendMessage(userId, `⚠️ You have already submitted your answer for this round: "${flagPrivateAnswers[userId].answer}". Please wait for the results.`, { parse_mode: "HTML" }).catch(console.error);
            return;
        }

        // Valid answer submission
        flagPrivateAnswers[userId] = {
            answer: text.toUpperCase(),
            timestamp: Date.now(),
        };
        await currentBotInstance.sendMessage(userId, `✅ Thanks! You answered: "${text}". Please wait for the results at the game room.`).catch(console.error);
    });


    // Proceed directly to the first flag round after the initial 30-second intro delay
    setTimeout(async () => {
        if (!flagGameActive) { // Check if game was stopped during the intro delay
            console.log("Guess the Flag game was stopped during intro. Aborting round start.");
            return;
        }

        // Ensure flagActivePlayers is correctly set based on current alive players
        flagActivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive").map(p => p.id);

        if (flagActivePlayers.length === 0) {
            await currentBotInstance.sendMessage(currentChatId, "😵 NO PLAYERS\n\nNo survivors available to play Guess the Flag. Ending game.", { parse_mode: "HTML" }).catch(console.error);
            finishFlagGame(currentChatId);
            return;
        }

        flagRoundNumber = 1;
        startFlagRound(currentChatId);

    }, 30 * 1000); // 30 seconds intro delay before first round


    // --- Register Stop Game Command Listener (Admin only, specific to this game) ---
    stopGameListenerId = currentBotInstance.onText(/\/stopgame7/, async (msg) => {
        if (msg.chat.id !== currentChatId) return; // Only respond in the active game chat
        if (msg.from.id !== currentAdminId) {
            return currentBotInstance.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" }).catch(console.error);
        }
        if (!flagGameActive && flagRoundNumber === 0) { // If game hasn't even started a round yet
            return currentBotInstance.sendMessage(msg.chat.id, "⚠️ Guess the Flag game is not running.", { parse_mode: "HTML" }).catch(console.error);
        }

        console.log("Guess the Flag game manually stopped.");

        // Clear any pending timers
        if (flagRoundTimeout) clearTimeout(flagRoundTimeout);
        // Removed: if (dmInteractionGracePeriodTimer) clearTimeout(dmInteractionGracePeriodTimer);

        // Reset game state and clean up listeners
        resetFlagGameState();

        if (messageListenerId) {
            currentBotInstance.removeListener('message', messageListenerId);
            messageListenerId = null;
        }
        if (stopGameListenerId) {
            currentBotInstance.removeTextListener(/\/stopgame7/, stopGameListenerId);
            stopGameListenerId = null;
        }

        await unlockGroupChat(currentChatId); // Ensure chat is unlocked
        await currentBotInstance.sendMessage(currentChatId, `🛑 Guess the Flag game has been forcefully stopped!`, { parse_mode: "HTML" }).catch(console.error);

        // Notify the game coordinator that this game has finished
        if (gameEndCallback) {
            gameEndCallback(currentRegisteredPlayers);
        }
    });

    console.log("Guess the Flag game initialized and listeners set.");
}

module.exports = {
    startGame
};
