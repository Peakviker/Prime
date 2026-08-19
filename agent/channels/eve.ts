import { eveChannel } from "eve/channels/eve";
import { httpBasic, localDev, vercelOidc, type AuthFn } from "eve/channels/auth";

const auth: AuthFn<Request>[] = [
  // Lets the eve TUI and your Vercel deployments reach the deployed agent.
  vercelOidc(),
  // Open on localhost for `eve dev` and the REPL; ignored in production.
  localDev(),
];

// Fails closed (production HTTP callers get 401) until both env vars are
// set in the Vercel project (Settings > Environment Variables). Replace
// with a real identity provider (oidc(), jwtHmac(), or a custom AuthFn)
// once this agent sits behind an app with its own auth — see
// node_modules/eve/docs/guides/auth-and-route-protection.md.
const { ROUTE_AUTH_BASIC_USERNAME, ROUTE_AUTH_BASIC_PASSWORD } = process.env;
if (ROUTE_AUTH_BASIC_USERNAME && ROUTE_AUTH_BASIC_PASSWORD) {
  auth.push(
    httpBasic({
      username: ROUTE_AUTH_BASIC_USERNAME,
      password: ROUTE_AUTH_BASIC_PASSWORD,
    }),
  );
}

export default eveChannel({ auth });
