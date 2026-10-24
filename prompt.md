Build a complete, working web app called "Opportunity Radar" that helps Indian college
students find CURRENTLY OPEN internships, hackathons, competitions, scholarships,
fellowships and open-source programs that match their profile, using live web data.
Build everything end to end in one go: backend, frontend, config, README, and a test
script. The only things I will provide are two API keys: TINYFISH_API_KEY and
GEMINI_API_KEY.

If you can browse the web, first read https://docs.tinyfish.ai/for-coding-agents.md
and https://docs.tinyfish.ai/search-api/reference.md and follow them where they differ
from the details below.

==================================================
TECH STACK
==================================================
- Next.js (App Router) + TypeScript + Tailwind CSS. If this environment requires a
  different stack, use the closest equivalent, but keep a server-side backend.
- Keys in .env.local: TINYFISH_API_KEY, GEMINI_API_KEY, and GEMINI_MODEL (default to the
  latest fast "Flash" Gemini model available). Create .env.example with placeholders.
- Use the official Google Gen AI SDK (@google/genai) for Gemini, with JSON output
  (responseMimeType "application/json").
- ALL TinyFish and Gemini calls happen in server-side API routes. API keys must never
  reach the browser.

==================================================
TINYFISH API REFERENCE
==================================================
Auth header on every request: "X-API-Key: <TINYFISH_API_KEY>"
Rate limit: 30 requests/minute per key. Use a concurrency limiter (max 4 parallel
TinyFish calls) and retry once on 429 after 3 seconds.

SEARCH: GET https://api.search.tinyfish.ai
  Params: query, location (use "IN"), language ("en"), after_date (YYYY-MM-DD),
  include_domains, exclude_domains (check docs for exact list format; log the raw
  response of the first call)
  Response: { results: [ { position, title, snippet, url, site_name, date } ] }
  Timeout: 15s.

FETCH: POST https://api.fetch.tinyfish.ai
  Body: { "urls": ["...", "..."] }  (max 10 URLs per call)
  Returns clean page text per URL (fields include url, title, text). Failed URLs come
  back in an "errors" array: skip them, never crash.
  Timeout: 150s.

==================================================
TRUSTED SOURCES (put in /config/sources.ts so it's easy to edit)
==================================================
Each entry: { name, url, domain, category, jsHeavy }
Internships:
- Internshala | https://internshala.com/internships/ | internshala.com
- AICTE Internship Portal | https://internship.aicte-india.org/internships | internship.aicte-india.org
- PM Internship Scheme | https://pminternship.mca.gov.in | pminternship.mca.gov.in
Hackathons:
- Devfolio | https://devfolio.co/hackathons | devfolio.co
- Hack2skill | https://hack2skill.com/hackathons-listing | hack2skill.com | jsHeavy
- HackCulture | https://www.hackculture.io | hackculture.io
- MLH | https://www.mlh.com/events | mlh.com
- lablab.ai | https://lablab.ai/ai-hackathons | lablab.ai
- DoraHacks | https://dorahacks.io/hackathon | dorahacks.io | jsHeavy
Competitions:
- Unstop | https://unstop.com/competitions | unstop.com | jsHeavy
- Kaggle | https://www.kaggle.com/competitions | kaggle.com | jsHeavy
- MyGov Innovate India | https://innovateindia.mygov.in/ | innovateindia.mygov.in
Scholarships:
- Buddy4Study | https://www.buddy4study.com/online-application-form | buddy4study.com | jsHeavy
- National Scholarship Portal | https://scholarships.gov.in/Students | scholarships.gov.in
- DAAD India | https://www.daad.in/en/find-funding/scholarship-database/ | daad.in
Fellowships:
- IASc Summer Research Fellowship | https://webjapps.ias.ac.in/fellowship2027/index.html | ias.ac.in
- Teach For India | https://teachforindia.org/how-to-be-a-fellow | teachforindia.org
Open Source:
- Google Summer of Code | https://developers.google.com/open-source/gsoc/timeline | developers.google.com
- GirlScript Summer of Code | https://gssoc.girlscript.org | gssoc.girlscript.org
- Outreachy | https://www.outreachy.org/apply/project-selection/ | outreachy.org

==================================================
PIPELINE (POST /api/radar, stream progress to the UI with Server-Sent Events)
==================================================
INPUT from user:
- lookingFor (free text, e.g. "paid ML internship, remote, or AI hackathons")
- profile (2-4 lines: course, year, college/city, skills, interests)
- optional category chips (All, Internships, Hackathons, Competitions, Scholarships,
  Fellowships, Open Source). Default "All" = let Gemini decide.

STEP 1 - UNDERSTAND (Gemini)
Send lookingFor + profile + today's date. Get JSON:
{ "categories": [...from the 6 categories...],
  "keywords": [5-8 specific keywords, e.g. "machine learning", "NLP", "Python", "stipend"],
  "skills": [...], "level": "1st year | 2nd year | 3rd year | final year | graduate",
  "location_preference": "remote | <city> | any",
  "search_queries": [5 short, specific search queries combining keywords with
     opportunity words like "internship apply", "hackathon registration open",
     "scholarship 2026-27 last date", "fellowship 2027 apply"] }
Show the extracted keywords as chips in the UI (the user should SEE what the AI understood).

STEP 2 - GATHER (run A and B in parallel)
A) Keyword search on trusted sites: run each search_query on TinyFish Search with
   location=IN, language=en, after_date = 60 days ago, and include_domains = the domains
   of the sources in the selected categories. Run ONE extra open-web search with the best
   query and exclude_domains=instagram.com,facebook.com,x.com,twitter.com,linkedin.com,
   youtube.com,reddit.com,pinterest.com,quora.com,medium.com.
   Merge, dedupe by URL, max 3 URLs per domain.
B) Source listing pages: take the listing URLs of the sources in the selected categories.
   For Internshala, also try a keyword URL
   https://internshala.com/internships/<keyword-slug>-internship/ for the top 2 keywords
   (e.g. machine-learning-internship); ignore it if it fails or returns thin text.

STEP 3 - TRIAGE SEARCH RESULTS (Gemini)
Send all search results (title, snippet, url, date) + keywords. Pick the 8 most
promising URLs that look like a SPECIFIC opportunity page or a live listing page.
Reject listicles ("top 10", "best", "how to", "tips"), news recaps, winners/results
pages and anything clearly past its date. Return [{ url, reason }]. Log reasons.

STEP 4 - FETCH
Fetch listing pages + triaged URLs with TinyFish Fetch, batches of max 10.
Cache each fetched page in memory for 30 minutes (key = URL) to save API calls.
Per source, record status: ok (text length >= 500 chars), thin (< 500 chars), or failed.

STEP 5 - EXTRACT AND MATCH (Gemini, one call per page, run in parallel, max 4 at a time)
Send page text (first 20000 characters), the page URL, source name, today's date,
keywords, and profile. Instruction:
"Extract ONLY real, specific opportunities that are currently open or upcoming as of
today. Ignore ads, navigation, and expired items. If the page only shows past dates
or the program is between cycles, return an empty array. NEVER invent or guess
deadlines. Return a JSON array, max 10 items:
[{ title, organization, type (Internship|Hackathon|Competition|Scholarship|Fellowship|
   Open Source), mode (Online|In-person|Hybrid|Remote|Unknown), location,
   deadline_text, deadline_iso (YYYY-MM-DD or null), eligibility (one line),
   stipend_or_prize (or null), link (the specific opportunity URL if present in the
   page, otherwise the page URL), evidence (short quote from the page showing the
   deadline or open status), keyword_matches (which user keywords it matches),
   fit_score (1-10, based on keywords, skills, level, location), why_it_fits
   (one sentence written directly to the student) }]"

STEP 6 - VALIDATE AND RANK (in code, not AI)
- Drop items where deadline_iso is before today. Never show expired items as a
  fallback. If nothing is left, show a friendly empty state.
- Items with deadline_iso null are kept but labelled "Deadline not listed - check link".
- Dedupe by normalized title + organization (keep the one with more info).
- Sort by fit_score desc, then nearest deadline. Return max 30.

==================================================
UI DESIGN
==================================================
- Clean, modern, minimal. Light background, indigo accent, rounded cards, soft shadows,
  great on mobile. Support dark mode.
- Hero: "Opportunity Radar", tagline "Live opportunities from 20 trusted sources,
  matched to you". Two inputs (What are you looking for? / About you), category chips,
  3 example buttons that fill the form ("Paid AI/ML internship, 3rd year B.Tech",
  "Hackathons for beginners in web dev", "Scholarships for engineering students"),
  and a big "Find opportunities" button.
- Live progress tracker (from SSE) with steps that tick off:
  Understanding you -> Searching trusted sites -> Reading pages -> Matching -> Done.
  Under it: the extracted keyword chips, and pills for each page being read.
- Results grid of cards: type badge (color per type), title, organization, mode +
  location, deadline (red if within 7 days, "Deadline not listed" in grey if null),
  stipend/prize, eligibility, fit score circle (green 8-10, amber 5-7, grey <5),
  why_it_fits in italics, matched keyword chips, "via <source name>", and an
  "Apply / View" button opening the link in a new tab.
- Filters above results: type chips, "Closing soon" toggle, sort (Best match / Deadline).
- Collapsible "Sources" panel: all 20 sources with a status dot (green ok, amber thin,
  red failed, grey not used for this search) and the number of opportunities found.
- Friendly error messages, never raw errors:
  401 -> "Your API key looks wrong", 429 -> "Too many requests, wait a minute",
  402 -> "Daily free limit reached", network -> "Couldn't reach TinyFish".

==================================================
ALSO BUILD
==================================================
1. scripts/test-sources.ts, runnable with "npm run test:sources": fetches all 20
   source URLs with TinyFish Fetch and prints a table: name, status, characters
   returned, first 120 characters of text. This lets me check which sources work.
2. README.md with: what the app does, setup in 4 steps (install, add keys to
   .env.local, npm run test:sources, npm run dev), how to add/remove sources, and
   a note that jsHeavy sources may return thin text with Fetch and are candidates
   for the TinyFish Agent API in a future version.
3. Console logging at every step (queries generated, results found, URLs triaged,
   chars per page, items extracted, items dropped as expired) so problems are easy
   to debug.
