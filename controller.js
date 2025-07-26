const fs = require('fs');
const TelegramBot = require('node-telegram-bot-api');
const path = require("path");
const { promisify } = require('util');
const sleep = promisify(setTimeout); // Helper for rate limiting/delays

// --- Bot Configuration ---
const token = '7844745835:AAHPQ6omh7DHzQlfSPBFJW8_7rqce9h0hek'; // Replace with your bot token
const bot = new TelegramBot(token, { polling: true });

const ADMIN_ID = 5622408740; // Replace with your Telegram User ID
const PLAYER_DATA_FILE = 'players.json'; // Persistent storage for player data

// --- Spam Prevention Variables ---
const eliminatedPlayerSpam = new Map(); // Stores { userId: { count: number, lastMsgTime: number } }
const SPAM_THRESHOLD = 3; // Number of messages to be considered spam for deletion
const SPAM_INTERVAL_MS = 2000; // Time window (in ms) for consecutive spam messages

// --- Game State Variables (Global for all game functions) ---
let maxSlots = 0; // Max players allowed for registration
let registrationOpen = false; // Is player registration currently active?


// --- Player Data Management ---
// Initialize registeredPlayers and load existing data from file
let registeredPlayers = [];
if (fs.existsSync(PLAYER_DATA_FILE)) {
  try {
    registeredPlayers = JSON.parse(fs.readFileSync(PLAYER_DATA_FILE));
  } catch (e) {
    console.error("Error loading players.json:", e);
    registeredPlayers = []; // Reset if file is corrupted
    fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2)); // Recreate empty file
  }
} else {
  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2)); // Create empty file if it doesn't exist
}

bot.onText(/\/kupal_id/, async (msg) => {
  const chatId = msg.chat.id;
  const from = msg.from;

  const username = from.username ? `@${from.username}` : "No username";
  const fullName = `${from.first_name || ""} ${from.last_name || ""}`.trim();

  const message = `
🪪 <b>User Info</b>
<b>Username:</b> ${username}
<b>User ID:</b> <code>${from.id}</code>
<b>Name:</b> ${fullName || "Not available"}
  `.trim();

  bot.sendMessage(chatId, message, { parse_mode: "HTML" });
});
bot.onText(/\/start (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start the game!");
  }

  maxSlots = parseInt(match[1]);
  registeredPlayers = []; // Clear players for a new registration
  registrationOpen = true;

  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));

  const instructions = `
🎮 *Welcome to Squid Game Registration!*

- 👥 Maximum slots: *${maxSlots}*
- 🕒 You have *5 minutes* to register.
- 🟢 To join, *DM me* (@squiidgamee_bot) with the command: */join*
- ✅ Registration will automatically close once all the slots are filled.

Get ready, players! 💥
    `;

  const startImgPath = path.resolve(__dirname, "images", "start.jpg");
  await bot.sendPhoto(msg.chat.id, fs.createReadStream(startImgPath), {
    caption: instructions,
    parse_mode: "Markdown"
  }).catch((err) => {
    console.error("❌ Failed to send start image:", err);
  });

  // Auto-close registration after 2 mins
  setTimeout(() => {
    if (registrationOpen) {
      registrationOpen = false;
      bot.sendMessage(msg.chat.id, "⏰ Registration time is over! Slots are now closed.");
    }
  }, 2 * 60 * 1000); // 2 minutes
});

// Reset Command (for Admin)
bot.onText(/\/reset/, (msg) => {
  if (msg.from.id !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "⚠️ Only the host can reset!");
  }

  registeredPlayers = [];
  maxSlots = 0;
  registrationOpen = false;

  // Delete and recreate the players.json file
  if (fs.existsSync(PLAYER_DATA_FILE)) fs.unlinkSync(PLAYER_DATA_FILE);
  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify([], null, 2));

  bot.sendMessage(msg.chat.id, "♻️ All data reset! Ready for a new game.");
});

// Join Command
bot.onText(/\/join/, async (msg) => {
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  if (!registrationOpen) {
    return bot.sendMessage(msg.chat.id, "❌ Registration is not open!");
  }

  if (registeredPlayers.find(p => p.id === userId)) {
    return bot.sendMessage(msg.chat.id, `⚠️ ${username}, you have already joined!`);
  }

  if (registeredPlayers.length >= maxSlots) {
    return bot.sendMessage(msg.chat.id, "❌ All slots are filled!");
  }

  registeredPlayers.push({
    id: userId,
    username,
    status: "alive", // New players start as alive
    progress: 0,
    stopped: false,
    isRunning: false,
    runStartTime: null,
    hasMoved: false
  });

  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));

  const joinedMsg = `
✅ *${username} has successfully joined the game!* ⭕ 🔺 ◼️

Slots filled: *${registeredPlayers.length}/${maxSlots}*

🎮 Get ready! Wait for the host to start the game.
    `;

  await bot.sendMessage(msg.chat.id, joinedMsg, { parse_mode: "Markdown" }).catch(console.error);

  if (registeredPlayers.length === maxSlots) {
    registrationOpen = false;
    await bot.sendMessage(msg.chat.id, "🎉 All slots are full! Registration is now closed.").catch(console.error);
  }
});



let game1Started = false;
let game1Phase = "waiting"; // "waiting", "red", "green"
let game1Timeout = null; // Stores the setTimeout ID for game end
let game1Interval = null; // Stores the setInterval ID for light changes
let game1EndTime = null; // Timestamp for when Game 1 should end
// Start Game 1 Command (Red Light, Green Light)
bot.onText(/\/startgame1/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start Game 1!");
  if (game1Started) return bot.sendMessage(msg.chat.id, "⚠️ Game 1 already started!");

  const alivePlayers = registeredPlayers.filter(p => p.status === "alive");
  if (alivePlayers.length === 0) {
    return bot.sendMessage(msg.chat.id, "⚠️ No alive players registered! Cannot start the game.");
  }

  // Reset game 1 specific states for all registered players
  registeredPlayers.forEach(p => {
    // For players who are "alive", reset their game-specific progress
    if (p.status === "alive") {
      p.progress = 0;
      p.stopped = false;
      p.isRunning = false;
      p.runStartTime = null;
      p.hasMoved = false;
    }
    // If a player was eliminated in a previous game but still in the list (e.g., if /reset wasn't used),
    // ensure they are unrestricted. They won't participate as `alivePlayers` filters them out.
    // This is a safety measure.
    if (p.status === "eliminated") {
      // Attempt to unrestrict any eliminated players, in case bot restarts or admin wants to manually re-add.
      // This doesn't make them 'alive' for the new game, just un-mutes them in chat if not kicked.
      bot.restrictChatMember(msg.chat.id, p.id, {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
        can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
        can_add_web_page_previews: true, can_change_info: true, can_invite_users: true,
        can_pin_messages: true, can_manage_topics: true
      }).catch(err => {
        // Log but don't stop execution if unrestrict fails (e.g., player already left or bot permission issue)
        console.warn(`Could not unrestrict player ${p.username} (ID: ${p.id}) during game start: ${err.message}`);
      });
    }
  });
  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2)); // Save reset states

  const instructions = `
🎮 *Game 1: Red Light, Green Light*

- ⏱ You have *5 minutes* to finish the game.
- 🟢 *Green Light*: click the *RUN* button to move forward.
- 🔴 *Red Light*: click *STOP* to freeze before the red light.

- ❌ If you fail to stop before Red Light, or if you move during Red Light, you will be *eliminated immediately*.

- 💯 Your goal is to reach *100% progress* to survive.
- ⚠️ You have 1 minute to prepare

Best of luck, players! 💚❤️
`;

  const instructionsImgPath = path.resolve(__dirname, "images", "game1.jpg");
  await bot.sendPhoto(msg.chat.id, fs.createReadStream(instructionsImgPath), {
    caption: instructions,
    parse_mode: "Markdown"
  }).catch(console.error);

  game1Phase = "waiting";
  game1Started = false; // Will be set to true after the 1-minute prep

  setTimeout(async () => {
    game1Phase = "red"; // Game starts with Red Light
    game1Started = true;
    game1EndTime = Date.now() + 5 * 60 * 1000; // 5 minutes total game time

    await sendGameButtons(msg.chat.id); // Send the RUN/STOP buttons
    await bot.sendMessage(msg.chat.id, "🔴 Red Light! Get ready...").catch(console.error);

    game1Interval = setInterval(async () => {
      const remainingMs = game1EndTime - Date.now();
      const mins = Math.floor(remainingMs / 60000);
      const secs = Math.floor((remainingMs % 60000) / 1000);

      if (remainingMs <= 0) {
        // Time's up, end the game
        clearInterval(game1Interval);
        clearTimeout(game1Timeout);
        game1Interval = null;
        game1Timeout = null;
        game1Started = false;
        await endGame1(msg.chat.id);
        return;
      }

      if (game1Phase === "green") {
        game1Phase = "red";

        const redImgPath = path.resolve(__dirname, "images", "red.jpg");
        await bot.sendPhoto(msg.chat.id, fs.createReadStream(redImgPath)).catch(console.error);
        await bot.sendMessage(msg.chat.id, `🔴 Red Light! Stop!\n⏰ Remaining: ${mins}m ${secs}s`).catch(console.error);

        // Check players who were running during Green Light but didn't stop before Red Light hit
        // Using for...of loop to correctly await `mutePlayer`
        for (const p of registeredPlayers) {
          // Only eliminate if progress is NOT yet 100% AND they were running AND they are still alive
          if (p.status === "alive" && p.isRunning && p.progress < 100) {
            p.status = "eliminated";
            p.isRunning = false;
            p.runStartTime = null;

            let progressMsg = `💀 <b>${p.username}</b> didn't stop in time and was eliminated!\n`;
            progressMsg += `💔 Final progress: <b>${Math.floor(p.progress)}%</b>`;
            await bot.sendMessage(msg.chat.id, progressMsg, { parse_mode: "HTML" }).catch(console.error);

            // MUTE THE PLAYER IMMEDIATELY
            await mutePlayer(msg.chat.id, p.id, p.username);
          }
        }
        fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));

      } else { // Current phase is "red", switching to "green"
        game1Phase = "green";

        const greenImgPath = path.resolve(__dirname, "images", "green.jpg");
        await bot.sendPhoto(msg.chat.id, fs.createReadStream(greenImgPath)).catch(console.error);
        await bot.sendMessage(msg.chat.id, `🟢 Green Light! Run!\n⏰ Remaining: ${mins}m ${secs}s`).catch(console.error);

        registeredPlayers.forEach(p => {
          if (p.status === "alive") {
            p.stopped = false;
            p.isRunning = false; // Players start as not running, they need to press RUN
            p.runStartTime = null;
          }
        });
      }
    }, Math.floor(Math.random() * 15000) + 15000); // Random interval (15-30 seconds)

    game1Timeout = setTimeout(() => {
      clearInterval(game1Interval);
      game1Interval = null;
      game1Timeout = null;
      game1Started = false;
      endGame1(msg.chat.id);
    }, 5 * 60 * 1000); // Total game duration timeout

    await bot.sendMessage(msg.chat.id, "🏁 Game 1 started! Wait for Green Light to move!").catch(console.error);
  }, 60 * 1000); // 1-minute preparation time before game starts
});

// Handle "🟢 RUN" command
bot.onText(/🟢 RUN/, async (msg) => {
  const userId = msg.from.id;
  const username = msg.from.first_name || msg.from.username;
  const player = registeredPlayers.find(p => p.id === userId);
  const chatId = msg.chat.id;

  // --- SPAM PREVENTION & INITIAL PLAYER STATUS CHECK ---
  if (!player || player.status !== "alive") {
    if (player && player.status === "eliminated") {
      const isSpam = await handleEliminatedPlayerSpam(userId, chatId, msg.message_id, username);
      if (isSpam) return; // If spam, the user's message was deleted, no further action needed

      // If not spam, but eliminated, inform them they can't move and DELETE THIS BOT MESSAGE SHORTLY
      const botResponse = await bot.sendMessage(chatId, `💀 ${username}, you are eliminated and cannot move.`, { reply_to_message_id: msg.message_id }).catch(console.error);
      if (botResponse) { // If message sent successfully, schedule its deletion
        setTimeout(() => {
          bot.deleteMessage(chatId, botResponse.message_id).catch(err => console.error("Error deleting bot response:", err.message));
        }, 7000); // Delete after 7 seconds
      }
      return;
    }
    return; // Player not in game or not alive, ignore
  }

  // --- GAME LOGIC FOR ALIVE PLAYERS ---
  if (!game1Started || game1Phase === "waiting") {
    return bot.sendMessage(chatId, "⛔ Wait for the game to start!", { reply_to_message_id: msg.message_id }).catch(console.error);
  }

  // BUG FIX: If player is already at 100% progress, they are safe and cannot be eliminated by moving
  if (player.progress >= 100) {
    return bot.sendMessage(chatId, "✅ You've already reached 100% progress and are safe!", { reply_to_message_id: msg.message_id }).catch(console.error);
  }

  // ELIMINATION: Player moved during Red Light
  if (game1Phase !== "green") {
    player.status = "eliminated";
    player.isRunning = false;
    player.runStartTime = null;

    fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));
    const botResponse = await bot.sendMessage(chatId, `💀 <b>${player.username}</b> moved during Red Light and was eliminated!`, { parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(console.error);
    if (botResponse) { // If message sent successfully, schedule its deletion
      setTimeout(() => {
        bot.deleteMessage(chatId, botResponse.message_id).catch(err => console.error("Error deleting bot response:", err.message));
      }, 7000); // Delete after 7 seconds
    }
    // MUTE THE PLAYER IMMEDIATELY
    await mutePlayer(chatId, player.id, player.username);
    return;
  }

  // Prevent double-running
  if (player.isRunning) {
    return bot.sendMessage(chatId, "⚠️ You're already running!", { reply_to_message_id: msg.message_id }).catch(console.error);
  }

  player.isRunning = true;
  player.runStartTime = Date.now();
  player.hasMoved = true; // Indicates they have made a move in the game

  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));
  return bot.sendMessage(chatId, "🏃 You started running!", { reply_to_message_id: msg.message_id }).catch(console.error);
});

// Handle "🔴 STOP" command
bot.onText(/🔴 STOP/, async (msg) => {
  const userId = msg.from.id;
  const username = msg.from.first_name || msg.from.username;
  const player = registeredPlayers.find(p => p.id === userId);
  const chatId = msg.chat.id;

  // --- SPAM PREVENTION & INITIAL PLAYER STATUS CHECK ---
  if (!player || player.status !== "alive") {
    if (player && player.status === "eliminated") {
      const isSpam = await handleEliminatedPlayerSpam(userId, chatId, msg.message_id, username);
      if (isSpam) return; // If spam, the user's message was deleted, no further action needed

      // If not spam, but eliminated, inform them they can't move and DELETE THIS BOT MESSAGE SHORTLY
      const botResponse = await bot.sendMessage(chatId, `💀 ${username}, you are eliminated and cannot move.`, { reply_to_message_id: msg.message_id }).catch(console.error);
      if (botResponse) { // If message sent successfully, schedule its deletion
        setTimeout(() => {
          bot.deleteMessage(chatId, botResponse.message_id).catch(err => console.error("Error deleting bot response:", err.message));
        }, 7000); // Delete after 7 seconds
      }
      return;
    }
    return; // Player not in game or not alive, ignore
  }

  // --- GAME LOGIC FOR ALIVE PLAYERS ---
  if (!game1Started || game1Phase === "waiting") {
    return bot.sendMessage(chatId, "⛔ Wait for the game to start!", { reply_to_message_id: msg.message_id }).catch(console.error);
  }

  // BUG FIX: If player is already at 100% progress, they are safe
  if (player.progress >= 100) {
    return bot.sendMessage(chatId, "✅ You've already reached 100% progress and are safe!", { reply_to_message_id: msg.message_id }).catch(console.error);
  }

  if (!player.isRunning) {
    return bot.sendMessage(chatId, "⚠️ You're not running!", { reply_to_message_id: msg.message_id }).catch(console.error);
  }

  // Calculate progress only if running
  const runTimeMs = Date.now() - player.runStartTime;
  const runTimeSec = runTimeMs / 1000;
  // Assuming 60 seconds of continuous running in Green Light phase to reach 100% progress
  let progressGain = (runTimeSec / 60) * 100;
  if (progressGain < 0) progressGain = 0; // Ensure progress doesn't go negative

  player.progress += progressGain;
  if (player.progress > 100) player.progress = 100; // Cap progress at 100%

  player.isRunning = false;
  player.runStartTime = null;
  player.stopped = true; // Indicates they successfully stopped

  let responseMsg = "";
  if (player.progress >= 100) {
    // Player status remains "alive" as they survived this game.
    responseMsg = `🏆 <b>${player.username}</b> has crossed the finish line and is SAFE! 🎉🎉`;
  } else {
    responseMsg = `🛑 <b>${player.username}</b> stopped!\n📈 Progress: <b>${Math.floor(player.progress)}%</b>`;
  }

  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));
  return bot.sendMessage(chatId, responseMsg, { parse_mode: "HTML", reply_to_message_id: msg.message_id }).catch(console.error);
});

// Stop Game 1 Command (for Admin)
bot.onText(/\/stopgame1/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can stop Game 1!");
  if (!game1Started && !game1Interval && !game1Timeout) return bot.sendMessage(msg.chat.id, "❌ Game 1 not running!");

  clearInterval(game1Interval);
  clearTimeout(game1Timeout);
  game1Interval = null;
  game1Timeout = null;
  game1Started = false;

  endGame1(msg.chat.id); // Trigger game end sequence
});



// --- Helper Functions ---

/**
 * Handles spam attempts from eliminated players.
 * Deletes message if spamming threshold is met.
 * @param {number} userId - The ID of the user.
 * @param {number} chatId - The ID of the chat.
 * @param {number} messageId - The ID of the message to potentially delete.
 * @param {string} username - The username of the player for logging.
 * @returns {Promise<boolean>} True if the message was deleted due to spam, false otherwise.
 */
async function handleEliminatedPlayerSpam(userId, chatId, messageId, username) {
  let spamData = eliminatedPlayerSpam.get(userId);
  const currentTime = Date.now();

  if (!spamData || (currentTime - spamData.lastMsgTime > SPAM_INTERVAL_MS)) {
    // Reset if no data or last message was too long ago
    spamData = { count: 1, lastMsgTime: currentTime };
  } else {
    // Increment count if within spam interval
    spamData.count++;
    spamData.lastMsgTime = currentTime;
  }

  eliminatedPlayerSpam.set(userId, spamData);

  if (spamData.count >= SPAM_THRESHOLD) {
    try {
      await bot.deleteMessage(chatId, messageId);
      console.log(`Deleted spam message from ${username} (ID: ${userId})`);
      // Reset count after deleting to prevent continuous deletion from one spam burst
      spamData.count = 0;
      eliminatedPlayerSpam.set(userId, spamData);
      return true; // Message was deleted
    } catch (error) {
      console.error(`Error deleting spam message from ${username} in chat ${chatId}:`, error.message);
      // If bot doesn't have delete_messages permission, it will fail.
      // Still reset count to prevent endless attempts.
      spamData.count = 0;
      eliminatedPlayerSpam.set(userId, spamData);
      return false; // Message could not be deleted
    }
  }
  return false; // Message was not deleted
}

/**
 * Sends the RUN/STOP reply keyboard buttons to the chat.
 * @param {number} chatId - The ID of the chat.
 */
async function sendGameButtons(chatId) {
  try {
    await bot.sendMessage(chatId, "🎮 Choose your action:", {
      reply_markup: {
        keyboard: [
          [{ text: "🟢 RUN" }, { text: "🔴 STOP" }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });
    console.log("Reply keyboard buttons sent successfully.");
  } catch (err) {
    console.error(`❌ Failed to send game buttons to chat ${chatId}:`, err.message);
    bot.sendMessage(chatId, `⚠️ Error sending game buttons: ${err.message}`).catch(console.error);
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
    await bot.restrictChatMember(chatId, userId, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false, // This covers stickers, gifs, etc.
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
      can_manage_topics: false // Relevant if the group is a forum
    });
    console.log(`Successfully muted ${username} (ID: ${userId}) in chat ${chatId}`);
    // Optionally, send a temporary message that the player has been muted
    const muteConfirmMsg = await bot.sendMessage(chatId, `🔇 ${username} has been muted due to elimination.`, { disable_notification: true }).catch(console.error);
    if (muteConfirmMsg) {
      setTimeout(() => {
        bot.deleteMessage(chatId, muteConfirmMsg.message_id).catch(err => console.error("Error deleting mute confirmation message:", err.message));
      }, 5000); // Delete after 5 seconds
    }
  } catch (err) {
    console.error(`❌ Failed to mute ${username} (ID: ${userId}) in chat ${chatId}:`, err.message);
    if (err.response && err.response.statusCode === 400 && err.response.description.includes("not enough rights")) {
      await bot.sendMessage(chatId, `⚠️ Failed to mute ${username}. Make sure the bot is an admin with 'Restrict members' permission!`).catch(console.error);
    }
  }
}



/**
 * Ends Game 1, calculates results, removes keyboard, and kicks eliminated players.
 * @param {number} chatId - The ID of the chat where the game is running.
 */
async function endGame1(chatId) {
  const totalParticipantsInGame1 = registeredPlayers.filter(p => p.status === "alive").length;

  // Mark any remaining alive players who didn't reach 100% as eliminated
  registeredPlayers.forEach(p => {
    if (p.status === "alive" && p.progress < 100) {
      p.status = "eliminated";
    }
  });

  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));

  const survivors = registeredPlayers.filter(p => p.status === "alive");
  const eliminated = registeredPlayers.filter(p => p.status === "eliminated");

  // Remove the reply keyboard at the end of the game
  try {
    await bot.sendMessage(chatId, "Game has ended. Removing game controls.", {
      reply_markup: {
        remove_keyboard: true
      }
    });
    console.log("Reply keyboard removed.");
  } catch (e) {
    console.warn(`⚠️ Failed to remove reply keyboard:`, e);
  }

  let resultMsg = `🏁✨ <b>Game 1 has ended!</b> ✨🏁\n\n`;
  resultMsg += `👥 Total Participants: <b>${totalParticipantsInGame1}</b>\n`;
  resultMsg += `✅ Survivors: <b>${survivors.length}</b>\n`;
  resultMsg += `💀 Eliminated: <b>${eliminated.length}</b>\n\n`;
  resultMsg += `✅ Survivors:\n${survivors.map(p => `• ${p.username}`).join('\n') || "None"}\n\n`;
  resultMsg += `💀 Eliminated:\n${eliminated.map(p => `• ${p.username} (Progress: ${Math.floor(p.progress)}%)`).join('\n') || "None"}`;

  await bot.sendMessage(chatId, resultMsg, { parse_mode: "HTML" }).catch(console.error);

  if (eliminated.length === 0) {
    const gif = path.resolve(__dirname, "gifs", "goodwork.gif");
    await bot.sendMessage(chatId, "🎉 No one was eliminated! Great job everyone!").catch(console.error);
    await bot.sendAnimation(chatId, fs.createReadStream(gif)).catch(console.error);
  } else {
    const gif = path.resolve(__dirname, "gifs", "bye.gif");
    await bot.sendAnimation(chatId, fs.createReadStream(gif)).catch(console.error);
    await bot.sendMessage(chatId, "⚠️ 💀 Eliminated players will be kicked in 10 seconds!").catch(console.error);

    // Clear spam tracking for all players at the end of the game
    eliminatedPlayerSpam.clear();

    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds

    for (const p of eliminated) {
      try {
        // Ensure they are unrestricted before kicking, in case there's an issue
        // with Telegram kicking restricted members. Though banChatMember often overrides restrictions.
        await bot.restrictChatMember(chatId, p.id, {
          can_send_messages: true, // Grant all permissions back
          can_send_audios: true,
          can_send_documents: true,
          can_send_photos: true,
          can_send_videos: true,
          can_send_video_notes: true,
          can_send_voice_notes: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: true,
          can_invite_users: true,
          can_pin_messages: true,
          can_manage_topics: true
        }).catch(err => console.warn(`Could not unrestrict ${p.username} (ID: ${p.id}) before kicking: ${err.message}`));

        await bot.banChatMember(chatId, p.id); // This is the kick action
        console.log(`Successfully kicked ${p.username} (ID: ${p.id})`);
      } catch (err) {
        console.error(`❌ Failed to kick ${p.username} (ID: ${p.id}) from chat ${chatId}:`, err.message);
        if (err.response && err.response.statusCode === 400 && err.response.description.includes("not enough rights")) {
          await bot.sendMessage(chatId, `⚠️ Failed to kick ${p.username}. Make sure the bot is an admin with 'Ban users' permission!`).catch(console.error);
        }
      }
    }

    await bot.sendMessage(chatId,
      `🏁✅ <b>Eliminations completed!</b>\n\n` +
      `👥 Remaining Survivors: <b>${survivors.length}</b>\n` +
      `💀 Total Eliminated: <b>${eliminated.length}</b>`,
      { parse_mode: "HTML" }
    ).catch(console.error);

    const gif2 = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
    await bot.sendAnimation(chatId, fs.createReadStream(gif2)).catch(console.error);
  }
}






// Show Current Players Command
bot.onText(/\/players/, (msg) => {
  if (registeredPlayers.length === 0) {
    return bot.sendMessage(msg.chat.id, "No players registered yet.");
  }
  let playerList = "📊 *Current Players:*\n\n";
  registeredPlayers.forEach(p => {
    playerList += `- ${p.username} (Status: ${p.status}, Progress: ${Math.floor(p.progress)}%)\n`;
  });
  bot.sendMessage(msg.chat.id, playerList, { parse_mode: "Markdown" });
});

// Reset All Player Data Command (for Admin)
bot.onText(/\/resetplayers/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can reset player data!");
  registeredPlayers = [];
  fs.writeFileSync(PLAYER_DATA_FILE, JSON.stringify(registeredPlayers, null, 2));
  bot.sendMessage(msg.chat.id, "✅ All player data has been reset.");
  console.log("Player data reset by admin.");
});


console.log('Bot is running...');


bot.onText(/\/unmute (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "⚠️ Only the host can unmute players!");
  }

  const targetUserId = parseInt(match[1]); // Extract the numeric User ID
  const chatId = msg.chat.id;

  if (isNaN(targetUserId)) {
    return bot.sendMessage(chatId, "❌ Invalid User ID. Please use `/unmute [numeric_user_id]` (e.g., `/unmute 123456789`).");
  }

  // Call the unmutePlayer helper function
  // We don't have a username readily available without fetching, so pass the ID.
  await unmutePlayer(chatId, targetUserId, `User ID: ${targetUserId}`);
});

let game2Started = false;
let correctShapes = [];
let game2Timeout = null;
let allowGuessing = false; // Block guessing at start

// New: In-memory cooldowns to prevent command spam from individual users
// Key: userId, Value: timestamp of the last allowed action
const userActionCooldowns = new Map();
const COOLDOWN_MS2 = 1000; // 1 second cooldown for general command/button spam

// Function to send the reply keyboard for guessing
async function sendGuessButtons(chatId) {
  try {
    await bot.sendMessage(chatId, "Pick your shape:", {
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
    // Add more specific error handling for rate limits if desired
    bot.sendMessage(chatId, `⚠️ Error sending guessing buttons: ${err.message}`).catch(console.error);
  }
}

// Function to remove the reply keyboard
async function removeGuessButtons(chatId) {
  try {
    // Send a blank message to trigger keyboard removal
    // Note: Telegram might send a "message not modified" error if the keyboard is already removed,
    // but this approach is generally reliable.
    await bot.sendMessage(chatId, "Buttons removed.", {
      reply_markup: {
        remove_keyboard: true
      }
    });
    console.log("Guessing reply keyboard removed successfully.");
  } catch (e) {
    console.warn(`⚠️ Failed to remove guessing reply keyboard:`, e);
  }
}

// Helper to safely delete messages
async function safeDeleteMessage(chatId, messageId) {
  try {
    await bot.deleteMessage(chatId, messageId);
    // console.log(`Successfully deleted message ${messageId} in chat ${chatId}`); // Uncomment for debugging
  } catch (err) {
    // Ignore "message to delete not found" errors (common if already deleted or user deleted it)
    if (err.response && err.response.description.includes("message to delete not found")) {
      // console.warn(`Message ${messageId} not found for deletion in chat ${chatId}.`); // Uncomment for debugging
    } else if (err.response && err.response.statusCode === 400 && err.response.description.includes("message can't be deleted")) {
      console.warn(`⚠️ Bot lacks permissions to delete message ${messageId} in chat ${chatId}. Grant 'Delete messages' permission.`);
    } else {
      console.error(`❌ Error deleting message ${messageId} in chat ${chatId}:`, err.message);
    }
  }
}


bot.onText(/\/startgame2/, async (msg) => { // Added async here for await calls
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start Game 2!");
  if (game2Started) return bot.sendMessage(msg.chat.id, "⚠️ Game 2 already started!");
  const alivePlayers = registeredPlayers.filter(p => p.status === "alive");
  if (alivePlayers.length === 0) {
    return bot.sendMessage(msg.chat.id, "❌ Cannot start Game 2! There are no registered or alive players.");
  }

  const shapes = ["circle", "triangle", "square"];
  // Ensure correctShapes are lowercase to match button texts (after stripping emoji)
  correctShapes = shapes.sort(() => 0.5 - Math.random()).slice(0, 2);

  // Reset guesses and statuses
  registeredPlayers.forEach(p => {
    if (p.status === "alive" || p.status === "safe") {
      p.guess = null;
      if (p.status === "safe") p.status = "alive";
    }
  });

  game2Started = true;
  allowGuessing = false; // Block guessing at start

  const instructions = `
🎮 *Game 2: Shape Guessing Game!*

- 👁 You will see *3 shapes*: circle, triangle, square.
- ✅ Only *2 shapes* are correct. You must pick one correct shape to survive.
- ⏰ You have *1 minute* to look carefully and think.

⚠️ Wait for the game to start completely and *wait for the buttons* to appear!
⚠️ Choose wisely! Only correct guesses survive.

Good luck! 💥
`;

  const shapesImgPath = path.resolve(__dirname, "images", "shapes.jpg");

  await bot.sendPhoto(msg.chat.id, fs.createReadStream(shapesImgPath), { // Ensure fs.createReadStream
    caption: instructions,
    parse_mode: "Markdown"
  }).catch((err) => {
    console.error("❌ Failed to send shapes image:", err);
  });

  // First 1-minute timer: think phase
  game2Timeout = setTimeout(async () => { // Added async here
    const guessInstruction = `
⏰ *Time's up for thinking!*

Now it's time to submit your guess!
👉 *Use the buttons below* to pick your shape!

⏰ You have *1 minute* to submit your guess!

⚠️ If you don't guess within this time, you will be eliminated!
        `;
    await bot.sendMessage(msg.chat.id, guessInstruction, { parse_mode: "Markdown" });

    allowGuessing = true; // Now allow guesses
    await sendGuessButtons(msg.chat.id); // Send the reply keyboard here

    // Second 1-minute timer: guess phase
    game2Timeout = setTimeout(() => {
      finishGame2(msg.chat.id);
    }, 1 * 60 * 1000);

  }, 1 * 60 * 1000);
});

// --- New bot.onText handlers for Reply Keyboard buttons ---
bot.onText(/⭕ Circle/, async (msg) => {
  handleShapeGuess(msg, "circle");
});

bot.onText(/🔺 Triangle/, async (msg) => {
  handleShapeGuess(msg, "triangle");
});

bot.onText(/◼️ Square/, async (msg) => {
  handleShapeGuess(msg, "square");
});

// Consolidated function to handle all shape guesses
async function handleShapeGuess(msg, chosenShape) {
  const userId = msg.from.id;
  const player = registeredPlayers.find(p => p.id === userId);
  const chatId = msg.chat.id;
  const userMessageId = msg.message_id; // The ID of the user's "Circle" / "Triangle" / "Square" message

  // 1. Initial Checks & Delete user's message if invalid context
  if (!game2Started) {
    safeDeleteMessage(chatId, userMessageId); // Delete user's message if game not active
    return bot.sendMessage(chatId, "❌ Game 2 is not running!");
  }
  if (!player || player.status !== "alive") {
    safeDeleteMessage(chatId, userMessageId); // Delete user's message if not in game or eliminated
    return bot.sendMessage(chatId, "❌ You are not in the game or already eliminated!");
  }
  if (!allowGuessing) {
    safeDeleteMessage(chatId, userMessageId); // Delete user's message if guessing is not allowed yet
    return bot.sendMessage(chatId, "⚠️ You cannot guess yet! Wait for the bot's final instruction before submitting your shape.");
  }

  // 2. Implement Per-User Cooldown for spam prevention
  const now = Date.now();
  const lastActionTime = userActionCooldowns.get(userId) || 0;

  if (now - lastActionTime < COOLDOWN_MS2) {
    // User is spamming within the cooldown period.
    // Delete their repeated message immediately.
    safeDeleteMessage(chatId, userMessageId);
    // Optionally, send a temporary warning to the user, then delete it.
    const tempWarnMsg = await bot.sendMessage(chatId, "🛑 Please wait a moment before interacting again.", { reply_to_message_id: userMessageId });
    setTimeout(() => safeDeleteMessage(chatId, tempWarnMsg.message_id), 3000); // Delete warning after 3 seconds
    return; // Stop processing this spam message
  }

  // Update last action time to prevent immediate re-spam
  userActionCooldowns.set(userId, now);

  // 3. Check if player has already made a guess
  if (player.guess !== null) {
    // Player has already made a guess.
    // Delete the player's repeated button press message.
    safeDeleteMessage(chatId, userMessageId);

    // Send a temporary warning that they already guessed, and then delete it.
    const alreadyGuessedMsg = await bot.sendMessage(chatId, "⚠️ You already made your guess!");
    setTimeout(() => safeDeleteMessage(chatId, alreadyGuessedMsg.message_id), 5000); // Delete after 5 seconds
    return; // Stop processing this repeated guess
  }

  // 4. This is a valid FIRST guess
  player.guess = chosenShape;
  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  let emoji = "";
  if (chosenShape === "circle") emoji = "⭕";
  else if (chosenShape === "triangle") emoji = "🔺";
  else if (chosenShape === "square") emoji = "◼️";

  // This is the FIRST vote confirmation message, which should NOT be deleted.
  bot.sendMessage(chatId, `✅ ${player.username} picked ${chosenShape} ${emoji}!`, { reply_to_message_id: userMessageId });
}


function finishGame2(chatId) {
  if (!game2Started) return;

  game2Started = false;
  clearTimeout(game2Timeout);
  game2Timeout = null;
  allowGuessing = false;

  // Remove the reply keyboard immediately when the game finishes
  removeGuessButtons(chatId);

  const survivors = [];
  const eliminated = [];
  const guesses = [];
  const eliminatedPlayers = [];

  registeredPlayers.forEach(p => {
    if (p.status === "alive") {
      guesses.push(`${p.username}: ${p.guess !== null ? p.guess : "❌ No guess"}`);

      if (p.guess !== null && correctShapes.includes(p.guess)) {
        p.status = "alive";
        survivors.push(p.username);
      } else {
        p.status = "eliminated";
        eliminated.push(p.username);
        eliminatedPlayers.push(p);
      }
    }
  });

  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  const totalParticipants = registeredPlayers.filter(p => p.status !== "pending").length; // Corrected from totalPlayers for clarity

  let resultMsg = `🏁✨ <b>Game 2 has ended!</b> ✨🏁\n\n`;
  resultMsg += `👥 Total Participants: <b>${totalParticipants}</b>\n`;
  resultMsg += `✅ Survivors: <b>${survivors.length}</b>\n`;
  resultMsg += `💀 Eliminated: <b>${eliminated.length}</b>\n\n`;
  resultMsg += `🎯 Correct shapes: <b>${correctShapes.join(", ")}</b>\n\n`;
  resultMsg += `🎲 <b>Player guesses:</b>\n${guesses.join('\n')}\n\n`;
  resultMsg += `✅ Survivors:\n${survivors.map(p => `• ${p}`).join('\n') || "None"}\n\n`;
  resultMsg += `💀 Eliminated:\n${eliminated.map(p => `• ${p}`).join('\n') || "None"}`;

  bot.sendMessage(chatId, resultMsg, { parse_mode: "HTML" })
    .then(() => {
      if (eliminated.length === 0) {
        // No one eliminated
        return bot.sendMessage(chatId, "🎉 No one was eliminated this round! Well done! 🙌");
      } else {
        // Send elimination GIF and prepare to kick
        const eliminationGifPath = path.resolve(__dirname, "gifs", "bye.gif");
        return bot.sendAnimation(chatId, fs.createReadStream(eliminationGifPath))
          .then(() => bot.sendMessage(chatId, "⚠️ 💀 Eliminated players will be kicked in 10 seconds! Prepare to say goodbye..."));
      }
    })
    .then(() => {
      if (eliminated.length === 0) {
        // If no eliminations, directly summarize and send congrats GIF
        let afterMsg = `🏁✅ <b>All players survived!</b>\n\n`;
        afterMsg += `👥 Remaining Survivors: <b>${survivors.length}</b>\n`;
        afterMsg += `💀 Total Eliminated: <b>0</b>`;

        bot.sendMessage(chatId, afterMsg, { parse_mode: "HTML" })
          .then(() => {
            const congratsGifPath = path.resolve(__dirname, "gifs", "goodwork.gif");
            bot.sendAnimation(chatId, fs.createReadStream(congratsGifPath))
              .then(() => {
                console.log("✅ Congratulations GIF sent!");
              })
              .catch((err) => {
                console.error("❌ Failed to send congratulations GIF:", err);
              });
          });
      } else {
        // Wait 10 seconds before kicking
        return new Promise(resolve => setTimeout(resolve, 10 * 1000))
          .then(() => {
            // Use Promise.allSettled to ensure all kicks are attempted even if some fail
            const kickPromises = eliminatedPlayers.map(p =>
              bot.banChatMember(chatId, p.id)
                .then(() => {
                  console.log(`✅ Kicked (banned) ${p.username}`);
                })
                .catch((err) => {
                  console.error(`❌ Failed to kick (ban) ${p.username}:`, err.message);
                  // You might want to send a public message if a kick fails for a known player
                  // e.g., bot.sendMessage(chatId, `Failed to kick ${p.username}. Bot might lack admin permissions.`).catch(console.error);
                })
            );
            return Promise.allSettled(kickPromises); // Wait for all kick attempts to finish
          })
          .then(() => {
            let afterKickMsg = `🏁✅ <b>Eliminations completed!</b>\n\n`;
            afterKickMsg += `👥 Remaining Survivors: <b>${survivors.length}</b>\n`;
            afterKickMsg += `💀 Total Eliminated: <b>${eliminated.length}</b>`;

            bot.sendMessage(chatId, afterKickMsg, { parse_mode: "HTML" })
              .then(() => {
                const celebrationGifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
                bot.sendAnimation(chatId, fs.createReadStream(celebrationGifPath))
                  .then(() => {
                    console.log("✅ Celebration GIF sent after Game 2!");
                  })
                  .catch((err) => {
                    console.error("❌ Failed to send celebration GIF:", err);
                  });
              });
          });
      }
    })
    .catch((err) => {
      console.error("❌ Error in finishGame2 flow:", err);
    });
}
bot.onText(/\/removebutton/, async (msg) => {
  const chatId = msg.chat.id;

  // Optional: restrict to admin only
  // if (msg.from.id !== ADMIN_ID) {
  //   return bot.sendMessage(chatId, "⚠️ Only the host can use this command.");
  // }

  await removeRollButtons(chatId);
});
async function removeRollButtons(chatId) {
  try {
    await bot.sendMessage(chatId, "Removing roll buttons...", {
      reply_markup: {
        remove_keyboard: true
      }
    });
    console.log("Roll reply keyboard removed successfully.");
  } catch (e) {
    console.warn(`⚠️ Failed to remove roll reply keyboard:`, e);
  }
}


const BRIDGE_CHOICE_TIMEOUT = 60 * 1000; // 1 minute for choices



// --- Game State Variables ---
let game4Started = false;
let game4JumpNumber = 1;
const maxJumps = 2; // Number of jumps required to cross the bridge
let game4Choices = {}; // { userId: "left" or "right" } for the current jump
let game4Timer = null; // Timer for the current jump's choices
let game4AlreadyNotified = {}; // { userId: true } - Tracks if a player has been notified they already picked in *this jump*
let game4NotificationMessageIds = {}; // { userId: message_id } - Stores message IDs of "already picked" notifications for deletion
let game4MessagesToClean = []; // Array to store IDs of messages sent by the bot that should be cleared


try {
  const playersData = fs.readFileSync('players.json', 'utf8');
  registeredPlayers = JSON.parse(playersData);
} catch (error) {
  console.warn("Could not load players.json, starting with empty players list.", error.message);
}


// --- Helper Functions ---

/**
 * Sends a message and stores its ID for later cleanup.
 * @param {number} chatId
 * @param {string} text
 * @param {object} [options={}]
 * @returns {Promise<TelegramBot.Message|null>}
 */
async function sendAndStoreMessage(chatId, text, options = {}) {
  try {
    const message = await bot.sendMessage(chatId, text, options);
    game4MessagesToClean.push(message.message_id); // Store message ID for later deletion
    return message;
  } catch (err) {
    console.error(`❌ Error sending message to chat ${chatId}:`, err.message);
    return null;
  }
}

/**
 * Deletes a specific message from the chat.
 * Logs only critical errors, suppresses "message to delete not found".
 * @param {number} chatId
 * @param {number} messageId
 */
async function deleteMessage(chatId, messageId) {
  if (!messageId) return; // Ensure messageId is valid
  try {
    await bot.deleteMessage(chatId, messageId);
    // console.log(`✅ Deleted message ${messageId} in chat ${chatId}`); // Keep commented out for production
  } catch (err) {
    // Ignore "message to delete not found" errors, as the message might have been deleted by user or another process.
    if (err.response && err.response.statusCode === 400 && err.response.description && err.response.description.includes("message to delete not found")) {
      // console.warn(`⚠️ Tried to delete message ${messageId} in chat ${chatId} but it was already gone.`); // Keep commented out
    } else {
      console.error(`❌ Failed to delete message ${messageId} in chat ${chatId}:`, err.message);
    }
  }
}

/**
 * Clears all stored bot messages for the current game from the chat.
 * Includes clearing "already picked" notifications.
 * @param {number} chatId
 */
async function clearGameSpecificMessages(chatId) {
  // Delete general game messages
  for (const msgId of game4MessagesToClean) {
    await deleteMessage(chatId, msgId);
  }
  game4MessagesToClean = [];

  // Delete "already picked" notification messages
  for (const userId in game4NotificationMessageIds) {
    await deleteMessage(chatId, game4NotificationMessageIds[userId]);
  }
  game4NotificationMessageIds = {}; // Reset these IDs for the new round/game
  game4AlreadyNotified = {}; // Reset notification flags
}

/**
 * Resets all game 4 state variables to their initial values.
 */
function resetGame4State() {
  game4Started = false;
  game4JumpNumber = 1;
  game4Choices = {};
  clearTimeout(game4Timer);
  game4Timer = null;
  game4AlreadyNotified = {};
  game4NotificationMessageIds = {};
  game4MessagesToClean = []; // Clear any remaining message IDs to delete
  // Note: registeredPlayers status should be managed by the game logic
  // and might not be fully reset here, depending on overall bot flow.
  // For a clean slate, you might re-initialize registeredPlayers here:
  // registeredPlayers = registeredPlayers.map(p => ({ ...p, status: "alive", bridgeJump: 0 }));
  // Or if it's a new game, just empty it:
  // registeredPlayers = [];
}

// --- Functions for Jump Reply Keyboard ---
async function sendJumpChoiceButtons(chatId) {
  try {
    const message = await bot.sendMessage(chatId, "Choose your path!", {
      reply_markup: {
        keyboard: [
          [{ text: "👈 Left" }, { text: "👉 Right" }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    });
    // console.log("Jump choice reply keyboard sent successfully."); // Keep commented
    // Add this message to cleanup if it's a fixed instruction
    // game4MessagesToClean.push(message.message_id); // Only if you want to delete this specific 'Choose your path!' message later
  } catch (err) {
    console.error(`❌ Failed to send jump choice buttons to chat ${chatId}:`, err.message);
    await bot.sendMessage(chatId, `⚠️ Error sending jump choice buttons: ${err.message}`).catch(console.error);
  }
}

async function removeJumpChoiceButtons(chatId) {
  try {
    // Send a temporary message to trigger keyboard removal
    await bot.sendMessage(chatId, "...", {
      reply_markup: {
        remove_keyboard: true
      }
    });
    // console.log("Jump choice reply keyboard removed successfully."); // Keep commented
    // The "..." message will be automatically deleted by Telegram after keyboard removal,
    // so no need to explicitly track its ID.
  } catch (e) {
    console.warn(`⚠️ Failed to remove jump choice reply keyboard:`, e.message); // Log error message only
  }
}
// --- End Functions ---

// --- Game 4 Commands ---

bot.onText(/\/startgame4/, async (msg) => { // Added async
  const chatId = msg.chat.id;
  if (msg.from.id !== ADMIN_ID) {
    await bot.sendMessage(chatId, "⚠️ Only the host can start Game 4!");
    await deleteMessage(chatId, msg.message_id); // Delete command
    return;
  }
  if (game4Started) {
    await bot.sendMessage(chatId, "⚠️ Game 4 already running!");
    await deleteMessage(chatId, msg.message_id); // Delete command
    return;
  }
  const alivePlayers = registeredPlayers.filter(p => p.status === "alive");
  if (alivePlayers.length === 0) {
    await bot.sendMessage(chatId, "⚠️ There are no alive players to start Game 4!");
    await deleteMessage(chatId, msg.message_id); // Delete command
    return;
  }

  await deleteMessage(chatId, msg.message_id); // Delete the /startgame4 command

  // Reset game state for a fresh start
  resetGame4State();
  game4Started = true;
  game4JumpNumber = 1;

  // Ensure all alive players are set for the first jump
  registeredPlayers.forEach(p => {
    if (p.status === "alive") {
      p.bridgeJump = 0; // Reset jump counter for players
    }
  });

  const bridgeImgPath = path.resolve(__dirname, "images", "bridge-game.jpg");

  try {
    const photoMessage = await bot.sendPhoto(chatId, fs.createReadStream(bridgeImgPath), {
      caption:
        "🌉 <b>GAME 4: THE GLASS BRIDGE!</b>\n\n" +
        "Players must cross a fragile glass bridge by jumping on glass panels suspended high above the ground.\n\n" +
        "In each round, you will choose to jump <b>left</b> or <b>right</b>. Only one side is safe — the other will break and you will fall.\n\n" +
        "🕒 <b> You have 1 minute to prepare.</b>\n\n" +
        `💡 You need to survive <b>${maxJumps} jumps</b> to cross safely.\n\n` +
        "⚔️ <i>Get ready... and choose wisely!</i>",
      parse_mode: "HTML"
    });
    game4MessagesToClean.push(photoMessage.message_id); // Store this message for cleanup
  } catch (err) {
    console.error("❌ Failed to send bridge image:", err.message);
    await bot.sendMessage(chatId, "🌉 Game 4: The Glass Bridge!\nPrepare to jump soon!").catch(console.error);
  } finally {
    // Wait 1 minute before first jump
    setTimeout(async () => {
      await sendJumpInstructions(chatId);
      await sendJumpChoiceButtons(chatId);
    }, 60 * 1000);
  }
});

async function sendJumpInstructions(chatId) {
  const jumpImgPath = path.resolve(__dirname, "images", "choose1.jpg");

  try {
    const photoMessage = await bot.sendPhoto(chatId, fs.createReadStream(jumpImgPath), {
      caption:
        `🟢 <b>Jump ${game4JumpNumber}/${maxJumps}</b>\n\n` +
        "Choose <b>👈 Left</b> or <b>👉 Right</b> wisely — only one side is safe!\n\n" +
        "💡 <b>Rules:</b>\n" +
        "- You have <b>1 minute</b> to make your choice.\n" +
        "- Step on the wrong panel and you will fall and be eliminated.\n\n" +
        "⏰ <i>Good luck, and watch your step!</i>",
      parse_mode: "HTML"
    });
    game4MessagesToClean.push(photoMessage.message_id); // Store this message for cleanup
  } catch (err) {
    console.error("❌ Failed to send jump instructions image:", err.message);
    await bot.sendMessage(chatId, `🟢 Jump ${game4JumpNumber}/${maxJumps}!\nChoose Left or Right!`).catch(console.error);
  } finally {
    announceJump(chatId);
  }
}


// --- MODIFIED bot.onText for the "👈 Left|👉 Right" buttons ---
bot.onText(/👈 Left|👉 Right/, async (msg) => {
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const chatId = msg.chat.id;
  const choiceText = msg.text;
  const choice = (choiceText === "👈 Left") ? "left" : "right";

  if (!game4Started) {
    // If the game is not running, always delete the user's message.
    await deleteMessage(chatId, msg.message_id);
    return;
  }

  const player = registeredPlayers.find(p => p.id === userId && p.status === "alive");
  if (!player) {
    // Not a valid active player. Delete their message.
    await deleteMessage(chatId, msg.message_id);
    return;
  }

  if (game4Choices[userId]) {
    // --- Player already picked this jump (THIS IS THE SPAM SCENARIO) ---

    // 1. Delete the user's *subsequent* (spam) message immediately.
    await deleteMessage(chatId, msg.message_id);

    if (!game4AlreadyNotified[userId]) {
      // 2. If not yet notified, send the "already picked" notification.
      try {
        const notificationMsg = await bot.sendMessage(chatId, "⚠️ You already picked this jump!", { reply_to_message_id: msg.message_id });
        game4NotificationMessageIds[userId] = notificationMsg.message_id; // Store bot's message ID
        game4AlreadyNotified[userId] = true; // Mark as notified for this jump
      } catch (err) {
        //console.error(`❌ Error sending "already picked" notification to ${username}:`, err.message);
      }
    } else if (game4NotificationMessageIds[userId]) {
      // 3. If already notified and we have the bot's message ID, delete the *previous bot notification*
      //    and resend a new one to keep it fresh/visible (or just delete and do nothing if you prefer less chat activity).
      //    For now, let's delete the previous notification as well to keep the chat clean.
      await deleteMessage(chatId, game4NotificationMessageIds[userId]);
      try {
        const notificationMsg = await bot.sendMessage(chatId, "⚠️ You already picked this jump!", { reply_to_message_id: msg.message_id });
        game4NotificationMessageIds[userId] = notificationMsg.message_id;
      } catch (err) {
        // console.error(`❌ Error resending "already picked" notification to ${username}:`, err.message);
      }
    }
    return; // Do not process further as it's a spam pick
  }

  // --- If we reach here, it's a VALID, FIRST-TIME CHOICE for this jump ---

  game4Choices[userId] = choice;
  // We DO NOT delete msg.message_id here, as this is the valid first pick.
  // The player's first choice message remains in the chat.

  // Send a confirmation from the bot that their choice was received.
  // This bot message will be collected by `game4MessagesToClean` and deleted later.
  await sendAndStoreMessage(chatId, `✅ ${username} chose ${choice}!`, { reply_to_message_id: msg.message_id });

  // Check if all alive players have made a choice
  const aliveCount = registeredPlayers.filter(p => p.status === "alive").length;
  if (Object.keys(game4Choices).length === aliveCount) {
    clearTimeout(game4Timer); // All choices in, resolve immediately
    resolveBridgeRound(chatId);
  }
});


async function announceJump(chatId) {
  // Reset notification trackers for the new jump
  game4AlreadyNotified = {};
  game4NotificationMessageIds = {};

  clearTimeout(game4Timer); // Clear any previous timer
  game4Timer = setTimeout(() => {
    resolveBridgeRound(chatId);
  }, BRIDGE_CHOICE_TIMEOUT); // Use the defined timeout constant
}

async function resolveBridgeRound(chatId) {
  clearTimeout(game4Timer); // Ensure no lingering timer

  await removeJumpChoiceButtons(chatId); // Remove the reply keyboard
  await clearGameSpecificMessages(chatId); // Clean up all bot messages from the round

  const alivePlayers = registeredPlayers.filter(p => p.status === "alive");

  // If no players or only one player left, end the game
  if (alivePlayers.length === 0 || (alivePlayers.length === 1 && game4JumpNumber >= maxJumps)) {
    summarizeGame4(chatId);
    return;
  }

  const safeSide = Math.random() < 0.5 ? "left" : "right";
  const survivorsThisJump = [];
  const eliminatedThisJump = [];

  alivePlayers.forEach(p => {
    if (!game4Choices[p.id]) {
      // Player did not choose or timed out
      p.status = "eliminated";
      eliminatedThisJump.push(p);
    } else if (game4Choices[p.id] !== safeSide) {
      // Player chose the wrong side
      p.status = "eliminated";
      eliminatedThisJump.push(p);
    } else {
      // Player chose the safe side
      survivorsThisJump.push(p.username);
      p.bridgeJump++; // Increment jump count for survivors
    }
  });

  // Update players.json with new statuses and jump counts
  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  let msg = `💥 <b>SAFE SIDE:</b> ${safeSide.toUpperCase()}!\n\n`;
  msg += `✅ <b>SURVIVORS THIS JUMP:</b>\n`;
  msg += survivorsThisJump.length > 0 ? survivorsThisJump.map(u => `• ${u}`).join('\n') : "None";
  msg += `\n\n💀 <b>ELIMINATED THIS JUMP:</b>\n`;
  msg += eliminatedThisJump.length > 0 ? eliminatedThisJump.map(p => `• ${p.username}`).join('\n') : "None";

  const summaryMessage = await sendAndStoreMessage(chatId, msg, { parse_mode: "HTML" });

  if (eliminatedThisJump.length > 0) {
    const gifPath = path.resolve(__dirname, "gifs", "bye.gif");
    try {
      const gifMessage = await bot.sendAnimation(chatId, fs.createReadStream(gifPath));
      game4MessagesToClean.push(gifMessage.message_id); // Store GIF message for cleanup

      const kickMsg = `💀 The following players will be removed in 5 seconds:\n\n${eliminatedThisJump.map(p => `• ${p.username}`).join('\n')}`;
      const kickConfirmation = await sendAndStoreMessage(chatId, kickMsg);

      setTimeout(async () => {
        for (const p of eliminatedThisJump) {
          try {
            await bot.banChatMember(chatId, p.id);
            // console.log(`✅ Kicked ${p.username}`); // Keep commented
          } catch (err) {
            console.error(`❌ Failed to kick ${p.username}:`, err.message);
            if (err.response && err.response.description && err.response.description.includes("can't remove chat owner")) {
              await sendAndStoreMessage(chatId, `⚠️ Could not kick ${p.username} (likely a group owner/admin). Please remove manually.`).catch(console.error);
            }
          }
        }
        setTimeout(async () => {
          await proceedToNextJumpOrEndGame(chatId);
        }, 3000); // Wait 3 seconds after kicking before proceeding
      }, 5000); // Wait 5 seconds after kick message
    } catch (err) {
      console.error("❌ Failed to send elimination GIF or kick message:", err.message);
      await proceedToNextJumpOrEndGame(chatId); // Proceed even if GIF/kick fails
    }
  } else {
    // No eliminations, proceed directly
    setTimeout(async () => {
      await proceedToNextJumpOrEndGame(chatId);
    }, 3000); // Short delay before next jump if no one was eliminated
  }
}

async function proceedToNextJumpOrEndGame(chatId) {
  const survivors = registeredPlayers.filter(p => p.status === "alive");
  const playersCompletedJumps = survivors.filter(p => p.bridgeJump >= maxJumps);

  if (playersCompletedJumps.length > 0) {
    // Players have successfully crossed!
    await sendAndStoreMessage(chatId, `🎉 <b>CONGRATULATIONS!</b> The following players have successfully crossed the bridge:\n\n${playersCompletedJumps.map(p => `• ${p.username}`).join('\n')}`, { parse_mode: "HTML" });
    // Mark these players as 'finished' or 'won' if needed, then remove from active survivors
    playersCompletedJumps.forEach(p => p.status = "alive"); // Or "winner"
    fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2)); // Save updated status

    // Check if any players are still on the bridge for next jump
    const remainingOnBridge = registeredPlayers.filter(p => p.status === "alive" && p.bridgeJump < maxJumps);
    if (remainingOnBridge.length === 0) {
      summarizeGame4(chatId);
      return; // End game
    }
  }

  if (game4JumpNumber >= maxJumps || survivors.length === 0) {
    summarizeGame4(chatId);
  } else {
    game4JumpNumber++;
    game4Choices = {}; // Reset choices for the next jump
    // notification trackers are reset in announceJump
    await sendAndStoreMessage(chatId, `Get ready for Jump ${game4JumpNumber}!`, { parse_mode: "HTML" }); // Announce next jump
    await sendJumpInstructions(chatId);
    await sendJumpChoiceButtons(chatId);
  }
}

async function summarizeGame4(chatId) {
  await clearGameSpecificMessages(chatId); // Clear any lingering messages before summary
  resetGame4State(); // Reset all game-specific state variables

  const totalPlayers = registeredPlayers.filter(p => p.initialParticipant).length; // Assuming an 'initialParticipant' flag
  const survivors = registeredPlayers.filter(p => p.status === "alive" || p.status === "finished"); // Survivors include those who finished
  const eliminated = registeredPlayers.filter(p => p.status === "eliminated");

  let msg = `🏁✨ <b>GAME 4 HAS ENDED!</b> ✨🏁\n\n`;
  msg += `👥 <b>TOTAL PARTICIPANTS:</b> ${totalPlayers}\n`;
  msg += `✅ <b>SURVIVORS (Crossed or Still Alive):</b> ${survivors.length}\n`;
  msg += `💀 <b>ELIMINATED:</b> ${eliminated.length}\n\n`;
  msg += `✅ <b>SURVIVORS LIST:</b>\n${survivors.length > 0 ? survivors.map(u => `• ${u.username} (${u.status === "finished" ? "Crossed" : "Alive"})`).join('\n') : "None"}\n\n`;
  msg += `💀 <b>ELIMINATED LIST:</b>\n${eliminated.length > 0 ? eliminated.map(u => `• ${u.username}`).join('\n') : "None"}`;

  await sendAndStoreMessage(chatId, msg, { parse_mode: "HTML" });

  const piggyGifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
  try {
    const gifMessage = await bot.sendAnimation(chatId, fs.createReadStream(piggyGifPath));
    game4MessagesToClean.push(gifMessage.message_id); // Store for potential cleanup if game is re-started quickly
    // console.log("✅ Piggy bank GIF sent at game end!"); // Keep commented
  } catch (err) {
    console.error("❌ Failed to send piggy bank GIF:", err.message);
  }
}

bot.onText(/\/stopgame4/, async (msg) => { // Added async
  const chatId = msg.chat.id;
  if (msg.from.id !== ADMIN_ID) {
    await bot.sendMessage(chatId, "⚠️ Only the host can stop Game 4!");
    await deleteMessage(chatId, msg.message_id); // Delete command
    return;
  }
  if (!game4Started) {
    await bot.sendMessage(chatId, "❌ Game 4 is not running!");
    await deleteMessage(chatId, msg.message_id); // Delete command
    return;
  }

  await deleteMessage(chatId, msg.message_id); // Delete the /stopgame4 command
  await clearGameSpecificMessages(chatId); // Clear all bot-sent messages
  await removeJumpChoiceButtons(chatId); // Ensure keyboard is removed

  resetGame4State(); // Reset all game variables

  // Re-set player statuses if needed after a stop
  registeredPlayers.forEach(p => {
    if (p.status === "alive" || p.status === "eliminated" || p.status === "finished") {
      p.status = "pending"; // Or "available", "ready" etc.
    }
  });
  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  await bot.sendMessage(chatId, "🛑 Game 4 has been forcefully stopped!");
});

// --- Error Handling (Important for production) ---
bot.on('polling_error', (err) => {
  console.error("Polling error:", err.code, err.message);
});




























// Game 5: Voting to eliminate
let game5Started = false;
let game5Votes = {};
let game5VoteTimeout = null;
let game5VotingOpen = false; // 🟢 Control if votes are accepted


// /startgame5 (Voting Game)
bot.onText(/\/startgame5/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start Game 5!");
  if (game5Started) return bot.sendMessage(msg.chat.id, "⚠️ Game 5 already running!");
  if (quizStarted) return bot.sendMessage(msg.chat.id, "⚠️ Quiz game is currently active. Please end it first!");

  const alivePlayers = registeredPlayers.filter(p => p.status === "alive");
  if (alivePlayers.length <= 2) return bot.sendMessage(msg.chat.id, "❌ Need more than 2 players to start Game 5 (Voting)!");

  game5Started = true;
  game5Votes = {};
  game5VotingOpen = false; // Voting not yet open

  const marblesImgPath = path.resolve(__dirname, "images", "voting.jpg");

  bot.sendPhoto(msg.chat.id, fs.createReadStream(marblesImgPath), {
    caption:
      "🔮 <b>GAME 5: ELIMINATION GAME!</b>\n\n" +
      "This is your final test of trust and strategy.\n\n" +
      "Each of you must vote for someone to eliminate. The player with the most votes will be eliminated.\n\n" +
      "⚠️ You cannot vote for yourself!\n\n" +
      "⏰ <b>You will have 1 minute to vote after this introduction.</b>\n\n" +
      "🕒 Take 20 seconds to think carefully and plan your move.\n\n" + // Reduced from 2 minutes for faster testing
      "💡 <i>Get ready... alliances will break and betrayals will begin!</i>",
    parse_mode: "HTML"
  })
    .then(() => {
      // Wait 20 seconds for them to read before opening voting
      setTimeout(() => {
        game5VotingOpen = true;

        bot.sendMessage(msg.chat.id,
          "🎲 <b>Voting has started!</b>\n\n" +
          "Vote who you want to eliminate by typing <b>/vote @username</b>.\n" +
          "⛔ You cannot vote for yourself!\n\n" +
          "⏰ <b>You have 1 minute to vote!</b>",
          { parse_mode: "HTML" }
        );

        game5VoteTimeout = setTimeout(() => {
          endGame5Vote(msg.chat.id);
        }, 60 * 1000); // 1 minute voting time
      }, 20 * 1000); // 20 seconds waiting
    })
    .catch((err) => {
      console.error("❌ Failed to send marbles image:", err);
      bot.sendMessage(msg.chat.id, "🔮 Game 5: Marbles Vote!\nGet ready to vote soon!");
    });
});

// /vote (remains the same)
bot.onText(/\/vote (.+)/, (msg, match) => {
  if (!game5Started) return bot.sendMessage(msg.chat.id, "❌ Game 5 is not running!");
  if (!game5VotingOpen) return bot.sendMessage(msg.chat.id, "⚠️ Voting has not started yet or is already closed!");

  const voterId = msg.from.id;
  const voter = registeredPlayers.find(p => p.id === voterId);
  if (!voter || voter.status !== "alive") return bot.sendMessage(msg.chat.id, "❌ You are not in the game or already eliminated!");

  const targetUsername = match[1].trim();
  const target = registeredPlayers.find(p => p.username === targetUsername && p.status === "alive");
  if (!target) return bot.sendMessage(msg.chat.id, "❌ Invalid target or target is not alive!");

  if (target.id === voterId) return bot.sendMessage(msg.chat.id, "⚠️ You cannot vote for yourself!");

  game5Votes[voterId] = target.id;
  bot.sendMessage(msg.chat.id, `✅ ${voter.username} voted to eliminate ${target.username}.`);
});

// endGame5Vote (Modified to end Game 5 and suggest starting Quiz)
function endGame5Vote(chatId) {
  game5VotingOpen = false;
  clearTimeout(game5VoteTimeout); // Ensure timeout is cleared

  const alivePlayers = registeredPlayers.filter(p => p.status === "alive");
  const voteCount = {};

  Object.values(game5Votes).forEach(targetId => {
    voteCount[targetId] = (voteCount[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let candidates = [];
  for (const [targetId, count] of Object.entries(voteCount)) {
    if (count > maxVotes) {
      maxVotes = count;
      candidates = [targetId];
    } else if (count === maxVotes) {
      candidates.push(targetId);
    }
  }

  let eliminatedId;

  // 💡 If no votes, pick random player
  if (candidates.length === 0) {
    const randomPlayer = alivePlayers[Math.floor(Math.random() * alivePlayers.length)];
    eliminatedId = randomPlayer.id;
    bot.sendMessage(chatId, "⚠️ No votes received! A random player will be eliminated...");
  } else if (candidates.length === 1) {
    eliminatedId = candidates[0];
  } else {
    eliminatedId = candidates[Math.floor(Math.random() * candidates.length)];
    bot.sendMessage(chatId, "⚖️ Tie detected! Randomly choosing one to eliminate...");
  }

  const eliminatedPlayer = registeredPlayers.find(p => p.id === parseInt(eliminatedId));
  eliminatedPlayer.status = "eliminated";

  const maskImgPath = path.resolve(__dirname, "images", "final-bye.jpg");

  bot.sendPhoto(chatId, fs.createReadStream(maskImgPath), {
    caption: `💀 ${eliminatedPlayer.username} was eliminated!`,
    parse_mode: "HTML"
  })
    .then(() => {
      // Wait 5 seconds before kicking (reduced from 15 for faster flow)
      setTimeout(() => {
        bot.banChatMember(chatId, eliminatedPlayer.id)
          .then(() => {
            console.log(`✅ Successfully kicked ${eliminatedPlayer.username}`);
          })
          .catch(err => {
            console.error(`❌ Failed to kick ${eliminatedPlayer.username}:`, err);
          });

        fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

        const survivors = registeredPlayers.filter(p => p.status === "alive");
        const totalPlayers = registeredPlayers.filter(p => p.status !== "pending").length;

        let msg = `🏁✨ <b>Game 5 (Voting) has ended!</b> ✨🏁\n\n`;
        msg += `👥 Total Participants: <b>${totalPlayers}</b>\n`;
        msg += `✅ Survivors: <b>${survivors.length}</b>\n`;
        msg += `💀 Eliminated: <b>${registeredPlayers.filter(p => p.status === "eliminated").length}</b>\n\n`;
        msg += `✅ Survivors:\n${survivors.map(u => `• ${u.username}`).join('\n') || "None"}\n\n`;
        msg += `💀 Eliminated:\n${registeredPlayers.filter(p => p.status === "eliminated").map(p => `• ${p.username}`).join('\n') || "None"}`;

        bot.sendMessage(chatId, msg, { parse_mode: "HTML" });

        const gifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
        bot.sendAnimation(chatId, fs.createReadStream(gifPath))
          .then(() => {
            console.log("✅ Celebration GIF sent after Game 5 (Voting)!");
          })
          .catch((err) => {
            console.error("❌ Failed to send GIF:", err);
          });

        // --- IMPORTANT CHANGE HERE ---
        // Instead of automatically starting the quiz, inform the admin
        if (survivors.length <= 2 && survivors.length > 0) { // Check for 1 or 2 survivors
          const survivorNames = survivors.map(p => p.username).join(' and ');
          bot.sendMessage(chatId,
            `🎉 <b>Game 5 (Voting) concluded!</b>\n\n` +
            `Only ${survivors.length} player(s) remain: <b>${survivorNames}</b>.\n` +
            `The final quiz duel is ready to begin!\n\n` +
            `👉 Host, type <b>/startquiz</b> to begin the final showdown!`,
            { parse_mode: "HTML" }
          );
        } else if (survivors.length === 0) {
          bot.sendMessage(chatId, "💀 All players eliminated! Game Over.");
        }
        else {
          // If more than 2 survivors, start next voting round
          prepareNextRound(chatId);
        }
        // Reset game 5 state
        game5Started = false;
        game5Votes = {};
      }, 5000); // 5 seconds waiting before next round or quiz prompt
    })
    .catch(err => {
      console.error("❌ Error during elimination sequence:", err);
    });
}

// ✅ Helper to start next voting round cleanly (No change)
function prepareNextRound(chatId) {
  game5Votes = {};
  game5VotingOpen = true;

  const survivors = registeredPlayers.filter(p => p.status === "alive");
  bot.sendMessage(chatId,
    `🔄 <b>Next Voting Round!</b>\n\n` +
    `👥 <b>Remaining players:</b> ${survivors.map(p => `@${p.username}`).join(', ')}\n\n` +
    `💣 <b>How to vote:</b> Type <code>/vote @username</code> to choose who you want to eliminate.\n` +
    `⛔ <i>Remember: You cannot vote for yourself!</i>\n\n` +
    `⏰ <b>You have 1 minute to make your decision. Choose wisely!</b>`,
    { parse_mode: "HTML" }
  );

  game5VoteTimeout = setTimeout(() => {
    endGame5Vote(chatId);
  }, 60 * 1000);
}



// --- Quiz Game Variables (moved and re-initialized for separate game) ---
let quizStarted = false;
let quizPlayers = []; // Will be populated by /startquiz
let quizScores = {}; // NEW: Initialize here for the quiz game
let currentQuestion = null;
let quizAnswerTimeout = null;
let currentQuestionAnswered = false; // 🔥 Flag to ensure only first correct answer counts

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
// --- NEW: /startquiz Command ---
bot.onText(/\/startquiz/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start the Quiz!");
  if (quizStarted) return bot.sendMessage(msg.chat.id, "⚠️ Quiz game is already running!");
  if (game5Started) return bot.sendMessage(msg.chat.id, "⚠️ Game 5 (Voting) is currently active. Please end it first!");

  const alivePlayers = registeredPlayers.filter(p => p.status === "alive");

  if (alivePlayers.length === 0) {
    return bot.sendMessage(msg.chat.id, "❌ No players left to start the quiz!");
  }
 

  // Set quizPlayers to the currently alive players
  quizPlayers = alivePlayers;
  quizScores = {}; // Reset scores for new quiz
  quizPlayers.forEach(p => {
    quizScores[p.id] = 0;
  });
  currentQuestionAnswered = false; // Reset for new quiz

  sendQuizInstructions(msg.chat.id, quizPlayers);
});


// sendFinalInstructions renamed to sendQuizInstructions
function sendQuizInstructions(chatId, finalPlayers) {
  const instructions =
    `⚔️ <b>FINAL GAME INSTRUCTIONS</b> ⚔️\n\n` +
    `- You have reached the ultimate final duel!\n` +
    `- You will face off 1v1 in a tense quiz battle.\n` +
    `- It is a best of 3: the first to reach 3 points will win.\n` +
    `- Only the FIRST player to answer correctly gets the point each round — speed matters!\n\n` +
    `- To answer, type: <code>/answer your_answer</code>\n\n` +
    `⏰ You have 2 minutes to prepare and get ready. The duel will start soon… feel the pressure! 🔥`;

  const finalImgPath = path.resolve(__dirname, "images", "final-quiz.jpg");

  bot.sendPhoto(chatId, fs.createReadStream(finalImgPath), {
    caption: instructions,
    parse_mode: "HTML"
  })
    .then(() => {
      setTimeout(() => {
        bot.sendMessage(chatId, "🔥 The FINAL GAME is starting now!");
        startQuiz(chatId, finalPlayers); // Pass finalPlayers to startQuiz
      }, 1 * 60 * 1000); // 1 minute wait before quiz
    })
    .catch(err => {
      console.error("❌ Failed to send final instructions photo:", err);
      bot.sendMessage(chatId, instructions, { parse_mode: "HTML" });

      setTimeout(() => {
        bot.sendMessage(chatId, "🔥 The FINAL GAME is starting now!");
        startQuiz(chatId, finalPlayers);
      }, 1 * 60 * 1000);
    });
}


// Quiz logic (remains mostly the same, but ensure quizPlayers and quizScores are reset)
function startQuiz(chatId, players) { // Now accepts players as an argument
  quizStarted = true;
  quizPlayers = players; // Ensure quizPlayers is updated
  quizScores = {}; // Reset scores
  players.forEach(p => {
    quizScores[p.id] = 0;
  });
  currentQuestionAnswered = false; // Reset for new quiz
  sendNextQuizQuestion(chatId);
}

function sendNextQuizQuestion(chatId) {
  if (quizAnswerTimeout) {
    clearTimeout(quizAnswerTimeout);
  }

  currentQuestionAnswered = false; // 🔥 Mark as unanswered

  // Ensure there are questions left, otherwise end quiz
  if (quizQuestions.length === 0) {
    bot.sendMessage(chatId, "Ran out of quiz questions! Ending quiz.");
    endQuiz(chatId); // Call a new end quiz function
    return;
  }

  // Pick a random question and remove it to avoid repetition in one quiz game
  const randomIndex = Math.floor(Math.random() * quizQuestions.length);
  currentQuestion = quizQuestions.splice(randomIndex, 1)[0]; // Removes the question from the array

  const questionMsg =
    `❓ <b>QUIZ DUEL!</b> ❓\n\n` +
    `⚔️ <b>First player to answer correctly gets the point!</b>\n\n` +
    `💬 <b>Question:</b>\n${currentQuestion.question}\n\n` +
    `⏰ <i>You have 30 seconds! Type</i> <code>/answer your_answer</code> <i>to reply quickly!</i>`; // Changed to 30 seconds

  bot.sendMessage(chatId, questionMsg, { parse_mode: "HTML" });

  quizAnswerTimeout = setTimeout(() => {
    if (!currentQuestionAnswered) {
      bot.sendMessage(chatId, "⌛ <b>Time's up!</b> No one got it correct. No points awarded.", { parse_mode: "HTML" });
      notifyNextQuestion(chatId);
    }
  }, 30 * 1000); // Timeout after 30 seconds
}


function notifyNextQuestion(chatId) {
  // Check if quiz is still active and there are enough players
  if (!quizStarted || quizPlayers.filter(p => p.status === "alive").length < 1) { // Changed to 1, as 1 player can be a winner
    endQuiz(chatId);
    return;
  }

  const msg =
    `⚔️ <b>Prepare for the next question!</b>\n\n` +
    `⏳ <i>You have 1 minute to get ready...</i>\n` +
    `🔥 <b>Stay sharp! The next question could decide your fate!</b>`;

  bot.sendMessage(chatId, msg, { parse_mode: "HTML" });

  setTimeout(() => {
    sendNextQuizQuestion(chatId);
  }, 60 * 1000); // 1 minute delay
}

bot.onText(/\/answer (.+)/, (msg, match) => {
  if (!quizStarted || currentQuestionAnswered) return;

  const userId = msg.from.id;
  const player = quizPlayers.find(p => p.id === userId && p.status === "alive"); // Ensure player is alive
  if (!player) return bot.sendMessage(msg.chat.id, "❌ You are not in the final duel or already eliminated!");

  const answer = match[1].trim().toLowerCase();
  if (answer === currentQuestion.answer.toLowerCase()) {
    currentQuestionAnswered = true; // 🔥 Only first correct counts
    clearTimeout(quizAnswerTimeout);

    quizScores[userId]++;

    let scoreMsg = `✅ ${player.username} answered first and correctly! They get 1 point!\n\n`;
    scoreMsg += "🏅 Current Scores:\n";
    quizPlayers.forEach(p => {
      scoreMsg += `• ${p.username}: ${quizScores[p.id]} point(s)\n`;
    });

    bot.sendMessage(msg.chat.id, scoreMsg);

    if (quizScores[userId] === 3) {
      // Player wins best of 3
      endQuiz(msg.chat.id, player); // Call endQuiz with the winner
    } else {
      notifyNextQuestion(msg.chat.id);
    }
  } else {
    bot.sendMessage(msg.chat.id, "❌ Wrong answer! Keep trying!");
  }
});

// --- NEW: endQuiz function to handle quiz termination ---
function endQuiz(chatId, winner = null) {
  quizStarted = false;
  clearTimeout(quizAnswerTimeout);
  quizAnswerTimeout = null;
  currentQuestion = null; // Clear current question
  currentQuestionAnswered = false; // Reset flag

  if (winner) {
    const winnerImgPath = path.resolve(__dirname, "images", "congrats-1.jpg");

    bot.sendPhoto(
      chatId,
      fs.createReadStream(winnerImgPath),
      {
        caption:
          `🎉 <b>CONGRATULATIONS!</b> 🎉\n\n` +
          `👑 <b>${winner.username} is now crowned the ULTIMATE CHAMPION of the Squid Game!</b>\n\n` +
          `🏆 <b>${winner.username} has won the FINAL GAME!</b>\n\n` +
          `👏 Congratulations to our well-deserving winner!`,
        parse_mode: "HTML"
      }
    );

    winner.status = "winner";
    fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

    // Eliminate other quiz players
    quizPlayers.forEach(p => {
      if (p.id !== winner.id) {
        p.status = "eliminated";
        bot.sendMessage(chatId, `💀 ${p.username} was eliminated.`);
      }
    });

    fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

    bot.sendMessage(chatId, `🏁 Quiz game ended! 🎊 Winner: ${winner.username}`);
  } else {
    // No winner (e.g., ran out of questions, or no players left)
    bot.sendMessage(chatId, "🏁 The Quiz Game has ended without a clear winner. All remaining players are eliminated.");
    quizPlayers.forEach(p => {
      if (p.status === "alive") p.status = "eliminated";
    });
    fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));
  }

  // Reset quiz-specific variables
  quizPlayers = [];
  quizScores = {};
}

// --- NEW: /stopgame5 (for voting) and /stopquiz (for quiz) ---
bot.onText(/\/stopgame5/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can stop Game 5!");
  if (!game5Started) return bot.sendMessage(msg.chat.id, "❌ Game 5 is not running!");

  clearTimeout(game5VoteTimeout);
  game5VoteTimeout = null;
  game5Started = false;
  game5Votes = {};
  game5VotingOpen = false;

  bot.sendMessage(msg.chat.id, "🛑 Game 5 (Voting) has been forcefully stopped!");

  // Reset player statuses if needed
  registeredPlayers.forEach(p => {
    if (p.status === "safe") p.status = "alive";
  });
  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));
});

bot.onText(/\/stopquiz/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can stop the Quiz!");
  if (!quizStarted) return bot.sendMessage(msg.chat.id, "❌ Quiz is not running!");

  endQuiz(msg.chat.id); // Call endQuiz to clean up and declare no winner
  bot.sendMessage(msg.chat.id, "🛑 The Quiz Game has been forcefully stopped!");
});


bot.onText(/\/unlockchat/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can unlock the chat!");

  unlockGroupChat(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ The group chat has been unlocked! Everyone can now send messages.");
});


function lockGroupChat(chatId) {
  bot.setChatPermissions(chatId, {
    can_send_messages: false
  });
}

function unlockGroupChat(chatId) {
  bot.setChatPermissions(chatId, {
    can_send_messages: true,
    can_send_media_messages: true,
    can_send_polls: true,
    can_send_other_messages: true,
    can_add_web_page_previews: true,
    can_invite_users: false
  });
}


// 🌟 ---------- VARIABLES ----------
let jumbledGameActive = false;
let jumbledCorrectWord = "";
let jumbledScrambledWord = "";
let jumbledActivePlayers = [];
let jumbledPrivateAnswers = {};
let roundNumber = 0;

const jumbledWords = [
  { word: "APPLE", question: "This fruit keeps the doctor away." },
  { word: "ORANGE", question: "A citrus fruit and also a color." },
  { word: "BANANA", question: "A long, yellow fruit loved by monkeys." },
  { word: "WATERMELON", question: "Big green fruit with red juicy flesh inside." },
  { word: "MANGO", question: "Known as the king of fruits in many Asian countries." },
  { word: "GRAPES", question: "Tiny fruits used to make wine." },
  { word: "PINEAPPLE", question: "A tropical fruit with spiky skin and sweet yellow flesh." },
  { word: "KIWI", question: "A small brown fruit with green inside and tiny seeds." },
  { word: "PEACH", question: "Soft, fuzzy fruit often seen in summer emoji 🍑." },
  { word: "STRAWBERRY", question: "Red, heart-shaped fruit with seeds on the outside." }
];

function scrambleWord(word) {
  const letters = word.split("");
  for (let i = letters.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [letters[i], letters[j]] = [letters[j], letters[i]];
  }
  return letters.join("");
}

function getRandomJumbledWord() {
  const randomIndex = Math.floor(Math.random() * jumbledWords.length);
  const entry = jumbledWords[randomIndex];
  const scrambled = scrambleWord(entry.word);
  return { word: entry.word, scrambled, question: entry.question };
}


bot.onText(/\/startgame6/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start this game!");
  if (jumbledGameActive) return bot.sendMessage(msg.chat.id, "⚠️ Jumbled Letters game is already active!");

  jumbledActivePlayers = registeredPlayers.filter(p => p.status === "alive").map(p => p.id);
  if (jumbledActivePlayers.length === 0) return bot.sendMessage(msg.chat.id, "⚠️ No active players!");

  lockGroupChat(msg.chat.id);

  const jumbledImgPath = path.resolve(__dirname, "images", "jumble.png");

  bot.sendPhoto(msg.chat.id, fs.createReadStream(jumbledImgPath), {
    caption:
      "🧩 <b>JUMBLED LETTERS GAME!</b>\n\n" +
      "This is a battle of your mind and speed.\n\n" +
      "❓ You will receive a <b>question</b> and a <b>scrambled word</b> HERE in this group chat.\n\n" +
      "✉️ <b>Send your answer PRIVATELY to me (@squiidgamee_bot).</b>\n" +
      "⚠️ <b>Important:</b> You only have <b>ONE TRY</b>! Typo = OUT!\n\n" +
      "⏰ <b>You will have 30 seconds to answer each round after I show the question.</b>\n\n" +
      "💡 <i>Be quick, be sharp — only the smartest will survive!</i>\n\n" +
      "🔒 <b>IMPORTANT:</b> The group chat is now LOCKED. You cannot send messages here until Game 6 ends!\n\n" +
      "⚔️ <b>Get ready!</b> The first round will start in 30 seconds...",
    parse_mode: "HTML"
  });

  setTimeout(() => {
    roundNumber = 1;
    startJumbledRound(msg.chat.id);
  }, 30000);
});

function startJumbledRound(groupChatId) {
  const randomWordData = getRandomJumbledWord();
  jumbledCorrectWord = randomWordData.word.toUpperCase(); // Force upper
  jumbledScrambledWord = randomWordData.scrambled;
  const question = randomWordData.question;
  jumbledPrivateAnswers = {};
  jumbledGameActive = true;

  // Step 1: pre-instruction
  bot.sendMessage(groupChatId,
    `📩 Send your answer PRIVATELY to me (@squiidgamee_bot).\n` +
    `⚠️ Important: You only have ONE TRY! Typo = OUT!\n\n` +
    `⏰ You have 30 seconds per round. Good luck!`
  ).then(() => {
    setTimeout(() => {
      // Step 2: start question
      bot.sendMessage(groupChatId,
        `🤖 @squiidgamee_bot\n\n` +
        `🚨 START ROUND ${roundNumber}\n\n` +
        `❓ <b>Question:</b> ${question}\n` +
        `🔀 Scrambled word: ${jumbledScrambledWord}`,
        { parse_mode: "HTML" }
      );

      // Step 3: wait 30 sec for answers
      setTimeout(() => {
        evaluateJumbledAnswers(groupChatId, question);
      }, 30000);
    }, 10000);
  });
}

bot.on('message', (msg) => {
  if (!jumbledGameActive) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id;
  if (!jumbledActivePlayers.includes(userId)) return;

  // Always reply to user even if duplicate
  if (!jumbledPrivateAnswers[userId]) {
    jumbledPrivateAnswers[userId] = {
      answer: msg.text.trim().toUpperCase(),
      timestamp: Date.now(),
    };
  }

  bot.sendMessage(userId, `✅ Thanks! You answered: "${msg.text.trim()}". Please wait for the results at the game room.`);
});

function evaluateJumbledAnswers(groupChatId, questionText) {
  jumbledGameActive = false;

  const survivors = [];
  const eliminated = [];

  jumbledActivePlayers.forEach((userId) => {
    if (
      jumbledPrivateAnswers[userId] &&
      jumbledPrivateAnswers[userId].answer === jumbledCorrectWord
    ) {
      survivors.push(userId);
    } else {
      eliminated.push(userId);
    }
  });

  registeredPlayers.forEach(p => {
    if (survivors.includes(p.id)) {
      p.status = "alive";
    } else if (eliminated.includes(p.id)) {
      p.status = "eliminated";
    }
  });

  const survivorNames = survivors.map(id => getUsernameById(id)).join(", ") || "None";
  const eliminatedNames = eliminated.map(id => getUsernameById(id)).join(", ") || "None";

  bot.sendMessage(groupChatId,
    `🏁 Round ${roundNumber} finished!\n\n` +
    `✅ Survivors: ${survivorNames}\n` +
    `❌ Eliminated: ${eliminatedNames}`
  );

  if (eliminated.length > 0) {
    const eliminationGifPath = path.resolve(__dirname, "gifs", "bye.gif");
    bot.sendAnimation(groupChatId, fs.createReadStream(eliminationGifPath), {
      caption: `💀 Eliminated: ${eliminatedNames}\n\n⚠️ They will be kicked in 5 seconds... Say your goodbyes!`
    });

    setTimeout(() => {
      eliminated.forEach(userId => {
        bot.banChatMember(groupChatId, userId).catch(err => console.log("Kick error:", err));
      });

      setTimeout(() => {
        handleNextRoundOrFinish(groupChatId, survivors);
      }, 5000);
    }, 5000);
  } else {
    const goodWorkGifPath = path.resolve(__dirname, "gifs", "goodwork.gif");
    bot.sendAnimation(groupChatId, fs.createReadStream(goodWorkGifPath), {
      caption: "👏 Amazing! Nobody was eliminated this round!"
    });

    setTimeout(() => {
      handleNextRoundOrFinish(groupChatId, survivors);
    }, 5000);
  }
}

function handleNextRoundOrFinish(groupChatId, survivors) {
  if (roundNumber === 1) {
    bot.sendMessage(groupChatId, "⚔️ Round 2 will start in 30 seconds! Get ready...");
    jumbledActivePlayers = survivors;

    setTimeout(() => {
      roundNumber = 2;
      startJumbledRound(groupChatId);
    }, 30000);
  } else {
    setTimeout(() => {
      const aliveCount = registeredPlayers.filter(p => p.status === "alive").length;
      const eliminatedCount = registeredPlayers.filter(p => p.status === "eliminated").length;

      // Always show summary first
      bot.sendMessage(groupChatId,
        `🎉 Jumbled Letters Game completed!\n\n` +
        `✅ Total Survivors: ${aliveCount}\n` +
        `❌ Total Eliminated: ${eliminatedCount}\n\n` +
        `🔓 <b>The chat is now UNLOCKED.</b>\n` +
        `⚔️ <b>Prepare yourselves for the next game soon!</b>`,
        { parse_mode: "HTML" }
      ).then(() => {
        unlockGroupChat(groupChatId);

        // Only send GIF if there are eliminated players
        if (eliminatedCount > 0) {
          setTimeout(() => {
            const moneyGifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
            bot.sendAnimation(groupChatId, fs.createReadStream(moneyGifPath), {
              caption: ""
            });
          }, 5000);
        }
      });
    }, 5000);
  }
}

function getUsernameById(id) {
  const player = registeredPlayers.find(p => p.id === id);
  if (!player || !player.username) return "Unknown";
  return player.username.startsWith("@") ? player.username : `@${player.username}`;
}

// 🌟 ---------- VARIABLES ----------
let flagGameActive = false;
let flagCorrectAnswer = "";
let flagActivePlayers = [];
let flagPrivateAnswers = {};
let flagRoundNumber = 0;

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

function getRandomFlag() {
  const randomIndex = Math.floor(Math.random() * flagDataList.length);
  return flagDataList[randomIndex];
}

// 🌟 ---------- START GAME ----------
bot.onText(/\/startgame7/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start this game!");
  if (flagGameActive) return bot.sendMessage(msg.chat.id, "⚠️ Guess the Flag game is already active!");

  flagActivePlayers = registeredPlayers.filter(p => p.status === "alive").map(p => p.id);
  if (flagActivePlayers.length === 0) return bot.sendMessage(msg.chat.id, "⚠️ No active players!");

  lockGroupChat(msg.chat.id);

  // Provide the image path here (you can change it to your chosen intro image)
  const flagIntroImgPath = path.resolve(__dirname, "images", "guess-flag.png");

  bot.sendPhoto(msg.chat.id, fs.createReadStream(flagIntroImgPath), {
    caption:
      "🏳️‍🌈 <b>GUESS THE FLAG GAME!</b>\n\n" +
      "This is a test of your world knowledge and speed!\n\n" +
      "🌍 You will see a <b>flag</b> HERE in this group chat.\n\n" +
      "✉️ <b>Send your guess PRIVATELY to me (@squiidgamee_bot).</b>\n" +
      "⚠️ <b>Important:</b> You only have <b>ONE TRY</b>! Typo = OUT!\n\n" +
      "⏰ <b>You will have 30 seconds to answer each round after I show the flag.</b>\n\n" +
      "💡 <i>Be quick, be sharp — only the best will survive!</i>\n\n" +
      "🔒 <b>IMPORTANT:</b> The group chat is now LOCKED. You cannot send messages here until Game 7 ends!\n\n" +
      "⚔️ <b>Get ready!</b> The first round will start in 30 seconds...",
    parse_mode: "HTML"
  });

  setTimeout(() => {
    flagRoundNumber = 1;
    startFlagRound(msg.chat.id);
  }, 30000);
});

function startFlagRound(groupChatId) {
  const flagData = getRandomFlag();
  flagCorrectAnswer = flagData.country.toUpperCase();
  flagPrivateAnswers = {};
  flagGameActive = true;

  bot.sendMessage(groupChatId,
    `📩 Send your answer PRIVATELY to me (@squiidgamee_bot).\n` +
    `⚠️ Important: You only have ONE TRY! Typo = OUT!\n\n` +
    `⏰ You have 30 seconds per round. Good luck!`
  ).then(() => {
    setTimeout(() => {
      const flagImgPath = path.resolve(__dirname, "images", flagData.file);
      bot.sendPhoto(groupChatId, fs.createReadStream(flagImgPath), {
        caption:
          `🤖 @squiidgamee_bot\n\n` +
          `🚨 START ROUND ${flagRoundNumber}\n\n` +
          `🏳️ Guess the flag!`,
        parse_mode: "HTML"
      });


      setTimeout(() => {
        evaluateFlagAnswers(groupChatId);
      }, 30000);
    }, 10000);
  });
}

bot.on('message', (msg) => {
  if (!flagGameActive) return;
  if (msg.chat.type !== "private") return;

  const userId = msg.from.id;
  if (!flagActivePlayers.includes(userId)) return;

  if (!flagPrivateAnswers[userId]) {
    flagPrivateAnswers[userId] = {
      answer: msg.text.trim().toUpperCase(),
      timestamp: Date.now(),
    };
  }

  bot.sendMessage(userId, `✅ Thanks! You answered: "${msg.text.trim()}". Please wait for the results at the game room.`);
});

function evaluateFlagAnswers(groupChatId) {
  flagGameActive = false;

  const survivors = [];
  const eliminated = [];

  flagActivePlayers.forEach((userId) => {
    if (
      flagPrivateAnswers[userId] &&
      flagPrivateAnswers[userId].answer === flagCorrectAnswer
    ) {
      survivors.push(userId);
    } else {
      eliminated.push(userId);
    }
  });

  registeredPlayers.forEach(p => {
    if (survivors.includes(p.id)) {
      p.status = "alive";
    } else if (eliminated.includes(p.id)) {
      p.status = "eliminated";
    }
  });

  const survivorNames = survivors.map(id => getUsernameById(id)).join(", ") || "None";
  const eliminatedNames = eliminated.map(id => getUsernameById(id)).join(", ") || "None";

  bot.sendMessage(groupChatId,
    `🏁 Round ${flagRoundNumber} finished!\n\n` +
    `✅ Survivors: ${survivorNames}\n` +
    `❌ Eliminated: ${eliminatedNames}`
  );

  if (eliminated.length > 0) {
    const eliminationGifPath = path.resolve(__dirname, "gifs", "bye.gif");
    bot.sendAnimation(groupChatId, fs.createReadStream(eliminationGifPath), {
      caption: `💀 Eliminated: ${eliminatedNames}\n\n⚠️ They will be kicked in 5 seconds... Say your goodbyes!`
    });

    setTimeout(() => {
      eliminated.forEach(userId => {
        bot.banChatMember(groupChatId, userId).catch(err => console.log("Kick error:", err));
      });

      setTimeout(() => {
        handleNextFlagRoundOrFinish(groupChatId, survivors);
      }, 5000);
    }, 5000);
  } else {
    const goodWorkGifPath = path.resolve(__dirname, "gifs", "goodwork.gif");
    bot.sendAnimation(groupChatId, fs.createReadStream(goodWorkGifPath), {
      caption: "👏 Amazing! Nobody was eliminated this round!"
    });

    setTimeout(() => {
      handleNextFlagRoundOrFinish(groupChatId, survivors);
    }, 5000);
  }
}

function handleNextFlagRoundOrFinish(groupChatId, survivors) {
  if (flagRoundNumber === 1) {
    bot.sendMessage(groupChatId, "⚔️ Round 2 will start in 30 seconds! Get ready...");
    flagActivePlayers = survivors;

    setTimeout(() => {
      flagRoundNumber = 2;
      startFlagRound(groupChatId);
    }, 30000);
  } else {
    setTimeout(() => {
      const aliveCount = registeredPlayers.filter(p => p.status === "alive").length;
      const eliminatedCount = registeredPlayers.filter(p => p.status === "eliminated").length;

      bot.sendMessage(groupChatId,
        `🎉 Guess the Flag Game completed!\n\n` +
        `✅ Total Survivors: ${aliveCount}\n` +
        `❌ Total Eliminated: ${eliminatedCount}\n\n` +
        `🔓 <b>The chat is now UNLOCKED.</b>\n` +
        `⚔️ <b>Prepare yourselves for the next game soon!</b>`,
        { parse_mode: "HTML" }
      ).then(() => {
        unlockGroupChat(groupChatId);

        if (eliminatedCount > 0) {
          setTimeout(() => {
            const moneyGifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
            bot.sendAnimation(groupChatId, fs.createReadStream(moneyGifPath), {
              caption: ""
            });
          }, 5000);
        }
      });
    }, 5000);
  }
}

function getUsernameById(id) {
  const player = registeredPlayers.find(p => p.id === id);
  if (!player || !player.username) return "Unknown";
  return player.username.startsWith("@") ? player.username : `@${player.username}`;
}




// --- New Game 3 State Variables ---
let choicePhaseStarted = false; // Indicates start of the Trust/Betray phase
let playerChoices = new Map(); // Stores userId -> "Trust" or "Betray"
let choicePhaseTimeout; // Timeout for the choice phase
let game3Started = false;
// Add these to your player object in players.json or when initializing
// p.choice = null; // To store their choice in the Trust/Betray game

// --- Functions for Trust/Betray Reply Keyboard ---
async function sendChoiceButtons(chatId, username) {
  try {
    await bot.sendMessage(chatId, `🤝 ${username}, it's time to make your choice. What will you do?`, {
      reply_markup: {
        keyboard: [
          [{ text: "🤝 Trust" }, { text: "🔪 Betray" }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true // Make it one-time so it disappears after choice
      }
    });
    console.log(`Choice reply keyboard sent to ${username}.`);
  } catch (err) {
    console.error(`❌ Failed to send choice buttons to chat ${chatId}:`, err.message);
    bot.sendMessage(chatId, `⚠️ Error sending choice buttons: ${err.message}`).catch(console.error);
  }
}

async function removeChoiceButtons(chatId) {
  try {
    await bot.sendMessage(chatId, "Removing choice buttons...", {
      reply_markup: {
        remove_keyboard: true
      }
    });
    console.log("Choice reply keyboard removed successfully.");
  } catch (e) {
    console.warn(`⚠️ Failed to remove choice reply keyboard:`, e);
  }
}

// --- Modified /startgame3 command ---
bot.onText(/\/startgame3/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can start Game 3!");
  if (game3Started) return bot.sendMessage(msg.chat.id, "⚠️ Game 3 already started!");

  const alivePlayers = registeredPlayers.filter(p => p.status === "alive" || p.status === "safe");
  if (alivePlayers.length < 2) {
    return bot.sendMessage(msg.chat.id, "❌ Cannot start Game 3! Need at least 2 alive players to form pairs.");
  }

  // Reset game state
  game3Started = true;
  pairs = [];
  sacrificePhaseStarted = false; // Remove if not used elsewhere, or keep for general game active status
  choicePhaseStarted = false; // New: indicate choice phase is not yet active
  allowPickingPartner = false;
  // currentRollPhase = "first"; // REMOVE THIS LINE
  // playerRollCooldowns.clear(); // REMOVE THIS LINE
  playerChoices.clear(); // NEW: Clear player choices

  // Reset players for Game 3
  registeredPlayers.forEach(p => {
    if (p.status === "alive" || p.status === "safe") {
      p.pickedPartner = null;
      p.partnerConfirmed = false;
      // REMOVE THESE:
      // p.firstRoll = null;
      // p.secondRoll = null;
      p.choice = null; // NEW: Reset choice
    }
  });
  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  const trustImgPath = path.resolve(__dirname, "images", "shake1.jpg");

  await bot.sendPhoto(msg.chat.id, fs.createReadStream(trustImgPath), {
    caption:
      "🤝 <b>Game 3: TRUST GAME!</b>\n\n" +
      "This round is a <b>partner-based</b> game. You must find a partner you trust — or face elimination.\n\n" +
      "⏰ You have <b>2 minutes</b> to look for and choose your partner. After this phase ends, the Front Man will announce how to <b>lock in</b> your chosen partner.\n\n" +
      "⚠️ <b>Important:</b> Players without partners after this phase will be <b>eliminated without mercy</b>.\n\n" +
      "Good luck... choose wisely! 🔥",
    parse_mode: "HTML"
  })
    .catch((err) => {
      console.error("❌ Failed to send trust game image:", err);
      bot.sendMessage(msg.chat.id, "🤝 Game 3: TRUST GAME!\n\nPick your most trusted friend as your partner. You have 2 minutes to decide...");
    });

  setTimeout(async () => {
    allowPickingPartner = true;
    await bot.sendMessage(msg.chat.id,
      "🤝 <b>Lock your choice!</b>\n\n" +
      "🕰️ Now is the time to officially pick your partner.\n" +
      "Use the command: <b>/pick @username</b> to lock in your partner.\n\n" +
      "⏰ You have <b>1 minute</b> to decide. After this, there is no turning back.\n\n" +
      "⚠️ <b>Remember:</b> If you fail to pick a partner in time, you will be <b>eliminated</b>."
      , { parse_mode: "HTML" });

    startPartnerPhase(msg.chat.id);
  }, 1 * 60 * 1000);
});

// --- startPartnerPhase remains largely the same, but calls startChoicePhase ---
function startPartnerPhase(chatId) {
  let minutesLeft = 1;

  partnerPhaseInterval = setInterval(() => {
    minutesLeft--;
    if (minutesLeft > 0) {
      const noPartners = registeredPlayers.filter(p => (p.status === "alive" || p.status === "safe") && !p.partnerConfirmed);

      const message = `⏰ *${minutesLeft} minute(s) remaining to choose your partner!*\n\n` +
        `💀 *WARNING: Players without partners when the time is up will be eliminated without mercy!*\n\n` +
        `🚨 *Current players without partners:* \n${noPartners.map(p => `• ${p.username}`).join('\n') || "✅ Everyone has a partner! Keep it up!"}`;

      bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
    }
  }, 60 * 1000);

  partnerPhaseTimeout = setTimeout(() => {
    clearInterval(partnerPhaseInterval);
    allowPickingPartner = false;

    registeredPlayers.forEach(p => {
      if ((p.status === "alive" || p.status === "safe") && !p.partnerConfirmed) {
        p.status = "eliminated";
      }
    });
    fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

    const validPairsForChoice = pairs.filter(pair =>
      (pair[0].status === "alive" || pair[0].status === "safe") &&
      (pair[1].status === "alive" || pair[1].status === "safe")
    );
    pairs = validPairsForChoice;

    const survivors = registeredPlayers.filter(p => p.partnerConfirmed && (p.status === "alive" || p.status === "safe")).map(p => p.username);
    const eliminatedPlayers = registeredPlayers.filter(p => p.status === "eliminated");
    const eliminatedNames = eliminatedPlayers.map(p => p.username);

    let summary = `🏁✨ <b>Partner phase has ended!</b> ✨🏁\n\n`;
    summary += `✅ Found partners:\n${survivors.map(u => `• ${u}`).join('\n') || "None"}\n\n`;
    summary += `💀 No partners (Eliminated):\n${eliminatedNames.map(u => `• ${u}`).join('\n') || "None"}`;

    bot.sendMessage(chatId, summary, { parse_mode: "HTML" })
      .then(() => {
        if (eliminatedPlayers.length === 0) {
          bot.sendMessage(chatId, "🎉 Amazing! Everyone found a partner and survived! 💪")
            .then(() => {
              const goodworkGifPath = path.resolve(__dirname, "gifs", "goodwork.gif");
              return bot.sendAnimation(chatId, fs.createReadStream(goodworkGifPath));
            })
            .then(() => {
              setTimeout(() => {
                if (pairs.length === 0) {
                  bot.sendMessage(chatId, "All players survived the partner phase, but no valid pairs were formed for the choice phase. Game 3 ends here.", { parse_mode: "HTML" });
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
          const eliminationGifPath = path.resolve(__dirname, "gifs", "bye.gif");
          bot.sendAnimation(chatId, fs.createReadStream(eliminationGifPath))
            .then(() => {
              return bot.sendMessage(chatId, "⚠️ 💀 Players without partners will be kicked in 10 seconds!");
            })
            .then(() => {
              return new Promise(resolve => setTimeout(resolve, 10 * 1000));
            })
            .then(async () => {
              for (const p of eliminatedPlayers) {
                try {
                  await bot.banChatMember(chatId, p.id);
                  console.log(`✅ Kicked (banned) ${p.username}`);
                } catch (err) {
                  console.error(`❌ Failed to kick ${p.username}:`, err);
                }
              }

              let afterKickMsg = `🏁✅ <b>Partner phase eliminations completed!</b>\n\n`;
              afterKickMsg += `👥 Remaining Survivors: <b>${survivors.length}</b>\n`;
              afterKickMsg += `💀 Total Eliminated: <b>${eliminatedNames.length}</b>`;

              await bot.sendMessage(chatId, afterKickMsg, { parse_mode: "HTML" });
              const moneyGifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
              await bot.sendAnimation(chatId, fs.createReadStream(moneyGifPath));
              console.log("✅ Celebration GIF sent!");
            })
            .then(() => {
              setTimeout(() => {
                if (pairs.length === 0) {
                  bot.sendMessage(chatId, "All surviving players formed pairs, but no pairs were valid for the choice phase. Game 3 ends here.", { parse_mode: "HTML" });
                  endGame3Cleanly(chatId);
                } else {
                  startChoicePhase(chatId); // CALL THE NEW CHOICE PHASE
                }
              }, 5000);
            })
            .catch(err => {
              console.error("❌ Error in elimination flow:", err);
            });
        }
      })
      .catch(err => {
        console.error("❌ Error in partner phase summary:", err);
      });
  }, 1 * 60 * 1000);
}

bot.onText(/\/pick (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

  // IMPORTANT: Normalize the target username to ensure consistent matching
  // Remove '@' if present, or add it if not (decide your standard)
  let targetUsername = match[1].trim();
  if (targetUsername.startsWith('@')) {
    targetUsername = targetUsername; // Keep it if your stored usernames have @
    // OR: targetUsername = targetUsername.substring(1); // Remove it if your stored usernames don't have @
  } else {
    // If your stored usernames usually have @, you might need to add it
    targetUsername = `@${targetUsername}`;
  }

  // Convert both for case-insensitive comparison
  const lowerCaseTargetUsername = targetUsername.toLowerCase();

  console.log(`[PICK COMMAND] ${username} attempting to pick ${targetUsername}`);

  if (!game3Started) {
    console.log(`[PICK COMMAND] Game 3 not started. User: ${username}`);
    return bot.sendMessage(chatId, "❌ Game 3 is not running!");
  }

  if (!allowPickingPartner) {
    console.log(`[PICK COMMAND] Partner picking not allowed yet. User: ${username}`);
    return bot.sendMessage(chatId, "⚠️ You cannot pick a partner yet! Wait for the Front Man's instruction to lock in your partner.");
  }

  if (lowerCaseTargetUsername === username.toLowerCase()) { // Compare lowercased
    console.log(`[PICK COMMAND] User tried to pick self. User: ${username}`);
    return bot.sendMessage(chatId, "⚠️ You cannot pick yourself as your partner! Please choose someone else.");
  }

  const player = registeredPlayers.find(p => p.id === userId && (p.status === "alive" || p.status === "safe"));
  if (!player) {
    console.log(`[PICK COMMAND] Player not in game or eliminated. User ID: ${userId}`);
    return bot.sendMessage(chatId, "❌ You are not in the game or already eliminated!");
  }
  if (player.partnerConfirmed) {
    console.log(`[PICK COMMAND] Player already confirmed partner. User: ${username}`);
    return bot.sendMessage(chatId, "⚠️ You have already locked in a partner!");
  }

  console.log(`[PICK COMMAND] Searching for targetPlayer: ${targetUsername} (normalized: ${lowerCaseTargetUsername})`);

  // The find operation, now with case-insensitive comparison
  const targetPlayer = registeredPlayers.find(p =>
    p.username.toLowerCase() === lowerCaseTargetUsername &&
    (p.status === "alive" || p.status === "safe")
  );

  // THIS IS THE CRITICAL CHECK FOR UNDEFINED
  if (!targetPlayer) {
    console.error(`[PICK ERROR] targetPlayer is undefined. Searched for: ${targetUsername}. Found in registeredPlayers: ${registeredPlayers.map(p => p.username).join(', ')}`);
    return bot.sendMessage(chatId, `❌ ${targetUsername} is not available, not registered, or already eliminated!`);
  }

  console.log(`[PICK COMMAND] Found targetPlayer: ${targetPlayer.username}. Status: ${targetPlayer.status}`);

  // This check is now safe because we know targetPlayer is defined
  if (targetPlayer.partnerConfirmed) {
    console.log(`[PICK COMMAND] Target player already confirmed partner. Target: ${targetPlayer.username}`);
    return bot.sendMessage(chatId, `⚠️ ${targetUsername} has already locked in a partner!`);
  }

  // If the target already picked the current player => auto lock both
  if (targetPlayer.pickedPartner === username) { // Use original 'username' as this is for comparison with what they 'picked'
    console.log(`[PICK COMMAND] Mutual pick confirmed between ${username} and ${targetUsername}`);
    player.partnerConfirmed = true;
    targetPlayer.partnerConfirmed = true;
    player.pickedPartner = null;
    targetPlayer.pickedPartner = null;

    const isPairAlreadyAdded = pairs.some(p =>
      (p[0].id === player.id && p[1].id === targetPlayer.id) ||
      (p[0].id === targetPlayer.id && p[1].id === player.id)
    );

    if (!isPairAlreadyAdded) {
      pairs.push([player, targetPlayer]);
      console.log(`[PICK COMMAND] Added new pair: ${player.username} - ${targetPlayer.username}`);
    } else {
      console.log(`[PICK COMMAND] Attempted to add existing pair ${player.username}-${targetPlayer.username}. Skipping.`);
    }

    bot.sendMessage(chatId, `🤝 ${username} and ${targetUsername} are now officially partners! 🫱🏼‍🫲🏼`);
  } else {
    player.pickedPartner = targetUsername;
    console.log(`[PICK COMMAND] ${username} picked ${targetUsername}. Waiting for reciprocal pick.`);
    bot.sendMessage(chatId, `✅ You picked ${targetUsername}. Waiting for them to pick you back to lock in!`);
  }

  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));
  console.log(`[PICK COMMAND] players.json updated.`);
});

async function startChoicePhase(chatId) {
  if (pairs.length === 0) {
    bot.sendMessage(chatId, "⚠️ No valid pairs were formed! Game 3 cannot continue to the choice phase.", { parse_mode: "HTML" });
    return endGame3Cleanly(chatId);
  }

  choicePhaseStarted = true; // NEW: Set choice phase active

  const choiceImgPath = path.resolve(__dirname, "images", "shake1.jpg"); // You'll need an image for this

  await bot.sendPhoto(chatId, fs.createReadStream(choiceImgPath), {
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
      "Your choice buttons will appear shortly.", // Updated message
    parse_mode: "HTML"
  })
    .catch((err) => {
      console.error("❌ Failed to send dilemma image:", err);
      bot.sendMessage(chatId, "🤔 THE FINAL TEST OF TRUST!\n\nRules will be explained, then your buttons will appear.");
    });

  // Announce the delay
  await bot.sendMessage(chatId, "⏳ The choice buttons will appear in **2 minutes**. Use this time to consider your options wisely!", { parse_mode: "Markdown" });


  // Delay sending the "Trust" / "Betray" buttons
  setTimeout(async () => {
    // Send the "Trust" / "Betray" buttons to each player
    // Determine whether to send to private chat (p.id) or group chat (chatId)
    // Based on your previous setup, you were sending to p.id (private chat)
    for (const pair of pairs) {
      const [p1, p2] = pair;
      // Only send buttons to players who haven't made a choice yet and are alive/safe
      if (p1.status !== "eliminated" && p1.choice === null) {
        await sendChoiceButtons(p1.id, p1.username); // Send to private chat
      }
      if (p2.status !== "eliminated" && p2.choice === null) {
        await sendChoiceButtons(p2.id, p2.username); // Send to private chat
      }
    }
    await bot.sendMessage(chatId, "🚨 **YOUR CHOICE BUTTONS HAVE APPEARED!** Look for them now to make your selection.", { parse_mode: "Markdown" });

    // Start the main timeout for choice phase resolution
    choicePhaseTimeout = setTimeout(() => {
      resolveChoicePhase(chatId);
    }, 60 * 1000); // 1 minute to choose after buttons appear

  }, 2 * 60 * 1000); // 2 minute delay for the buttons
}

// --- NEW bot.onText for "Trust" and "Betray" buttons ---
bot.onText(/^(🤝 Trust|🔪 Betray)$/, async (msg) => {
  const userId = msg.from.id;
  const chatId = msg.chat.id; // This will be the group chat ID
  const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
  const choice = msg.text === "🤝 Trust" ? "Trust" : "Betray";

  if (!choicePhaseStarted) {
    bot.sendMessage(chatId, "❌ You can't make a choice now! The game is not in a choice phase.");
    return;
  }

  const player = registeredPlayers.find(p => p.id === userId && p.partnerConfirmed && p.status !== "eliminated");

  if (!player) {
    bot.sendMessage(chatId, "❌ You are not in the game or eligible to make a choice!");
    return;
  }

  // Check if player has already made a choice
  if (player.choice !== null) {
    bot.sendMessage(chatId, "⚠️ You have already made your choice! You cannot change it.");
    return;
  }

  // Store the player's choice
  player.choice = choice;
  playerChoices.set(userId, choice); // Also update the temporary map for quick lookup

  bot.sendMessage(chatId, `✅ ${username}, your choice of <b>${choice}</b> has been recorded!`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });

  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  // Optional: Check if all players in a pair have made their choice, then reveal early
  const playerPair = pairs.find(p => p[0].id === userId || p[1].id === userId);
  if (playerPair) {
    const otherPlayer = playerPair[0].id === userId ? playerPair[1] : playerPair[0];
    if (otherPlayer.choice !== null) {
      // Both players in the pair have made their choice
      // You could potentially trigger resolution earlier for this specific pair,
      // or just let the main timeout handle it. For simplicity, we'll let the timeout.
      // If you want instant resolution per pair, this is where you'd call a sub-function.
    }
  }
});

// --- NEW resolveChoicePhase function (replaces resolveFightPhase) ---
async function resolveChoicePhase(chatId) {
  if (!game3Started) return bot.sendMessage(chatId, "❌ Game 3 is not running!");

  clearTimeout(choicePhaseTimeout); // Clear any lingering timeout

  await removeChoiceButtons(chatId); // Remove the choice buttons

  const survivors = [];
  const eliminated = [];
  const choiceSummary = [];

  const activePairs = pairs.filter(pair =>
    (pair[0].status === "alive" || pair[0].status === "safe") &&
    (pair[1].status === "alive" || pair[1].status === "safe")
  );

  if (activePairs.length === 0) {
    await bot.sendMessage(chatId, "No active pairs left to resolve in the Choice Phase. Ending Game 3.", { parse_mode: "HTML" });
    return endGame3Cleanly(chatId);
  }

  for (const pair of activePairs) {
    const [p1, p2] = pair;

    // Default choice to "Betray" if no choice was made
    p1.choice = p1.choice || "Betray";
    p2.choice = p2.choice || "Betray";

    choiceSummary.push(`🤝 <b>${p1.username}</b> chose: <b>${p1.choice}</b>`);
    choiceSummary.push(`🤝 <b>${p2.username}</b> chose: <b>${p2.choice}</b>`);

    let outcomeMessage = ``;

    if (p1.choice === "Trust" && p2.choice === "Trust") {
      // Both Trust: Both Survive
      p1.status = "safe";
      p2.status = "safe";
      survivors.push(p1.username, p2.username);
      outcomeMessage = `🎉 <b>Both ${p1.username} and ${p2.username} chose to TRUST each other! Both survive!</b>`;
    } else if (p1.choice === "Betray" && p2.choice === "Betray") {
      // Both Betray: Both Eliminated
      p1.status = "eliminated";
      p2.status = "eliminated";
      eliminated.push(p1.username, p2.username);
      outcomeMessage = `💀 <b>Both ${p1.username} and ${p2.username} chose to BETRAY each other! Both are eliminated!</b>`;
    } else {
      // One Trust, One Betray
      if (p1.choice === "Trust" && p2.choice === "Betray") {
        p1.status = "eliminated";
        p2.status = "safe";
        survivors.push(p2.username);
        eliminated.push(p1.username);
        outcomeMessage = `💔 <b>${p2.username} BETRAYED ${p1.username}! ${p1.username} is eliminated, ${p2.username} survives!</b>`;
      } else { // p1.choice === "Betray" && p2.choice === "Trust"
        p1.status = "safe";
        p2.status = "eliminated";
        survivors.push(p1.username);
        eliminated.push(p2.username);
        outcomeMessage = `💔 <b>${p1.username} BETRAYED ${p2.username}! ${p2.username} is eliminated, ${p1.username} survives!</b>`;
      }
    }
    choiceSummary.push(outcomeMessage);
    choiceSummary.push("\n"); // Add a separator for clarity
  }

  let finalMessage = `🏁 <b>CHOICE PHASE RESULTS!</b> 🏁\n\n`;
  finalMessage += choiceSummary.join('\n');

  await bot.sendMessage(chatId, finalMessage, { parse_mode: "HTML" });

  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  const actualEliminatedPlayers = registeredPlayers.filter(p => p.status === "eliminated");
  const actualEliminatedNames = actualEliminatedPlayers.map(p => p.username);

  if (actualEliminatedPlayers.length > 0) {
    const eliminationMsg = `💀 <b>The following players were eliminated and will be kicked in 10 seconds:</b>\n\n${actualEliminatedNames.map(u => `• ${u}`).join('\n')}`;
    await bot.sendMessage(chatId, eliminationMsg, { parse_mode: "HTML" });
    const eliminationGifPath = path.resolve(__dirname, "gifs", "bye.gif");
    await bot.sendAnimation(chatId, fs.createReadStream(eliminationGifPath));
    await new Promise(resolve => setTimeout(resolve, 10 * 1000));

    for (const player of actualEliminatedPlayers) {
      try {
        await bot.banChatMember(chatId, player.id);
        console.log(`✅ Successfully kicked ${player.username}`);
      } catch (err) {
        console.error(`❌ Failed to kick ${player.username}:`, err);
      }
    }

    let afterKickMsg = `🏁✅ <b>Choice Phase Eliminations Completed!</b>\n\n`;
    afterKickMsg += `👥 <b>Remaining Survivors:</b> ${survivors.length}\n`;
    afterKickMsg += `💀 <b>Total Eliminated:</b> ${actualEliminatedNames.length}`;

    await bot.sendMessage(chatId, afterKickMsg, { parse_mode: "HTML" });
    const moneyGifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
    await bot.sendAnimation(chatId, fs.createReadStream(moneyGifPath));
    console.log("✅ Celebration GIF sent!");
  } else {
    await bot.sendMessage(chatId, `✅ <b>Everyone survived the choice phase! 🎉</b>`, { parse_mode: "HTML" });
    const moneyGifPath = path.resolve(__dirname, "gifs", "falling-money-squid-game.gif");
    await bot.sendAnimation(chatId, fs.createReadStream(moneyGifPath));
    console.log("✅ Celebration GIF sent!");
  }

  endGame3Cleanly(chatId);
}

// --- Modified endGame3Cleanly function ---
function endGame3Cleanly(chatId) {
  registeredPlayers.forEach(p => {
    if (p.status === "safe") p.status = "alive";
    p.pickedPartner = null;
    p.partnerConfirmed = false;
    // REMOVE THESE:
    // p.firstRoll = null;
    // p.secondRoll = null;
    p.choice = null; // NEW: Clear player choice
  });
  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  bot.sendMessage(chatId, "🎉 <b>Game 3 has ended!</b>\nGet ready for the next game!", { parse_mode: "HTML" });

  // Reset all game state flags
  game3Started = false;
  pairs = [];
  // sacrificePhaseStarted = false; // Keep if you use it as a general 'game active' flag
  choicePhaseStarted = false; // NEW: Reset choice phase flag
  allowPickingPartner = false;
  // currentRollPhase = "first"; // REMOVE THIS
  // playerRollCooldowns.clear(); // REMOVE THIS
  playerChoices.clear(); // NEW: Ensure cleared

  // Clear any lingering timeouts/intervals
  clearTimeout(partnerPhaseTimeout);
  clearInterval(partnerPhaseInterval);
  clearTimeout(choicePhaseTimeout); // NEW: Clear choice phase timeout
  // clearTimeout(firstRollPhaseTimeout); // REMOVE THIS
  // clearTimeout(secondRollPhaseTimeout); // REMOVE THIS

  partnerPhaseTimeout = null;
  partnerPhaseInterval = null;
  choicePhaseTimeout = null; // NEW: Set to null
  // firstRollPhaseTimeout = null; // REMOVE THIS
  // secondRollPhaseTimeout = null; // REMOVE THIS
}


// --- Modified /stopgame3 command ---
bot.onText(/\/stopgame3/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return bot.sendMessage(msg.chat.id, "⚠️ Only the host can stop Game 3!");
  if (!game3Started) return bot.sendMessage(msg.chat.id, "❌ Game 3 is not running!");

  await bot.sendMessage(msg.chat.id, "🛑 Game 3 has been forcefully stopped and reset!");
  // You might need to remove both roll and choice buttons if they could overlap
  // await removeRollButtons(msg.chat.id); // REMOVE OR REMOVE IF ONLY CHOICE BUTTONS ARE PRESENT
  await removeChoiceButtons(msg.chat.id); // NEW: Ensure choice buttons are removed

  endGame3Cleanly(msg.chat.id);
});



const GROUP_CHAT_ID = -1002586678117; // <<< REPLACE THIS WITH YOUR ACTUAL GROUP CHAT ID

// --- Game Assets Paths ---
const GAME9_INSTRUCTIONS_PHOTO_PATH = 'images/guess_number.jpg';
const FALLING_MONEY_GIF_PATH = 'gifs/falling-money-squid-game.gif';
const GOOD_WORK_GIF_PATH = 'gifs/goodwork.gif';

// --- Game State Variables ---
let game9Active = false;
let game9Data = {}; // { userId: { number, guessesLeft, timeout } }
let game9Participants = []; // To keep track of all players participating for the summary
let gameEndProcessed = false; // Prevent multiple game end processing

// --- Utility Functions ---

function getUsernameById(id) {
  try {
    let players = JSON.parse(fs.readFileSync("players.json"));
    const player = players.find(p => p.id === id);
    if (!player) {
      return "Unknown Player";
    }
    return player.username ? (player.username.startsWith("@") ? player.username : `@${player.username}`) : (player.first_name || "Unknown Player");
  } catch (error) {
    console.error("Error reading players.json in getUsernameById:", error.message);
    return "Unknown Player";
  }
}

async function markPlayerSafe(userId) {
  try {
    let players = JSON.parse(fs.readFileSync("players.json"));
    const p = players.find(p => p.id === userId);
    if (p) {
      p.status = "alive";
      fs.writeFileSync("players.json", JSON.stringify(players, null, 2));
    }
  } catch (error) {
    console.error("Error marking player safe:", error.message);
  }
}

async function eliminatePlayer(userId) {
  try {
    let players = JSON.parse(fs.readFileSync("players.json"));
    const p = players.find(p => p.id === userId);
    if (p) {
      p.status = "eliminated";
      fs.writeFileSync("players.json", JSON.stringify(players, null, 2));
    }
  } catch (error) {
    console.error("Error eliminating player:", error.message);
  }
}

function updateParticipantStatus(userId, status) {
  const participant = game9Participants.find(p => p.id === userId);
  if (participant) {
    participant.status = status;
  }
}

// Consolidated function to handle player elimination
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
    await bot.sendMessage(userId, `🚨 ELIMINATED 🚨

${messageToPlayer}

💀 Game over.`, { parse_mode: "HTML" });
  } catch (error) {
    console.error(`Failed to send elimination message to ${userId}:`, error.message);
  }

  // Send group notification
  const username = getUsernameById(userId);
  try {
    await bot.sendMessage(GROUP_CHAT_ID, `💥 ${username} ELIMINATED! 💥

⚰️ Another one falls...`, { parse_mode: "HTML" });
  } catch (error) {
    console.error(`Failed to send group elimination message:`, error.message);
  }

  // Handle kicking with delay if requested
  if (shouldKick) {
    setTimeout(async () => {
      try {
        await bot.banChatMember(GROUP_CHAT_ID, userId);
        console.log(`Successfully banned ${username} (ID: ${userId}) from the group.`);
      } catch (error) {
        console.error(`Failed to ban user ${username} (ID: ${userId}):`, error.message);
        try {
          await bot.sendMessage(GROUP_CHAT_ID, `⚠️ SYSTEM ERROR

Could not remove ${username}.
Bot lacks permissions.`, { parse_mode: "HTML" });
        } catch (msgError) {
          console.error("Failed to send ban failure message:", msgError.message);
        }
      }
    }, 3000);
  }

  // Check game end immediately after processing elimination
  setTimeout(() => checkGameEnd(), 1000);
}

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

    const survivedPlayers = game9Participants.filter(p => p.status === 'safe');
    const eliminatedPlayers = game9Participants.filter(p => p.status === 'eliminated');

    // Build enhanced summary message
    let summaryMessage = "🎯 GAME 9 RESULTS 🎯\n\n📊 GUESS THE NUMBER";

    if (survivedPlayers.length > 0) {
      summaryMessage += `\n\n🏆 SURVIVORS (${survivedPlayers.length})`;
      survivedPlayers.forEach(p => summaryMessage += `\n   ✅ ${getUsernameById(p.id)}`);
    } else {
      summaryMessage += `\n\n💀 TOTAL ELIMINATION\n😱 Nobody survived!`;
    }

    if (eliminatedPlayers.length > 0) {
      summaryMessage += `\n\n☠️ ELIMINATED (${eliminatedPlayers.length})`;
      eliminatedPlayers.forEach(p => summaryMessage += `\n   ❌ ${getUsernameById(p.id)}`);
    }

    summaryMessage += eliminatedPlayers.length === 0 ? 
      `\n\n🎊 PERFECT ROUND!` : 
      `\n\n⚰️ Numbers claimed victims...`;

    // Send summary
    try {
      await bot.sendMessage(GROUP_CHAT_ID, summaryMessage, { parse_mode: "HTML" });
    } catch (error) {
      console.error("Error sending game summary:", error.message);
    }

    // Send appropriate GIF based on outcome
    const gifToSend = eliminatedPlayers.length === 0 ? GOOD_WORK_GIF_PATH : FALLING_MONEY_GIF_PATH;
    const gifName = eliminatedPlayers.length === 0 ? "Good Work" : "Falling Money";

    try {
      const gifPath = path.resolve(__dirname, gifToSend);
      await bot.sendAnimation(GROUP_CHAT_ID, fs.createReadStream(gifPath), { caption: "" });
    } catch (error) {
      console.error(`Error sending ${gifName} GIF:`, error.message);
      try {
        await bot.sendMessage(GROUP_CHAT_ID, `❌ MEDIA ERROR

Failed to load animation.
Check file permissions.`, { parse_mode: "HTML" });
      } catch (msgError) {
        console.error("Failed to send GIF error message:", msgError.message);
      }
    }

    // Send final game end notification after GIF
    setTimeout(async () => {
      try {
        await bot.sendMessage(GROUP_CHAT_ID, `🏁 GAME 9 ENDED 🏁

🎲 Challenge complete!
⏳ Next game coming soon...

🔥 Stay ready.`, { parse_mode: "HTML" });
      } catch (error) {
        console.error("Error sending game end notification:", error.message);
      }
    }, 2000); // 2 second delay after GIF

    // Clear game data
    game9Data = {};
    game9Participants = [];
    gameEndProcessed = false; // Reset flag for next game
  }
}

// --- Bot Command Handler: Start Game 9 ---
bot.onText(/\/startgame9/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" });
  }
  if (game9Active) {
    return bot.sendMessage(msg.chat.id, "⚠️ GAME ACTIVE\n\nWait for current game to finish.", { parse_mode: "HTML" });
  }

  let players;
  try {
    players = JSON.parse(fs.readFileSync("players.json"));
  } catch (error) {
    console.error("Error reading players.json:", error.message);
    return bot.sendMessage(msg.chat.id, "💥 SYSTEM ERROR\n\nCouldn't load player data.", { parse_mode: "HTML" });
  }

  let alivePlayers = players.filter(p => p.status === "alive" || p.status === "safe");

  if (alivePlayers.length === 0) {
    return bot.sendMessage(msg.chat.id, "😵 NO PLAYERS\n\nNo survivors available.", { parse_mode: "HTML" });
  }

  // Initialize game state
  game9Active = true;
  game9Data = {};
  gameEndProcessed = false;
  game9Participants = alivePlayers.map(p => ({ id: p.id, username: getUsernameById(p.id), status: 'playing' }));

  // Send initial instructions with photo
  try {
    const photoPath = path.resolve(__dirname, GAME9_INSTRUCTIONS_PHOTO_PATH);
    await bot.sendPhoto(msg.chat.id, fs.createReadStream(photoPath), {
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

  } catch (error) {
    console.error("Error sending game 9 instructions photo:", error.message);
    await bot.sendMessage(msg.chat.id, "💥 MEDIA ERROR\n\nCouldn't load game image.", { parse_mode: "HTML" });
  }

  // Set timeout for DMs
  setTimeout(async () => {
    if (!game9Active) {
      return;
    }

    try {
      const botInfo = await bot.getMe();
      const botUsername = botInfo.username;

      // Send DMs to all eligible players
      const dmPromises = alivePlayers.map(async (player) => {
        const participantStillActive = game9Participants.find(p => p.id === player.id && p.status === 'playing');
        if (!participantStillActive) {
          return;
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
          await bot.sendMessage(player.id,
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
          await bot.sendMessage(GROUP_CHAT_ID, `📱 CONNECTION ISSUE\n\n⚠️ Couldn't reach ${getUsernameById(player.id)}\n\nThey need to message me first.`, { parse_mode: "HTML" });
        }
      });

      // Wait for all DMs to be processed
      await Promise.allSettled(dmPromises);

      // Send group announcement after all DMs
      await bot.sendMessage(msg.chat.id, `🚨 GAME 9 LIVE! 🚨

📱 CHECK YOUR DMs NOW!

Click @${botUsername} to play!

⏰ Time is ticking!`, { parse_mode: "HTML" });

    } catch (error) {
      console.error("Error during DM phase:", error.message);
    }
  }, 1 * 60 * 1000); // 1 minute
});

// --- Bot Message Handler for DMs ---
bot.on("message", async (msg) => {
  const userId = msg.from.id;
  const text = msg.text;

  // Only handle DMs (private chats)
  if (msg.chat.type !== "private") return;

  // Only process if Game 9 is active and user is participating
  if (!game9Active || !game9Data[userId]) {
    if (game9Active && !game9Data[userId]) {
      await bot.sendMessage(userId, `🚫 NOT IN GAME

You're not playing Game 9.

Reasons:
• Game started without you
• Already eliminated  
• Technical error

Wait for next game.`, { parse_mode: "HTML" });
    }
    return;
  }

  const data = game9Data[userId];
  const guess = parseInt(text);

  if (isNaN(guess) || guess < 1 || guess > 100) {
    return bot.sendMessage(userId, `❌ INVALID GUESS

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
      await bot.sendMessage(userId, `🎉 WINNER! 🎉

✅ CORRECT! Number was ${data.number}

🛡️ YOU'RE SAFE!

You survive to the next round!

🏆 Well played!`, { parse_mode: "HTML" });
      
      await bot.sendMessage(GROUP_CHAT_ID, `🎉 SURVIVOR! 🎉

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
      hintMessage = `🔼 HIGHER! 🔼`;
    } else {
      hintMessage = `🔽  LOWER! 🔽`;
    }
    
    const urgency = data.guessesLeft <= 2 ? "🚨 DANGER! 🚨" : "";
    const encouragement = data.guessesLeft <= 2 ? 
      '⚠️ Last chances! Choose wisely!' : 
      '💡 Keep going!';
    
    return bot.sendMessage(userId, `${urgency}

${hintMessage}

🎯 Guesses left: ${data.guessesLeft}

${encouragement}

🚨 NEXT GUESS NOW! 🚨`, { parse_mode: "HTML" });
  }
});

// --- Stop Game Command ---
bot.onText(/\/stopgame9/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "🚫 ACCESS DENIED\n\nAdmin only.", { parse_mode: "HTML" });
  }
  if (!game9Active) {
    return bot.sendMessage(msg.chat.id, "⚠️ NO GAME\n\nGame 9 not running.", { parse_mode: "HTML" });
  }

  // Clear all timeouts
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

  await bot.sendMessage(GROUP_CHAT_ID, `🛑 GAME STOPPED 🛑

🎯 Game 9 manually ended.

📊 All challenges cancelled.

⏸️ Game over.`, { parse_mode: "HTML" });
  
  console.log("Game 9 manually stopped.");
});

