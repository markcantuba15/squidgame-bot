// games/skill/guessTheNumber.js - Skill Game: Guess the Number
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

// Game-specific state variables for Guess the Number
let game9Active = false;
let game9Data = {}; // { userId: { number, guessesLeft, timeout } }
let game9Participants = []; // To keep track of all players participating for the summary
let gameEndProcessed = false; // Prevent multiple game end processing

// Telegram listener IDs to manage their lifecycle
let messageListenerId = null;
let stopGameListenerId = null;

// --- Game Assets Paths (relative to the project root) ---
const GAME9_INSTRUCTIONS_PHOTO_PATH = path.resolve(__dirname, "..", "..", "images", "guess_number.jpg");
const FALLING_MONEY_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "falling-money-squid-game.gif");
const GOOD_WORK_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "goodwork.gif");

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
 * Marks a player's status as "alive" (or "safe" in this game's context) in the global player list.
 * @param {number} userId - The ID of the user to mark safe.
 */
async function markPlayerSafe(userId) {
    const p = currentRegisteredPlayers.find(p => p.id === userId);
    if (p) {
        p.status = "alive"; // Or "safe" if you want a distinct status for this game
        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
    }
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
 * Updates the status of a participant within the game9Participants list.
 * @param {number} userId - The ID of the participant.
 * @param {string} status - The new status ('playing', 'safe', 'eliminated').
 */
function updateParticipantStatus(userId, status) {
    const participant = game9Participants.find(p => p.id === userId);
    if (participant) {
        participant.status = status;
    }
}

/**
 * Handles spam attempts from eliminated players.
 * Deletes message if spamming threshold is met.
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
 * Consolidated function to handle player elimination.
 * @param {number} userId - The ID of the player to eliminate.
 * @param {string} messageToPlayer - The message to send to the eliminated player.
 * @param {boolean} shouldKick - Whether the player should be kicked from the group.
 */
async function handlePlayerElimination(userId, messageToPlayer, shouldKick = true) {
    // Clear timeout first
    if (game9Data[userId]?.timeout) {
        clearTimeout(game9Data[userId].timeout);
    }

    // Update statuses
    await eliminatePlayer(userId);
    updateParticipantStatus(userId, 'eliminated');
    delete game9Data[userId]; // Remove from active game data immediately

    // Send elimination message to player
    try {
        await currentBotInstance.sendMessage(userId, `🚨 ELIMINATED 🚨\n\n${messageToPlayer}\n\n💀 Game over.`, { parse_mode: "HTML" });
    } catch (error) {
        console.error(`Failed to send elimination message to ${userId}:`, error.message);
    }

    // Send group notification
    const username = getUsernameById(userId);
    try {
        await currentBotInstance.sendMessage(currentChatId, `💥 ${username} ELIMINATED! 💥\n\n⚰️ Another one falls...`, { parse_mode: "HTML" });
    } catch (error) {
        console.error(`Failed to send group elimination message:`, error.message);
    }

    // Handle kicking with delay if requested
    if (shouldKick) {
        setTimeout(async () => {
            try {
                await currentBotInstance.banChatMember(currentChatId, userId);
                console.log(`Successfully banned ${username} (ID: ${userId}) from the group.`);
            } catch (error) {
                console.error(`Failed to ban user ${username} (ID: ${userId}):`, error.message);
                try {
                    await currentBotInstance.sendMessage(currentChatId, `⚠️ SYSTEM ERROR\n\nCould not remove ${username}.\nBot lacks permissions.`, { parse_mode: "HTML" });
                } catch (msgError) {
                    console.error("Failed to send ban failure message:", msgError.message);
                }
            }
        }, 3000);
    }

    // Check game end immediately after processing elimination
    setTimeout(() => checkGameEnd(), 1000);
}

/**
 * Checks if the game has ended (all players have finished or been eliminated).
 * If so, it processes the game results and notifies the game coordinator.
 */
async function checkGameEnd() {
    // Prevent multiple simultaneous game end processing
    if (gameEndProcessed || !game9Active) {
        return;
    }

    const allPlayersProcessed = game9Participants.every(p => p.status === 'safe' || p.status === 'eliminated');
    const noPlayersLeftToGuess = Object.keys(game9Data).length === 0;

    if (allPlayersProcessed && noPlayersLeftToGuess) {
        gameEndProcessed = true; // Set flag immediately
        game9Active = false;

        // Clean up listeners for this game
        if (messageListenerId) {
            currentBotInstance.removeListener('message', messageListenerId);
            messageListenerId = null;
        }
        if (stopGameListenerId) {
            currentBotInstance.removeTextListener(/\/stopgame9/, stopGameListenerId);
            stopGameListenerId = null;
        }

        const survivedPlayers = game9Participants.filter(p => p.status === 'safe');
        const eliminatedPlayers = game9Participants.filter(p => p.status === 'eliminated');

        // Build enhanced summary message
        let summaryMessage = "🎯 GAME 9 RESULTS 🎯\n\n📊 GUESS THE NUMBER";

        if (survivedPlayers.length > 0) {
            summaryMessage += `\n\n🏆 SURVIVORS (${survivedPlayers.length})`;
            survivedPlayers.forEach(p => summaryMessage += `\n   ✅ ${getUsernameById(p.id)}`);
        } else {
            summaryMessage += `\n\n💀 TOTAL ELIMINATION\n😱 Nobody survived!`;
        }

        if (eliminatedPlayers.length > 0) {
            summaryMessage += `\n\n☠️ ELIMINATED (${eliminatedPlayers.length})`;
            eliminatedPlayers.forEach(p => summaryMessage += `\n   ❌ ${getUsernameById(p.id)}`);
        }

        summaryMessage += eliminatedPlayers.length === 0 ?
            `\n\n🎊 PERFECT ROUND!` :
            `\n\n⚰️ Numbers claimed victims...`;

        // Send summary
        try {
            await currentBotInstance.sendMessage(currentChatId, summaryMessage, { parse_mode: "HTML" });
        } catch (error) {
            console.error("Error sending game summary:", error.message);
        }

        // Send appropriate GIF based on outcome
        const gifToSend = eliminatedPlayers.length === 0 ? GOOD_WORK_GIF_PATH : FALLING_MONEY_GIF_PATH;
        const gifName = eliminatedPlayers.length === 0 ? "Good Work" : "Falling Money";

        try {
            if (fs.existsSync(gifToSend)) {
                await currentBotInstance.sendAnimation(currentChatId, fs.createReadStream(gifToSend), { caption: "" });
            } else {
                console.warn(`GIF not found at ${gifToSend}. Skipping animation.`);
            }
        } catch (error) {
            console.error(`Error sending ${gifName} GIF:`, error.message);
            try {
                await currentBotInstance.sendMessage(currentChatId, `❌ MEDIA ERROR\n\nFailed to load animation.\nCheck file permissions.`, { parse_mode: "HTML" });
            } catch (msgError) {
                console.error("Failed to send GIF error message:", msgError.message);
            }
        }

        // Send final game end notification after GIF
        setTimeout(async () => {
            try {
                await currentBotInstance.sendMessage(currentChatId, `🏁 GAME 9 ENDED 🏁\n\n🎲 Challenge complete!\n⏳ Next game coming soon...\n\n🔥 Stay ready.`, { parse_mode: "HTML" });
            } catch (error) {
                console.error("Error sending game end notification:", error.message);
            }
        }, 2000); // 2 second delay after GIF

        // Clear game data for next potential run
        game9Data = {};
        game9Participants = [];
        gameEndProcessed = false; // Reset flag for next game

        // Notify the game coordinator that this game has finished
        if (gameEndCallback) {
            gameEndCallback(currentRegisteredPlayers);
        }
    }
}

/**
 * Starts the Guess the Number game. This function is called by the game coordinator.
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

    console.log("Starting Guess the Number Game (Game 9)...");

    // Reset game state for a new game
    game9Active = false; // Will be set to true after initial instructions
    game9Data = {};
    game9Participants = [];
    gameEndProcessed = false;

    // Filter for truly alive players who can participate
    let alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");

    if (alivePlayers.length === 0) {
        await currentBotInstance.sendMessage(currentChatId, "😵 NO PLAYERS\n\nNo survivors available to play Guess the Number. Skipping round.", { parse_mode: "HTML" });
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
        return;
    }

    game9Active = true; // Mark game as active now
    game9Participants = alivePlayers.map(p => ({ id: p.id, username: getUsernameById(p.id), status: 'playing' }));


    // Send initial instructions with photo
    try {
        if (fs.existsSync(GAME9_INSTRUCTIONS_PHOTO_PATH)) {
            await currentBotInstance.sendPhoto(currentChatId, fs.createReadStream(GAME9_INSTRUCTIONS_PHOTO_PATH), {
                caption: `🎯 GAME 9: GUESS THE NUMBER 🎯

🎲 THE CHALLENGE
Guess my secret number (1-100)
You have 7 attempts!

🎮 HOW TO PLAY
• Wait 1 minute for my DM
• Open private chat with me
• Send guesses there only!
• I'll say "higher" or "lower"

⏰ TIME LIMIT: 100 seconds
🎯 SURVIVE: Guess correctly or die!

💀 Think fast. Guess smart.`,
                parse_mode: "HTML"
            });
        } else {
            await currentBotInstance.sendMessage(currentChatId, `🎯 GAME 9: GUESS THE NUMBER 🎯

🎲 THE CHALLENGE
Guess my secret number (1-100)
You have 7 attempts!

🎮 HOW TO PLAY
• Wait 1 minute for my DM
• Open private chat with me
• Send guesses there only!
• I'll say "higher" or "lower"

⏰ TIME LIMIT: 100 seconds
🎯 SURVIVE: Guess correctly or die!

💀 Think fast. Guess smart.`, { parse_mode: "HTML" });
            console.warn(`Image not found at ${GAME9_INSTRUCTIONS_PHOTO_PATH}. Sending text instructions only.`);
        }

    } catch (error) {
        console.error("Error sending game 9 instructions photo:", error.message);
        await currentBotInstance.sendMessage(currentChatId, "💥 MEDIA ERROR\n\nCouldn't load game image.", { parse_mode: "HTML" });
    }

    // Set timeout for DMs
    setTimeout(async () => {
        if (!game9Active) { // Check if game was stopped during the 1-min prep
            console.log("Game 9 was stopped during prep time. Aborting DM phase.");
            return;
        }

        try {
            const botInfo = await currentBotInstance.getMe();
            const botUsername = botInfo.username;

            // Send DMs to all eligible players
            const dmPromises = alivePlayers.map(async (player) => {
                const participantStillActive = game9Participants.find(p => p.id === player.id && p.status === 'playing');
                if (!participantStillActive) {
                    return; // Player might have been eliminated by admin during prep time
                }

                const targetNumber = Math.floor(Math.random() * 100) + 1;
                game9Data[player.id] = {
                    number: targetNumber,
                    guessesLeft: 7,
                    timeout: setTimeout(() => {
                        handlePlayerElimination(player.id, `⏰ TIME'S UP!\n\nThe secret number was ${targetNumber}.\nYou failed to guess within the time limit.`);
                    }, 100 * 1000) // 100 seconds
                };

                try {
                    await currentBotInstance.sendMessage(player.id,
                        `🎯 GAME 9 STARTS NOW!

🎲 MISSION
Guess my number (1-100)

📊 YOU HAVE:
• 7 guesses max
• 100 seconds total
• Higher/Lower hints

⚡ RULES
• Only numbers 1-100
• Time starts NOW!

🚨 SEND FIRST GUESS!

💀 Your life depends on it!`,
                        { parse_mode: "HTML" }
                    );
                } catch (dmError) {
                    console.error(`Failed to send DM to ${getUsernameById(player.id)} (ID: ${player.id}):`, dmError.message);
                    // Eliminate player if DM fails (no kick since they can't play)
                    await handlePlayerElimination(player.id, `📱 CONNECTION FAILED\n\nCouldn't send game instructions.\nCan't play without them.`, false);
                    await currentBotInstance.sendMessage(currentChatId, `📱 CONNECTION ISSUE\n\n⚠️ Couldn't reach ${getUsernameById(player.id)}\n\nThey need to message me first.`, { parse_mode: "HTML" });
                }
            });

            // Wait for all DMs to be processed
            await Promise.allSettled(dmPromises);

            // Send group announcement after all DMs
            await currentBotInstance.sendMessage(currentChatId, `🚨 GAME 9 LIVE! 🚨

📱 CHECK YOUR DMs NOW!

Click @${botUsername} to play!

⏰ Time is ticking!`, { parse_mode: "HTML" });

        } catch (error) {
            console.error("Error during DM phase:", error.message);
        }
    }, 1 * 60 * 1000); // 1 minute delay before sending DMs

    // --- Register Bot Message Handler for DMs (only for private chats) ---
    // Store the listener ID to remove it later
    messageListenerId = currentBotInstance.on("message", async (msg) => {
        const userId = msg.from.id;
        const text = msg.text;

        // Only handle DMs (private chats) for this game's logic
        if (msg.chat.type !== "private") return;

        // Only process if Game 9 is active and user is participating
        if (!game9Active || !game9Data[userId]) {
            if (game9Active && !game9Data[userId]) {
                // If game is active but player not in game9Data, they were eliminated or not started
                await currentBotInstance.sendMessage(userId, `🚫 NOT IN GAME

You're not playing Game 9.

Reasons:
• Game started without you
• Already eliminated
• Technical error

Wait for next game.`, { parse_mode: "HTML" });
            }
            return; // Ignore messages from non-participants or if game is not active
        }

        const data = game9Data[userId];
        const guess = parseInt(text);

        if (isNaN(guess) || guess < 1 || guess > 100) {
            return currentBotInstance.sendMessage(userId, `❌ INVALID GUESS

Send number 1-100 only.

Guesses left: ${data.guessesLeft}
Example: 42`, { parse_mode: "HTML" });
        }

        data.guessesLeft--;

        if (guess === data.number) {
            // Player won - handle success
            clearTimeout(data.timeout);
            await markPlayerSafe(userId);
            updateParticipantStatus(userId, 'safe');
            delete game9Data[userId]; // Remove immediately

            const username = getUsernameById(userId);

            // Send messages
            try {
                await currentBotInstance.sendMessage(userId, `🎉 WINNER! 🎉

✅ CORRECT! Number was ${data.number}

🛡️ YOU'RE SAFE!

You survive to the next round!

🏆 Well played!`, { parse_mode: "HTML" });

                await currentBotInstance.sendMessage(currentChatId, `🎉 SURVIVOR! 🎉

🏆 ${username} guessed correctly!


🎯 Smart thinking!`, { parse_mode: "HTML" });
            } catch (error) {
                console.error("Error sending success messages:", error.message);
            }

            setTimeout(() => checkGameEnd(), 1000);

        } else if (data.guessesLeft === 0) {
            // Out of guesses - eliminate
            clearTimeout(data.timeout);
            await handlePlayerElimination(userId, `🎯 OUT OF GUESSES!\n\nAnswer was ${data.number}.\nYour guess: ${guess}`);

        } else {
            // Continue guessing with highlighted hints
            let hintMessage;
            if (guess < data.number) {
                hintMessage = `🔼 HIGHER! �`;
            } else {
                hintMessage = `🔽  LOWER! 🔽`;
            }

            const urgency = data.guessesLeft <= 2 ? "🚨 DANGER! 🚨" : "";
            const encouragement = data.guessesLeft <= 2 ?
                '⚠️ Last chances! Choose wisely!' :
                '💡 Keep going!';

            return currentBotInstance.sendMessage(userId, `${urgency}

${hintMessage}

🎯 Guesses left: ${data.guessesLeft}

${encouragement}

🚨 NEXT GUESS NOW! 🚨`, { parse_mode: "HTML" });
        }
    });

    // --- Register Stop Game Command Listener (Admin only, specific to this game) ---
    // Store the listener ID to remove it later
    stopGameListenerId = currentBotInstance.onText(/\/stopgame9/, async (msg) => {
        if (msg.chat.id !== currentChatId) return; // Only respond in the active game chat
        if (msg.from.id !== currentAdminId) {
            return currentBotInstance.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" });
        }
        if (!game9Active) {
            return currentBotInstance.sendMessage(msg.chat.id, "⚠️ NO GAME\n\nGame 9 not running.", { parse_mode: "HTML" });
        }

        // Clear all player-specific timeouts
        for (const userId in game9Data) {
            if (game9Data[userId].timeout) {
                clearTimeout(game9Data[userId].timeout);
            }
        }

        // Reset game state
        game9Active = false;
        game9Data = {};
        game9Participants = [];
        gameEndProcessed = false;

        // Clean up listeners for this game
        if (messageListenerId) {
            currentBotInstance.removeListener('message', messageListenerId);
            messageListenerId = null;
        }
        if (stopGameListenerId) {
            currentBotInstance.removeTextListener(/\/stopgame9/, stopGameListenerId);
            stopGameListenerId = null;
        }

        await currentBotInstance.sendMessage(currentChatId, `🛑 GAME STOPPED 🛑\n\n🎯 Game 9 manually ended.\n\n📊 All challenges cancelled.\n\n⏸️ Game over.`, { parse_mode: "HTML" });

        console.log("Game 9 manually stopped.");

        // Notify the game coordinator that this game has finished
        if (gameEndCallback) {
            gameEndCallback(currentRegisteredPlayers);
        }
    });

    console.log("Guess the Number game initialized and listeners set.");
}

module.exports = {
    startGame
};
