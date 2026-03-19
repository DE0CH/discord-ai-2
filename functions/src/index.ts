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
    // Some Discord payloads use `interaction_metadata.name`, others use `command_name`.
    typeof m?.interaction_metadata?.name === "string"
      ? m.interaction_metadata.name
      : typeof m?.interaction_metadata?.command_name === "string"
        ? m.interaction_metadata.command_name
        : typeof m?.interaction?.name === "string"
          ? m.interaction.name
          : typeof m?.interaction?.command_name === "string"
            ? m.interaction.command_name
            : "";

  // Newer payloads may include options in interaction metadata; older may not.
  const interactionOptions = m?.interaction_metadata?.options ?? m?.interaction?.options;
  const interactionOptsStr = formatCommandOptions(interactionOptions);

  const systemContent = typeof m?.system_content === "string" ? m.system_content.trim() : "";
  const cleanContent = typeof m?.clean_content === "string" ? m.clean_content.trim() : "";
  const contentValue = m?.content;
  let content =
    typeof contentValue === "string" ? contentValue.trim() : contentValue == null ? "" : String(contentValue).trim();

  if (!content) {
    if (systemContent) {
      content = systemContent;
    } else if (cleanContent) {
      content = cleanContent;
    } else {
      const hasAttachments = Array.isArray(m?.attachments) && m.attachments.length > 0;
      const hasEmbeds = Array.isArray(m?.embeds) && m.embeds.length > 0;
      const hasStickers = Array.isArray(m?.sticker_items) && m.sticker_items.length > 0;
      const hasComponents = Array.isArray(m?.components) && m.components.length > 0;
      const hasRich =
        hasAttachments || hasEmbeds || hasStickers || hasComponents || (Array.isArray(m?.stickers) && m.stickers.length > 0);

      const contentWithheldHint =
        // When the privileged intent isn't configured/approved, Discord returns empty values for
        // `content`, `embeds`, `attachments`, and `components`.
        !interactionName &&
        !systemContent &&
        !cleanContent &&
        !hasRich &&
        (!contentValue || (typeof contentValue === "string" && contentValue.length === 0))
          ? "(content withheld by Discord: enable MESSAGE_CONTENT privileged intent)"
          : "";

      if (contentWithheldHint) {
        content = contentWithheldHint;
      } else {
        const attachmentNames = hasAttachments
          ? m.attachments
              .map((a: any) =>
                typeof a?.filename === "string"
                  ? a.filename
                  : typeof a?.url === "string"
                    ? a.url
                    : "attachment"
              )
              .slice(0, 3)
          : [];

        const embedHints = hasEmbeds
          ? m.embeds
              .map((e: any) => (typeof e?.title === "string" ? e.title : typeof e?.url === "string" ? e.url : "embed"))
              .slice(0, 2)
          : [];

        const stickerNames = hasStickers ? m.sticker_items.map((s: any) => (typeof s?.name === "string" ? s.name : "sticker")).slice(0, 3) : [];

        const parts: string[] = [];
        if (attachmentNames.length > 0) parts.push(`attachments: ${attachmentNames.join(", ")}`);
        if (embedHints.length > 0) parts.push(`embeds: ${embedHints.join(", ")}`);
        if (stickerNames.length > 0) parts.push(`stickers: ${stickerNames.join(", ")}`);
        if (hasComponents) parts.push(`components: ${m.components.length}`);

        if (interactionName) {
          const slash = `/${interactionName}${interactionOptsStr ? " " + interactionOptsStr : ""}`;
          parts.unshift(`command: ${slash}`);
        }

        content = parts.length > 0 ? `(${parts.join(" | ")})` : "(non-text message)";
      }
    }
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
  // Discord returns newest-first; reverse so it's chronological (oldest -> newest).
  return apiJson
    .slice()
    .reverse()
    .map((m) => formatDiscordMessage(m))
    .join("\n");
}

function buildDiscordTranscript(apiJson: any, maxChars: number): string {
  const full = formatDiscordHistory(apiJson);
  if (full.length <= maxChars) return full;
  // Keep the tail of the transcript (most recent messages) while cutting on line boundaries.
  const lines = full.split("\n");
  const kept: string[] = [];
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const add = line.length + (kept.length > 0 ? 1 : 0);
    if (total + add > maxChars) break;
    kept.push(line);
    total += add;
  }
  return kept.reverse().join("\n");
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

      if (!discordResp.ok) {
        const errText = await discordResp.text().catch(() => "");
        throw new Error(`Discord history fetch failed (${discordResp.status}): ${errText.slice(0, 300)}`);
      }

      const apiJson = await discordResp.json();
      // Keep enough room for the model to produce an output; long histories
      // increase the chance of cut-off responses.
      const MAX_TRANSCRIPT_CHARS = 12_000;
      console.log(apiJson);
      const transcript = buildDiscordTranscript(apiJson, MAX_TRANSCRIPT_CHARS);

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
          system: `You are a helpful assistant, named DE0CH's AI Bot, participating in the conversation. Respond with a single Discord message in plain text (no JSON).\n\nInstruction: participate by forming a reply.`,
          messages: [
            {
              role: "user",
              content:
                `Here is the Discord channel transcript (chronological, oldest -> newest):\n\n` +
                transcript +
                `\n\nThe user ${userName} invoked /ai. Write the next assistant message as a reply to the latest context in the transcript.`
            }
          ]
        })
      });

      const aiData = await aiResp.json().catch(() => null);
      if (!aiResp.ok) {
        const msg =
          typeof (aiData as any)?.error?.message === "string"
            ? (aiData as any).error.message
            : typeof (aiData as any)?.message === "string"
              ? (aiData as any).message
              : JSON.stringify(aiData);
        throw new Error(`Anthropic error (${aiResp.status}): ${String(msg).slice(0, 500)}`);
      }

      const aiText = (aiData as any)?.content?.[0]?.text;
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

// Export these for local rapid-prototyping scripts.
export { formatDiscordMessage, formatDiscordHistory, buildDiscordTranscript };
