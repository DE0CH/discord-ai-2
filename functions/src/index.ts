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
  application_id?: string;
  token?: string;
  channel_id?: string;
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
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

export const discord = onRequest({ region: "us-central1", invoker: "public" }, async (req, res) => {
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
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      res.status(500).json({ error: "Missing DISCORD_BOT_TOKEN" });
      return;
    }

    const channelId = interaction.channel_id;
    if (!channelId) {
      res.status(400).json({ error: "Missing channel_id in interaction" });
      return;
    }

    // Fetch recent messages from the current channel.
    const discordResp = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages?limit=100`,
      {
        method: "GET",
        headers: {
          Authorization: `Bot ${botToken}`
        }
      }
    );

    if (!discordResp.ok) {
      res.status(500).json({
        error: "Failed to fetch Discord message history",
        status: discordResp.status
      });
      return;
    }

    const apiJson = await discordResp.json();
    const content = JSON.stringify(apiJson);

    res.json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: content.length > 1900 ? content.slice(0, 1900) : content }
    });
    return;
  }

  if (interaction.type === APP_COMMAND_TYPE && interaction.data?.name === "ai") {
    let webhookUrl: string | null = null;

    try {
      const botToken = process.env.DISCORD_BOT_TOKEN;
      const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      const channelId = interaction.channel_id;
      const applicationId = interaction.application_id;
      const interactionToken = interaction.token;

      if (!botToken) throw new Error("Missing DISCORD_BOT_TOKEN");
      if (!anthropicApiKey) throw new Error("Missing ANTHROPIC_API_KEY");
      if (!channelId) throw new Error("Missing channel_id in interaction");
      if (!applicationId) throw new Error("Missing application_id in interaction");
      if (!interactionToken) throw new Error("Missing token in interaction");

      webhookUrl = `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`;

      const promptOption = interaction.data?.options?.find((o) => o.name === "prompt");
      const prompt =
        typeof promptOption?.value === "string" && promptOption.value.trim().length > 0 ? promptOption.value.trim() : "";

      const userName =
        interaction.member?.user?.global_name ??
        interaction.member?.user?.username ??
        interaction.user?.global_name ??
        interaction.user?.username ??
        "User";

      // Acknowledge quickly to avoid Discord timing out while we call external APIs.
      res.json({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      const discordResp = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=100`, {
        method: "GET",
        headers: { Authorization: `Bot ${botToken}` }
      });

      const apiJson = await discordResp.json();
      const historyJson = JSON.stringify(apiJson);
      const truncatedHistoryJson = historyJson;

      const userInstruction =
        prompt.length > 0 ? `The user ${userName} gives this instruction: ${prompt}` : "";

      const aiResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 512,
          system: `You are a helpful assistant, named DE0CH's AI Bot, participating in the conversation. Respond with JSON in the format: {"message": "..."}.\n\nInstruction: participate by forming a reply. ${userInstruction}`,
          messages: [
            {
              role: "user",
              content: `Here is the Discord channel chat history JSON:\n\n${truncatedHistoryJson}`
            }
          ]
        })
      });

      const aiData = await aiResp.json();
      const aiText = aiData?.content?.[0]?.text as string;
      const parsed = JSON.parse(aiText) as { message?: string };
      const message = parsed.message ?? aiText;

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message })
      });

      return;
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const safeMessage = `Error: ${errMessage}`.slice(0, 1900);

      // If we've already deferred, Discord expects us to use the interaction webhook.
      if (webhookUrl) {
        try {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: safeMessage })
          });
        } catch {
          // Ignore secondary failures; nothing else we can do without a valid webhookUrl.
        }
        return;
      }

      // If we haven't deferred yet, respond with a normal interaction message.
      res.json({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: safeMessage }
      });
      return;
    }
  }

  res.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content: "Unknown command" }
  });
});
