const fs = require("fs");
const path = require("path");

let game1Interval = null;
let game1Timeout = null;
let game1Phase = "red";
let game1Started = false;
let game1EndTime = null;

function startGame1(bot, chatId, registeredPlayers, ADMIN_ID) {
  return new Promise(async (resolve) => {
    const alivePlayers = registeredPlayers.filter(p => p.status === "alive");
    if (alivePlayers.length === 0) {
      bot.sendMessage(chatId, "⚠️ No alive players registered! Cannot start the game.");
      return resolve();
    }

    registeredPlayers.forEach(p => {
      if (p.status === "alive") {
        p.progress = 0;
        p.stopped = false;
        p.isRunning = false;
        p.runStartTime = null;
        p.hasMoved = false;
      }
    });

    const instructions = `
🎮 *Game 1: Red Light, Green Light*

- ⏱ You have *5 minutes* to finish the game.
- When the bot says 🟢 *Green Light*, you can run forward.
- When the bot says 🔴 *Red Light*, you must freeze *before* it turns red.
- ❌ If you move during Red Light, you will be *eliminated*.
- 💯 Goal: Reach 100% progress.

⚠️ 1 minute preparation time!

Good luck! 💚❤️
`;

    const instructionsImgPath = path.resolve(__dirname, "../images/game1.jpg");
    await bot.sendPhoto(chatId, fs.createReadStream(instructionsImgPath), {
      caption: instructions,
      parse_mode: "Markdown"
    });

    game1Started = false;
    game1Phase = "waiting";

    setTimeout(async () => {
      game1Phase = "red";
      game1Started = true;
      game1EndTime = Date.now() + 1 * 60 * 1000; // 2 mins

      bot.sendMessage(chatId, "🔴 Red Light! Get ready...");

      game1Interval = setInterval(async () => {
        const remainingMs = game1EndTime - Date.now();
        const mins = Math.floor(remainingMs / 60000);
        const secs = Math.floor((remainingMs % 60000) / 1000);

        if (game1Phase === "green") {
          game1Phase = "red";

          const redImgPath = path.resolve(__dirname, "../images/red.jpg");
          await bot.sendPhoto(chatId, fs.createReadStream(redImgPath));
          await bot.sendMessage(chatId, `🔴 Red Light! Stop!\n⏰ Remaining: ${mins}m ${secs}s`);

          registeredPlayers.forEach(p => {
            if (p.status === "alive" && p.isRunning) {
              p.status = "eliminated";
              p.isRunning = false;
              p.runStartTime = null;

              bot.sendMessage(chatId, `💀 <b>${p.username}</b> moved during Red Light and was eliminated!`, { parse_mode: "HTML" });
            }
          });

        } else {
          game1Phase = "green";

          const greenImgPath = path.resolve(__dirname, "../images/green.jpg");
          await bot.sendPhoto(chatId, fs.createReadStream(greenImgPath));
          await bot.sendMessage(chatId, `🟢 Green Light! Run!\n⏰ Remaining: ${mins}m ${secs}s`);

          registeredPlayers.forEach(p => {
            if (p.status === "alive") {
              p.stopped = false;
              p.isRunning = false;
              p.runStartTime = null;
            }
          });
        }

        fs.writeFileSync("players.json", JSON.stringify(registeredPlayers, null, 2));
      }, Math.floor(Math.random() * 15000) + 15000);

      game1Timeout = setTimeout(() => {
        clearInterval(game1Interval);
        game1Interval = null;
        game1Timeout = null;
        game1Started = false;

        endGame1(bot, chatId, registeredPlayers);
        resolve();
      }, 1 * 60 * 1000);

      bot.sendMessage(chatId, "🏁 Game 1 started! Wait for Green Light to move!");
    }, 60 * 1000);
  });
}

function stopGame1(bot, chatId, registeredPlayers) {
  if (!game1Interval && !game1Timeout) return bot.sendMessage(chatId, "❌ Game 1 not running!");

  clearInterval(game1Interval);
  clearTimeout(game1Timeout);
  game1Interval = null;
  game1Timeout = null;
  game1Started = false;

  endGame1(bot, chatId, registeredPlayers);
}

function endGame1(bot, chatId, registeredPlayers) {
  const totalPlayers = registeredPlayers.filter(p => p.status !== "pending").length;

  registeredPlayers.forEach(p => {
    if (p.status === "alive" && p.progress >= 100) {
      p.status = "alive";
    } else if (p.status === "alive" && p.progress < 100) {
      p.status = "eliminated";
    }
  });

  fs.writeFileSync('players.json', JSON.stringify(registeredPlayers, null, 2));

  const survivors = registeredPlayers.filter(p => p.status === "alive");
  const eliminated = registeredPlayers.filter(p => p.status === "eliminated");
  const eliminatedPlayers = [...eliminated];

  let resultMsg = `🏁✨ <b>Game 1 has ended!</b> ✨🏁\n\n`;
  resultMsg += `👥 Total Participants: <b>${totalPlayers}</b>\n`;
  resultMsg += `✅ Survivors: <b>${survivors.length}</b>\n`;
  resultMsg += `💀 Eliminated: <b>${eliminated.length}</b>\n\n`;
  resultMsg += `✅ Survivors:\n${survivors.map(p => `• ${p.username}`).join('\n') || "None"}\n\n`;
  resultMsg += `💀 Eliminated:\n${eliminated.map(p => `• ${p.username}`).join('\n') || "None"}`;

  bot.sendMessage(chatId, resultMsg, { parse_mode: "HTML" })
    .then(() => {
      if (eliminated.length === 0) {
        return bot.sendMessage(chatId, "🎉 No one was eliminated! Great job everyone!")
          .then(() => {
            const goodworkGifPath = path.resolve(__dirname, "../gifs/goodwork.gif");
            return bot.sendAnimation(chatId, fs.createReadStream(goodworkGifPath));
          });
      } else {
        const eliminationGifPath = path.resolve(__dirname, "../gifs/bye.gif");
        return bot.sendAnimation(chatId, fs.createReadStream(eliminationGifPath))
          .then(() => bot.sendMessage(chatId, "⚠️ 💀 Eliminated players will be kicked in 10 seconds! Prepare to say goodbye..."))
          .then(() => new Promise(resolve => setTimeout(resolve, 10000)))
          .then(() => {
            eliminatedPlayers.forEach(p => {
              bot.banChatMember(chatId, p.id)
                .then(() => console.log(`✅ Kicked (banned) ${p.username}`))
                .catch(err => console.error(`❌ Failed to kick (ban) ${p.username}:`, err));
            });
          });
      }
    })
    .catch(err => console.error("❌ Error in endGame1 flow:", err));
}

function attachPlayerCommands(bot, registeredPlayers) {
  bot.onText(/\/run/, (msg) => {
    const userId = msg.from.id;
    const player = registeredPlayers.find(p => p.id === userId);

    if (!player || (player.status !== "alive" && player.status !== "safe")) {
      return bot.sendMessage(msg.chat.id, "❌ You are not in the game or already eliminated!");
    }

    if (!game1Started || game1Phase === "waiting") {
      return bot.sendMessage(msg.chat.id, "⛔ You can't move yet! Wait for Green Light!");
    }

    if (game1Phase !== "green") {
      player.status = "eliminated";
      player.isRunning = false;
      player.runStartTime = null;

      let progressMsg = `💀 <b>${player.username}</b> moved during Red Light and was eliminated!\n`;
      progressMsg += `💔 Final progress: <b>${Math.floor(player.progress)}%</b>`;

      fs.writeFileSync("players.json", JSON.stringify(registeredPlayers, null, 2));
      return bot.sendMessage(msg.chat.id, progressMsg, { parse_mode: "HTML" });
    }

    if (player.isRunning) {
      return bot.sendMessage(msg.chat.id, "⚠️ You are already running! Type /stop to stop.");
    }

    player.isRunning = true;
    player.runStartTime = Date.now();
    player.hasMoved = true;

    fs.writeFileSync("players.json", JSON.stringify(registeredPlayers, null, 2));

    bot.sendMessage(msg.chat.id, `🏃 ${player.username} started running! Type /stop to stop.`);
  });

  bot.onText(/\/stop/, (msg) => {
    const userId = msg.from.id;
    const player = registeredPlayers.find(p => p.id === userId);

    if (!player || player.status !== "alive") {
      return bot.sendMessage(msg.chat.id, "❌ You are not in the game or already eliminated!");
    }

    if (!player.isRunning) {
      return bot.sendMessage(msg.chat.id, "⚠️ You are not currently running!");
    }

    const runTimeMs = Date.now() - player.runStartTime;
    const runTimeSec = runTimeMs / 1000;
    const maxRunSec = 5;
    let progressPercent = (runTimeSec / maxRunSec) * 100;

    if (progressPercent < 0) progressPercent = 0;
    if (progressPercent > 100) progressPercent = 100;

    player.progress += progressPercent;
    if (player.progress > 100) player.progress = 100;

    player.isRunning = false;
    player.runStartTime = null;
    player.stopped = true;

    if (player.progress >= 100) {
      player.progress = 100;
      player.status = "alive";

      bot.sendMessage(msg.chat.id, `🏆 <b>${player.username}</b> has crossed the finish line and is SAFE! 🎉`, { parse_mode: "HTML" });
    } else {
      bot.sendMessage(msg.chat.id, `🛑 <b>${player.username}</b> stopped!\n📈 Progress: <b>${Math.floor(player.progress)}%</b>`, { parse_mode: "HTML" });
    }

    fs.writeFileSync("players.json", JSON.stringify(registeredPlayers, null, 2));
  });
}

module.exports = {
  startGame1,
  stopGame1,
  attachPlayerCommands,
};