// games/skill/shapeGuessing.js - Skill Game: Shape Guessing Game
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

// Game-specific state variables for Shape Guessing Game
let game2Started = false;
let correctShapes = []; // Stores the 2 correct shapes for this round
let game2Timeout = null;
let allowGuessing = false; // Block guessing at start

// In-memory cooldowns to prevent command spam from individual users
// Key: userId, Value: timestamp of the last allowed action
const userActionCooldowns = new Map();
const COOLDOWN_MS2 = 1000; // 1 second cooldown for general command/button spam

// Telegram listener IDs to manage their lifecycle
let circleListenerId = null;
let triangleListenerId = null;
let squareListenerId = null;
let stopGame2ListenerId = null; // For the /stopgame2 command

// --- Game Assets Paths (relative to the project root) ---
const SHAPES_IMAGE_PATH = path.resolve(__dirname, "..", "..", "images", "shapes.jpg");
const FALLING_MONEY_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "falling-money-squid-game.gif");
const GOOD_WORK_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "goodwork.gif");
const BYE_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "bye.gif"); // Assuming you have a bye.gif as in red_green.js

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
 * Helper to safely delete messages.
 * @param {number} chatId - The chat ID.
 * @param {number} messageId - The message ID to delete.
 */
async function safeDeleteMessage(chatId, messageId) {
    try {
        await currentBotInstance.deleteMessage(chatId, messageId);
    } catch (err) {
        if (err.response && err.response.description.includes("message to delete not found")) {
            // console.warn(`Message ${messageId} not found for deletion in chat ${chatId}.`);
        } else if (err.response && err.response.statusCode === 400 && err.response.description.includes("message can't be deleted")) {
            console.warn(`⚠️ Bot lacks permissions to delete message ${messageId} in chat ${chatId}. Grant 'Delete messages' permission.`);
        } else {
            console.error(`❌ Error deleting message ${messageId} in chat ${chatId}:`, err.message);
        }
    }
}

/**
 * Sends the reply keyboard for guessing.
 * @param {number} chatId - The ID of the chat.
 */
async function sendGuessButtons(chatId) {
    try {
        await currentBotInstance.sendMessage(chatId, "Pick your shape:", {
            reply_markup: {
                keyboard: [
                    [{ text: "⭕ Circle" }, { text: "🔺 Triangle" }, { text: "◼️ Square" }]
                ],
                resize_keyboard: true,
                one_time_keyboard: false // Keep it visible until removed
            }
        });
        console.log("Guessing reply keyboard sent successfully.");
    } catch (err) {
        console.error(`❌ Failed to send guessing buttons to chat ${chatId}:`, err.message);
        currentBotInstance.sendMessage(chatId, `⚠️ Error sending guessing buttons: ${err.message}`).catch(console.error);
    }
}

/**
 * Removes the reply keyboard.
 * @param {number} chatId - The ID of the chat.
 */
async function removeGuessButtons(chatId) {
    try {
        // Send a blank message to trigger keyboard removal
        await currentBotInstance.sendMessage(chatId, "Buttons removed.", {
            reply_markup: {
                remove_keyboard: true
            }
        });
        console.log("Guessing reply keyboard removed successfully.");
    } catch (e) {
        console.warn(`⚠️ Failed to remove guessing reply keyboard:`, e);
    }
}

/**
 * Handles all shape guesses from players.
 * @param {Object} msg - The Telegram message object.
 * @param {string} chosenShape - The shape chosen by the player (e.g., "circle").
 */
async function handleShapeGuess(msg, chosenShape) {
    const userId = msg.from.id;
    const player = currentRegisteredPlayers.find(p => p.id === userId);
    const chatId = msg.chat.id;
    const userMessageId = msg.message_id;

    // 1. Initial Checks & Delete user's message if invalid context
    if (chatId !== currentChatId || !game2Started) {
        safeDeleteMessage(chatId, userMessageId); // Delete user's message if game not active or wrong chat
        if (chatId === currentChatId) await currentBotInstance.sendMessage(chatId, "❌ Game 2 is not running!").catch(console.error);
        return;
    }
    if (!player || player.status !== "alive") {
        safeDeleteMessage(chatId, userMessageId); // Delete user's message if not in game or eliminated
        if (player && player.status === "eliminated") {
            // Use general spam handler for eliminated players if they try to interact
            const username = getUsernameById(userId);
            const isSpam = await handleEliminatedPlayerSpam(userId, userMessageId, username);
            if (isSpam) return;
            const botResponse = await currentBotInstance.sendMessage(chatId, `💀 ${username}, you are eliminated and cannot guess.`, { reply_to_message_id: userMessageId }).catch(console.error);
            if (botResponse) {
                setTimeout(() => safeDeleteMessage(chatId, botResponse.message_id), 7000);
            }
        } else {
            await currentBotInstance.sendMessage(chatId, "❌ You are not in the game or already eliminated!").catch(console.error);
        }
        return;
    }
    if (!allowGuessing) {
        safeDeleteMessage(chatId, userMessageId); // Delete user's message if guessing is not allowed yet
        await currentBotInstance.sendMessage(chatId, "⚠️ You cannot guess yet! Wait for the bot's final instruction before submitting your shape.").catch(console.error);
        return;
    }

    // 2. Implement Per-User Cooldown for spam prevention
    const now = Date.now();
    const lastActionTime = userActionCooldowns.get(userId) || 0;

    if (now - lastActionTime < COOLDOWN_MS2) {
        safeDeleteMessage(chatId, userMessageId);
        const tempWarnMsg = await currentBotInstance.sendMessage(chatId, "🛑 Please wait a moment before interacting again.", { reply_to_message_id: userMessageId }).catch(console.error);
        if (tempWarnMsg) setTimeout(() => safeDeleteMessage(chatId, tempWarnMsg.message_id), 3000);
        return;
    }
    userActionCooldowns.set(userId, now);

    // 3. Check if player has already made a guess
    if (player.guess !== null) {
        safeDeleteMessage(chatId, userMessageId);
        const alreadyGuessedMsg = await currentBotInstance.sendMessage(chatId, "⚠️ You already made your guess!").catch(console.error);
        if (alreadyGuessedMsg) setTimeout(() => safeDeleteMessage(chatId, alreadyGuessedMsg.message_id), 5000);
        return;
    }

    // 4. This is a valid FIRST guess
    player.guess = chosenShape;
    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    let emoji = "";
    if (chosenShape === "circle") emoji = "⭕";
    else if (chosenShape === "triangle") emoji = "🔺";
    else if (chosenShape === "square") emoji = "◼️";

    currentBotInstance.sendMessage(chatId, `✅ ${player.username} picked ${chosenShape} ${emoji}!`, { reply_to_message_id: userMessageId }).catch(console.error);
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
            await currentBotInstance.deleteMessage(currentChatId, messageId);
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
 * Ends Game 2, calculates results, removes keyboard, and kicks eliminated players.
 * @param {number} chatId - The ID of the chat where the game is running.
 */
function finishGame2(chatId) {
    if (!game2Started) return;

    game2Started = false;
    if (game2Timeout) clearTimeout(game2Timeout);
    game2Timeout = null;
    allowGuessing = false;
    userActionCooldowns.clear(); // Clear cooldowns for next game

    // Remove the reply keyboard immediately when the game finishes
    removeGuessButtons(chatId).catch(console.error);

    // Remove all listeners specific to this game
    if (circleListenerId) {
        currentBotInstance.removeTextListener(/⭕ Circle/, circleListenerId);
        circleListenerId = null;
    }
    if (triangleListenerId) {
        currentBotInstance.removeTextListener(/🔺 Triangle/, triangleListenerId);
        triangleListenerId = null;
    }
    if (squareListenerId) {
        currentBotInstance.removeTextListener(/◼️ Square/, squareListenerId);
        squareListenerId = null;
    }
    if (stopGame2ListenerId) {
        currentBotInstance.removeTextListener(/\/stopgame2/, stopGame2ListenerId);
        stopGame2ListenerId = null;
    }

    const survivors = [];
    const eliminated = [];
    const guesses = [];
    const eliminatedPlayersToKick = []; // Separate list for players to kick

    currentRegisteredPlayers.forEach(p => {
        if (p.status === "alive") { // Only process players who were alive at the start of this game
            guesses.push(`${getUsernameById(p.id)}: ${p.guess !== null ? p.guess : "❌ No guess"}`);

            if (p.guess !== null && correctShapes.includes(p.guess)) {
                // Player survives this round, status remains "alive"
                survivors.push(getUsernameById(p.id));
            } else {
                p.status = "eliminated"; // Mark as eliminated
                eliminated.push(getUsernameById(p.id));
                eliminatedPlayersToKick.push(p); // Add to kick list
            }
            p.guess = null; // Reset guess for next game
        }
    });

    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    const totalParticipants = currentRegisteredPlayers.filter(p => p.status !== "pending").length; // Use currentRegisteredPlayers

    let resultMsg = `🏁✨ <b>Game 2 has ended!</b> ✨🏁\n\n`;
    resultMsg += `👥 Total Participants: <b>${totalParticipants}</b>\n`;
    resultMsg += `✅ Survivors: <b>${survivors.length}</b>\n`;
    resultMsg += `💀 Eliminated: <b>${eliminated.length}</b>\n\n`;
    resultMsg += `🎯 Correct shapes: <b>${correctShapes.join(", ")}</b>\n\n`;
    resultMsg += `🎲 <b>Player guesses:</b>\n${guesses.join('\n')}\n\n`;
    resultMsg += `✅ Survivors:\n${survivors.join('\n') || "None"}\n\n`;
    resultMsg += `💀 Eliminated:\n${eliminated.join('\n') || "None"}`;

    currentBotInstance.sendMessage(chatId, resultMsg, { parse_mode: "HTML" })
        .then(() => {
            if (eliminated.length === 0) {
                return currentBotInstance.sendMessage(chatId, "🎉 No one was eliminated this round! Well done! 🙌");
            } else {
                const eliminationGifPath = BYE_GIF_PATH; // Use the BYE_GIF_PATH
                if (fs.existsSync(eliminationGifPath)) {
                    return currentBotInstance.sendAnimation(chatId, fs.createReadStream(eliminationGifPath))
                        .then(() => currentBotInstance.sendMessage(chatId, "⚠️ 💀 Eliminated players will be kicked in 10 seconds! Prepare to say goodbye..."));
                } else {
                    console.warn(`GIF not found at ${eliminationGifPath}. Skipping animation.`);
                    return currentBotInstance.sendMessage(chatId, "⚠️ 💀 Eliminated players will be kicked in 10 seconds! Prepare to say goodbye...").catch(console.error);
                }
            }
        })
        .then(() => {
            if (eliminated.length === 0) {
                let afterMsg = `🏁✅ <b>All players survived!</b>\n\n`;
                afterMsg += `👥 Remaining Survivors: <b>${survivors.length}</b>\n`;
                afterMsg += `💀 Total Eliminated: <b>0</b>`;

                currentBotInstance.sendMessage(chatId, afterMsg, { parse_mode: "HTML" })
                    .then(() => {
                        const congratsGifPath = GOOD_WORK_GIF_PATH;
                        if (fs.existsSync(congratsGifPath)) {
                            currentBotInstance.sendAnimation(chatId, fs.createReadStream(congratsGifPath))
                                .then(() => {
                                    console.log("✅ Congratulations GIF sent!");
                                    if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
                                })
                                .catch((err) => {
                                    console.error("❌ Failed to send congratulations GIF:", err);
                                    if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
                                });
                        } else {
                            console.warn(`GIF not found at ${congratsGifPath}. Skipping animation.`);
                            if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
                        }
                    })
                    .catch(console.error);
            } else {
                return new Promise(resolve => setTimeout(resolve, 10 * 1000))
                    .then(async () => {
                        const kickPromises = eliminatedPlayersToKick.map(p =>
                            currentBotInstance.banChatMember(chatId, p.id)
                                .then(() => {
                                    console.log(`✅ Kicked (banned) ${getUsernameById(p.id)}`);
                                })
                                .catch((err) => {
                                    console.error(`❌ Failed to kick (ban) ${getUsernameById(p.id)}:`, err.message);
                                    // Optionally, send a public message if a kick fails for a known player
                                    currentBotInstance.sendMessage(chatId, `⚠️ Failed to kick ${getUsernameById(p.id)}. Bot might lack admin permissions.`).catch(console.error);
                                })
                        );
                        await Promise.allSettled(kickPromises); // Wait for all kick attempts to finish

                        let afterKickMsg = `🏁✅ <b>Eliminations completed!</b>\n\n`;
                        afterKickMsg += `👥 Remaining Survivors: <b>${survivors.length}</b>\n`;
                        afterKickMsg += `💀 Total Eliminated: <b>${eliminated.length}</b>`;

                        currentBotInstance.sendMessage(chatId, afterKickMsg, { parse_mode: "HTML" })
                            .then(() => {
                                const celebrationGifPath = FALLING_MONEY_GIF_PATH;
                                if (fs.existsSync(celebrationGifPath)) {
                                    currentBotInstance.sendAnimation(chatId, fs.createReadStream(celebrationGifPath))
                                        .then(() => {
                                            console.log("✅ Celebration GIF sent after Game 2!");
                                            if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
                                        })
                                        .catch((err) => {
                                            console.error("❌ Failed to send celebration GIF:", err);
                                            if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
                                        });
                                } else {
                                    console.warn(`GIF not found at ${celebrationGifPath}. Skipping animation.`);
                                    if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
                                }
                            })
                            .catch(console.error);
                    });
            }
        })
        .catch((err) => {
            console.error("❌ Error in finishGame2 flow:", err);
            if (gameEndCallback) gameEndCallback(currentRegisteredPlayers); // Ensure callback is called even on error
        });
}

/**
 * Starts the Shape Guessing Game. This function is called by the game coordinator.
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

    console.log("Starting Shape Guessing Game (Game 2)...");

    // Reset game state for a new game instance
    game2Started = false;
    correctShapes = [];
    if (game2Timeout) clearTimeout(game2Timeout);
    game2Timeout = null;
    allowGuessing = false;
    userActionCooldowns.clear(); // Clear cooldowns for a fresh start

    // Filter for truly alive players who can participate
    const alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");

    if (alivePlayers.length === 0) {
        await currentBotInstance.sendMessage(currentChatId, "😵 NO PLAYERS\n\nNo survivors available to play Shape Guessing. Skipping round.", { parse_mode: "HTML" }).catch(console.error);
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
        return;
    }

    // Reset player-specific game data for this game
    currentRegisteredPlayers.forEach(p => {
        if (p.status === "alive") {
            p.guess = null; // Reset previous game's guess
        }
    });
    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    const shapes = ["circle", "triangle", "square"];
    correctShapes = shapes.sort(() => 0.5 - Math.random()).slice(0, 2); // Randomly select 2 correct shapes

    game2Started = true; // Mark game as active

    const instructions = `
🎮 *Game 2: Shape Guessing Game!*

- 👁 You will see *3 shapes*: circle, triangle, square.
- ✅ Only *2 shapes* are correct. You must pick one correct shape to survive.
- ⏰ You have *1 minute* to look carefully and think.

⚠️ Wait for the game to start completely and *wait for the buttons* to appear!
⚠️ Choose wisely! Only correct guesses survive.

Good luck! 💥
`;

    // Send initial instructions with photo
    try {
        if (fs.existsSync(SHAPES_IMAGE_PATH)) {
            await currentBotInstance.sendPhoto(currentChatId, fs.createReadStream(SHAPES_IMAGE_PATH), {
                caption: instructions,
                parse_mode: "Markdown"
            }).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(currentChatId, instructions, { parse_mode: "Markdown" }).catch(console.error);
            console.warn(`Image not found at ${SHAPES_IMAGE_PATH}. Sending text instructions only.`);
        }
    } catch (error) {
        console.error("Error sending game 2 instructions photo:", error.message);
        await currentBotInstance.sendMessage(currentChatId, "💥 MEDIA ERROR\n\nCouldn't load game image.", { parse_mode: "HTML" }).catch(console.error);
    }

    // First 1-minute timer: think phase
    game2Timeout = setTimeout(async () => {
        if (!game2Started) return; // Check if game was stopped during prep time

        const guessInstruction = `
⏰ *Time's up for thinking!*

Now it's time to submit your guess!
� *Use the buttons below* to pick your shape!

⏰ You have *1 minute* to submit your guess!

⚠️ If you don't guess within this time, you will be eliminated!
        `;
        await currentBotInstance.sendMessage(currentChatId, guessInstruction, { parse_mode: "Markdown" }).catch(console.error);

        allowGuessing = true; // Now allow guesses
        await sendGuessButtons(currentChatId).catch(console.error); // Send the reply keyboard here

        // Second 1-minute timer: guess phase
        game2Timeout = setTimeout(() => {
            finishGame2(currentChatId);
        }, 1 * 60 * 1000); // 1 minute for guessing

    }, 1 * 60 * 1000); // 1 minute preparation time

    // --- Register Bot.onText handlers for Reply Keyboard buttons ---
    // Store the listener IDs to remove them later
    circleListenerId = currentBotInstance.onText(/⭕ Circle/, async (msg) => {
        handleShapeGuess(msg, "circle");
    });
    triangleListenerId = currentBotInstance.onText(/🔺 Triangle/, async (msg) => {
        handleShapeGuess(msg, "triangle");
    });
    squareListenerId = currentBotInstance.onText(/◼️ Square/, async (msg) => {
        handleShapeGuess(msg, "square");
    });

    // Register admin stop command for this specific game
    stopGame2ListenerId = currentBotInstance.onText(/\/stopgame2/, async (msg) => {
        if (msg.chat.id !== currentChatId) return; // Only respond in the active game chat
        if (msg.from.id !== currentAdminId) {
            return currentBotInstance.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" }).catch(console.error);
        }
        if (!game2Started) {
            return currentBotInstance.sendMessage(msg.chat.id, "⚠️ NO GAME\n\nGame 2 not running.", { parse_mode: "HTML" }).catch(console.error);
        }

        console.log("Game 2 manually stopped.");
        finishGame2(currentChatId); // End the game
    });

    console.log("Shape Guessing game initialized and listeners set.");
}

module.exports = {
    startGame
};
