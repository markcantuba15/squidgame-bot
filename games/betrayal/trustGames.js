// games/betrayal/trustGame.js - Betrayal Game: Trust Game
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

// Game-specific state variables for Trust Game
let game3Started = false;
let pairs = []; // Stores confirmed pairs: [[player1_obj, player2_obj], ...]
let allowPickingPartner = false; // Controls if /pick command is active
let partnerPhaseInterval = null; // Interval for partner phase reminders
let partnerPhaseTimeout = null; // Timeout for partner picking phase
let choicePhaseStarted = false; // Indicates start of the Trust/Betray phase
let choicePhaseTimeout = null; // Timeout for the choice phase

// Telegram listener IDs to manage their lifecycle
let pickCommandListenerId = null;
let trustBetrayListenerId = null;
let stopGame3ListenerId = null;

// --- Game Assets Paths (relative to the project root) ---
const SHAKE_IMAGE_PATH = path.resolve(__dirname, "..", "..", "images", "shake1.jpg"); // Assuming this is the image for the game
const BYE_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "bye.gif");
const GOOD_WORK_GIF_PATH = path.resolve(__dirname, "..", "..", "gifs", "goodwork.gif");
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

// --- Functions for Trust/Betray Reply Keyboard ---
async function sendChoiceButtons(chatId, username) {
    try {
        await currentBotInstance.sendMessage(chatId, `🤝 ${username}, it's time to make your choice. What will you do?`, {
            reply_markup: {
                keyboard: [
                    [{ text: "🤝 Trust" }, { text: "🔪 Betray" }]
                ],
                resize_keyboard: true,
                one_time_keyboard: true // Make it one-time so it disappears after choice
            }
        }).catch(console.error);
        console.log(`Choice reply keyboard sent to ${username}.`);
    } catch (err) {
        console.error(`❌ Failed to send choice buttons to chat ${chatId}:`, err.message);
        currentBotInstance.sendMessage(chatId, `⚠️ Error sending choice buttons: ${err.message}`).catch(console.error);
    }
}

async function removeChoiceButtons(chatId) {
    try {
        await currentBotInstance.sendMessage(chatId, "Removing choice buttons...", {
            reply_markup: {
                remove_keyboard: true
            }
        }).catch(console.error);
        console.log("Choice reply keyboard removed successfully.");
    } catch (e) {
        console.warn(`⚠️ Failed to remove choice reply keyboard:`, e.message);
    }
}

/**
 * Resets all game 3 state variables to their initial values.
 */
function resetGame3State() {
    game3Started = false;
    pairs = [];
    allowPickingPartner = false;
    if (partnerPhaseInterval) clearInterval(partnerPhaseInterval);
    partnerPhaseInterval = null;
    if (partnerPhaseTimeout) clearTimeout(partnerPhaseTimeout);
    partnerPhaseTimeout = null;
    choicePhaseStarted = false;
    if (choicePhaseTimeout) clearTimeout(choicePhaseTimeout);
    choicePhaseTimeout = null;
}

/**
 * Ends Game 3 cleanly, resetting player statuses and game state.
 * @param {number} chatId - The ID of the chat.
 */
async function endGame3Cleanly(chatId) {
    currentRegisteredPlayers.forEach(p => {
        if (p.status === "safe") p.status = "alive"; // Convert 'safe' players back to 'alive' for next game
        p.pickedPartner = null;
        p.partnerConfirmed = false;
        p.choice = null; // Clear player choice
    });
    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    await currentBotInstance.sendMessage(chatId, "🎉 <b>Game 3 has ended!</b>\nGet ready for the next game!", { parse_mode: "HTML" }).catch(console.error);

    resetGame3State(); // Reset all game state flags and timers

    // Notify the game coordinator that this game has finished
    if (gameEndCallback) {
        gameEndCallback(currentRegisteredPlayers);
    }
}

/**
 * Handles a player's partner pick command.
 * @param {Object} msg - The Telegram message object.
 * @param {Array<string>} match - Regex match array.
 */
async function handlePickCommand(msg, match) {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const username = getUsernameById(userId);

    let targetUsername = match[1].trim();
    if (!targetUsername.startsWith('@')) {
        targetUsername = `@${targetUsername}`; // Ensure target username has @ for consistent comparison
    }
    const lowerCaseTargetUsername = targetUsername.toLowerCase();

    console.log(`[PICK COMMAND] ${username} attempting to pick ${targetUsername}`);

    if (!game3Started) {
        console.log(`[PICK COMMAND] Game 3 not started. User: ${username}`);
        await currentBotInstance.sendMessage(chatId, "❌ Game 3 is not running!").catch(console.error);
        return;
    }

    if (!allowPickingPartner) {
        console.log(`[PICK COMMAND] Partner picking not allowed yet. User: ${username}`);
        await currentBotInstance.sendMessage(chatId, "⚠️ You cannot pick a partner yet! Wait for the Front Man's instruction to lock in your partner.").catch(console.error);
        return;
    }

    if (lowerCaseTargetUsername === username.toLowerCase()) {
        console.log(`[PICK COMMAND] User tried to pick self. User: ${username}`);
        await currentBotInstance.sendMessage(chatId, "⚠️ You cannot pick yourself as your partner! Please choose someone else.").catch(console.error);
        return;
    }

    const player = currentRegisteredPlayers.find(p => p.id === userId && (p.status === "alive" || p.status === "safe"));
    if (!player) {
        console.log(`[PICK COMMAND] Player not in game or eliminated. User ID: ${userId}`);
        await currentBotInstance.sendMessage(chatId, "❌ You are not in the game or already eliminated!").catch(console.error);
        return;
    }
    if (player.partnerConfirmed) {
        console.log(`[PICK COMMAND] Player already confirmed partner. User: ${username}`);
        await currentBotInstance.sendMessage(chatId, "⚠️ You have already locked in a partner!").catch(console.error);
        return;
    }

    console.log(`[PICK COMMAND] Searching for targetPlayer: ${targetUsername} (normalized: ${lowerCaseTargetUsername})`);

    const targetPlayer = currentRegisteredPlayers.find(p =>
        getUsernameById(p.id).toLowerCase() === lowerCaseTargetUsername &&
        (p.status === "alive" || p.status === "safe")
    );

    if (!targetPlayer) {
        console.error(`[PICK ERROR] targetPlayer is undefined. Searched for: ${targetUsername}.`);
        await currentBotInstance.sendMessage(chatId, `❌ ${targetUsername} is not available, not registered, or already eliminated!`).catch(console.error);
        return;
    }

    console.log(`[PICK COMMAND] Found targetPlayer: ${getUsernameById(targetPlayer.id)}. Status: ${targetPlayer.status}`);

    if (targetPlayer.partnerConfirmed) {
        console.log(`[PICK COMMAND] Target player already confirmed partner. Target: ${getUsernameById(targetPlayer.id)}`);
        await currentBotInstance.sendMessage(chatId, `⚠️ ${targetUsername} has already locked in a partner!`).catch(console.error);
        return;
    }

    // If the target already picked the current player => auto lock both
    if (targetPlayer.pickedPartner === username) { // Use original 'username' as this is for comparison with what they 'picked'
        console.log(`[PICK COMMAND] Mutual pick confirmed between ${username} and ${targetUsername}`);
        player.partnerConfirmed = true;
        targetPlayer.partnerConfirmed = true;
        player.pickedPartner = null; // Clear pickedPartner once confirmed
        targetPlayer.pickedPartner = null; // Clear pickedPartner once confirmed

        const isPairAlreadyAdded = pairs.some(p =>
            (p[0].id === player.id && p[1].id === targetPlayer.id) ||
            (p[0].id === targetPlayer.id && p[1].id === player.id)
        );

        if (!isPairAlreadyAdded) {
            pairs.push([player, targetPlayer]);
            console.log(`[PICK COMMAND] Added new pair: ${getUsernameById(player.id)} - ${getUsernameById(targetPlayer.id)}`);
        } else {
            console.log(`[PICK COMMAND] Attempted to add existing pair ${getUsernameById(player.id)}-${getUsernameById(targetPlayer.id)}. Skipping.`);
        }

        await currentBotInstance.sendMessage(chatId, `🤝 ${username} and ${targetUsername} are now officially partners! 🫱🏼‍🫲🏼`).catch(console.error);
    } else {
        player.pickedPartner = targetUsername;
        console.log(`[PICK COMMAND] ${username} picked ${targetUsername}. Waiting for reciprocal pick.`);
        await currentBotInstance.sendMessage(chatId, `✅ You picked ${targetUsername}. Waiting for them to pick you back to lock in!`).catch(console.error);
    }

    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));
    console.log(`[PICK COMMAND] players.json updated.`);
}

/**
 * Starts the partner picking phase of the game.
 * @param {number} chatId - The ID of the chat.
 */
function startPartnerPhase(chatId) {
    let minutesLeft = 1; // 1 minute for picking partner

    partnerPhaseInterval = setInterval(async () => {
        minutesLeft--;
        if (minutesLeft > 0) {
            const noPartners = currentRegisteredPlayers.filter(p => (p.status === "alive" || p.status === "safe") && !p.partnerConfirmed);

            const message = `⏰ *${minutesLeft} minute(s) remaining to choose your partner!*\n\n` +
                `💀 *WARNING: Players without partners when the time is up will be eliminated without mercy!*\n\n` +
                `🚨 *Current players without partners:* \n${noPartners.map(p => `• ${getUsernameById(p.id)}`).join('\n') || "✅ Everyone has a partner! Keep it up!"}`;

            await currentBotInstance.sendMessage(chatId, message, { parse_mode: "Markdown" }).catch(console.error);
        }
    }, 60 * 1000); // Send reminder every minute (after the initial 2-min intro)

    partnerPhaseTimeout = setTimeout(async () => {
        clearInterval(partnerPhaseInterval);
        allowPickingPartner = false; // Disable /pick command

        const eliminatedPlayers = [];
        currentRegisteredPlayers.forEach(p => {
            if ((p.status === "alive" || p.status === "safe") && !p.partnerConfirmed) {
                p.status = "eliminated";
                eliminatedPlayers.push(p);
            }
        });
        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

        // Filter pairs to only include those where both players are still alive/safe
        pairs = pairs.filter(pair =>
            (pair[0].status === "alive" || pair[0].status === "safe") &&
            (pair[1].status === "alive" || pair[1].status === "safe")
        );

        const survivors = currentRegisteredPlayers.filter(p => p.partnerConfirmed && (p.status === "alive" || p.status === "safe")).map(p => getUsernameById(p.id));
        const eliminatedNames = eliminatedPlayers.map(p => getUsernameById(p.id));

        let summary = `🏁✨ <b>Partner phase has ended!</b> ✨🏁\n\n`;
        summary += `✅ Found partners:\n${survivors.map(u => `• ${u}`).join('\n') || "None"}\n\n`;
        summary += `💀 No partners (Eliminated):\n${eliminatedNames.map(u => `• ${u}`).join('\n') || "None"}`;

        await currentBotInstance.sendMessage(chatId, summary, { parse_mode: "HTML" }).catch(console.error)
            .then(async () => {
                if (eliminatedPlayers.length === 0) {
                    await currentBotInstance.sendMessage(chatId, "🎉 Amazing! Everyone found a partner and survived! 💪").catch(console.error)
                        .then(async () => {
                            const goodworkGifPath = GOOD_WORK_GIF_PATH;
                            if (fs.existsSync(goodworkGifPath)) {
                                await currentBotInstance.sendAnimation(chatId, fs.createReadStream(goodworkGifPath)).catch(console.error);
                            } else {
                                console.warn(`GIF not found at ${goodworkGifPath}. Skipping animation.`);
                            }
                        })
                        .then(() => {
                            setTimeout(async () => {
                                if (pairs.length === 0) {
                                    await currentBotInstance.sendMessage(chatId, "All players survived the partner phase, but no valid pairs were formed for the choice phase. Game 3 ends here.", { parse_mode: "HTML" }).catch(console.error);
                                    endGame3Cleanly(chatId);
                                } else {
                                    startChoicePhase(chatId); // CALL THE NEW CHOICE PHASE
                                }
                            }, 5000);
                        })
                        .catch(err => {
                            console.error("❌ Error in sending congratulations flow:", err);
                        });
                } else {
                    const eliminationGifPath = BYE_GIF_PATH;
                    if (fs.existsSync(eliminationGifPath)) {
                        await currentBotInstance.sendAnimation(chatId, fs.createReadStream(eliminationGifPath)).catch(console.error)
                            .then(async () => {
                                await currentBotInstance.sendMessage(chatId, "⚠️ 💀 Players without partners will be kicked in 10 seconds!").catch(console.error);
                            });
                    } else {
                        console.warn(`GIF not found at ${eliminationGifPath}. Skipping animation.`);
                        await currentBotInstance.sendMessage(chatId, "⚠️ 💀 Players without partners will be kicked in 10 seconds!").catch(console.error);
                    }

                    await new Promise(resolve => setTimeout(resolve, 10 * 1000)); // Wait for kick delay

                    for (const p of eliminatedPlayers) {
                        await kickPlayer(chatId, p.id, getUsernameById(p.id));
                    }

                    let afterKickMsg = `🏁✅ <b>Partner phase eliminations completed!</b>\n\n`;
                    afterKickMsg += `👥 Remaining Survivors: <b>${survivors.length}</b>\n`;
                    afterKickMsg += `💀 Total Eliminated: <b>${eliminatedNames.length}</b>`;

                    await currentBotInstance.sendMessage(chatId, afterKickMsg, { parse_mode: "HTML" }).catch(console.error);
                    const moneyGifPath = FALLING_MONEY_GIF_PATH;
                    if (fs.existsSync(moneyGifPath)) {
                        await currentBotInstance.sendAnimation(chatId, fs.createReadStream(moneyGifPath)).catch(console.error);
                    } else {
                        console.warn(`GIF not found at ${moneyGifPath}. Skipping animation.`);
                    }
                    console.log("✅ Celebration GIF sent!");

                    setTimeout(async () => {
                        if (pairs.length === 0) {
                            await currentBotInstance.sendMessage(chatId, "All surviving players formed pairs, but no pairs were valid for the choice phase. Game 3 ends here.", { parse_mode: "HTML" }).catch(console.error);
                            endGame3Cleanly(chatId);
                        } else {
                            startChoicePhase(chatId); // CALL THE NEW CHOICE PHASE
                        }
                    }, 5000);
                }
            })
            .catch(err => {
                console.error("❌ Error in partner phase summary or kick flow:", err);
            });
    }, 1 * 60 * 1000); // 1 minute for partner picking
}

/**
 * Starts the choice phase (Trust/Betray) of the game.
 * @param {number} chatId - The ID of the chat.
 */
async function startChoicePhase(chatId) {
    if (pairs.length === 0) {
        await currentBotInstance.sendMessage(chatId, "⚠️ No valid pairs were formed! Game 3 cannot continue to the choice phase.", { parse_mode: "HTML" }).catch(console.error);
        return endGame3Cleanly(chatId);
    }

    choicePhaseStarted = true; // Set choice phase active

    const choiceImgPath = SHAKE_IMAGE_PATH; // Re-using shake1.jpg for dilemma image

    try {
        if (fs.existsSync(choiceImgPath)) {
            await currentBotInstance.sendPhoto(chatId, fs.createReadStream(choiceImgPath), {
                caption:
                    "🤔 <b>THE FINAL TEST OF TRUST!</b>\n\n" +
                    "You are now face-to-face with your partner. Your fate, and theirs, rests on a single choice.\n\n" +
                    "🤫 You will be given two options: <b>Trust</b> or <b>Betray</b>.\n" +
                    "Choose wisely, as your decision will determine who survives.\n\n" +
                    "📊 Here's how it works:\n" +
                    "• If <b>both choose 'Trust'</b>: You both survive. 🎉\n" +
                    "• If <b>one chooses 'Trust' and the other 'Betray'</b>: The one who 'Trusted' is eliminated. The 'Betrayer' survives. 😈\n" +
                    "• If <b>both choose 'Betray'</b>: You are both eliminated. 💀\n\n" +
                    "⏰ You have <b>1 minute</b> to make your choice. Once made, it cannot be changed!\n\n" +
                    "Your choice buttons will appear shortly.",
                parse_mode: "HTML"
            }).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(chatId, "🤔 THE FINAL TEST OF TRUST!\n\nRules will be explained, then your buttons will appear.", { parse_mode: "HTML" }).catch(console.error);
            console.warn(`Image not found at ${choiceImgPath}. Sending text instructions only.`);
        }
    } catch (err) {
        console.error("❌ Failed to send dilemma image:", err.message);
        await currentBotInstance.sendMessage(chatId, "Error sending choice phase instructions image.").catch(console.error);
    }

    // Announce the delay
    await currentBotInstance.sendMessage(chatId, "⏳ The choice buttons will appear in **1 minute**. Use this time to consider your options wisely!", { parse_mode: "Markdown" }).catch(console.error);


    // Delay sending the "Trust" / "Betray" buttons
    setTimeout(async () => {
        // Send the "Trust" / "Betray" buttons to each player in active pairs
        for (const pair of pairs) {
            const [p1, p2] = pair;
            // Only send buttons to players who haven't made a choice yet and are alive/safe
            if (p1.status !== "eliminated" && p1.choice === null) {
                await sendChoiceButtons(p1.id, getUsernameById(p1.id)); // Send to private chat
            }
            if (p2.status !== "eliminated" && p2.choice === null) {
                await sendChoiceButtons(p2.id, getUsernameById(p2.id)); // Send to private chat
            }
        }
        await currentBotInstance.sendMessage(chatId, "🚨 **YOUR CHOICE BUTTONS HAVE APPEARED!** Look for them now to make your selection.", { parse_mode: "Markdown" }).catch(console.error);

        // Start the main timeout for choice phase resolution
        choicePhaseTimeout = setTimeout(() => {
            resolveChoicePhase(chatId);
        }, 60 * 1000); // 1 minute to choose after buttons appear

    }, 1 * 60 * 1000); // 1 minute delay for the buttons
}

/**
 * Resolves the choice phase, determining who survives based on Trust/Betray choices.
 * @param {number} chatId - The ID of the chat.
 */
async function resolveChoicePhase(chatId) {
    if (!game3Started) return; // Ensure game is still active

    clearTimeout(choicePhaseTimeout); // Clear any lingering timeout

    // Remove choice buttons for all players. This needs to be done for each player's private chat.
    // Since we don't have a direct list of all private chat IDs, we iterate through players
    // who were active in this phase and attempt to remove buttons.
    const allPlayersInPairs = pairs.flat(); // Get all players from all pairs
    for (const player of allPlayersInPairs) {
        if (player.status === "alive" || player.status === "safe") {
            await removeChoiceButtons(player.id); // Attempt to remove from private chat
        }
    }


    const survivors = [];
    const eliminated = [];
    const choiceSummary = [];

    const activePairs = pairs.filter(pair =>
        (pair[0].status === "alive" || pair[0].status === "safe") &&
        (pair[1].status === "alive" || pair[1].status === "safe")
    );

    if (activePairs.length === 0) {
        await currentBotInstance.sendMessage(chatId, "No active pairs left to resolve in the Choice Phase. Ending Game 3.", { parse_mode: "HTML" }).catch(console.error);
        return endGame3Cleanly(chatId);
    }

    for (const pair of activePairs) {const path = require("path");
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
const REQUIRED_RUN_DURATION_MS = 45 * 1000; // 45 seconds to reach 100%
const PROGRESS_PER_MS = 100 / REQUIRED_RUN_DURATION_MS; // Progress per millisecond

/**
 * Sends the RUN/STOP reply keyboard buttons to the chat.
 * @param {number} chatId - The ID of the chat.
 */
async function sendGameButtons(chatId) {
    try {
        await currentBotInstance.sendMessage(chatId, "🎮 Choose your action:", {
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

        const [p1, p2] = pair;

        // Default choice to "Betray" if no choice was made (timeout)
        p1.choice = p1.choice || "Betray";
        p2.choice = p2.choice || "Betray";

        choiceSummary.push(`🤝 <b>${getUsernameById(p1.id)}</b> chose: <b>${p1.choice}</b>`);
        choiceSummary.push(`🤝 <b>${getUsernameById(p2.id)}</b> chose: <b>${p2.choice}</b>`);

        let outcomeMessage = ``;

        if (p1.choice === "Trust" && p2.choice === "Trust") {
            // Both Trust: Both Survive
            p1.status = "alive"; // Set back to alive for next game
            p2.status = "alive";
            survivors.push(getUsernameById(p1.id), getUsernameById(p2.id));
            outcomeMessage = `🎉 <b>Both ${getUsernameById(p1.id)} and ${getUsernameById(p2.id)} chose to TRUST each other! Both survive!</b>`;
        } else if (p1.choice === "Betray" && p2.choice === "Betray") {
            // Both Betray: Both Eliminated
            p1.status = "eliminated";
            p2.status = "eliminated";
            eliminated.push(getUsernameById(p1.id), getUsernameById(p2.id));
            outcomeMessage = `💀 <b>Both ${getUsernameById(p1.id)} and ${getUsernameById(p2.id)} chose to BETRAY each other! Both are eliminated!</b>`;
        } else {
            // One Trust, One Betray
            if (p1.choice === "Trust" && p2.choice === "Betray") {
                p1.status = "eliminated";
                p2.status = "alive";
                survivors.push(getUsernameById(p2.id));
                eliminated.push(getUsernameById(p1.id));
                outcomeMessage = `💔 <b>${getUsernameById(p2.id)} BETRAYED ${getUsernameById(p1.id)}! ${getUsernameById(p1.id)} is eliminated, ${getUsernameById(p2.id)} survives!</b>`;
            } else { // p1.choice === "Betray" && p2.choice === "Trust"
                p1.status = "alive";
                p2.status = "eliminated";
                survivors.push(getUsernameById(p1.id));
                eliminated.push(getUsernameById(p2.id));
                outcomeMessage = `💔 <b>${getUsernameById(p1.id)} BETRAYED ${getUsernameById(p2.id)}! ${getUsernameById(p2.id)} is eliminated, ${getUsernameById(p1.id)} survives!</b>`;
            }
        }
        choiceSummary.push(outcomeMessage);
        choiceSummary.push("\n"); // Add a separator for clarity
    }

    let finalMessage = `🏁 <b>CHOICE PHASE RESULTS!</b> 🏁\n\n`;
    finalMessage += choiceSummary.join('\n');

    await currentBotInstance.sendMessage(chatId, finalMessage, { parse_mode: "HTML" }).catch(console.error);

    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    const actualEliminatedPlayers = currentRegisteredPlayers.filter(p => p.status === "eliminated");
    const actualEliminatedNames = actualEliminatedPlayers.map(p => getUsernameById(p.id));

    if (actualEliminatedPlayers.length > 0) {
        const eliminationMsg = `💀 <b>The following players were eliminated and will be kicked in 10 seconds:</b>\n\n${actualEliminatedNames.map(u => `• ${u}`).join('\n')}`;
        await currentBotInstance.sendMessage(chatId, eliminationMsg, { parse_mode: "HTML" }).catch(console.error);
        const eliminationGifPath = BYE_GIF_PATH;
        if (fs.existsSync(eliminationGifPath)) {
            await currentBotInstance.sendAnimation(chatId, fs.createReadStream(eliminationGifPath)).catch(console.error);
        } else {
            console.warn(`GIF not found at ${eliminationGifPath}. Skipping animation.`);
        }
        await new Promise(resolve => setTimeout(resolve, 10 * 1000));

        for (const player of actualEliminatedPlayers) {
            await kickPlayer(chatId, player.id, getUsernameById(player.id));
        }

        let afterKickMsg = `🏁✅ <b>Choice Phase Eliminations Completed!</b>\n\n`;
        afterKickMsg += `👥 <b>Remaining Survivors:</b> ${survivors.length}\n`;
        afterKickMsg += `💀 <b>Total Eliminated:</b> ${actualEliminatedNames.length}`;

        await currentBotInstance.sendMessage(chatId, afterKickMsg, { parse_mode: "HTML" }).catch(console.error);
        const moneyGifPath = FALLING_MONEY_GIF_PATH;
        if (fs.existsSync(moneyGifPath)) {
            await currentBotInstance.sendAnimation(chatId, fs.createReadStream(moneyGifPath)).catch(console.error);
        } else {
            console.warn(`GIF not found at ${moneyGifPath}. Skipping animation.`);
        }
        console.log("✅ Celebration GIF sent!");
    } else {
        await currentBotInstance.sendMessage(chatId, `✅ <b>Everyone survived the choice phase! 🎉</b>`, { parse_mode: "HTML" }).catch(console.error);
        const moneyGifPath = FALLING_MONEY_GIF_PATH;
        if (fs.existsSync(moneyGifPath)) {
            await currentBotInstance.sendAnimation(chatId, fs.createReadStream(moneyGifPath)).catch(console.error);
        } else {
            console.warn(`GIF not found at ${moneyGifPath}. Skipping animation.`);
        }
        console.log("✅ Celebration GIF sent!");
    }

    endGame3Cleanly(chatId);
}

/**
 * Starts the Trust Game. This function is called by the game coordinator.
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

    console.log("Starting Trust Game (Game 3)...");

    // Reset game state for a fresh start
    resetGame3State();
    game3Started = true;

    const alivePlayers = currentRegisteredPlayers.filter(p => p.status === "alive");
    if (alivePlayers.length < 2) {
        await currentBotInstance.sendMessage(currentChatId, "❌ Cannot start Game 3! Need at least 2 alive players to form pairs. Skipping round.", { parse_mode: "HTML" }).catch(console.error);
        if (gameEndCallback) gameEndCallback(currentRegisteredPlayers);
        return;
    }

    // Reset player-specific game data for this game
    currentRegisteredPlayers.forEach(p => {
        if (p.status === "alive" || p.status === "safe") {
            p.pickedPartner = null;
            p.partnerConfirmed = false;
            p.choice = null; // Reset choice for Trust/Betray
        }
    });
    fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

    const trustImgPath = SHAKE_IMAGE_PATH;

    try {
        if (fs.existsSync(trustImgPath)) {
            await currentBotInstance.sendPhoto(currentChatId, fs.createReadStream(trustImgPath), {
                caption:
                    "🤝 <b>Game 3: TRUST GAME!</b>\n\n" +
                    "This round is a <b>partner-based</b> game. You must find a partner you trust — or face elimination.\n\n" +
                    "⏰ You have <b>1 minute</b> to look for and choose your partner. After this phase ends, the Front Man will announce how to <b>lock in</b> your chosen partner.\n\n" +
                    "⚠️ <b>Important:</b> Players without partners after this phase will be <b>eliminated without mercy</b>.\n\n" +
                    "Good luck... choose wisely! 🔥",
                parse_mode: "HTML"
            }).catch(console.error);
        } else {
            await currentBotInstance.sendMessage(currentChatId, "🤝 Game 3: TRUST GAME!\n\nPick your most trusted friend as your partner. You have 1 minute to decide...", { parse_mode: "HTML" }).catch(console.error);
            console.warn(`Image not found at ${trustImgPath}. Sending text instructions only.`);
        }
    } catch (err) {
        console.error("❌ Failed to send trust game image:", err.message);
        await currentBotInstance.sendMessage(currentChatId, "Error sending game instructions image.").catch(console.error);
    }

    // Delay for initial partner discussion phase (1 minute)
    setTimeout(async () => {
        if (!game3Started) return; // Check if game was stopped during prep time

        allowPickingPartner = true; // Enable /pick command
        await currentBotInstance.sendMessage(currentChatId,
            "🤝 <b>Lock your choice!</b>\n\n" +
            "🕰️ Now is the time to officially pick your partner.\n" +
            "Use the command: <b>/pick @username</b> to lock in your partner.\n\n" +
            "⏰ You have <b>1 minute</b> to decide. After this, there is no turning back.\n\n" +
            "⚠️ <b>Remember:</b> If you fail to pick a partner in time, you will be <b>eliminated</b>."
            , { parse_mode: "HTML" }).catch(console.error);

        startPartnerPhase(currentChatId); // Start the 1-minute partner picking phase
    }, 1 * 60 * 1000); // 1 minute for initial discussion

    // --- Register Bot.onText handlers ---
    pickCommandListenerId = currentBotInstance.onText(/\/pick (.+)/, async (msg, match) => {
        handlePickCommand(msg, match);
    });

    trustBetrayListenerId = currentBotInstance.onText(/^(🤝 Trust|🔪 Betray)$/, async (msg) => {
        const userId = msg.from.id;
        const username = getUsernameById(userId);
        const choice = msg.text === "🤝 Trust" ? "Trust" : "Betray";

        // This listener should only process messages from private chats
        if (msg.chat.type !== "private") return;

        if (!choicePhaseStarted) {
            await currentBotInstance.sendMessage(userId, "❌ You can't make a choice now! The game is not in a choice phase.").catch(console.error);
            return;
        }

        const player = currentRegisteredPlayers.find(p => p.id === userId && p.partnerConfirmed && p.status !== "eliminated");

        if (!player) {
            await currentBotInstance.sendMessage(userId, "❌ You are not in the game or eligible to make a choice!").catch(console.error);
            return;
        }

        if (player.choice !== null) {
            await currentBotInstance.sendMessage(userId, "⚠️ You have already made your choice! You cannot change it.").catch(console.error);
            return;
        }

        player.choice = choice;
        fs.writeFileSync(currentPlayerDataFile, JSON.stringify(currentRegisteredPlayers, null, 2));

        await currentBotInstance.sendMessage(userId, `✅ Your choice of <b>${choice}</b> has been recorded! Please wait for the results in the group chat.`, { parse_mode: "HTML" }).catch(console.error);

        // Check if all players in the pair have made their choice
        const playerPair = pairs.find(p => p[0].id === userId || p[1].id === userId);
        if (playerPair) {
            const otherPlayer = playerPair[0].id === userId ? playerPair[1] : playerPair[0];
            if (otherPlayer.choice !== null) {
                // Both players in this pair have made their choice, no need to wait for global timeout for them
                // This could trigger an early resolution for just this pair if desired,
                // but for simplicity, we'll let the main choicePhaseTimeout handle the overall resolution.
            }
        }
    });

    // Register admin stop command for this specific game
    stopGame3ListenerId = currentBotInstance.onText(/\/stopgame3/, async (msg) => {
        if (msg.chat.id !== currentChatId) return; // Only respond in the active game chat
        if (msg.from.id !== currentAdminId) {
            return currentBotInstance.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" }).catch(console.error);
        }
        if (!game3Started) {
            return currentBotInstance.sendMessage(msg.chat.id, "⚠️ Game 3 is not running.", { parse_mode: "HTML" }).catch(console.error);
        }

        console.log("Game 3 manually stopped.");

        // Clear any pending timers
        if (partnerPhaseInterval) clearInterval(partnerPhaseInterval);
        if (partnerPhaseTimeout) clearTimeout(partnerPhaseTimeout);
        if (choicePhaseTimeout) clearTimeout(choicePhaseTimeout);

        // Reset game state and clean up listeners
        resetGame3State();

        if (pickCommandListenerId) {
            currentBotInstance.removeTextListener(/\/pick (.+)/, pickCommandListenerId);
            pickCommandListenerId = null;
        }
        if (trustBetrayListenerId) {
            currentBotInstance.removeTextListener(/^(🤝 Trust|🔪 Betray)$/, trustBetrayListenerId);
            trustBetrayListenerId = null;
        }
        if (stopGame3ListenerId) {
            currentBotInstance.removeTextListener(/\/stopgame3/, stopGame3ListenerId);
            stopGame3ListenerId = null;
        }

        // Attempt to remove choice buttons from all players' private chats
        const allPlayers = currentRegisteredPlayers.filter(p => p.status === "alive" || p.status === "eliminated");
        for (const player of allPlayers) {
            await removeChoiceButtons(player.id);
        }

        await currentBotInstance.sendMessage(currentChatId, `🛑 Game 3 has been forcefully stopped!`, { parse_mode: "HTML" }).catch(console.error);

        // Notify the game coordinator that this game has finished
        if (gameEndCallback) {
            gameEndCallback(currentRegisteredPlayers);
        }
    });

    console.log("Trust Game initialized and listeners set.");
}

module.exports = {
    startGame
};
