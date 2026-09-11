// server.js
// A tiny chat server. It does two jobs:
//   1. Serves the chat webpage (from the "public" folder).
//   2. Relays messages between everyone connected, in real time.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Images are sent as base64 text, which is bigger than the raw file.
  // Raise the default limit so a few-MB photo doesn't get rejected.
  maxHttpBufferSize: 8 * 1024 * 1024 // 8MB
});

// Serve everything in the "public" folder (our HTML/CSS/JS page)
app.use(express.static("public"));

// Keep track of who's online: { socketId: username }
const users = {};

io.on("connection", (socket) => {
  console.log("Someone connected:", socket.id);

  // When a user picks a name and joins
  socket.on("join", (username) => {
    users[socket.id] = username;
    io.emit("system message", `${username} joined the chat`);
    io.emit("user list", Object.values(users));
  });

  // When a user sends a chat message
  socket.on("chat message", (text) => {
    const username = users[socket.id] || "Unknown";
    io.emit("chat message", { username, text, time: Date.now() });
  });

  // When a user sends an image (sent as a base64 data URL from the browser)
  socket.on("chat image", (imageData) => {
    const username = users[socket.id] || "Unknown";
    // Basic sanity check: only accept actual image data URLs
    if (typeof imageData === "string" && imageData.startsWith("data:image/")) {
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
