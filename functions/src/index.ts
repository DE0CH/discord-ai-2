import { onRequest } from "firebase-functions/v2/https";
import nacl from "tweetnacl";

type DiscordInteraction = {
  type: number;
  data?: {
    name?: string;
    options?: Array<{
      name?: string;
      type?: number;
      value?: unknown;
    }>;
  };
  member?: {
    user?: {
      username?: string;
      global_name?: string;
      id?: string;
    };
  };
  user?: {
    username?: string;
    global_name?: string;
    id?: string;
  };
};

const PING_TYPE = 1;
const APP_COMMAND_TYPE = 2;
const PONG_RESPONSE_TYPE = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;

// In-memory history for debugging-style commands.
// Note: Cloud Function instances can be recycled, so this is not guaranteed to persist.
const ECHO_CHAT_MAX_STORED = 50;
let echoChatHistory: string[] = [];

function getOptionValue(interaction: DiscordInteraction, name: string): string | undefined {
  const option = interaction.data?.options?.find((o) => o.name === name);
  const value = option?.value;
  return typeof value === "string" ? value : undefined;
}

function getDisplayName(interaction: DiscordInteraction): string {
  const u = interaction.member?.user ?? interaction.user;
  return u?.global_name ?? u?.username ?? "unknown";
}

export const discord = onRequest({ region: "us-central1", invoker: "public" }, (req, res) => {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    res.status(500).json({ error: "Missing DISCORD_PUBLIC_KEY" });
    return;
  }

  const signature = req.header("X-Signature-Ed25519");
  const timestamp = req.header("X-Signature-Timestamp");

  if (!signature || !timestamp || !req.rawBody) {
    res.status(401).json({ error: "Invalid request headers or body" });
    return;
  }

  const body = req.rawBody;
  const isVerified = nacl.sign.detached.verify(
    Buffer.from(timestamp + body.toString("utf8")),
    Buffer.from(signature, "hex"),
    Buffer.from(publicKey, "hex")
  );

  if (!isVerified) {
    res.status(401).json({ error: "Bad request signature" });
    return;
  }

  const interaction = JSON.parse(body.toString("utf8")) as DiscordInteraction;

  if (interaction.type === PING_TYPE) {
    res.json({ type: PONG_RESPONSE_TYPE });
    return;
  }

  if (interaction.type === APP_COMMAND_TYPE && interaction.data?.name === "ping") {
    res.json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "pong" }
    });
    return;
  }

  if (interaction.type === APP_COMMAND_TYPE && interaction.data?.name === "echo-chat") {
    const input = getOptionValue(interaction, "message");
    if (input) {
      const displayName = getDisplayName(interaction);
      echoChatHistory.push(`${displayName}: ${input}`);
      if (echoChatHistory.length > ECHO_CHAT_MAX_STORED) {
        echoChatHistory = echoChatHistory.slice(echoChatHistory.length - ECHO_CHAT_MAX_STORED);
      }
    }

    const lines = echoChatHistory.length ? echoChatHistory : ["(no history yet)"];
    // Keep response comfortably within Discord's 2000 character limit.
    const maxLines = 30;
    const sliced = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
    const content = sliced.join("\n");

    res.json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `Echoed chat history (${echoChatHistory.length} total messages):\n${content}` }
    });
    return;
  }

  res.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Unknown command" }
  });
});
