import { onRequest } from "firebase-functions/v2/https";
import nacl from "tweetnacl";

type DiscordInteraction = {
  type: number;
  data?: {
    name?: string;
  };
};

const PING_TYPE = 1;
const APP_COMMAND_TYPE = 2;
const PONG_RESPONSE_TYPE = 1;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;

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

  res.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Unknown command" }
  });
});
