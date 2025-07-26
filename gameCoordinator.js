//gameCoordinator.js - Manages game rounds, loads games, and handles flow
const path = require('path');
const fs = require('fs');

// Define game categories and their round mapping
const GAME_CATEGORIES = {
    1: 'fixed',
    2: 'skill',
    3: 'luck', // Changed to luck-based as per your request
    4: 'betrayal',
    5: 'final'
};

const TOTAL_ROUNDS = 5;

// Global references for the current game session
let currentBotInstance = null;
let currentChatId = null;
let currentRegisteredPlayers = []; // This array is updated as players are eliminated
let currentAdminId = null;
let currentPlayerDataFile = null;
let currentRound = 1; // Tracks the current round (0 means not started/reset)
let currentEliminatedPlayerSpamMap = null; // Reference to the spam map
let currentSpamThreshold = null;
let currentSpamIntervalMs = null;
let isGameActive = false; // New: Flag to indicate if a game is currently running
let currentGameTimeout = null; // New: To store the timeout for the break between rounds

// Stores paths to all available game modules, categorized
const loadedGames = {};

/**
 * Loads available games from the 'games' directory into the loadedGames object.
 */
function loadGames() {
    const gamesDir = path.join(__dirname, 'games');
    console.log(`Scanning for games in: ${gamesDir}`);

    for (const category of Object.values(GAME_CATEGORIES)) {
        const categoryPath = path.join(gamesDir, category);
        if (fs.existsSync(categoryPath) && fs.lstatSync(categoryPath).isDirectory()) {
            loadedGames[category] = fs.readdirSync(categoryPath)
                .filter(file => file.endsWith('.js'))
                .map(file => path.join(categoryPath, file));
            console.log(`Found ${loadedGames[category].length} games in category '${category}': ${loadedGames[category].map(p => path.basename(p)).join(', ')}`);
        } else {
            console.warn(`Warning: Game category directory not found: ${categoryPath}`);
            loadedGames[category] = [];
        }
    }
}

// Load games once when the coordinator module is required
loadGames();

/**
 * Selects a game for a given round based on its category.
 * @param {number} round - The current round number.
 * @returns {string|null} The absolute path to the selected game module, or null if none found.
 */
function selectGameForRound(round) {
    const category = GAME_CATEGORIES[round];
    if (!category) {
        // This log is now primarily for debugging unexpected round numbers
        console.error(`Error: No category defined for round ${round}`);
        return null;
    }

    const gamesIn_Category = loadedGames[category];
    if (!gamesIn_Category || gamesIn_Category.length === 0) {
        console.error(`Error: No games found for category '${category}' for round ${round}`);
        return null;
    }

    if (round === 1) {
        // Game 1 is always fixed: 'red_green.js'
        const fixedGamePath = gamesIn_Category.find(gamePath => path.basename(gamePath) === 'red_green.js');
        if (!fixedGamePath) {
            console.error("Error: 'red_green.js' not found in games/fixed/. Please ensure it exists.");
            return null;
        }
        return fixedGamePath;
    } else {
        // For other rounds, pick a random game from the category
        const randomIndex = Math.floor(Math.random() * gamesIn_Category.length);
        return gamesIn_Category[randomIndex];
    }
}

/**
 * Resets all game-related state variables.
 */
function resetGameInternal() {
    currentBotInstance = null;
    currentChatId = null;
    currentRegisteredPlayers = [];
    currentAdminId = null;
    currentPlayerDataFile = null;
    currentRound = 1;
    currentEliminatedPlayerSpamMap = null;
    currentSpamThreshold = null;
    currentSpamIntervalMs = null;
    isGameActive = false;
    if (currentGameTimeout) {
        clearTimeout(currentGameTimeout);
        currentGameTimeout = null;
    }
}

/**
 * Public function to stop the current game immediately.
 * @param {TelegramBot} bot - The Telegram bot instance.
 * @param {number} chatId - The ID of the chat where the stop command was issued.
 */
async function stopGame(bot, chatId) {
    if (isGameActive && currentChatId) {
        await bot.sendMessage(currentChatId, "🚨 The current game has been stopped by the admin.").catch(console.error);
        resetGameInternal();
        console.log("Game stopped and state reset.");
        return true; // Indicate that a game was active and stopped
    } else {
        await bot.sendMessage(chatId, "ℹ️ No game is currently active to stop.").catch(console.error);
        return false; // Indicate no active game
    }
}


/**
 * Callback function to be executed when a game ends.
 * This function is passed to each game module and called by it upon completion.
 * @param {Array<Object>} updatedPlayers - The player array after the game has concluded.
 */
async function onGameEnded(updatedPlayers) {
    currentRegisteredPlayers = updatedPlayers; // Update the main player list
    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2)); // Save updated players

    const aliveSurvivors = currentRegisteredPlayers.filter(p => p.status === "alive");

    if (aliveSurvivors.length === 0) {
        await currentBotInstance.sendMessage(currentChatId, "💀 Everyone has been eliminated! The game ends here.").catch(console.error);
        resetGameInternal(); // Use the new reset function
        return;
    }

    currentRound++;
    if (currentRound <= TOTAL_ROUNDS) {
        await currentBotInstance.sendMessage(currentChatId, `Moving to Round ${currentRound}...`).catch(console.error);
        currentGameTimeout = setTimeout(async () => { // Use currentGameTimeout
            if (!isGameActive) return; // If game was stopped during timeout, don't proceed
            // Recursively call startGameFlow to start the next round
            await startGameFlow(
                currentBotInstance,
                currentChatId,
                currentRegisteredPlayers,
                currentAdminId,
                currentPlayerDataFile,
                currentEliminatedPlayerSpamMap,
                currentSpamThreshold,
                currentSpamIntervalMs
            );
        }, 5000); // Short break before next game
    } else {
        // All rounds completed
        await currentBotInstance.sendMessage(currentChatId, "🎉 All rounds completed! Congratulations to the survivors!").catch(console.error);
        // Display final survivors
        const finalSurvivorsList = aliveSurvivors.map(p => `• ${p.username}`).join('\n');
        await currentBotInstance.sendMessage(currentChatId, `🏆 Final Survivors:\n${finalSurvivorsList}`).catch(console.error);
        resetGameInternal(); // Use the new reset function
    }
}

/**
 * Helper function to format the game title nicely.
 */
const formatGameTitle = (gameFilePath) => {
    // Get the base name (e.g., 'red_green.js')
    const baseName = path.basename(gameFilePath, '.js');
    // Replace underscores with spaces and capitalize each word
    return baseName.split('_')
                   .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                   .join(' ');
};

/**
 * Helper function to commence a specific game round.
 * Separated to handle the initial delay for Round 1 and immediate start for subsequent rounds.
 */
async function commenceGameRound(bot, chatId, players, adminId, playerDataFile, eliminatedPlayerSpamMap, spamThreshold, spamIntervalMs, gamePath, gameTitle) {
    // Check if the game has been stopped externally before proceeding to the current round
    if (!isGameActive) {
        console.log("Game was stopped externally, aborting current round.");
        return;
    }

    try {
        // Clear the current game timeout reference as we are now commencing the game
        // This prevents `clearTimeout` in `resetGameInternal` from affecting previous delays
        // once the game has actually started.
        currentGameTimeout = null;

        const gameModule = require(gamePath);
        if (typeof gameModule.startGame !== 'function') {
            throw new Error(`Game module at ${gamePath} does not export a 'startGame' function.`);
        }

        // Now, send the "Game commencing" message with the cleaned title
        await currentBotInstance.sendMessage(currentChatId, `🏁 *Game ${currentRound}* is now commencing: *${gameTitle}*!`, { parse_mode: "Markdown" }).catch(console.error);

        await gameModule.startGame(
            currentBotInstance,
            currentChatId,
            currentRegisteredPlayers,
            currentAdminId,
            currentPlayerDataFile,
            onGameEnded, // This callback will be called by the game module when it finishes
            currentEliminatedPlayerSpamMap, // Pass spam map
            currentSpamThreshold,          // Pass spam constants
            currentSpamIntervalMs
        );

    } catch (error) {
        console.error(`Error loading or starting game for round ${currentRound} (${gamePath}):`, error);
        await currentBotInstance.sendMessage(currentChatId, `❌ An error occurred while starting Game for Round ${currentRound}. Please check bot logs.`).catch(console.error);
        resetGameInternal(); // Reset game flow on error
    }
}

/**
 * Starts the overall game flow, progressing through rounds.
 * This is the entry point for the game automation after registration.
 * @param {TelegramBot} bot - The Telegram bot instance.
 * @param {number} chatId - The ID of the chat.
 * @param {Array<Object>} players - The array of registered players.
 * @param {number} adminId - The ID of the admin.
 * @param {string} playerDataFile - Path to the player data file.
 * @param {Map} eliminatedPlayerSpamMap - Map for tracking spam from eliminated players.
 * @param {number} spamThreshold - Constant for spam threshold.
 * @param {number} spamIntervalMs - Constant for spam interval.
 */
async function startGameFlow(bot, chatId, players, adminId, playerDataFile, eliminatedPlayerSpamMap, spamThreshold, spamIntervalMs) {
    // Store current session details globally within the coordinator
    currentBotInstance = bot;
    currentChatId = chatId;
    currentRegisteredPlayers = players;
    currentAdminId = adminId;
    currentPlayerDataFile = playerDataFile;
    currentEliminatedPlayerSpamMap = eliminatedPlayerSpamMap;
    currentSpamThreshold = spamThreshold;
    currentSpamIntervalMs = spamIntervalMs;
    isGameActive = true; // Set game as active

    // If it's the very first round (currentRound is 0), set it to 1 and announce the start.
    // Then, schedule the actual game commencement after a delay.
    if (currentRound === 1) {
        currentRound = 1; // Set to 1 for the first game
       await currentBotInstance.sendMessage(chatId, "Your *FATE* will now be determined! The games will commence in 1 minute.", { parse_mode: "Markdown" }).catch(console.error);

        // Schedule the actual game commencement after a 1-minute delay
        currentGameTimeout = setTimeout(async () => {
            if (!isGameActive) return; // If game was stopped during timeout, don't proceed

            // Select the game for Round 1
            const gamePath = selectGameForRound(currentRound); // Now currentRound is 1

            if (!gamePath) {
                await currentBotInstance.sendMessage(currentChatId, `❌ Error: Could not find a game for Round ${currentRound}. Ending game flow.`).catch(console.error);
                resetGameInternal();
                return;
            }
            const gameTitle = formatGameTitle(gamePath);
            await commenceGameRound(bot, chatId, players, adminId, playerDataFile, eliminatedPlayerSpamMap, spamThreshold, spamIntervalMs, gamePath, gameTitle);
        }, 60 * 1000); // 1 minute delay (60,000 milliseconds)
        return; // Exit here, the game will commence after the timeout
    }

    // For subsequent rounds (currentRound > 0), the delay is already handled
    // by the `onGameEnded` function's `setTimeout` which calls `startGameFlow`.
    // So, we just proceed directly to select and commence the game for the current round.
    const gamePath = selectGameForRound(currentRound);

    if (!gamePath) {
        await currentBotInstance.sendMessage(currentChatId, `❌ Error: Could not find a game for Round ${currentRound}. Ending game flow.`).catch(console.error);
        resetGameInternal();
        return;
    }
    const gameTitle = formatGameTitle(gamePath);
    await commenceGameRound(bot, chatId, players, adminId, playerDataFile, eliminatedPlayerSpamMap, spamThreshold, spamIntervalMs, gamePath, gameTitle);
}

module.exports = {
    startGameFlow,
    stopGame, // Export the new stopGame function
    TOTAL_ROUNDS // Export total rounds for external reference if needed
};