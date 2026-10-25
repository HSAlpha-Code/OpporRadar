import fs from "fs";
import path from "path";
import os from "os";

export type JobStatus =
  | "PENDING"
  | "GENERATING_QUERIES"
  | "GATHERING_LINKS"
  | "TRIAGING"
  | "FETCHING_CONTENT"
  | "EXTRACTING_OPPORTUNITIES"
  | "COMPLETED"
  | "FAILED";

export interface SourceStatus {
  name: string;
  status: "ok" | "thin" | "failed" | "not_used";
  chars: number;
  foundCount: number;
}

export interface ExtractedOpportunity {
  title: string;
  organization: string;
  type: "Internship" | "Hackathon" | "Competition" | "Scholarship" | "Fellowship" | "Open Source";
  mode: "Online" | "In-person" | "Hybrid" | "Remote" | "Unknown";
  location: string;
  deadline_text: string;
  deadline_iso: string | null;
  eligibility: string;
  stipend_or_prize: string | null;
  link: string;
  evidence: string;
  keyword_matches: string[];
  fit_score: number;
  why_it_fits: string;
}

export interface JobState {
  jobId: string;
  status: JobStatus;
  progressMessage: string;
  stepNumber: number; // 0 to 6
  totalSteps: number; // 6
  createdAt: number;
  updatedAt: number;
  extractedKeywords?: string[];
  activeReadingPages?: { url: string; sourceName?: string }[];
  sourcesSummary?: Record<string, SourceStatus>;
  opportunities?: ExtractedOpportunity[];
  error?: string;
}

// In-memory global store (persists across warm invocations)
const globalStore = (globalThis as any).__job_store__ || new Map<string, JobState>();
(globalThis as any).__job_store__ = globalStore;

// File-based /tmp fallback directory (persists across cold/warm instances on filesystem)
const TMP_DIR = path.join(os.tmpdir(), "oppor-radar-jobs");

function ensureTmpDir() {
  try {
    if (!fs.existsSync(TMP_DIR)) {
      fs.mkdirSync(TMP_DIR, { recursive: true });
    }
  } catch {}
}

function getTmpFilePath(jobId: string): string {
  const safeId = jobId.replace(/[^a-zA-Z0-9_-]/g, "");
  return path.join(TMP_DIR, `${safeId}.json`);
}

/**
 * Job State Manager
 * Uses Upstash/Vercel KV REST if env variables are set, with automatic fallback
 * to globalThis in-memory map + /tmp persistent filesystem storage.
 */
class JobStore {
  private kvUrl = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  private kvToken = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  async createJob(jobId: string, initialMessage = "Job registered and queued..."): Promise<JobState> {
    const job: JobState = {
      jobId,
      status: "PENDING",
      progressMessage: initialMessage,
      stepNumber: 0,
      totalSteps: 6,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      extractedKeywords: [],
      activeReadingPages: [],
      sourcesSummary: {},
      opportunities: [],
    };

    await this.saveJob(job);
    return job;
  }

  async updateJob(jobId: string, updates: Partial<JobState>): Promise<JobState | null> {
    const current = await this.getJob(jobId);
    if (!current) {
      console.warn(`[JobStore] Attempted to update non-existent job ${jobId}`);
      return null;
    }

    const updated: JobState = {
      ...current,
      ...updates,
      jobId, // preserve identity
      updatedAt: Date.now(),
    };

    await this.saveJob(updated);
    return updated;
  }

  async getJob(jobId: string): Promise<JobState | null> {
    // 1. Try Upstash / Vercel KV REST API if available
    if (this.kvUrl && this.kvToken) {
      try {
        const res = await fetch(`${this.kvUrl}/get/job:${jobId}`, {
          headers: { Authorization: `Bearer ${this.kvToken}` },
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json();
          if (data.result) {
            const parsed = typeof data.result === "string" ? JSON.parse(data.result) : data.result;
            return parsed;
          }
        }
      } catch (err: any) {
        console.warn(`[JobStore KV Read Error]:`, err.message);
      }
    }

    // 2. Check in-memory global Map
    if (globalStore.has(jobId)) {
      return globalStore.get(jobId)!;
    }

    // 3. Check /tmp filesystem
    try {
      const filePath = getTmpFilePath(jobId);
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        globalStore.set(jobId, parsed);
        return parsed;
      }
    } catch (err: any) {
      console.warn(`[JobStore File Read Error]:`, err.message);
    }

    return null;
  }

  private async saveJob(job: JobState): Promise<void> {
    // Save in global memory
    globalStore.set(job.jobId, job);

    // Save to /tmp
    try {
      ensureTmpDir();
      fs.writeFileSync(getTmpFilePath(job.jobId), JSON.stringify(job), "utf-8");
    } catch {}

    // Save to KV REST if configured (TTL: 2 hours)
    if (this.kvUrl && this.kvToken) {
      try {
        await fetch(`${this.kvUrl}/set/job:${job.jobId}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.kvToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify([JSON.stringify(job), "EX", 7200]),
        });
      } catch (err: any) {
        console.warn(`[JobStore KV Save Error]:`, err.message);
      }
    }
  }
}

export const jobStore = new JobStore();
