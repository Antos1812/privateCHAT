// server.js
// A tiny chat server. It does five jobs:
//   1. Serves the chat webpage (from the "public" folder).
//   2. Handles simple accounts: a username + password, so names can't be
//      duplicated or stolen by someone else.
//   3. Remembers logged-in people via a session token, so they don't have
//      to retype their password every time they reopen the page.
//   4. Relays messages between everyone connected, in real time (with a
//      basic rate limit so nobody can flood the chat).
//   5. Saves recent messages to a small local database so new joiners
//      can see what they missed, and messages survive a server restart.

const express = require("express");
const http = require("http");
const crypto = require("crypto");
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
// A single file on disk holds accounts, sessions, and messages.
const db = new Database("chat.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,   -- stored lowercase so "Bob" and "bob" can't collide
    display_name TEXT NOT NULL,  -- the name with the capitalization the user chose
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,      -- lowercase account key this token belongs to
    created_at INTEGER NOT NULL
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

const getSession = db.prepare("SELECT * FROM sessions WHERE token = ?");
const createSession = db.prepare(
  "INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)"
);
const deleteSession = db.prepare("DELETE FROM sessions WHERE token = ?");

// Sessions "remember" a login for this many days before requiring a
// password again, even if the browser is closed and reopened.
const SESSION_MAX_AGE_DAYS = 30;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

function makeSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Only keep this many messages around, oldest ones get dropped.
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
// Which usernames are currently connected, to block a second simultaneous
// login with the same account: Set of lowercase usernames
const onlineUsernames = new Set();
// Basic spam protection: last message time per socket
const lastMessageAt = new Map();
const MIN_MS_BETWEEN_MESSAGES = 350;

function logInSocket(socket, displayName, usernameKey) {
  users[socket.id] = displayName;
  onlineUsernames.add(usernameKey);
  socket.emit("history", loadHistory());
  io.emit("system message", `${displayName} joined the chat`);
  io.emit("user list", Object.values(users));
}

io.on("connection", (socket) => {
  console.log("Someone connected:", socket.id);

  // Login or register with username + password. If the username doesn't
  // exist yet, this creates the account (first person to use a name
  // "claims" it). If it exists, the password must match.
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
      const hash = bcrypt.hashSync(cleanPassword, 10);
      createAccount.run(key, cleanUsername, hash);
    }

    if (onlineUsernames.has(key)) {
      socket.emit("auth error", "Ta osoba jest już zalogowana gdzie indziej.");
      return;
    }

    const displayName = existing ? existing.display_name : cleanUsername;

    // Issue a "remember me" session token so next time they don't need the password
    const token = makeSessionToken();
    createSession.run(token, key, Date.now());

    logInSocket(socket, displayName, key);
    socket.emit("auth success", { displayName, token });
  });

  // Auto-login using a remembered session token, no password needed
  socket.on("auth token", ({ token }) => {
    const session = token ? getSession.get(token) : null;

    if (!session || Date.now() - session.created_at > SESSION_MAX_AGE_MS) {
      if (session) deleteSession.run(token); // expired, clean it up
      socket.emit("auth token invalid");
      return;
    }

    const account = getAccount.get(session.username);
    if (!account) {
      deleteSession.run(token);
      socket.emit("auth token invalid");
      return;
    }

    if (onlineUsernames.has(session.username)) {
      socket.emit("auth token invalid"); // already logged in elsewhere
      return;
    }

    logInSocket(socket, account.display_name, session.username);
    socket.emit("auth success", { displayName: account.display_name, token });
  });

  // Explicit "leave chat" button
  socket.on("logout", ({ token } = {}) => {
    if (token) deleteSession.run(token);
    handleLeave(socket);
  });

  // When a user sends a chat message
  socket.on("chat message", (text) => {
    const username = users[socket.id];
    if (!username) return; // not logged in yet, ignore
    if (!checkRateLimit(socket)) return;
    if (typeof text !== "string" || !text.trim()) return;
    saveMessage("text", username, text);
    io.emit("chat message", { username, text, time: Date.now() });
  });

  // When a user sends an image (sent as a base64 data URL from the browser)
  socket.on("chat image", (imageData) => {
    const username = users[socket.id];
    if (!username) return; // not logged in yet, ignore
    if (!checkRateLimit(socket)) return;
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

  // When a user disconnects (closes tab, loses connection, etc.)
  socket.on("disconnect", () => {
    handleLeave(socket);
  });
});

function checkRateLimit(socket) {
  const now = Date.now();
  const last = lastMessageAt.get(socket.id) || 0;
  if (now - last < MIN_MS_BETWEEN_MESSAGES) {
    socket.emit("system message", "Zwolnij trochę! Wiadomości wysyłasz za szybko.");
    return false;
  }
  lastMessageAt.set(socket.id, now);
  return true;
}

function handleLeave(socket) {
  const username = users[socket.id];
  if (username) {
    io.emit("system message", `${username} left the chat`);
    onlineUsernames.delete(username.toLowerCase());
    delete users[socket.id];
    lastMessageAt.delete(socket.id);
    io.emit("user list", Object.values(users));
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Chat server running! Open http://localhost:${PORT} in your browser.`);
});
