// games/skill/quizGame.js - Skill Game: Quiz Game (Final Game)
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

// Game-specific state variables for Quiz Game
let quizStarted = false;
let quizPlayers = []; // Will be populated by alive players at game start
let quizScores = {}; // { userId: score }
let currentQuestion = null;
let quizAnswerTimeout = null;
let currentQuestionAnswered = false; // Flag to ensure only first correct answer counts

// Telegram listener IDs to manage their lifecycle
let answerCommandListenerId = null;
let stopQuizListenerId = null;

// --- Game Assets Paths (relative to the project root) ---
const FINAL_QUIZ_IMAGE_PATH = path.resolve(__dirname, "..", "..", "images", "final-quiz.jpg");
const BYE_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "bye.gif");
const FALLING_MONEY_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "falling-money-squid-game.gif");
const CONGRATS_IMAGE_PATH = path.resolve(__dirname, "..", "..", "images", "congrats-1.jpg"); // Assuming this image exists for winner

// Quiz Questions (original list provided by user)
const quizQuestions = [
    { question: "What is the capital of Japan?", answer: "tokyo" },
    { question: "2 + 2 x 2 = ?", answer: "6" },
    { question: "What color do you get when you mix blue and yellow?", answer: "green" },
    { question: "How many continents are there?", answer: "7" },
    { question: "What is the largest ocean on Earth?", answer: "pacific" },
    { question: "What planet is known as the Red Planet?", answer: "mars" },
    { question: "Who wrote 'Romeo and Juliet'?", answer: "shakespeare" },
    { question: "What is the tallest animal in the world?", answer: "giraffe" },
    { question: "Which country is famous for pizza and pasta?", answer: "italy" },
    { question: "What is the chemical symbol for water?", answer: "h2o" },
    { question: "Which fruit is known for keeping the doctor away?", answer: "apple" },
    { question: "What do bees collect and use to make honey?", answer: "nectar" },
    { question: "What is the largest mammal in the world?", answer: "blue whale" },
    { question: "What gas do plants absorb from the atmosphere?", answer: "carbon dioxide" },
    { question: "How many days are there in a leap year?", answer: "366" },
    { question: "What is the hardest natural substance on Earth?", answer: "diamond" },
    { question: "Which bird is known for mimicking sounds?", answer: "parrot" },
    { question: "What is the boiling point of water in Celsius?", answer: "100" },
    { question: "How many planets are in our solar system?", answer: "8" },
    { question: "Who painted the Mona Lisa?", answer: "da vinci" },
    { question: "Which animal is known as the King of the Jungle?", answer: "lion" },
    { question: "What is the fastest land animal?", answer: "cheetah" },
    { question: "How many sides does a hexagon have?", answer: "6" },
    { question: "Which country has the Eiffel Tower?", answer: "france" },
    { question: "What is the main ingredient in sushi?", answer: "rice" }
];

// Keep a copy of original questions for resetting the game
const originalQuizQuestions = [...quizQuestions];

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
 * Resets all quiz game state variables.
 */
function resetQuizGameState() {
    quizStarted = false;
    quizPlayers = [];
    quizScores = {};
    currentQuestion = null;
    if (quizAnswerTimeout) clearTimeout(quizAnswerTimeout);
    quizAnswerTimeout = null;
    currentQuestionAnswered = false;
    // Restore original questions for next game
    quizQuestions.splice(0, quizQuestions.length, ...originalQuizQuestions);
}

/**
 * Sends the initial quiz instructions.
 * @param {number} chatId - The ID of the chat.
 * @param {Array<Object>} players - The list of players participating.
 */
async function sendQuizInstructions(chatId, players) {
    const instructions =
        `⚔️ <b>FINAL GAME INSTRUCTIONS</b> ⚔️\n\n` +
        `- You have reached the ultimate final duel!\n` +
        `- You will face off in a tense quiz battle.\n` +
        `- It is a best of 3: the first player to reach 3 points will win.\n` +
        `- Only the FIRST player to answer correctly gets the point each round — speed matters!\n\n` +
        `- To answer, type: <code>/answer your_answer</code>\n\n` +
        `⏰ You have 1 minute to prepare and get ready. The duel will start soon… feel the pressure! 🔥`;

    try {
        if (fs.existsSync(FINAL_QUIZ_IMAGE_PATH)) {
            await currentBotInstance.sendPhoto(chatId, fs.createReadStream(FINAL_QUIZ_IMAGE_PATH), {
                caption: instructions,
                parse_mode: "HTML"
            }).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(chatId, instructions, { parse_mode: "HTML" }).catch(console.error);
            console.warn(`Image not found at ${FINAL_QUIZ_IMAGE_PATH}. Sending text instructions only.`);
        }
    } catch (err) {
        console.error("❌ Failed to send final instructions photo:", err.message);
        await currentBotInstance.sendMessage(chatId, instructions, { parse_mode: "HTML" }).catch(console.error); // Send text fallback
    } finally {
        // Set quizStarted to true BEFORE the timeout to ensure the check passes
        quizStarted = true; // MOVED THIS LINE HERE

        setTimeout(async () => {
            console.log("Quiz Game: 1-minute prep time over. Checking if quizStarted is true:", quizStarted);
            if (!quizStarted) {
                console.log("Quiz Game: quizStarted is false, not starting quiz after delay (game might have been stopped).");
                return;
            }
            await currentBotInstance.sendMessage(chatId, "🔥 The FINAL GAME is starting now!").catch(console.error);
            startQuiz(chatId, players); // Pass players to startQuiz
        }, 60 * 1000); // 1 minute wait before quiz
    }
}

/**
 * Starts the quiz game.
 * @param {number} chatId - The ID of the chat.
 * @param {Array<Object>} players - The list of players participating.
 */
function startQuiz(chatId, players) {
    console.log("Quiz Game: Entering startQuiz function.");
    // quizStarted = true; // This line was moved to sendQuizInstructions
    quizPlayers = players; // Ensure quizPlayers is updated with current alive players
    quizScores = {}; // Reset scores
    quizPlayers.forEach(p => {
        quizScores[p.id] = 0;
    });
    currentQuestionAnswered = false; // Reset for new quiz
    sendNextQuizQuestion(chatId);
    console.log("Quiz Game: Exiting startQuiz function. sendNextQuizQuestion should have been called.");
}

/**
 * Sends the next quiz question.
 * @param {number} chatId - The ID of the chat.
 */
function sendNextQuizQuestion(chatId) {
    console.log("Quiz Game: Entering sendNextQuizQuestion function.");
    if (quizAnswerTimeout) {
        clearTimeout(quizAnswerTimeout);
    }

    currentQuestionAnswered = false; // Mark as unanswered for the new question

    // Ensure there are questions left, otherwise end quiz
    console.log("Quiz Game: Remaining questions length:", quizQuestions.length);
    if (quizQuestions.length === 0) {
        currentBotInstance.sendMessage(chatId, "Ran out of quiz questions! Ending quiz.").catch(console.error);
        endQuiz(chatId); // Call end quiz function
        return;
    }

    // Pick a random question and remove it to avoid repetition in one quiz game
    const randomIndex = Math.floor(Math.random() * quizQuestions.length);
    currentQuestion = quizQuestions.splice(randomIndex, 1)[0]; // Removes the question from the array

    const questionMsg =
        `❓ <b>QUIZ DUEL!</b> ❓\n\n` +
        `⚔️ <b>First player to answer correctly gets the point!</b>\n\n` +
        `💬 <b>Question:</b>\n${currentQuestion.question}\n\n` +
        `⏰ <i>You have 30 seconds! Type</i> <code>/answer your_answer</code> <i>to reply quickly!</i>`;

    currentBotInstance.sendMessage(chatId, questionMsg, { parse_mode: "HTML" }).catch(console.error);
    console.log("Quiz Game: Question sent:", currentQuestion.question);

    quizAnswerTimeout = setTimeout(() => {
        console.log("Quiz Game: Quiz answer timeout triggered. currentQuestionAnswered:", currentQuestionAnswered);
        if (!currentQuestionAnswered) {
            currentBotInstance.sendMessage(chatId, "⌛ <b>Time's up!</b> No one got it correct. No points awarded. The correct answer was: <b>" + currentQuestion.answer + "</b>", { parse_mode: "HTML" }).catch(console.error);
            notifyNextQuestion(chatId);
        }
    }, 30 * 1000); // Timeout after 30 seconds
}

/**
 * Notifies players about the next question and sets a delay.
 * @param {number} chatId - The ID of the chat.
 */
function notifyNextQuestion(chatId) {
    console.log("Quiz Game: Entering notifyNextQuestion function.");
    // Check if quiz is still active and there are enough players
    const alivePlayersCount = quizPlayers.filter(p => p.status === "alive").length;
    console.log("Quiz Game: Alive players count for next question:", alivePlayersCount);
    if (!quizStarted || alivePlayersCount < 1) { // If less than 1 alive player, end quiz
        console.log("Quiz Game: Ending quiz from notifyNextQuestion due to game not started or insufficient players.");
        endQuiz(chatId);
        return;
    }

    const msg =
        `⚔️ <b>Prepare for the next question!</b>\n\n` +
        `⏳ <i>You have 1 minute to get ready...</i>\n` +
        `🔥 <b>Stay sharp! The next question could decide your fate!</b>`;

    currentBotInstance.sendMessage(chatId, msg, { parse_mode: "HTML" }).catch(console.error);
    console.log("Quiz Game: Next question notification sent.");

    setTimeout(() => {
        console.log("Quiz Game: 1-minute delay for next question over. Checking if quizStarted is true:", quizStarted);
        if (!quizStarted) {
            console.log("Quiz Game: quizStarted is false, not sending next question after delay.");
            return; // Check if game was stopped during delay
        }
        sendNextQuizQuestion(chatId);
    }, 60 * 1000); // 1 minute delay
}

/**
 * Handles a player's answer to a quiz question.
 * @param {Object} msg - The Telegram message object.
 * @param {Array<string>} match - Regex match array.
 */
async function handleAnswerCommand(msg, match) {
    console.log("Quiz Game: handleAnswerCommand received. quizStarted:", quizStarted, "currentQuestionAnswered:", currentQuestionAnswered);
    if (!quizStarted || currentQuestionAnswered) return; // Ignore if quiz not started or question already answered

    const userId = msg.from.id;
    const player = quizPlayers.find(p => p.id === userId && p.status === "alive"); // Ensure player is alive
    if (!player) {
        // If an eliminated player tries to answer, handle as spam
        const username = getUsernameById(userId);
        const isSpam = await handleEliminatedPlayerSpam(userId, msg.message_id, username);
        if (isSpam) return;
        await currentBotInstance.sendMessage(msg.chat.id, "❌ You are not in the final duel or already eliminated!").catch(console.error);
        return;
    }

    const answer = match[1].trim().toLowerCase();
    console.log(`Quiz Game: Player ${getUsernameById(userId)} answered: "${answer}". Correct answer: "${currentQuestion.answer.toLowerCase()}"`);
    if (answer === currentQuestion.answer.toLowerCase()) {
        currentQuestionAnswered = true; // Only first correct counts
        clearTimeout(quizAnswerTimeout);

        quizScores[userId]++;

        let scoreMsg = `✅ ${getUsernameById(userId)} answered first and correctly! They get 1 point!\n\n`;
        scoreMsg += "🏅 Current Scores:\n";
        quizPlayers.forEach(p => {
            scoreMsg += `• ${getUsernameById(p.id)}: ${quizScores[p.id]} point(s)\n`;
        });

        await currentBotInstance.sendMessage(msg.chat.id, scoreMsg).catch(console.error);
        console.log(`Quiz Game: ${getUsernameById(userId)} scored. Current score: ${quizScores[userId]}`);

        if (quizScores[userId] === 3) {
            console.log(`Quiz Game: ${getUsernameById(userId)} reached 3 points. Ending quiz.`);
            // Player wins best of 3
            endQuiz(msg.chat.id, player); // Call endQuiz with the winner
        } else {
            notifyNextQuestion(msg.chat.id);
        }
    } else {
        await currentBotInstance.sendMessage(msg.chat.id, "❌ Wrong answer! Keep trying!").catch(console.error);
    }
}

/**
 * Ends the quiz game, declares a winner if any, and updates player statuses.
 * @param {number} chatId - The ID of the chat.
 * @param {Object|null} winner - The winning player object, or null if no winner.
 */
async function endQuiz(chatId, winner = null) {
    console.log("Quiz Game: Entering endQuiz function. Winner:", winner ? getUsernameById(winner.id) : "None");
    resetQuizGameState(); // Reset all quiz-specific variables

    // Remove all listeners specific to this game
    if (answerCommandListenerId) {
        currentBotInstance.removeTextListener(/\/answer (.+)/, answerCommandListenerId);
        answerCommandListenerId = null;
        console.log("Quiz Game: Removed /answer listener.");
    }
    if (stopQuizListenerId) {
        currentBotInstance.removeTextListener(/\/stopquiz/, stopQuizListenerId);
        stopQuizListenerId = null;
        console.log("Quiz Game: Removed /stopquiz listener.");
    }

    if (winner) {
        try {
            if (fs.existsSync(CONGRATS_IMAGE_PATH)) {
                await currentBotInstance.sendPhoto(
                    chatId,
                    fs.createReadStream(CONGRATS_IMAGE_PATH),
                    {
                        caption:
                            `🎉 <b>CONGRATULATIONS!</b> �\n\n` +
                            `👑 <b>${getUsernameById(winner.id)} is now crowned the ULTIMATE CHAMPION of the Squid Game!</b>\n\n` +
                            `🏆 <b>${getUsernameById(winner.id)} has won the FINAL GAME!</b>\n\n` +
                            `👏 Congratulations to our well-deserving winner!`,
                        parse_mode: "HTML"
                    }
                ).catch(console.error);
            } else {
                await currentBotInstance.sendMessage(chatId,
                    `🎉 <b>CONGRATULATIONS!</b> 🎉\n\n` +
                    `👑 <b>${getUsernameById(winner.id)} is now crowned the ULTIMATE CHAMPION of the Squid Game!</b>\n\n` +
                    `🏆 <b>${getUsernameById(winner.id)} has won the FINAL GAME!</b>\n\n` +
                    `👏 Congratulations to our well-deserving winner!`,
                    { parse_mode: "HTML" }
                ).catch(console.error);
                console.warn(`Image not found at ${CONGRATS_IMAGE_PATH}. Sending text only.`);
            }
        } catch (err) {
            console.error("❌ Failed to send winner photo:", err.message);
        }

        // Update winner's status
        const winnerPlayer = currentRegisteredPlayers.find(p => p.id === winner.id);
        if (winnerPlayer) {
            winnerPlayer.status = "winner"; // Set winner status
        }

        // Eliminate other players who were active in the quiz but didn't win
        const eliminatedQuizPlayers = quizPlayers.filter(p => p.id !== winner.id);
        for (const p of eliminatedQuizPlayers) {
            const playerToEliminate = currentRegisteredPlayers.find(rp => rp.id === p.id);
            if (playerToEliminate && playerToEliminate.status === "alive") { // Only eliminate if still alive
                playerToEliminate.status = "eliminated";
                await currentBotInstance.sendMessage(chatId, `💀 ${getUsernameById(p.id)} was eliminated.`).catch(console.error);
                await kickPlayer(chatId, p.id, getUsernameById(p.id)); // Kick eliminated players
            }
        }

        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

        await currentBotInstance.sendMessage(chatId, `🏁 Quiz game ended! 🎊 Winner: ${getUsernameById(winner.id)}`).catch(console.error);
    } else {
        // No winner (e.g., ran out of questions, or no players left)
        await currentBotInstance.sendMessage(chatId, "🏁 The Quiz Game has ended without a clear winner. All remaining players are eliminated.").catch(console.error);
        const remainingAlive = currentRegisteredPlayers.filter(p => p.status === "alive");
        for (const p of remainingAlive) {
            p.status = "eliminated";
            await kickPlayer(chatId, p.id, getUsernameById(p.id)); // Kick them
        }
        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
    }

    // Send falling money GIF at the very end
    setTimeout(async () => {
        const moneyGifPath = FALLING_MONEY_GIF_PATH;
        try {
            if (fs.existsSync(moneyGifPath)) {
                await currentBotInstance.sendAnimation(chatId, fs.createReadStream(moneyGifPath), { caption: "" }).catch(console.error);
            } else {
                console.warn(`GIF not found at ${moneyGifPath}. Skipping animation.`);
            }
        } catch (err) {
            console.error("❌ Failed to send falling money GIF:", err.message);
        }
    }, 2000); // 2 second delay for GIF

    // Notify the game coordinator that this game has finished
    if (gameEndCallback) {
        gameEndCallback(currentRegisteredPlayers);
    }
    console.log("Quiz Game: endQuiz function finished.");
}

/**
 * Starts the Quiz Game. This function is called by the game coordinator.
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

    console.log("Starting Quiz Game...");

    // Reset quiz game state for a new game
    resetQuizGameState();

    const alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");

    if (alivePlayers.length === 0) {
        await currentBotInstance.sendMessage(currentChatId, "❌ No players left to start the quiz! Skipping round.", { parse_mode: "HTML" }).catch(console.error);
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
        return;
    }

    // Set quizPlayers to the currently alive players for this game instance
    quizPlayers = alivePlayers;
    quizPlayers.forEach(p => {
        quizScores[p.id] = 0; // Initialize scores for active players
    });

    // Register listeners
    answerCommandListenerId = currentBotInstance.onText(/\/answer (.+)/, async (msg, match) => {
        handleAnswerCommand(msg, match);
    });

    stopQuizListenerId = currentBotInstance.onText(/\/stopquiz/, async (msg) => {
        if (msg.chat.id !== currentChatId) return; // Only respond in the active game chat
        if (msg.from.id !== currentAdminId) {
            return currentBotInstance.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" }).catch(console.error);
        }
        if (!quizStarted) {
            return currentBotInstance.sendMessage(msg.chat.id, "⚠️ Quiz game is not running.", { parse_mode: "HTML" }).catch(console.error);
        }

        console.log("Quiz game manually stopped.");
        endQuiz(currentChatId, null); // End quiz without a winner
        await currentBotInstance.sendMessage(currentChatId, `🛑 Quiz game has been forcefully stopped!`, { parse_mode: "HTML" }).catch(console.error);
    });

    sendQuizInstructions(currentChatId, quizPlayers);
    console.log("Quiz game initialized and listeners set.");
}

module.exports = {
    startGame
};
