import fs from "fs";
import path from "path";
import { TRUSTED_SOURCES } from "../src/config/sources";

// Load .env.local if present
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  const content = fs.readFileSync(envLocalPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const idx = trimmed.indexOf("=");
      if (idx !== -1) {
        const key = trimmed.slice(0, idx).trim();
        const value = trimmed.slice(idx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

const apiKey = process.env.TINYFISH_API_KEY;
if (!apiKey) {
  console.error("❌ Error: TINYFISH_API_KEY is not set in environment or .env.local");
  process.exit(1);
}

async function runTestSources() {
  console.log("🔍 Opportunity Radar: Testing all 20 Trusted Sources with TinyFish Fetch...");
  console.log(`Loaded ${TRUSTED_SOURCES.length} sources.\n`);

  const urls = TRUSTED_SOURCES.map((s) => s.url);

  // Batch URLs in chunks of 10
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += 10) {
    chunks.push(urls.slice(i, i + 10));
  }

  const resultsMap = new Map<
    string,
    { status: "ok" | "thin" | "failed"; chars: number; snippet: string; error?: string }
  >();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log(`Fetching batch ${i + 1}/${chunks.length} (${chunk.length} URLs)...`);

    try {
      const response = await fetch("https://api.fetch.tinyfish.ai", {
        method: "POST",
        headers: {
          "X-API-Key": apiKey as string,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: chunk }),
      });

      if (!response.ok) {
        console.error(`Batch ${i + 1} HTTP ${response.status}: ${response.statusText}`);
        for (const u of chunk) {
          resultsMap.set(u, {
            status: "failed",
            chars: 0,
            snippet: `HTTP ${response.status}`,
            error: response.statusText,
          });
        }
        continue;
      }

      const data = await response.json();
      const results = data.results || [];
      const errors = data.errors || [];

      for (const item of results) {
        const text = (item.text || "").replace(/\s+/g, " ").trim();
        const chars = text.length;
        const status: "ok" | "thin" = chars >= 500 ? "ok" : "thin";
        const snippet = text.slice(0, 120);
        resultsMap.set(item.url, {
          status,
          chars,
          snippet,
        });
      }

      for (const err of errors) {
        const errUrl = typeof err === "string" ? err : err.url;
        resultsMap.set(errUrl, {
          status: "failed",
          chars: 0,
          snippet: typeof err === "object" ? err.error : "Fetch failed",
        });
      }
    } catch (err: any) {
      console.error(`Batch ${i + 1} exception:`, err.message);
      for (const u of chunk) {
        resultsMap.set(u, {
          status: "failed",
          chars: 0,
          snippet: err.message,
        });
      }
    }
  }

  // Print results table
  console.log("\n" + "=".repeat(110));
  console.log(
    "NAME".padEnd(32) +
      "STATUS".padEnd(10) +
      "CHARS".padEnd(10) +
      "FIRST 120 CHARACTERS"
  );
  console.log("=".repeat(110));

  for (const src of TRUSTED_SOURCES) {
    const res = resultsMap.get(src.url) || {
      status: "failed",
      chars: 0,
      snippet: "No response",
    };

    const statusDisplay =
      res.status === "ok" ? "✓ OK" : res.status === "thin" ? "⚠ THIN" : "✗ FAILED";

    console.log(
      src.name.slice(0, 30).padEnd(32) +
        statusDisplay.padEnd(10) +
        res.chars.toString().padEnd(10) +
        res.snippet
    );
  }

  console.log("=".repeat(110));
  console.log("\nNote: Sources with status 'THIN' are often JavaScript-heavy (SPAs)");
  console.log("and are candidates for the TinyFish Agent API in future iterations.\n");
}

runTestSources().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
