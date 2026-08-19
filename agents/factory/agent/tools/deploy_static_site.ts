import { defineTool } from "eve/tools";
import { once } from "eve/tools/approval";
import { z } from "zod";

/**
 * Publishes a built directory from the sandbox to Vercel.
 *
 * This runs in the app runtime, not the sandbox, which is the whole point: the
 * Vercel token is read from `process.env` here and never crosses into the
 * sandbox or into anything the model can see. The model chooses *what* to
 * deploy; it never holds the credential that makes deployment possible.
 */

/** Vercel accepts inline file bodies on this endpoint; larger trees need the sha upload flow. */
const DEPLOY_ENDPOINT = "https://api.vercel.com/v13/deployments";

/** Guards against a runaway build directory being base64'd into one request. */
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;

const SKIP_DIRS = ["node_modules", ".git", ".next/cache", ".vercel"];

export default defineTool({
  description:
    "Deploy an already-built static site from a sandbox directory to Vercel and return its public URL. Build the site first — this uploads whatever is in the directory as-is. Use for plain HTML/CSS/JS or the output directory of a framework build (dist, out, build).",
  inputSchema: z.object({
    directory: z
      .string()
      .describe(
        "Sandbox directory holding the built site, e.g. 'site' or 'app/dist'. Relative paths resolve from /workspace.",
      ),
    projectName: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,62}$/,
        "Lowercase letters, digits and hyphens only; must start with a letter or digit.",
      )
      .describe("Vercel project name. Reusing a name deploys a new version of that project."),
    production: z
      .boolean()
      .default(false)
      .describe("Deploy to production. Leave false for a preview URL."),
  }),

  // Publishing to the internet is an external side effect, so the first one in
  // a session asks. Switch to always() if every deploy should be confirmed.
  approval: once(),

  async execute({ directory, projectName, production }, ctx) {
    const token = process.env.VERCEL_TOKEN;
    if (!token) {
      throw new Error(
        "VERCEL_TOKEN is not set on the agent runtime. Add it to the environment and retry; it is never passed through the sandbox.",
      );
    }

    const sandbox = await ctx.getSandbox();
    const root = sandbox.resolvePath(directory);

    const prune = SKIP_DIRS.map((d) => `-path '${root}/${d}' -prune`).join(" -o ");
    const listed = await sandbox.run({
      command: `find ${root} \\( ${prune} \\) -o -type f -print`,
    });

    const paths = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (paths.length === 0) {
      throw new Error(
        `No files found in "${directory}". Build the site first, then deploy the directory the build wrote to.`,
      );
    }
    if (paths.length > MAX_FILES) {
      throw new Error(
        `${paths.length} files in "${directory}" exceeds the ${MAX_FILES}-file cap. Deploy a built output directory rather than a source tree.`,
      );
    }

    let totalBytes = 0;
    const files: { file: string; data: string; encoding: "base64" }[] = [];

    for (const absolute of paths) {
      const bytes = await sandbox.readBinaryFile({ path: absolute });
      if (bytes === null) {
        // `find` listed it a moment ago, so this means the build is still
        // writing or something removed it mid-upload — either way, deploying a
        // half-read tree would publish a broken site.
        throw new Error(
          `Could not read "${absolute}" from the sandbox. Re-run the build and deploy again.`,
        );
      }
      const buffer = Buffer.from(bytes);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(
          `"${directory}" exceeds the ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB upload cap.`,
        );
      }
      files.push({
        // Vercel wants paths relative to the deployment root.
        file: absolute.slice(root.length + 1),
        data: buffer.toString("base64"),
        encoding: "base64",
      });
    }

    const teamId = process.env.VERCEL_TEAM_ID;
    const url = teamId
      ? `${DEPLOY_ENDPOINT}?teamId=${encodeURIComponent(teamId)}`
      : DEPLOY_ENDPOINT;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: projectName,
        files,
        target: production ? "production" : undefined,
        projectSettings: { framework: null },
      }),
    });

    const body = (await response.json()) as {
      url?: string;
      id?: string;
      error?: { message?: string };
    };

    if (!response.ok) {
      // Surface Vercel's own message — it names the actual problem (name taken,
      // bad token, quota) far better than a generic status line.
      throw new Error(
        `Vercel rejected the deployment (HTTP ${response.status}): ${body.error?.message ?? "no message returned"}`,
      );
    }

    return {
      url: body.url ? `https://${body.url}` : null,
      deploymentId: body.id ?? null,
      target: production ? "production" : "preview",
      fileCount: files.length,
      totalBytes,
    };
  },
});
