import { NextRequest } from "next/server";
import { jobStore } from "@/lib/job-store";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const jobId = searchParams.get("jobId");

  if (!jobId) {
    return new Response(JSON.stringify({ error: "Missing required 'jobId' query parameter." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const job = await jobStore.getJob(jobId);

  if (!job) {
    return new Response(JSON.stringify({ error: "Job not found or expired." }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(job), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    },
  });
}
