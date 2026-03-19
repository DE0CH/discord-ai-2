// chat.ts
const API_KEY = process.env.ANTHROPIC_API_KEY!;

const messages = [
  { role: "alex", content: "tabs are objectively better, indentation should be visible" },
  { role: "sam", content: "spaces all the way, tabs render differently in every editor" },
  { role: "alex", content: "that's a skill issue, just configure your editor" },
  { role: "sam", content: "why make everyone configure their editor when spaces just work" },
  { role: "alex", content: "tabs let people choose their indent size, spaces force your preference on everyone" },
  { role: "sam", content: "consistency matters more than preference, spaces give you that" },
  { role: "alex", content: "you're being so closed minded about this" },
  { role: "sam", content: "i'm being practical, you're being stubborn" },
  { role: "alex", content: "/ai help me explain my viewpoint better" },
];

const aiCommand = messages.find((m) => m.content.startsWith("/ai "));
if (!aiCommand) throw new Error("No /ai command found in messages");
const instruction = aiCommand.content.slice("/ai ".length);

const transcript = messages
  .filter((m) => !m.content.startsWith("/ai "))
  .map((m) => `${m.role}: ${m.content}`)
  .join("\n");

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
    "anthropic-version": "2023-06-01",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: `You are a helpful assistant, named DE0CH's AI Bot, participating in the conversation. Now the user has asked you to participate in the conversation. Respond with JSON in the format: {"message": "..."}\n\nInstruction: ${instruction}`,
    messages: [
      {
        role: "user",
        content: `Here is the Discord conversation:\n\n${transcript}`,
      },
    ],
  }),
});

const data = await response.json();
const result = JSON.parse(data.content[0].text);
console.log(result.message);

export {};
