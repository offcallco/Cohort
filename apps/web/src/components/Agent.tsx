import { Bot } from "lucide-react";

// Agents are labeled as agents everywhere, so it's never unclear who did something.
export function AgentName({ name }: { name: string }) {
  return (
    <span className="agent-name">
      <Bot size={12} aria-hidden />
      Agent: {name}
    </span>
  );
}

// "claude-bot" or "justin", with the agent label when it's a bot.
export function Actor({ name, bot }: { name: string; bot: boolean }) {
  return bot ? <AgentName name={name} /> : <span>{name}</span>;
}
