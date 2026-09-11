# Simple Chat Lobby

A tiny real-time chat room. No accounts, no database — just pick a name and talk.

## 1. Requirements

You need **Node.js** installed (version 16 or later is fine).
Check if you have it by running:

```
node -v
```

If that gives an error, install Node.js from https://nodejs.org (just click the big green "LTS" download button and install it like any normal program).

## 2. Run it on your own computer

Open a terminal in this folder and run:

```
npm install
npm start
```

Then open your browser to:

```
http://localhost:3000
```

You should see the lobby. Pick a name and start chatting. Open it in a second browser tab to test that messages appear in both.

## 3. Letting your friends join

Right now it only works on your own computer. To actually chat with friends, you have two easy options:

### Option A — Quick and temporary (best for just trying it out tonight)

Use a free tool called **ngrok** to create a temporary public link to your local server:

1. Download ngrok: https://ngrok.com/download
2. Run your chat server (`npm start`) like above
3. In another terminal, run:
   ```
   ngrok http 3000
   ```
4. It will give you a link like `https://abcd1234.ngrok-free.app` — send that link to your friends. As long as your computer stays on and ngrok is running, they can join.

This is free but the link changes each time you restart ngrok (on the free plan), and your computer has to stay running.

### Option B — Permanent and free/cheap (best if you'll use it regularly)

Host it on a free-tier cloud service so it's always online, without your computer needing to stay on. Good beginner-friendly options:

- **Render.com** — free tier, connect a GitHub repo, click deploy
- **Railway.app** — very simple, similar to Render
- **Fly.io** — a bit more technical but has a generous free tier

The general steps for any of these:
1. Put this folder into a GitHub repository
2. Sign up on the hosting service and connect your GitHub account
3. Tell it to run `npm install` then `npm start`
4. It gives you a public URL you can share with friends permanently

If you want, I can walk you through deploying to one of these step by step once you decide.

## How it works (in plain English)

- `server.js` starts a small web server. It hands out the webpage, and uses a library called **Socket.IO** to keep an open connection with every browser that's connected, so it can instantly forward messages back and forth.
- `public/index.html` is the actual page you see — a name box, then a chat window. All the styling and behavior (sending messages, showing who's online, "typing..." indicator) lives right in this one file to keep things simple.
- There's no database — if you restart the server, chat history is gone. That's intentional, to keep this as bare-bones as possible. Let me know if you'd like message history added later; it's a small addition (a file or a lightweight database like SQLite).
