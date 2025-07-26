const fs = require("fs");
const path = require("path");

let game2Started = false;
let correctShapes = [];
let game2Timeout = null;
let allowGuessing = false;

module.exports = {
  start: async function (bot, chatId, registeredPlayers) {
    // This will return a Promise that resolves when Game 2 is truly finished
    return new Promise(async (resolve, reject) => {
      await module.exports.startGame2(bot, chatId, registeredPlayers, resolve);
    });
  },

  startGame2: async function (bot, chatId, registeredPlayers, resolveGame2) { // Pass resolve function
    if (game2Started) return;

    // Filter alive/safe players
    const alivePlayers = registeredPlayers.filter((p) => p.status === "alive" || p.status === "safe");
    if (alivePlayers.length === 0) {
      await bot.sendMessage(chatId, "❌ Cannot start Game 2! There are no alive players.");
      return resolveGame2(); // Resolve immediately if no players
    }

    const shapes = ["circle", "triangle", "square"];
    correctShapes = shapes.sort(() => 0.5 - Math.random()).slice(0, 2);

    // Reset guesses and fix statuses
    registeredPlayers.forEach((p) => {
      if (p.status === "alive" || p.status === "safe") {
        p.guess = null;
        if (p.status === "safe") p.status = "alive";
      }
    });

    // Save updated player statuses
    fs.writeFileSync("players.json", JSON.stringify(registeredPlayers, null, 2));

    game2Started = true;
    allowGuessing = false;

    const instructions = `
🎮 *Game 2: Shape Guessing Game!*

- 👁 You will see *3 shapes*: circle, triangle, square.
- ✅ Only *2 shapes* are correct. You must pick one correct shape to survive.
- ⏰ You have *1 minute* to look carefully and think.

⚠️ Wait for the game to start completely and *wait for the instructions* on how to guess!
⚠️ Choose wisely! Only correct guesses survive.

Good luck! 💥
`;

    const shapesImgPath = path.resolve(__dirname, "../images", "shapes.jpg");

    await bot.sendPhoto(chatId, fs.createReadStream(shapesImgPath), {
      caption: instructions,
      parse_mode: "Markdown",
    });

    // 1 minute viewing phase
    game2Timeout = setTimeout(() => {
      const guessInstruction = `
⏰ *Time's up!*

Now it's time to submit your guess!

👉 *How to guess:*
Type the command:
/guess <shape>

Example: *Type* /guess circle

⏰ You have *1 minute* to submit your guess!
⚠️ If you don't guess within this time, you will be eliminated!
`;
      bot.sendMessage(chatId, guessInstruction, { parse_mode: "Markdown" });
      allowGuessing = true;

      // 1 minute guessing phase
      game2Timeout = setTimeout(() => {
        finishGame2(bot, chatId);
        resolveGame2(); // Resolve the main Game 2 promise here
      }, 60 * 1000);
    }, 60 * 1000);
  },
  onGuessCommand: function (bot, msg, match) {
    const userId = msg.from.id;

    let registeredPlayers = JSON.parse(fs.readFileSync("players.json"));
    const playerIndex = registeredPlayers.findIndex((p) => p.id === userId);
    if (playerIndex === -1) return bot.sendMessage(msg.chat.id, "❌ You are not in the game!");

    const player = registeredPlayers[playerIndex];

    if (!game2Started) return bot.sendMessage(msg.chat.id, "❌ Game 2 is not running!");
    if (player.status !== "alive") return bot.sendMessage(msg.chat.id, "❌ You are not in the game or already eliminated!");
    if (!allowGuessing) return bot.sendMessage(msg.chat.id, "⚠️ You cannot guess yet! Wait for the instruction.");

    const chosenShape = match[1].toLowerCase();
    const allowedShapes = ["circle", "triangle", "square"];

    if (!allowedShapes.includes(chosenShape)) {
      return bot.sendMessage(msg.chat.id, "⚠️ Invalid shape! Choose: circle, triangle, or square.");
    }

    if (player.guess !== null) {
      return bot.sendMessage(msg.chat.id, "⚠️ You already made your guess!");
    }

    // ✅ Save the guess in the right player slot
    registeredPlayers[playerIndex].guess = chosenShape;
    fs.writeFileSync("players.json", JSON.stringify(registeredPlayers, null, 2));

    const emoji = {
      circle: "⭕",
      triangle: "🔺",
      square: "◼️",
    }[chosenShape];

    bot.sendMessage(msg.chat.id, `✅ ${player.username} picked ${chosenShape} ${emoji}!`);
  },
};

function finishGame2(bot, chatId) {
  const registeredPlayers = JSON.parse(fs.readFileSync("players.json"));

  game2Started = false;
  allowGuessing = false;
  clearTimeout(game2Timeout);

  const survivors = [];
  const eliminated = [];
  const guesses = [];
  const eliminatedPlayers = [];

  registeredPlayers.forEach((p) => {
    if (p.status === "alive") {
      guesses.push(`${p.username}: ${p.guess ?? "❌ No guess"}`);
      if (p.guess && correctShapes.includes(p.guess)) {
        p.status = "safe";
        survivors.push(p.username);
      } else {
        p.status = "eliminated";
        eliminated.push(p.username);
        eliminatedPlayers.push(p);
      }
    }
  });

  fs.writeFileSync("players.json", JSON.stringify(registeredPlayers, null, 2));

  let resultMsg = `🏁✨ <b>Game 2 has ended!</b> ✨🏁\n\n`;
  resultMsg += `✅ Survivors: <b>${survivors.length}</b>\n`;
  resultMsg += `💀 Eliminated: <b>${eliminated.length}</b>\n\n`;
  resultMsg += `🎯 Correct shapes: <b>${correctShapes.join(", ")}</b>\n\n`;
  resultMsg += `🎲 <b>Player guesses:</b>\n${guesses.join("\n")}\n\n`;
  resultMsg += `✅ Survivors:\n${survivors.map((p) => `• ${p}`).join("\n") || "None"}\n\n`;
  resultMsg += `💀 Eliminated:\n${eliminated.map((p) => `• ${p}`).join("\n") || "None"}`;

  bot.sendMessage(chatId, resultMsg, { parse_mode: "HTML" }).then(() => {
    if (eliminatedPlayers.length > 0) {
      const gifPath = path.resolve(__dirname, "../gifs", "bye.gif");
      bot.sendAnimation(chatId, fs.createReadStream(gifPath)).then(() => {
        setTimeout(() => {
          eliminatedPlayers.forEach((p) => {
            bot.banChatMember(chatId, p.id).catch(() => { });
          });
        }, 10 * 1000);
      });
    } else {
      const congratsGifPath = path.resolve(__dirname, "../gifs", "goodwork.gif");
      bot.sendAnimation(chatId, fs.createReadStream(congratsGifPath));
    }
  });
}