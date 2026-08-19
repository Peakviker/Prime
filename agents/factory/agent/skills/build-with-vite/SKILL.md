---
description: Use when a site needs a real build step — a framework, bundling, or npm dependencies — rather than a single static HTML file.
---

# Building a bundled site with Vite

Only take this path when plain HTML genuinely cannot do the job. A build step
adds three ways to fail (install, build, wrong output directory) that a single
`index.html` does not have.

## Steps

Run each from `/workspace`. Read the output of every command before moving on.

**1. Scaffold**

```sh
npm create vite@latest <name> -- --template vanilla
```

For a React site use `--template react` instead. Both are plain JavaScript —
do not add TypeScript unless the request asks for it, because a type error
becomes another build failure between you and a deployed site.

**2. Install**

```sh
cd <name> && npm install
```

This is the slowest step and the one most likely to hit a network problem. If
it fails, read the error: a registry timeout is worth one retry, a missing
package name is not.

**3. Write the actual content**

Edit `index.html` and `src/`. The scaffold ships a demo page — replace it
rather than adding to it, or the demo content ends up deployed.

**4. Build**

```sh
npm run build
```

Vite writes to `dist/`. Confirm it:

```sh
ls -la dist
```

An empty or missing `dist` means the build did not actually succeed, whatever
the exit code suggested.

**5. Deploy**

Pass `<name>/dist` to `deploy_static_site` — never `<name>` itself, which
contains `node_modules` and would blow the file cap.

## When the build fails

Read the error text and fix one thing. The usual causes, in order of how often
they happen:

- An import path that does not match the file on disk (case matters).
- A dependency used in code but never installed.
- A syntax error in a file you just wrote.

If the same error survives two fixes, stop and report it with the exact output
rather than trying a third variation.
