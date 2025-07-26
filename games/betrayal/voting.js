// games/betrayal/votingGame.js - Betrayal Game: Voting to Eliminate (Game 5)
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
let isQuizRunning = null; // Function to check if quiz is running from game coordinator

// Game-specific state variables for Voting Game
let game5Started = false;
let game5Votes = {}; // { voterId: targetId }
let game5VoteTimeout = null;
let game5VotingOpen = false; // Control if votes are accepted

// Telegram listener IDs to manage their lifecycle
let voteCommandListenerId = null;
let stopGame5ListenerId = null;

// --- Game Assets Paths (relative to the project root) ---
const VOTING_IMAGE_PATH = path.resolve(__dirname, "..", "..", "images", "voting.jpg");
const FINAL_BYE_IMAGE_PATH = path.resolve(__dirname, "..", "..", "images", "final-bye.jpg");
const FALLING_MONEY_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "falling-money-squid-game.gif");

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
 * Resets all game 5 state variables to their initial values.
 */
function resetGame5State() {
    game5Started = false;
    game5Votes = {};
    if (game5VoteTimeout) clearTimeout(game5VoteTimeout);
    game5VoteTimeout = null;
    game5VotingOpen = false;
}

/**
 * Handles a player's vote.
 * @param {Object} msg - The Telegram message object.
 * @param {Array<string>} match - Regex match array.
 */
async function handleVoteCommand(msg, match) {
    if (!game5Started) return currentBotInstance.sendMessage(msg.chat.id, "❌ Game 5 is not running!").catch(console.error);
    if (!game5VotingOpen) return currentBotInstance.sendMessage(msg.chat.id, "⚠️ Voting has not started yet or is already closed!").catch(console.error);

    const voterId = msg.from.id;
    const voter = currentRegisteredPlayers.find(p => p.id === voterId);
    if (!voter || voter.status !== "alive") {
        const username = getUsernameById(voterId);
        const isSpam = await handleEliminatedPlayerSpam(voterId, msg.message_id, username);
        if (isSpam) return;
        return currentBotInstance.sendMessage(msg.chat.id, "❌ You are not in the game or already eliminated!").catch(console.error);
    }

    const targetUsernameInput = match[1].trim();
    // Normalize target username input: remove '@' and convert to lowercase
    const cleanTargetUsernameInput = targetUsernameInput.startsWith('@') ? targetUsernameInput.substring(1).toLowerCase() : targetUsernameInput.toLowerCase();

    const target = currentRegisteredPlayers.find(p => {
        // Normalize stored username/first_name for comparison
        const pUsernameLower = p.username ? (p.username.startsWith('@') ? p.username.substring(1).toLowerCase() : p.username.toLowerCase()) : null;
        const pFirstNameLower = p.first_name ? p.first_name.toLowerCase() : null;

        return (pUsernameLower === cleanTargetUsernameInput) || (pFirstNameLower === cleanTargetUsernameInput);
    });

    if (!target) return currentBotInstance.sendMessage(msg.chat.id, `❌ Invalid target username: ${targetUsernameInput}. Please use a valid @username or first name of an alive player.`).catch(console.error);
    if (target.status !== "alive") return currentBotInstance.sendMessage(msg.chat.id, `❌ ${getUsernameById(target.id)} is already eliminated and cannot be voted for.`).catch(console.error);
    if (target.id === voterId) return currentBotInstance.sendMessage(msg.chat.id, "⚠️ You cannot vote for yourself!").catch(console.error);

    game5Votes[voterId] = target.id;
    await currentBotInstance.sendMessage(msg.chat.id, `✅ ${getUsernameById(voterId)} voted to eliminate ${getUsernameById(target.id)}.`).catch(console.error);

    // Check if all alive players have voted
    const alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");
    const uniqueVoters = new Set(Object.keys(game5Votes).map(id => parseInt(id)));
    
    if (uniqueVoters.size === alivePlayers.length) {
        clearTimeout(game5VoteTimeout); // All votes in, resolve immediately
        endGame5Vote(currentChatId);
    }
}

/**
 * Ends the voting round, determines elimination, and updates player statuses.
 * @param {number} chatId - The ID of the chat.
 */
async function endGame5Vote(chatId) {
    game5VotingOpen = false;
    if (game5VoteTimeout) clearTimeout(game5VoteTimeout); // Ensure timeout is cleared

    const alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");
    const voteCount = {}; // { targetId: count }

    // Count votes
    Object.values(game5Votes).forEach(targetId => {
        voteCount[targetId] = (voteCount[targetId] || 0) + 1;
    });

    let maxVotes = 0;
    let candidates = []; // IDs of players with max votes

    // Find player(s) with the most votes
    for (const [targetId, count] of Object.entries(voteCount)) {
        if (count > maxVotes) {
            maxVotes = count;
            candidates = [parseInt(targetId)]; // Reset candidates if a new max is found
        } else if (count === maxVotes) {
            candidates.push(parseInt(targetId)); // Add to candidates if it's a tie
        }
    }

    let eliminatedId = null;

    // Determine eliminated player
    if (candidates.length === 0) {
        // No votes received, pick a random alive player
        if (alivePlayers.length > 0) {
            const randomPlayer = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
            eliminatedId = randomPlayer.id;
            await currentBotInstance.sendMessage(chatId, "⚠️ No votes received! A random player will be eliminated...").catch(console.error);
        } else {
            // Should not happen if alivePlayers.length check at start of game is correct
            await currentBotInstance.sendMessage(chatId, "No players left to eliminate. Game ending.").catch(console.error);
            summarizeGame5(chatId);
            return;
        }
    } else if (candidates.length === 1) {
        eliminatedId = candidates[0];
    } else {
        // Tie detected, randomly choose from candidates
        eliminatedId = candidates[Math.floor(Math.random() * candidates.length)];
        await currentBotInstance.sendMessage(chatId, "⚖️ Tie detected! Randomly choosing one to eliminate...").catch(console.error);
    }

    const eliminatedPlayer = currentRegisteredPlayers.find(p => p.id === eliminatedId);

    if (eliminatedPlayer) {
        eliminatedPlayer.status = "eliminated";
        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

        try {
            if (fs.existsSync(FINAL_BYE_IMAGE_PATH)) {
                await currentBotInstance.sendPhoto(chatId, fs.createReadStream(FINAL_BYE_IMAGE_PATH), {
                    caption: `💀 ${getUsernameById(eliminatedPlayer.id)} was eliminated!`,
                    parse_mode: "HTML"
                }).catch(console.error);
            } else {
                await currentBotInstance.sendMessage(chatId, `💀 ${getUsernameById(eliminatedPlayer.id)} was eliminated!`, { parse_mode: "HTML" }).catch(console.error);
                console.warn(`Image not found at ${FINAL_BYE_IMAGE_PATH}. Sending text only.`);
            }
        } catch (err) {
            console.error("❌ Error sending elimination image:", err.message);
        }

        // Wait 5 seconds before kicking
        setTimeout(async () => {
            await kickPlayer(chatId, eliminatedPlayer.id, getUsernameById(eliminatedPlayer.id));

            // After elimination, check remaining players and decide next action
            const remainingAlivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");

            if (remainingAlivePlayers.length <= 1) { // 0 or 1 player left
                await currentBotInstance.sendMessage(chatId, "💀 Only one player or no players left! Game 5 ending.").catch(console.error);
                summarizeGame5(chatId);
            } else if (remainingAlivePlayers.length === 2) { // Exactly 2 players left, proceed to quiz
                const survivorNames = remainingAlivePlayers.map(p => getUsernameById(p.id)).join(' and ');
                await currentBotInstance.sendMessage(chatId,
                    `🎉 <b>Game 5 (Voting) concluded!</b>\n\n` +
                    `Only <b>${remainingAlivePlayers.length} player(s) remain: ${survivorNames}</b>.\n` +
                    `The final quiz duel is ready to begin!\n\n` +
                    `👉 Host, type <b>/startquiz</b> to begin the final showdown!`,
                    { parse_mode: "HTML" }
                ).catch(console.error);
                summarizeGame5(chatId); // Call summarize to end game5 state and call gameEndCallback
            } else {
                // More than 2 players remain, start next voting round
                prepareNextRound(chatId);
            }
        }, 5000); // 5 seconds waiting before kick and next round decision
    } else {
        await currentBotInstance.sendMessage(chatId, "Error: Could not find player to eliminate.").catch(console.error);
        summarizeGame5(chatId); // End game if an error occurred
    }
}

/**
 * Prepares and starts the next voting round.
 * @param {number} chatId - The ID of the chat.
 */
async function prepareNextRound(chatId) {
    game5Votes = {}; // Reset votes for the new round
    game5VotingOpen = true;

    const survivors = currentRegisteredPlayers.filter(p => p.status === "alive");
    await currentBotInstance.sendMessage(chatId,
        `🔄 <b>Next Voting Round!</b>\n\n` +
        `👥 <b>Remaining players:</b> ${survivors.map(p => getUsernameById(p.id)).join(', ')}\n\n` +
        `💣 <b>How to vote:</b> Type <code>/vote @username</code> to choose who you want to eliminate.\n` +
        `⛔ <i>Remember: You cannot vote for yourself!</i>\n\n` +
        `⏰ <b>You have 1 minute to make your decision. Choose wisely!</b>`,
        { parse_mode: "HTML" }
    ).catch(console.error);

    game5VoteTimeout = setTimeout(() => {
        endGame5Vote(chatId);
    }, 60 * 1000); // 1 minute voting time
}

/**
 * Summarizes and officially ends Game 5.
 * @param {number} chatId - The ID of the chat.
 */
async function summarizeGame5(chatId) {
    resetGame5State(); // Reset all game-specific state variables

    // Remove all listeners specific to this game
    if (voteCommandListenerId) {
        currentBotInstance.removeTextListener(/\/vote (.+)/, voteCommandListenerId);
        voteCommandListenerId = null;
    }
    if (stopGame5ListenerId) {
        currentBotInstance.removeTextListener(/\/stopgame5/, stopGame5ListenerId);
        stopGame5ListenerId = null;
    }

    // Re-read players.json to get the latest status after all eliminations/updates
    let finalPlayers;
    try {
        finalPlayers = JSON.parse(fs.readFileSync(currentPlayerDataFile, 'utf8'));
    } catch (error) {
        console.error("Error reading players.json for final summary:", error.message);
        finalPlayers = currentRegisteredPlayers; // Fallback to in-memory if file read fails
    }

    const totalParticipants = finalPlayers.filter(p => p.initialParticipant).length; // Assuming an 'initialParticipant' flag
    const survivors = finalPlayers.filter(p => p.status === "alive");
    const eliminated = finalPlayers.filter(p => p.status === "eliminated");

    let msg = `🏁✨ <b>GAME 5 HAS ENDED!</b> ✨�\n\n`;
    msg += `👥 <b>TOTAL PARTICIPANTS:</b> ${totalParticipants}\n`;
    msg += `✅ <b>SURVIVORS:</b> ${survivors.length}\n`;
    msg += `💀 <b>ELIMINATED:</b> ${eliminated.length}\n\n`;
    msg += `✅ <b>SURVIVORS LIST:</b>\n${survivors.length > 0 ? survivors.map(u => `• ${getUsernameById(u.id)}`).join('\n') : "None"}\n\n`;
    msg += `💀 <b>ELIMINATED LIST:</b>\n${eliminated.length > 0 ? eliminated.map(u => `• ${getUsernameById(u.id)}`).join('\n') : "None"}`;

    await currentBotInstance.sendMessage(chatId, msg, { parse_mode: "HTML" }).catch(console.error);

    const piggyGifPath = FALLING_MONEY_GIF_PATH;
    try {
        if (fs.existsSync(piggyGifPath)) {
            await currentBotInstance.sendAnimation(chatId, fs.createReadStream(piggyGifPath)).catch(console.error);
        } else {
            console.warn(`GIF not found at ${piggyGifPath}. Skipping animation.`);
        }
    } catch (err) {
        console.error("❌ Failed to send falling money GIF:", err.message);
    }

    // Call the gameEndCallback to notify the coordinator
    if (gameEndCallback) {
        gameEndCallback(currentRegisteredPlayers);
    }
}

/**
 * Starts the Voting Game (Game 5). This function is called by the game coordinator.
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
 * @param {Function} quizRunningCheck - Function to check if quiz game is active.
 */
async function startGame(bot, chatId, players, adminId, playerDataFile, onGameEnd, spamMap, sThreshold, sIntervalMs, quizRunningCheck) {
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
    isQuizRunning = quizRunningCheck; // Assign the check function

    console.log("Starting Voting Game (Game 5)...");

    // Check if quiz game is running
    if (isQuizRunning && isQuizRunning()) {
        await currentBotInstance.sendMessage(currentChatId, "⚠️ Quiz game is currently active. Please end it first!").catch(console.error);
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers); // Notify coordinator game cannot start
        return;
    }

    // Reset game state for a fresh start
    resetGame5State();

    const alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");
    if (alivePlayers.length <= 2) {
        await currentBotInstance.sendMessage(currentChatId, "❌ Need more than 2 players to start Game 5 (Voting)! Skipping round.", { parse_mode: "HTML" }).catch(console.error);
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
        return;
    }

    game5Started = true;
    game5VotingOpen = false; // Voting not yet open

    try {
        if (fs.existsSync(VOTING_IMAGE_PATH)) {
            await currentBotInstance.sendPhoto(currentChatId, fs.createReadStream(VOTING_IMAGE_PATH), {
                caption:
                    "🔮 <b>GAME 5: ELIMINATION GAME!</b>\n\n" +
                    "This is your final test of trust and strategy.\n\n" +
                    "Each of you must vote for someone to eliminate. The player with the most votes will be eliminated.\n\n" +
                    "⚠️ You cannot vote for yourself!\n\n" +
                    "⏰ <b>You will have 1 minute to vote after this introduction.</b>\n\n" +
                    "🕒 Take 20 seconds to think carefully and plan your move.\n\n" +
                    "💡 <i>Get ready... alliances will break and betrayals will begin!</i>",
                parse_mode: "HTML"
            }).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(currentChatId, "🔮 Game 5: Marbles Vote!\nGet ready to vote soon!", { parse_mode: "HTML" }).catch(console.error);
            console.warn(`Image not found at ${VOTING_IMAGE_PATH}. Sending text instructions only.`);
        }
    } catch (err) {
        console.error("❌ Failed to send voting image:", err.message);
        await currentBotInstance.sendMessage(currentChatId, "Error sending game instructions image.").catch(console.error);
    } finally {
        // Wait 20 seconds for them to read before opening voting
        setTimeout(async () => {
            if (!game5Started) return; // Check if game was stopped during prep
            game5VotingOpen = true;

            await currentBotInstance.sendMessage(currentChatId,
                "🎲 <b>Voting has started!</b>\n\n" +
                "Vote who you want to eliminate by typing <b>/vote @username</b>.\n" +
                "⛔ You cannot vote for yourself!\n\n" +
                "⏰ <b>You have 1 minute to vote!</b>",
                { parse_mode: "HTML" }
            ).catch(console.error);

            game5VoteTimeout = setTimeout(() => {
                endGame5Vote(currentChatId);
            }, 60 * 1000); // 1 minute voting time
        }, 20 * 1000); // 20 seconds waiting
    }

    // Register listeners
    voteCommandListenerId = currentBotInstance.onText(/\/vote (.+)/, async (msg, match) => {
        handleVoteCommand(msg, match);
    });

    stopGame5ListenerId = currentBotInstance.onText(/\/stopgame5/, async (msg) => {
        if (msg.chat.id !== currentChatId) return; // Only respond in the active game chat
        if (msg.from.id !== currentAdminId) {
            return currentBotInstance.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" }).catch(console.error);
        }
        if (!game5Started) {
            return currentBotInstance.sendMessage(msg.chat.id, "⚠️ Game 5 is not running.", { parse_mode: "HTML" }).catch(console.error);
        }

        console.log("Game 5 manually stopped.");
        summarizeGame5(currentChatId); // Summarize and end the game
        await currentBotInstance.sendMessage(currentChatId, `🛑 Game 5 has been forcefully stopped!`, { parse_mode: "HTML" }).catch(console.error);
    });

    console.log("Voting game initialized and listeners set.");
}

module.exports = {
    startGame
};
