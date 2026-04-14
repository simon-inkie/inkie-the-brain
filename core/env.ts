import { readFileSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

// Load env vars from ~/io-data/.env if not already set
if (!process.env.GEMINI_API_KEY) {
  try {
    const envPath = resolve(homedir(), "io-data", ".env");
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const match = line.match(/^([^#]\w*)=(.+)$/);
      if (match && !process.env[match[1]]) {
        process.env[match[1]] = match[2].trim();
      }
    }
  } catch {
    // .env not found — GEMINI_API_KEY must be set externally
  }
}
