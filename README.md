# Opportunity Radar 📡

> **Live opportunities from 20 trusted sources, matched directly to Indian college students.**

Opportunity Radar helps Indian college students discover **CURRENTLY OPEN** internships, hackathons, competitions, scholarships, fellowships, and open-source programs that match their profile, academic level, and location preferences, powered by live web data from **TinyFish** and reasoning from **NVIDIA Nemotron 3.5 Lightning** (`nvidia/nemotron-3.5-lightning:free`) via **OpenRouter**.

---

## What the App Does

Instead of relying on stale databases or static scrapers, Opportunity Radar executes an end-to-end live intelligence pipeline on every search:

1. **Understand (Nemotron 3.5)**: Takes the student's free-text goal and background (course, year, college, skills, constraints) and generates precise search keywords, intent categories, and 5 targeted search queries.
2. **Gather (TinyFish Search & Listing Pages)**: Runs parallel search queries across trusted Indian and international student opportunity domains (with geographic and freshness targeting), plus direct portal crawling.
3. **Triage (Nemotron 3.5)**: Evaluates incoming search results and filters down to the 8 most promising live opportunity listing pages, rejecting listicles, outdated recaps, and winner announcements.
4. **Fetch (TinyFish Fetch)**: Fast, server-side content extraction with clean markdown/text stripping, in-memory 30-minute caching, and automatic rate-limit concurrency management.
5. **Extract & Match (Nemotron 3.5)**: Reads up to 20,000 characters per page to extract real, currently open opportunities, verifying deadlines, stipend/prizes, eligibility, and calculating a personalized 1–10 fit score.
6. **Validate & Rank (Deterministic Code)**: Drops expired items, ensures deadlines are honored, dedupes listings, and ranks opportunities by fit score and upcoming deadline.

---

## Setup in 4 Steps

### 1. Install dependencies
```bash
npm install
```

### 2. Configure API keys
Create a `.env.local` file based on `.env.example`:
```bash
cp .env.example .env.local
```
Add your keys to `.env.local`:
```env
# TinyFish API key for live search and web page fetching
TINYFISH_API_KEY=sk-tinyfish-your-key-here

# OpenRouter API key
OPENROUTER_API_KEY=your_openrouter_api_key_here

# OpenRouter Model (defaults to nvidia/nemotron-3.5-lightning:free)
OPENROUTER_MODEL=nvidia/nemotron-3.5-lightning:free
```

> **Security Note**: All TinyFish and OpenRouter API calls are strictly executed server-side. Your keys are never exposed to the client or browser.

### 3. Verify trusted sources
Run the pre-flight testing script to test all 20 source portals with TinyFish Fetch:
```bash
npm run test:sources
```
This prints a live status table showing character counts and preview snippets for each portal.

### 4. Start the development server
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## How to Add or Remove Sources

All trusted opportunity portals are declared in [`src/config/sources.ts`](./src/config/sources.ts).

To add a new portal, add an entry to `TRUSTED_SOURCES`:
```typescript
{
  name: "Your Portal Name",
  url: "https://example.com/opportunities",
  domain: "example.com",
  category: "Internships", // "Internships" | "Hackathons" | "Competitions" | "Scholarships" | "Fellowships" | "Open Source"
  jsHeavy: false, // Set to true if the portal relies heavily on client-side JS rendering
}
```

To remove a source, simply delete or comment out its entry in `TRUSTED_SOURCES`.

---

## Note on JavaScript-Heavy (SPA) Sources

Some portals (such as AICTE Internship Portal or single-page apps) rely heavily on client-side JavaScript rendering and may return relatively "thin" text (< 500 characters) via standard HTML Fetch.

- The application handles this gracefully without crashing and marks such sources as `thin` or `failed`.
- These portals are prime candidates for the **TinyFish Agent API** in future iterations, which spins up a headless browser to execute interactive flows and client-side DOM rendering.

---

## Debugging & Observability

Opportunity Radar provides structured console logging at every step:
- 🎯 Generated queries and extracted keywords
- 🔍 Raw search results and domain deduplication
- ⚖️ Triaged URLs and acceptance/rejection reasons
- 📄 Characters fetched per portal and cache hits/misses
- 🤖 Opportunities extracted per page
- ⏱️ Filtered/dropped expired items and final ranking order
