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

function formatCommandOptions(options: any): string {
  if (!Array.isArray(options) || options.length === 0) return "";
  const parts: string[] = [];

  for (const o of options) {
    const name = typeof o?.name === "string" ? o.name : "option";

    if (Array.isArray(o?.options) && o.options.length > 0) {
      // Subcommand / group style: { name, options: [...] }
      const nested = formatCommandOptions(o.options);
      parts.push(nested.length > 0 ? `${name} ${nested}` : name);
      continue;
    }

    const value =
      typeof o?.value === "string" || typeof o?.value === "number" || typeof o?.value === "boolean"
        ? String(o.value)
        : o?.value == null
          ? ""
          : JSON.stringify(o.value);

    parts.push(value.length > 0 ? `${name}: ${value}` : name);
  }

  return parts.join(" ");
}

function formatDiscordMessage(m: any): string {
  const author =
    m?.author?.global_name ??
    m?.author?.username ??
    m?.member?.nick ??
    (typeof m?.author?.id === "string" ? `user:${m.author.id}` : "unknown");

  const timestamp = typeof m?.timestamp === "string" ? m.timestamp : "";

  // Discord "interaction" message (slash command invoked)
  const interactionName =
    typeof m?.interaction_metadata?.name === "string"
      ? m.interaction_metadata.name
      : typeof m?.interaction?.name === "string"
        ? m.interaction.name
        : "";

  // Newer payloads may include options in interaction metadata; older may not.
  const interactionOptions = m?.interaction_metadata?.options;
  const interactionOptsStr = formatCommandOptions(interactionOptions);

  let content = typeof m?.content === "string" ? m.content.trim() : "";
  if (!content) {
    const attachmentNames =
      Array.isArray(m?.attachments) && m.attachments.length > 0
        ? m.attachments
            .map((a: any) => (typeof a?.filename === "string" ? a.filename : typeof a?.url === "string" ? a.url : "attachment"))
            .slice(0, 3)
        : [];
    const embedHints =
      Array.isArray(m?.embeds) && m.embeds.length > 0
        ? m.embeds
            .map((e: any) => (typeof e?.title === "string" ? e.title : typeof e?.url === "string" ? e.url : "embed"))
            .slice(0, 2)
        : [];
    const stickerNames =
      Array.isArray(m?.sticker_items) && m.sticker_items.length > 0
        ? m.sticker_items.map((s: any) => (typeof s?.name === "string" ? s.name : "sticker")).slice(0, 3)
        : [];

    const parts: string[] = [];
    if (attachmentNames.length > 0) parts.push(`attachments: ${attachmentNames.join(", ")}`);
    if (embedHints.length > 0) parts.push(`embeds: ${embedHints.join(", ")}`);
    if (stickerNames.length > 0) parts.push(`stickers: ${stickerNames.join(", ")}`);

    if (interactionName) {
      const slash = `/${interactionName}${interactionOptsStr ? " " + interactionOptsStr : ""}`;
      parts.unshift(`command: ${slash}`);
    }

    content = parts.length > 0 ? `(${parts.join(" | ")})` : "(non-text message)";
  } else if (interactionName) {
    // If Discord includes both content and an interaction tag, keep both.
    const slash = `/${interactionName}${interactionOptsStr ? " " + interactionOptsStr : ""}`;
    content = `(command: ${slash}) ${content}`;
  }

  const prefixParts = [];
  if (timestamp) prefixParts.push(timestamp);
  prefixParts.push(author);
  return `[${prefixParts.join(" ")}] ${content}`;
}

function formatDiscordHistory(apiJson: any): string {
  if (!Array.isArray(apiJson)) return JSON.stringify(apiJson);
  // Discord returns newest-first; reverse to chronological.
  const chronological = [...apiJson].reverse();
  return chronological.map((m) => formatDiscordMessage(m)).join("\n");
}

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
    const content = formatDiscordHistory(apiJson);

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
      const historyText = formatDiscordHistory(apiJson);
      // Keep enough room for the model to produce an output; long histories
      // increase the chance of cut-off responses.
      const MAX_HISTORY_CHARS = 12_000;
      const truncatedHistoryText =
        historyText.length > MAX_HISTORY_CHARS ? historyText.slice(historyText.length - MAX_HISTORY_CHARS) : historyText;

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
          // Output cap for Discord-sized answers.
          max_tokens: 1024,
          system: `You are a helpful assistant, named DE0CH's AI Bot, participating in the conversation. Respond with a single Discord message in plain text (no JSON).\n\nInstruction: participate by forming a reply. ${userInstruction}`,
          messages: [
            {
              role: "user",
              content: `Here is the Discord channel history (chronological). It includes explicit slash command context when present:\n\n${truncatedHistoryText}`
            }
          ]
        })
      });

      const aiData = await aiResp.json();
      const aiText = aiData?.content?.[0]?.text;
      const message =
        typeof aiText === "string" && aiText.trim().length > 0
          ? aiText.trim()
          : "Sorry - I couldn't produce a response.";
      const safeMessage = message.slice(0, 1900);

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: safeMessage })
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
