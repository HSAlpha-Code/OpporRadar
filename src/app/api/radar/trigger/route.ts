import { NextRequest } from "next/server";
import { waitUntil } from "@vercel/functions";
import { jobStore } from "@/lib/job-store";
import { runOpportunityPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON request body." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { lookingFor, profile, category } = body || {};

  if (!lookingFor || !profile) {
    return new Response(
      JSON.stringify({
        error: "Please provide both what you are looking for and your student profile.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey || openRouterKey === "your_openrouter_api_key_here") {
    return new Response(
      JSON.stringify({
        error: "OPENROUTER_API_KEY is not configured in .env.local. Please add your OpenRouter API key.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const tinyfishKey = process.env.TINYFISH_API_KEY;
  if (!tinyfishKey || tinyfishKey === "your_tinyfish_api_key_here") {
    return new Response(
      JSON.stringify({
        error: "TINYFISH_API_KEY is not configured in .env.local. Please add your TinyFish API key.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Generate unique job ID
  const jobId = crypto.randomUUID();

  // Initialize job in state manager
  await jobStore.createJob(jobId, "Pipeline queued. Starting background live research...");

  // Kick off heavy background execution using waitUntil (non-blocking for Vercel/Next.js)
  waitUntil(
    runOpportunityPipeline(jobId, lookingFor, profile, category).catch((err) => {
      console.error(`[Unhandled Pipeline Error for ${jobId}]:`, err);
    })
  );

  // Return 202 Accepted immediately
  return new Response(
    JSON.stringify({
      jobId,
      status: "PENDING",
      message: "Opportunity Radar pipeline initiated.",
    }),
    {
      status: 202,
      headers: { "Content-Type": "application/json" },
    }
  );
}
