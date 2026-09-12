// server.js
// A tiny chat server. It does five jobs:
//   1. Serves the chat webpage (from the "public" folder).
//   2. Handles simple accounts: a username + password, so names can't be
//      duplicated or stolen by someone else.
//   3. Remembers logged-in people via a session token, so they don't have
//      to retype their password every time they reopen the page.
//   4. Relays messages between everyone connected, in real time (with a
//      basic rate limit so nobody can flood the chat).
//   5. Saves recent messages to a database so new joiners can see what
//      they missed, and everything survives a server restart or redeploy.
//
// The database is Turso (a hosted SQLite-compatible database) when
// TURSO_DATABASE_URL is set, e.g. when running on Render. If that's not
// set (like on your own laptop during testing), it automatically falls
// back to a plain local file called chat.db, so nothing extra is needed
// to just try things out locally.

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const { createClient } = require("@libsql/client");
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
const db = createClient(
  process.env.TURSO_DATABASE_URL
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: "file:chat.db" } // local fallback for testing on your own computer
);

async function setupDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS accounts (
      username TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      username TEXT NOT NULL,
      content TEXT NOT NULL,
      time INTEGER NOT NULL
    )
  `);
}

// Sessions "remember" a login for this many days before requiring a
// password again, even if the browser is closed and reopened.
const SESSION_MAX_AGE_DAYS = 30;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

function makeSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Only keep this many messages around, oldest ones get dropped.
const HISTORY_LIMIT = 60;

async function saveMessage(type, username, content) {
  await db.execute({
    sql: "INSERT INTO messages (type, username, content, time) VALUES (?, ?, ?, ?)",
    args: [type, username, content, Date.now()]
  });
  await db.execute({
    sql: `DELETE FROM messages WHERE id NOT IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)`,
    args: [HISTORY_LIMIT]
  });
}

async function loadHistory() {
  const result = await db.execute({
    sql: "SELECT type, username, content, time FROM messages ORDER BY id ASC LIMIT ?",
    args: [HISTORY_LIMIT]
  });
  return result.rows.map((row) => {
    if (row.type === "image") {
      return { type: "image", username: row.username, imageData: row.content, time: row.time };
    }
    return { type: "text", username: row.username, text: row.content, time: row.time };
  });
}

async function getAccount(key) {
  const result = await db.execute({
    sql: "SELECT * FROM accounts WHERE username = ?",
    args: [key]
  });
  return result.rows[0] || null;
}

async function createAccount(key, displayName, passwordHash) {
  await db.execute({
    sql: "INSERT INTO accounts (username, display_name, password_hash) VALUES (?, ?, ?)",
    args: [key, displayName, passwordHash]
  });
}

async function getSession(token) {
  const result = await db.execute({
    sql: "SELECT * FROM sessions WHERE token = ?",
    args: [token]
  });
  return result.rows[0] || null;
}

async function createSession(token, key) {
  await db.execute({
    sql: "INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
    args: [token, key, Date.now()]
  });
}

async function deleteSession(token) {
  await db.execute({ sql: "DELETE FROM sessions WHERE token = ?", args: [token] });
}

// Keep track of who's currently online: { socketId: displayName }
const users = {};
// Which usernames are currently connected, to block a second simultaneous
// login with the same account: Set of lowercase usernames
const onlineUsernames = new Set();
// Basic spam protection: last message time per socket
const lastMessageAt = new Map();
const MIN_MS_BETWEEN_MESSAGES = 350;

async function logInSocket(socket, displayName, usernameKey) {
  users[socket.id] = displayName;
  onlineUsernames.add(usernameKey);
  socket.emit("history", await loadHistory());
  io.emit("system message", `${displayName} joined the chat`);
  io.emit("user list", Object.values(users));
}

io.on("connection", (socket) => {
  console.log("Someone connected:", socket.id);

  // Login or register with username + password. If the username doesn't
  // exist yet, this creates the account (first person to use a name
  // "claims" it). If it exists, the password must match.
  socket.on("auth", async ({ username, password }) => {
    try {
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

      const existing = await getAccount(key);

      if (existing) {
        const passwordMatches = bcrypt.compareSync(cleanPassword, existing.password_hash);
        if (!passwordMatches) {
          socket.emit("auth error", "Złe hasło dla tej nazwy.");
          return;
        }
      } else {
        const hash = bcrypt.hashSync(cleanPassword, 10);
        await createAccount(key, cleanUsername, hash);
      }

      if (onlineUsernames.has(key)) {
        socket.emit("auth error", "Ta osoba jest już zalogowana gdzie indziej.");
        return;
      }

      const displayName = existing ? existing.display_name : cleanUsername;

      const token = makeSessionToken();
      await createSession(token, key);

      await logInSocket(socket, displayName, key);
      socket.emit("auth success", { displayName, token });
    } catch (err) {
      console.error("Auth error:", err);
      socket.emit("auth error", "Coś poszło nie tak, spróbuj ponownie.");
    }
  });

  // Auto-login using a remembered session token, no password needed
  socket.on("auth token", async ({ token }) => {
    try {
      const session = token ? await getSession(token) : null;

      if (!session || Date.now() - session.created_at > SESSION_MAX_AGE_MS) {
        if (session) await deleteSession(token);
        socket.emit("auth token invalid");
        return;
      }

      const account = await getAccount(session.username);
      if (!account) {
        await deleteSession(token);
        socket.emit("auth token invalid");
        return;
      }

      if (onlineUsernames.has(session.username)) {
        socket.emit("auth token invalid");
        return;
      }

      await logInSocket(socket, account.display_name, session.username);
      socket.emit("auth success", { displayName: account.display_name, token });
    } catch (err) {
      console.error("Auth token error:", err);
      socket.emit("auth token invalid");
    }
  });

  // Explicit "leave chat" button
  socket.on("logout", async ({ token } = {}) => {
    try {
      if (token) await deleteSession(token);
    } catch (err) {
      console.error("Logout error:", err);
    }
    handleLeave(socket);
  });

  // When a user sends a chat message
  socket.on("chat message", async (text) => {
    const username = users[socket.id];
    if (!username) return; // not logged in yet, ignore
    if (!checkRateLimit(socket)) return;
    if (typeof text !== "string" || !text.trim()) return;
    try {
      await saveMessage("text", username, text);
      io.emit("chat message", { username, text, time: Date.now() });
    } catch (err) {
      console.error("Save message error:", err);
    }
  });

  // When a user sends an image (sent as a base64 data URL from the browser)
  socket.on("chat image", async (imageData) => {
    const username = users[socket.id];
    if (!username) return; // not logged in yet, ignore
    if (!checkRateLimit(socket)) return;
    if (typeof imageData === "string" && imageData.startsWith("data:image/")) {
      try {
        await saveMessage("image", username, imageData);
        io.emit("chat image", { username, imageData, time: Date.now() });
      } catch (err) {
        console.error("Save image error:", err);
      }
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

setupDatabase()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Chat server running! Open http://localhost:${PORT} in your browser.`);
      console.log(
        process.env.TURSO_DATABASE_URL
          ? "Using Turso database (data persists across redeploys)."
          : "Using local chat.db file (fine for local testing only)."
      );
    });
  })
  .catch((err) => {
    console.error("Failed to set up database:", err);
    process.exit(1);
  });
