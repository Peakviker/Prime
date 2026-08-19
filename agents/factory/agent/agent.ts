import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

/**
 * Routed through OpenRouter rather than the Vercel AI Gateway, so the model is
 * a provider-authored `LanguageModel` object instead of a gateway id string.
 *
 * `apiKey` is read from the environment at runtime. It is deliberately not
 * asserted at module scope: `eve build` evaluates this file, and a missing key
 * during a build should not fail the build — it should fail the first model
 * call, with a message that says what to set.
 */
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});

/** Overridable so a stronger model can be swapped in without a code change. */
const MODEL_ID = process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3.5-lightning:free";

export default defineAgent({
  model: openrouter.chat(MODEL_ID),

  // eve otherwise resolves the context window from the AI Gateway catalog,
  // which does not list OpenRouter models — without this the agent fails to
  // start with a 403 from the catalog lookup.
  //
  // Deliberately a conservative floor rather than the model's real window:
  // guessing low only makes compaction fire earlier, while guessing high
  // overflows the context outright. Raise it once you confirm the real window
  // for the model you settle on.
  modelContextWindowTokens: 32_768,

  // A small free model drifts on long tool loops. Compacting earlier keeps the
  // working set inside its context rather than letting a build log push the
  // task description out.
  compaction: {
    thresholdPercent: 0.7,
  },

  limits: {
    // A build-and-deploy loop that goes wrong can spin for a long time. This is
    // a stop, not a budget: the session pauses and asks rather than burning on.
    maxOutputTokensPerSession: 200_000,
  },
});
