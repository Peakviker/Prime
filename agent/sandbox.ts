import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

// Locked decision (docs/ARCHITECTURE.md): the VM runs the sandbox itself,
// never vercel() — that would create hosted Vercel Sandboxes from a
// non-Vercel host. Pinning docker() also means a missing Docker daemon fails
// loudly instead of silently falling back to microsandbox or just-bash.
export default defineSandbox({
  backend: docker(),
});
