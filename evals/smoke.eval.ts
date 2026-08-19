import { defineEval } from "eve/evals";

export default defineEval({
  description: "The agent boots and replies to a basic message.",
  async test(t) {
    await t.send("Hello, are you there?");
    t.succeeded();
  },
});
