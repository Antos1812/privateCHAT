// server.js
// A tiny chat server. It does four jobs:
//   1. Serves the chat webpage (from the "public" folder).
//   2. Handles simple accounts: a username + password, so names can't be
//      duplicated or stolen by someone else.
//   3. Relays messages between everyone connected, in real time.
//   4. Saves recent messages to a small local database so new joiners
//      can see what they missed, and messages survive a server restart.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Images are sent as base64 text, which is bigger than the raw file.
  // Raise the default limit so a few-MB photo doesn't get rejected.
  maxHttpBufferSize: 8 * 1024 * 1024 // 8MB
});

// Serve everything in the "public" folder (our HTML/CSS/JS page)
app.use(express.static("public"));

// --- Database setup ---
// A single file on disk holds accounts and messages. No separate database server needed.
const db = new Database("chat.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,   -- stored lowercase so "Bob" and "bob" can't collide
    display_name TEXT NOT NULL,  -- the name with the capitalization the user chose
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,       -- "text" or "image"
    username TEXT NOT NULL,
    content TEXT NOT NULL,    -- message text, or the image data URL
    time INTEGER NOT NULL
  );
`);

const getAccount = db.prepare("SELECT * FROM accounts WHERE username = ?");
const createAccount = db.prepare(
  "INSERT INTO accounts (username, display_name, password_hash) VALUES (?, ?, ?)"
);

// Only keep this many messages around, oldest ones get dropped.
// Images take up a lot of space as text, so keep this modest.
const HISTORY_LIMIT = 60;

const insertMessage = db.prepare(
  "INSERT INTO messages (type, username, content, time) VALUES (?, ?, ?, ?)"
);
const trimOldMessages = db.prepare(`
  DELETE FROM messages
  WHERE id NOT IN (
    SELECT id FROM messages ORDER BY id DESC LIMIT ?
  )
`);
const getRecentMessages = db.prepare(
  "SELECT type, username, content, time FROM messages ORDER BY id ASC LIMIT ?"
);

function saveMessage(type, username, content) {
  insertMessage.run(type, username, content, Date.now());
  trimOldMessages.run(HISTORY_LIMIT);
}

function loadHistory() {
  const rows = getRecentMessages.all(HISTORY_LIMIT);
  return rows.map((row) => {
    if (row.type === "image") {
      return { type: "image", username: row.username, imageData: row.content, time: row.time };
    }
    return { type: "text", username: row.username, text: row.content, time: row.time };
  });
}

// Keep track of who's currently online: { socketId: displayName }
const users = {};
// Keep track of which usernames are currently connected, to block a second
// simultaneous login with the same account: Set of lowercase usernames
const onlineUsernames = new Set();

io.on("connection", (socket) => {
  console.log("Someone connected:", socket.id);

  // Login or register. If the username doesn't exist yet, this creates
  // the account (first person to use a name "claims" it). If it exists,
  // the password must match.
  socket.on("auth", ({ username, password }) => {
    const cleanUsername = (username || "").trim();
    const cleanPassword = password || "";
    const key = cleanUsername.toLowerCase();

    if (!cleanUsername || cleanUsername.length > 20) {
      socket.emit("auth error", "Nazwa musi mieć 1–20 znaków.");
      return;
    }
    if (!cleanPassword) {
      socket.emit("auth error", "Podaj hasło.");
      return;
    }

    const existing = getAccount.get(key);

    if (existing) {
      const passwordMatches = bcrypt.compareSync(cleanPassword, existing.password_hash);
      if (!passwordMatches) {
        socket.emit("auth error", "Złe hasło dla tej nazwy.");
        return;
      }
    } else {
      // New account: register it now with a hashed password
      const hash = bcrypt.hashSync(cleanPassword, 10);
      createAccount.run(key, cleanUsername, hash);
    }

    if (onlineUsernames.has(key)) {
      socket.emit("auth error", "Ta osoba jest już zalogowana gdzie indziej.");
      return;
    }

    // Success: log them in
    const displayName = existing ? existing.display_name : cleanUsername;
    users[socket.id] = displayName;
    onlineUsernames.add(key);

    socket.emit("auth success", displayName);
    socket.emit("history", loadHistory());
    io.emit("system message", `${displayName} joined the chat`);
    io.emit("user list", Object.values(users));
  });

  // When a user sends a chat message
  socket.on("chat message", (text) => {
    const username = users[socket.id];
    if (!username) return; // not logged in yet, ignore
    saveMessage("text", username, text);
    io.emit("chat message", { username, text, time: Date.now() });
  });

  // When a user sends an image (sent as a base64 data URL from the browser)
  socket.on("chat image", (imageData) => {
    const username = users[socket.id];
    if (!username) return; // not logged in yet, ignore
    // Basic sanity check: only accept actual image data URLs
    if (typeof imageData === "string" && imageData.startsWith("data:image/")) {
      saveMessage("image", username, imageData);
      io.emit("chat image", { username, imageData, time: Date.now() });
    }
  });

  // When someone is typing
  socket.on("typing", () => {
    const username = users[socket.id];
    if (username) socket.broadcast.emit("typing", username);
  });

  // When a user disconnects
  socket.on("disconnect", () => {
    const username = users[socket.id];
    if (username) {
      io.emit("system message", `${username} left the chat`);
      onlineUsernames.delete(username.toLowerCase());
      delete users[socket.id];
      io.emit("user list", Object.values(users));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running! Open http://localhost:${PORT} in your browser.`);
});
