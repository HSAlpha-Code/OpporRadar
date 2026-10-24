import { NextRequest } from "next/server";
import { TRUSTED_SOURCES, TrustedSource } from "@/config/sources";
import { tinyfish, TinyFishSearchResult } from "@/lib/tinyfish";
import {
  understandUserGoal,
  triageSearchResults,
  extractOpportunitiesFromPage,
  ExtractedOpportunity,
} from "@/lib/gemini";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minute max duration for full SSE pipeline

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch (err) {
    return new Response(
      JSON.stringify({ message: "Invalid JSON request body." }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { lookingFor, profile, category } = body || {};

  if (!lookingFor || !profile) {
    return new Response(
      JSON.stringify({
        message: "Please provide both what you are looking for and your student profile.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey || openRouterKey === "your_openrouter_api_key_here") {
    return new Response(
      JSON.stringify({
        message:
          "OPENROUTER_API_KEY is not configured in .env.local. Please add your OpenRouter API key to .env.local.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const tinyfishKey = process.env.TINYFISH_API_KEY;
  if (!tinyfishKey || tinyfishKey === "your_tinyfish_api_key_here") {
    return new Response(
      JSON.stringify({
        message:
          "TINYFISH_API_KEY is not configured in .env.local. Please add your TinyFish API key to .env.local.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();

  // Create SSE stream
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (event: string, data: any) => {
    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      await writer.write(encoder.encode(payload));
    } catch (e) {
      console.error("[SSE sendEvent error]", e);
    }
  };

  // Run the pipeline asynchronously and stream events
  (async () => {
    try {
      console.log("[Radar Pipeline] Starting new search pipeline...");
      console.log(`[Radar Pipeline] Looking for: "${lookingFor}"`);
      console.log(`[Radar Pipeline] Category: "${category || "All"}"`);

      // ----------------------------------------------------
      // STEP 1 - UNDERSTAND (Gemini)
      // ----------------------------------------------------
      await sendEvent("progress", {
        step: "understanding",
        message: "Understanding your student profile and target opportunities...",
      });

      const understanding = await understandUserGoal(lookingFor, profile, category);
      console.log("[Radar Pipeline] Step 1 Understanding Result:", understanding);

      await sendEvent("step_understanding_done", {
        understanding,
      });

      // Selected categories filter
      const selectedCategories =
        category && category !== "All"
          ? [category]
          : understanding.categories && understanding.categories.length > 0
          ? understanding.categories
          : ["Internships", "Hackathons", "Competitions", "Scholarships", "Fellowships", "Open Source"];

      // Filter trusted sources by selected categories
      const targetSources = TRUSTED_SOURCES.filter((s) =>
        selectedCategories.includes(s.category)
      );
      const targetDomains = Array.from(new Set(targetSources.map((s) => s.domain)));

      // ----------------------------------------------------
      // STEP 2 - GATHER (Search & Listing Pages in parallel)
      // ----------------------------------------------------
      await sendEvent("progress", {
        step: "searching",
        message: `Searching ${targetSources.length} trusted sources and live opportunities...`,
        queries: understanding.search_queries,
      });

      const today = new Date();
      const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split("T")[0];

      // A) Keyword searches on trusted sites
      const searchPromises = understanding.search_queries.map((q) =>
        tinyfish
          .search({
            query: q,
            location: "IN",
            language: "en",
            after_date: sixtyDaysAgo,
            include_domains: targetDomains,
          })
          .catch((err) => {
            console.warn(`[Radar Pipeline] Search query failed for "${q}":`, err.message);
            return { results: [] };
          })
      );

      // Extra open-web search with best query and excluded domains
      const openWebExclude = [
        "instagram.com",
        "facebook.com",
        "x.com",
        "twitter.com",
        "linkedin.com",
        "youtube.com",
        "reddit.com",
        "pinterest.com",
        "quora.com",
        "medium.com",
      ];

      const bestQuery = understanding.search_queries[0] || lookingFor;
      const openWebSearchPromise = tinyfish
        .search({
          query: bestQuery,
          location: "IN",
          language: "en",
          after_date: sixtyDaysAgo,
          exclude_domains: openWebExclude,
        })
        .catch((err) => {
          console.warn("[Radar Pipeline] Open web search failed:", err.message);
          return { results: [] };
        });

      // B) Source listing pages
      const listingUrls: { url: string; sourceName: string }[] = targetSources.map(
        (s) => ({ url: s.url, sourceName: s.name })
      );

      // Internshala keyword URLs
      if (selectedCategories.includes("Internships")) {
        const topKeywords = understanding.keywords.slice(0, 2);
        for (const kw of topKeywords) {
          const slug = kw
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          if (slug) {
            listingUrls.push({
              url: `https://internshala.com/internships/${slug}-internship/`,
              sourceName: "Internshala",
            });
          }
        }
      }

      // Wait for all searches to finish
      const allSearchResultsArrays = await Promise.all([
        ...searchPromises,
        openWebSearchPromise,
      ]);

      // Flatten & dedupe search results (max 3 per domain)
      const domainCountMap = new Map<string, number>();
      const seenSearchUrls = new Set<string>();
      const mergedSearchResults: TinyFishSearchResult[] = [];

      for (const res of allSearchResultsArrays) {
        for (const item of res.results || []) {
          if (!item.url || seenSearchUrls.has(item.url)) continue;
          seenSearchUrls.add(item.url);

          let domain = "";
          try {
            domain = new URL(item.url).hostname.replace(/^www\./, "");
          } catch {
            domain = "unknown";
          }

          const currentCount = domainCountMap.get(domain) || 0;
          if (currentCount < 3) {
            domainCountMap.set(domain, currentCount + 1);
            mergedSearchResults.push(item);
          }
        }
      }

      console.log(`[Radar Pipeline] Gathered ${mergedSearchResults.length} total search results across domains.`);

      // ----------------------------------------------------
      // STEP 3 - TRIAGE SEARCH RESULTS (Gemini)
      // ----------------------------------------------------
      await sendEvent("progress", {
        step: "triaging",
        message: `Triaging ${mergedSearchResults.length} candidate URLs for specific live listings...`,
      });

      const triagedResults = await triageSearchResults(
        mergedSearchResults,
        understanding.keywords
      );

      await sendEvent("step_triaged", {
        triagedCount: triagedResults.length,
        triaged: triagedResults,
      });

      // ----------------------------------------------------
      // STEP 4 - FETCH (Listing Pages + Triaged URLs)
      // ----------------------------------------------------
      // Consolidate URLs to read
      const pagesToFetchMap = new Map<string, string>(); // url -> sourceName

      for (const item of listingUrls) {
        pagesToFetchMap.set(item.url, item.sourceName);
      }

      for (const item of triagedResults) {
        let domain = "";
        try {
          domain = new URL(item.url).hostname.replace(/^www\./, "");
        } catch {
          domain = item.url;
        }
        const matchedSource = TRUSTED_SOURCES.find((s) => s.domain === domain);
        pagesToFetchMap.set(item.url, matchedSource ? matchedSource.name : domain);
      }

      const allUrlsToFetch = Array.from(pagesToFetchMap.keys());

      await sendEvent("progress", {
        step: "reading",
        message: `Reading and extracting text from ${allUrlsToFetch.length} opportunity portals...`,
        pages: allUrlsToFetch.map((u) => ({
          url: u,
          sourceName: pagesToFetchMap.get(u),
        })),
      });

      const fetchedPagesMap = await tinyfish.fetchPages(allUrlsToFetch);

      // Record per-source status (ok, thin, failed)
      const sourceStatusMap: Record<
        string,
        {
          name: string;
          status: "ok" | "thin" | "failed" | "not_used";
          chars: number;
          foundCount: number;
        }
      > = {};

      for (const source of TRUSTED_SOURCES) {
        const isSelected = targetSources.some((s) => s.name === source.name);
        if (!isSelected) {
          sourceStatusMap[source.name] = {
            name: source.name,
            status: "not_used",
            chars: 0,
            foundCount: 0,
          };
          continue;
        }

        const pageData = fetchedPagesMap.get(source.url);
        if (!pageData) {
          sourceStatusMap[source.name] = {
            name: source.name,
            status: "failed",
            chars: 0,
            foundCount: 0,
          };
        } else {
          sourceStatusMap[source.name] = {
            name: source.name,
            status: pageData.status,
            chars: pageData.text?.length || 0,
            foundCount: 0,
          };
        }
      }

      await sendEvent("step_reading_done", {
        sourcesStatus: sourceStatusMap,
      });

      // ----------------------------------------------------
      // STEP 5 - EXTRACT AND MATCH (Gemini in parallel, max 4)
      // ----------------------------------------------------
      await sendEvent("progress", {
        step: "matching",
        message: "Matching open opportunities against your skills and academic level...",
      });

      const extractionPromises: Promise<ExtractedOpportunity[]>[] = [];

      for (const [url, sourceName] of pagesToFetchMap.entries()) {
        const page = fetchedPagesMap.get(url);
        if (page && page.text && page.text.length >= 100) {
          extractionPromises.push(
            extractOpportunitiesFromPage({
              pageUrl: url,
              sourceName,
              pageText: page.text,
              keywords: understanding.keywords,
              profile,
            }).then((opps) => {
              console.log(`[Radar Pipeline] Extracted ${opps.length} opportunities from ${sourceName} (${url})`);
              return opps;
            })
          );
        }
      }

      const extractedBatches = await Promise.all(extractionPromises);
      const allExtracted: ExtractedOpportunity[] = extractedBatches.flat();
      console.log(`[Radar Pipeline] Total raw extracted opportunities: ${allExtracted.length}`);

      // ----------------------------------------------------
      // STEP 6 - VALIDATE AND RANK (in code, not AI)
      // ----------------------------------------------------
      const todayIso = today.toISOString().split("T")[0];
      const validOpportunities: ExtractedOpportunity[] = [];

      let droppedExpiredCount = 0;

      for (const opp of allExtracted) {
        // Drop items where deadline_iso is before today. Never show expired items as fallback
        if (opp.deadline_iso) {
          const deadlineClean = opp.deadline_iso.trim();
          if (deadlineClean < todayIso) {
            droppedExpiredCount++;
            continue;
          }
        } else {
          // If deadline_iso is null, keep it but label clearly
          if (!opp.deadline_text || opp.deadline_text.toLowerCase().includes("not listed")) {
            opp.deadline_text = "Deadline not listed - check link";
          }
        }
        validOpportunities.push(opp);
      }

      console.log(`[Radar Pipeline] Dropped ${droppedExpiredCount} expired items. ${validOpportunities.length} currently open.`);

      // Dedupe by normalized title + organization (keep the one with more info)
      const dedupedMap = new Map<string, ExtractedOpportunity>();

      for (const opp of validOpportunities) {
        const normKey = `${opp.title} ${opp.organization}`
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");

        const existing = dedupedMap.get(normKey);
        if (!existing) {
          dedupedMap.set(normKey, opp);
        } else {
          // Keep the one with higher fit score or more information
          const existingInfoLen = (existing.eligibility || "").length + (existing.stipend_or_prize || "").length;
          const newInfoLen = (opp.eligibility || "").length + (opp.stipend_or_prize || "").length;
          if (opp.fit_score > existing.fit_score || (opp.fit_score === existing.fit_score && newInfoLen > existingInfoLen)) {
            dedupedMap.set(normKey, opp);
          }
        }
      }

      const dedupedList = Array.from(dedupedMap.values());

      // Sort by fit_score desc, then nearest deadline
      dedupedList.sort((a, b) => {
        if (b.fit_score !== a.fit_score) {
          return b.fit_score - a.fit_score;
        }
        if (a.deadline_iso && b.deadline_iso) {
          return a.deadline_iso.localeCompare(b.deadline_iso);
        }
        if (a.deadline_iso && !b.deadline_iso) return -1;
        if (!a.deadline_iso && b.deadline_iso) return 1;
        return 0;
      });

      // Max 30
      const finalResults = dedupedList.slice(0, 30);

      // Update source opportunity counts
      for (const opp of finalResults) {
        // Try to match to trusted sources
        for (const [srcName, stat] of Object.entries(sourceStatusMap)) {
          if (
            opp.link.includes(srcName.toLowerCase().replace(/[^a-z0-9]/g, "")) ||
            (opp.organization && opp.organization.toLowerCase().includes(srcName.toLowerCase()))
          ) {
            stat.foundCount++;
          }
        }
      }

      console.log(`[Radar Pipeline] Final ranked opportunities ready: ${finalResults.length}`);

      // Emit complete results
      await sendEvent("done", {
        opportunities: finalResults,
        sourcesSummary: sourceStatusMap,
        totalFound: finalResults.length,
        droppedExpired: droppedExpiredCount,
      });

      await writer.close();
    } catch (err: any) {
      console.error("[Radar Pipeline Error]:", err);
      let friendlyMessage = err.message || "An unexpected error occurred.";
      if (friendlyMessage.includes("401") || friendlyMessage.includes("API key")) {
        friendlyMessage = "Your API key looks wrong. Please check your .env.local file.";
      } else if (friendlyMessage.includes("429")) {
        friendlyMessage = "Too many requests. Please wait a minute before trying again.";
      } else if (friendlyMessage.includes("402")) {
        friendlyMessage = "Daily free limit reached for live search.";
      } else if (friendlyMessage.includes("timeout") || friendlyMessage.includes("fetch")) {
        friendlyMessage = "Couldn't reach TinyFish live endpoints. Check your internet connection.";
      }

      await sendEvent("error", {
        message: friendlyMessage,
      });
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
