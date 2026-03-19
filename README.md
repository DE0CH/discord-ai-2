# Minimal Discord Bot on Firebase Functions (TypeScript)

This project exposes a Discord Interactions endpoint as a Firebase Cloud Function.

When a `/ping` slash command is sent to your app, the function replies with `pong`.

## 1. Prerequisites

- Node.js 20+
- Firebase CLI (`npm i -g firebase-tools`)
- A Firebase project
- A Discord application

## 2. Install

```bash
cd functions
npm install
npm run build
```

## 3. Configure Firebase

1. Update `.firebaserc` with your Firebase project id.
2. Login and select project:

```bash
firebase login
firebase use --add
```

## 4. Deploy

```bash
cd functions
npm run deploy
```

After deploy, copy the HTTPS function URL for `discord`.

## 5. Configure Discord Interactions URL

1. In Discord Developer Portal, open your app.
2. Go to **General Information** and copy the **Public Key**.
3. Create `functions/.env` from `functions/.env.example` and set your key:

```bash
cp functions/.env.example functions/.env
```

Then edit `functions/.env`:

```env
DISCORD_PUBLIC_KEY=YOUR_PUBLIC_KEY
```

4. In **Interactions Endpoint URL**, set your deployed function URL.

Discord sends a validation `PING` first; the function returns the correct `PONG` response.

## 6. Register `/ping` command

Register a global slash command named `ping` for your app (via Discord API or your preferred tooling). Minimal payload:

```json
{
  "name": "ping",
  "description": "Replies with pong",
  "type": 1
}
```

Once command registration propagates, run `/ping` in Discord and the bot replies `pong`.
