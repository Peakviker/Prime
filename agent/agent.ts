import { defineAgent } from "eve";

export default defineAgent({
  // Research work here is reasoning-heavy and writes its own analysis code,
  // and the Telegram channel accepts inbound chart images — so this needs a
  // strong vision-capable model. The scaffold default (zai/glm-5.2) takes no
  // image input at all.
  model: "anthropic/claude-opus-5",
  reasoning: "high",
});
