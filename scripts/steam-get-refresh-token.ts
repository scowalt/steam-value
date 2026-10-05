#!/usr/bin/env bun
import { LoginSession, EAuthTokenPlatformType } from "steam-session";

async function main() {
  const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);

  session.on("authenticated", async () => {
    console.log("\n✓ Authenticated!");

    const refreshToken = session.refreshToken;
    if (refreshToken) {
      if (await setDopplerSecret("STEAM_REFRESH_TOKEN", refreshToken)) {
        console.log("✓ Saved refresh token to Doppler");
      } else {
        console.error("Failed to save STEAM_REFRESH_TOKEN to Doppler; rerun after checking Doppler auth.");
      }
    }

    const cookies = await session.getWebCookies();
    const loginCookie = cookies.find((c) => c.startsWith("steamLoginSecure="));
    if (loginCookie) {
      const value = loginCookie.split("=").slice(1).join("=");
      if (await setDopplerSecret("STEAM_LOGIN_SECURE", value)) {
        console.log("✓ Saved fresh cookie to Doppler");
      } else {
        console.error("Failed to save STEAM_LOGIN_SECURE to Doppler; rerun after checking Doppler auth.");
      }
    }

    process.exit(0);
  });

  session.on("error", (err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });

  const result = await session.startWithQR();
  console.log("\nScan this URL with your Steam mobile app:");
  console.log(result.qrChallengeUrl);
  console.log("\nOr use this to generate a QR code:");
  console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(result.qrChallengeUrl!)}`);
  console.log("\nWaiting for scan (5 minutes timeout)...");

  await new Promise((r) => setTimeout(r, 300000));
  console.log("Timed out. Run again.");
  process.exit(1);
}

async function setDopplerSecret(name: string, value: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["doppler", "secrets", "set", name, "--project", "steam-value", "--config", "dev", "--no-interactive"],
    {
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
    }
  );

  proc.stdin.write(value);
  proc.stdin.end();

  return (await proc.exited) === 0;
}

main().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
