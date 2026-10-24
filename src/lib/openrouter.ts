// OpenRouter AI client using nvidia/nemotron-3.5-lightning:free

export interface UnderstandResult {
  categories: ("Internships" | "Hackathons" | "Competitions" | "Scholarships" | "Fellowships" | "Open Source")[];
  keywords: string[];
  skills: string[];
  level: string;
  location_preference: string;
  search_queries: string[];
}

export interface TriageResult {
  url: string;
  reason: string;
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

class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  constructor(private maxConcurrent: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next?.();
      }
    }
  }
}

const openRouterLimiter = new ConcurrencyLimiter(4);

function getOpenRouterApiKey(): string {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === "your_openrouter_api_key_here") {
    throw new Error("OPENROUTER_API_KEY is not configured in .env.local");
  }
  return apiKey;
}

function getModelName(): string {
  return process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning:free";
}

function parseJsonSafe<T>(rawText: string, fallback: T): T {
  try {
    let clean = rawText.trim();
    // Remove markdown json code fences if present
    if (clean.includes("```json")) {
      const match = clean.match(/```json\s*([\s\S]*?)\s*```/i);
      if (match && match[1]) {
        clean = match[1].trim();
      }
    } else if (clean.includes("```")) {
      const match = clean.match(/```\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        clean = match[1].trim();
      }
    }

    // If still contains leading/trailing non-json chars, find first { or [ and last } or ]
    const firstBrace = clean.indexOf("{");
    const firstBracket = clean.indexOf("[");
    const startIdx =
      firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)
        ? firstBrace
        : firstBracket;

    const lastBrace = clean.lastIndexOf("}");
    const lastBracket = clean.lastIndexOf("]");
    const endIdx = Math.max(lastBrace, lastBracket);

    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      clean = clean.slice(startIdx, endIdx + 1);
    }

    return JSON.parse(clean);
  } catch (err: any) {
    console.error(
      "[OpenRouter parseJsonSafe] Failed to parse JSON:",
      err.message,
      "Raw snippet:",
      rawText.slice(0, 300)
    );
    return fallback;
  }
}

/**
 * Execute a completion via OpenRouter
 */
async function callOpenRouter(prompt: string, systemPrompt?: string): Promise<string> {
  const apiKey = getOpenRouterApiKey();
  const model = getModelName();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://opportunity-radar.local",
        "X-Title": "Opportunity Radar",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              systemPrompt ||
              "You are an expert AI parser and career advisor for Indian college students. You must ALWAYS reply with valid JSON only. Do not include markdown code block ticks, conversation, or commentary outside the JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const errText = await res.text();
      let errorMsg = `OpenRouter API error (status ${res.status})`;
      try {
        const parsedErr = JSON.parse(errText);
        if (parsedErr?.error?.message) {
          errorMsg = parsedErr.error.message;
        }
      } catch {}
      console.error(`[OpenRouter Error]: ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "";
    return content;
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("OpenRouter request timed out after 60 seconds");
    }
    throw err;
  }
}

/**
 * Step 1: Understand user request and profile using Nemotron 3.5 Lightning
 */
export async function understandUserGoal(
  lookingFor: string,
  profile: string,
  selectedCategory?: string
): Promise<UnderstandResult> {
  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are an AI advisor for Indian college students finding career and learning opportunities.
Today's date is: ${today}.

User Goal / What they are looking for: "${lookingFor}"
User Profile:
${profile}
User Selected Category filter: "${selectedCategory || "All"}"

Available Categories:
- Internships
- Hackathons
- Competitions
- Scholarships
- Fellowships
- Open Source

Your Task:
Analyze the user's intent, course, year of study, skills, and constraints.
Generate a valid JSON object matching this exact schema:
{
  "categories": ["Internships", "Hackathons"],
  "keywords": ["5-8 specific, high-intent keywords e.g. machine learning, NLP, Python, stipend"],
  "skills": ["skills extracted or implied from the profile"],
  "level": "1st year | 2nd year | 3rd year | final year | graduate",
  "location_preference": "remote | specific city | any",
  "search_queries": [
    "5 short, specific search queries combining keywords with opportunity phrases e.g. internship apply, hackathon registration open 2026, scholarship 2026-27 last date"
  ]
}

Return ONLY the JSON object.`;

  console.log(`[Nemotron 3.5 Step 1: Understand] Analyzing user input...`);
  const rawResponse = await callOpenRouter(prompt);

  const parsed = parseJsonSafe<UnderstandResult>(rawResponse, {
    categories: ["Internships", "Hackathons"],
    keywords: ["internship", "hackathon", "student", "technology"],
    skills: [],
    level: "3rd year",
    location_preference: "any",
    search_queries: [
      "college internship apply India",
      "student hackathon registration open",
      "tech competition 2026",
      "student scholarship last date",
      "open source program apply",
    ],
  });

  return parsed;
}

/**
 * Step 3: Triage search results using Nemotron 3.5 Lightning
 */
export async function triageSearchResults(
  results: { title: string; snippet: string; url: string; date?: string }[],
  keywords: string[]
): Promise<TriageResult[]> {
  if (results.length === 0) return [];

  const today = new Date().toISOString().split("T")[0];

  const prompt = `You are evaluating web search results to find CURRENTLY OPEN or UPCOMING student opportunities in India.
Today's date is: ${today}.
Target keywords: ${keywords.join(", ")}

Search Results:
${JSON.stringify(
  results.map((r, i) => ({
    index: i,
    title: r.title,
    snippet: r.snippet,
    url: r.url,
    date: r.date || "unknown",
  })),
  null,
  2
)}

Task:
Pick UP TO 8 of the most promising URLs that look like a SPECIFIC opportunity page or an active live listing page.
Reject:
- Listicles ("top 10", "best 5", "how to get", "tips")
- Past news recaps or archives
- Winner / results announcements
- Outdated or expired programs from past years
- Social media profiles, generic homepages with no listings

Return ONLY a JSON array of objects with the exact "url" and a short "reason" why it was picked:
[
  {
    "url": "https://example.com/apply",
    "reason": "Direct registration portal for upcoming AI hackathon"
  }
]`;

  console.log(`[Nemotron 3.5 Step 3: Triage] Triaging ${results.length} search results...`);
  const rawResponse = await callOpenRouter(prompt);

  const parsed = parseJsonSafe<TriageResult[]>(rawResponse, []);
  console.log(`[Nemotron 3.5 Step 3: Triage] Selected ${parsed.length} URLs. Reasons:`);
  for (const item of parsed) {
    console.log(`  - [${item.url}]: ${item.reason}`);
  }
  return parsed.slice(0, 8);
}

/**
 * Step 5: Extract and match opportunities from a single page using Nemotron 3.5 Lightning
 */
export async function extractOpportunitiesFromPage(params: {
  pageUrl: string;
  sourceName: string;
  pageText: string;
  keywords: string[];
  profile: string;
}): Promise<ExtractedOpportunity[]> {
  const { pageUrl, sourceName, pageText, keywords, profile } = params;

  if (!pageText || pageText.trim().length < 100) {
    return [];
  }

  return openRouterLimiter.run(async () => {
    const today = new Date().toISOString().split("T")[0];
    const textSample = pageText.slice(0, 20000);

    const prompt = `You are an expert opportunity parser for Indian college students.
Source Name: ${sourceName}
Source URL: ${pageUrl}
Today's Date: ${today}
Target Keywords: ${keywords.join(", ")}
Student Profile:
${profile}

Page Content (first 20,000 characters):
\"\"\"
${textSample}
\"\"\"

Instruction:
Extract ONLY real, specific opportunities that are currently open or upcoming as of today (${today}).
Ignore ads, navigation, and expired items.
If the page only shows past dates or the program is between cycles, return an empty array [].
NEVER invent or guess deadlines.
Return a JSON array, max 10 items:
[
  {
    "title": "Opportunity Title",
    "organization": "Hosting Company / University / Foundation",
    "type": "Internship" | "Hackathon" | "Competition" | "Scholarship" | "Fellowship" | "Open Source",
    "mode": "Online" | "In-person" | "Hybrid" | "Remote" | "Unknown",
    "location": "e.g. Remote, Bengaluru, India, or Global",
    "deadline_text": "e.g. 'Nov 15, 2026' or 'Rolling' or 'Apply soon'",
    "deadline_iso": "YYYY-MM-DD or null if not explicitly stated",
    "eligibility": "One line summarizing who can apply",
    "stipend_or_prize": "e.g. '₹25,000/month', '$5,000 Prize Pool', or null",
    "link": "Specific application or opportunity URL if present in the text, otherwise '${pageUrl}'",
    "evidence": "Short quote from the page showing the deadline or open status",
    "keyword_matches": ["list of user keywords matched"],
    "fit_score": 8, // Integer 1-10 based on relevance to profile, skills, and level
    "why_it_fits": "One concise sentence written directly to the student explaining why this matches their background"
  }
]

Return ONLY the JSON array.`;

    try {
      const rawResponse = await callOpenRouter(prompt);
      const parsed = parseJsonSafe<ExtractedOpportunity[]>(rawResponse, []);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err: any) {
      console.error(
        `[Nemotron 3.5 Step 5: Extract] Error extracting from ${pageUrl}:`,
        err.message
      );
      return [];
    }
  });
}
