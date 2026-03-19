#!/usr/bin/env node
/// <reference types="node" />

type EnvVar = string | undefined;

function requireEnv(name: string, value: EnvVar): string {
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const appId = requireEnv("DISCORD_APPLICATION_ID", process.env.DISCORD_APPLICATION_ID);
  const botToken = requireEnv("DISCORD_BOT_TOKEN", process.env.DISCORD_BOT_TOKEN);
  const guildId = process.env.DISCORD_GUILD_ID;

  const commandBody = [
    {
      name: "ping",
      description: "Replies with pong",
      type: 1
    },
    {
      name: "echo-chat",
      description: "Echoes previous /echo-chat inputs",
      type: 1,
      options: [
        {
          name: "message",
          description: "Message to append to the echoed history",
          type: 3,
          required: false
        }
      ]
    },
    {
      name: "ai",
      description: "Respond with AI using recent channel chat history",
      type: 1,
    }
  ];

  const endpoint = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const scope = guildId ? `guild ${guildId}` : "global";

  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commandBody)
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Failed to register slash command (${scope}). HTTP ${response.status}: ${text}`);
  }

  console.log(`Registered slash commands (${scope}).`);
  console.log(text);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
