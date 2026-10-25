import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { createCloudClient, cloudVerificationUrl } from "./client.js";
import { resolveCloudHost } from "./config.js";
import { createNativeCredentialStore, resolveCloudCredential } from "./credentials.js";
import { runWorkbenchSubcommand } from "../workbench-subcommand.js";
import { type WorkbenchCliIo, writeUsageError, terminalSafeText } from "../workbench-shared.js";
import {
  cloudErrorExit,
  cloudSignal,
  cloudSleep,
  type CloudCommandDependencies,
} from "./shared.js";

const AUTH_USAGE = `Usage: tubeless auth <login|status|logout> [options]

Sign in to Tubeless Cloud with an expiring first-party session.

Options:
  --host <origin>  Cloud origin (default https://cloud.tubeless.io)
  --no-browser     Print the login URL without opening a browser
  --json           Machine-readable status
  -h, --help       Show this help

Credentials use the OS credential store. TUBELESS_TOKEN overrides stored sessions.
`;

async function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await promisify(execFile)(command, args, { timeout: 5000 });
}

export async function runAuth(
  argv: readonly string[],
  io: WorkbenchCliIo,
  dependencies: CloudCommandDependencies = {}
): Promise<number> {
  return runWorkbenchSubcommand(
    {
      usage: AUTH_USAGE,
      parse: (args) =>
        parseArgs({
          args: [...args],
          allowPositionals: true,
          strict: true,
          options: {
            host: { type: "string" },
            "no-browser": { type: "boolean" },
            json: { type: "boolean" },
            help: { type: "boolean", short: "h" },
          },
        }),
      run: async ({ values, positionals }) => {
        const [command] = positionals;
        if (positionals.length !== 1 || !["login", "status", "logout"].includes(command ?? "")) {
          return writeUsageError(io, "Pass login, status, or logout.", AUTH_USAGE);
        }
        if (values.json && command !== "status")
          return writeUsageError(io, "--json is supported by auth status.", AUTH_USAGE);
        if (values["no-browser"] && command !== "login")
          return writeUsageError(io, "--no-browser is supported by auth login.", AUTH_USAGE);
        const managed = cloudSignal(io);
        try {
          const host = resolveCloudHost(values.host);
          const store = dependencies.store ?? createNativeCredentialStore();
          const now = dependencies.now ?? Date.now;
          const env = dependencies.env ?? process.env;
          if (command === "login") {
            const client = createCloudClient({
              host,
              fetch: dependencies.fetch,
              signal: managed.signal,
            });
            const code = await client.deviceCode();
            const verification = cloudVerificationUrl(host, code.verification_uri_complete);
            io.stdout.write(
              `Open ${terminalSafeText(verification)}\nConfirm code: ${terminalSafeText(code.user_code)}\n`
            );
            if (!values["no-browser"]) {
              try {
                await (dependencies.openBrowser ?? openBrowser)(verification);
              } catch {
                io.stderr.write("Could not open a browser. Open the printed URL to continue.\n");
              }
            }
            let interval = Math.max(code.interval, 1) * 1000;
            const deadline = now() + code.expires_in * 1000;
            while (now() < deadline) {
              await (dependencies.sleep ?? cloudSleep)(interval, managed.signal);
              if (now() >= deadline) break;
              const token = await client.deviceToken(code.device_code);
              if ("error" in token) {
                if (token.error === "authorization_pending") continue;
                if (token.error === "slow_down") {
                  interval += 5000;
                  continue;
                }
                if (token.error === "access_denied") throw new Error("Device sign-in was denied.");
                if (token.error === "expired_token")
                  throw new Error("Device sign-in expired. Run tubeless auth login again.");
                throw new Error(`Device sign-in failed (${token.error}).`);
              }
              const credential = {
                token: token.access_token,
                expiresAt: now() + token.expires_in * 1000,
              };
              try {
                await store.set(host, credential);
              } catch (error) {
                try {
                  await createCloudClient({
                    host,
                    token: credential.token,
                    fetch: dependencies.fetch,
                    signal: managed.signal,
                  }).logout();
                } catch {
                  io.stderr.write(
                    "The newly issued session could not be revoked. It remains valid until expiry.\n"
                  );
                }
                throw error;
              }
              io.stdout.write(
                `Signed in to ${host}. Session expires ${new Date(credential.expiresAt).toISOString()}.\n`
              );
              return 0;
            }
            throw new Error("Device sign-in expired. Run tubeless auth login again.");
          }
          if (command === "logout" && env.TUBELESS_TOKEN) {
            io.stderr.write(
              "TUBELESS_TOKEN is active. Remove it from your environment; this command does not revoke environment-supplied sessions.\n"
            );
            return 2;
          }
          const credential = await resolveCloudCredential(host, { store, env, now });
          if (!credential)
            throw new Error(
              "No active Cloud credential. Run tubeless auth login or supply TUBELESS_TOKEN."
            );
          const client = createCloudClient({
            host,
            token: credential.token,
            fetch: dependencies.fetch,
            signal: managed.signal,
          });
          if (command === "logout") {
            let revoked = true;
            try {
              await client.logout();
            } catch {
              revoked = false;
            }
            await store.delete(host);
            if (!revoked) {
              io.stderr.write(
                "Removed the local credential. Remote revocation failed; the remote session could remain valid until expiry.\n"
              );
              return 2;
            }
            io.stdout.write(`Signed out of ${host}.\n`);
            return 0;
          }
          const session = await client.session();
          const status = { ...session, host, credentialSource: credential.source };
          if (values.json) io.stdout.write(`${JSON.stringify(status)}\n`);
          else
            io.stdout.write(
              `${terminalSafeText(session.user.name)} (${terminalSafeText(session.user.email)})\nHost: ${host}\nSession expires: ${new Date(session.expiresAt).toISOString()}\nCredential: ${credential.source}\n`
            );
          return 0;
        } catch (error) {
          return cloudErrorExit(error, io, managed.signal);
        } finally {
          managed.cleanup();
        }
      },
    },
    argv,
    io
  );
}
