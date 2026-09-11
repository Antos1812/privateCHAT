// server.js
// A tiny chat server. It does three jobs:
//   1. Serves the chat webpage (from the "public" folder).
//   2. Relays messages between everyone connected, in real time.
//   3. Saves recent messages to a small local database so new joiners
//      can see what they missed, and messages survive a server restart.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");

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
// A single file on disk holds all messages. No separate database server needed.
const db = new Database("chat.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,       -- "text" or "image"
    username TEXT NOT NULL,
    content TEXT NOT NULL,    -- message text, or the image data URL
    time INTEGER NOT NULL
  )
`);

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

// Keep track of who's online: { socketId: username }
const users = {};

io.on("connection", (socket) => {
  console.log("Someone connected:", socket.id);

  // When a user picks a name and joins
  socket.on("join", (username) => {
    users[socket.id] = username;
    io.emit("system message", `${username} joined the chat`);
    io.emit("user list", Object.values(users));
    // Send this one person the recent chat history, right after they join
    socket.emit("history", loadHistory());
  });

  // When a user sends a chat message
  socket.on("chat message", (text) => {
    const username = users[socket.id] || "Unknown";
    saveMessage("text", username, text);
    io.emit("chat message", { username, text, time: Date.now() });
  });

  // When a user sends an image (sent as a base64 data URL from the browser)
  socket.on("chat image", (imageData) => {
    const username = users[socket.id] || "Unknown";
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
      delete users[socket.id];
      io.emit("user list", Object.values(users));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running! Open http://localhost:${PORT} in your browser.`);
});
