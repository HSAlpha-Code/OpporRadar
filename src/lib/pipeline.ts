import { TRUSTED_SOURCES } from "@/config/sources";
import { tinyfish, TinyFishSearchResult } from "@/lib/tinyfish";
import {
  understandUserGoal,
  triageSearchResults,
  extractOpportunitiesFromPage,
  ExtractedOpportunity,
} from "@/lib/openrouter";
import { jobStore, SourceStatus } from "@/lib/job-store";

export async function runOpportunityPipeline(
  jobId: string,
  lookingFor: string,
  profile: string,
  category?: string
): Promise<void> {
  console.log(`[Pipeline ${jobId}] Starting decoupled background execution...`);

  try {
    // ----------------------------------------------------
    // STEP 1 - GENERATING_QUERIES (Step 1/6: Understand)
    // ----------------------------------------------------
    await jobStore.updateJob(jobId, {
      status: "GENERATING_QUERIES",
      progressMessage: "Step 1/6: Analyzing student profile & generating queries with Nemotron...",
      stepNumber: 1,
    });

    const understanding = await understandUserGoal(lookingFor, profile, category);
    console.log(`[Pipeline ${jobId}] Step 1 Understanding complete:`, understanding.keywords);

    await jobStore.updateJob(jobId, {
      extractedKeywords: understanding.keywords || [],
      progressMessage: `Step 1/6: Generated 5 targeted queries for ${understanding.categories?.join(", ") || "selected fields"}`,
    });

    // Determine target sources and domains
    const selectedCategories =
      category && category !== "All"
        ? [category]
        : understanding.categories && understanding.categories.length > 0
        ? understanding.categories
        : ["Internships", "Hackathons", "Competitions", "Scholarships", "Fellowships", "Open Source"];

    const targetSources = TRUSTED_SOURCES.filter((s) => selectedCategories.includes(s.category));
    const targetDomains = Array.from(new Set(targetSources.map((s) => s.domain)));

    // ----------------------------------------------------
    // STEP 2 - GATHERING_LINKS (Step 2/6: Gather)
    // ----------------------------------------------------
    await jobStore.updateJob(jobId, {
      status: "GATHERING_LINKS",
      progressMessage: `Step 2/6: Searching ${targetSources.length} trusted sources with TinyFish Search...`,
      stepNumber: 2,
    });

    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Parallel searches on trusted sites
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
          console.warn(`[Pipeline ${jobId}] Search query failed for "${q}":`, err.message);
          return { results: [] };
        })
    );

    // Open-web search with excluded social domains
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
        console.warn(`[Pipeline ${jobId}] Open-web search failed:`, err.message);
        return { results: [] };
      });

    // Listing pages of target sources
    const listingUrls: { url: string; sourceName: string }[] = targetSources.map((s) => ({
      url: s.url,
      sourceName: s.name,
    }));

    // Internshala keyword URLs
    if (selectedCategories.includes("Internships")) {
      const topKeywords = (understanding.keywords || []).slice(0, 2);
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

    const allSearchResultsArrays = await Promise.all([...searchPromises, openWebSearchPromise]);

    // Flatten & dedupe (max 3 URLs per domain)
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

        const count = domainCountMap.get(domain) || 0;
        if (count < 3) {
          domainCountMap.set(domain, count + 1);
          mergedSearchResults.push(item);
        }
      }
    }

    console.log(`[Pipeline ${jobId}] Gathered ${mergedSearchResults.length} total search results.`);

    // ----------------------------------------------------
    // STEP 3 - TRIAGING (Step 3/6: Triage)
    // ----------------------------------------------------
    await jobStore.updateJob(jobId, {
      status: "TRIAGING",
      progressMessage: `Step 3/6: Triaging ${mergedSearchResults.length} candidate URLs for specific live listings...`,
      stepNumber: 3,
    });

    const triagedResults = await triageSearchResults(mergedSearchResults, understanding.keywords);

    console.log(`[Pipeline ${jobId}] Triaged to ${triagedResults.length} selected pages.`);

    // ----------------------------------------------------
    // STEP 4 - FETCHING_CONTENT (Step 4/6: Fetch)
    // ----------------------------------------------------
    const pagesToFetchMap = new Map<string, string>(); // url -> sourceName

    // Prioritize AI-triaged specific opportunity pages (highest signal)
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

    // Add top 2-3 primary category portal listing URLs
    for (const item of listingUrls.slice(0, 3)) {
      if (!pagesToFetchMap.has(item.url)) {
        pagesToFetchMap.set(item.url, item.sourceName);
      }
    }

    // Limit to max 10 URLs total for fast serverless execution
    const allUrlsToFetch = Array.from(pagesToFetchMap.keys()).slice(0, 10);
    const activeReadingPages = allUrlsToFetch.map((u) => ({
      url: u,
      sourceName: pagesToFetchMap.get(u),
    }));

    await jobStore.updateJob(jobId, {
      status: "FETCHING_CONTENT",
      progressMessage: `Step 4/6: Reading and extracting text from ${allUrlsToFetch.length} top opportunity portals...`,
      stepNumber: 4,
      activeReadingPages,
    });

    const fetchedPagesMap = await tinyfish.fetchPages(allUrlsToFetch);

    // Record per-source status (ok, thin, failed)
    const sourceStatusMap: Record<string, SourceStatus> = {};

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

    await jobStore.updateJob(jobId, {
      sourcesSummary: sourceStatusMap,
    });

    // ----------------------------------------------------
    // STEP 5 - EXTRACTING_OPPORTUNITIES (Step 5/6: Extract & Match)
    // ----------------------------------------------------
    await jobStore.updateJob(jobId, {
      status: "EXTRACTING_OPPORTUNITIES",
      progressMessage: "Step 5/6: Extracting verified opportunities & matching against your profile...",
      stepNumber: 5,
    });

    // Filter to top 8 highest quality pages with meaningful content (>= 200 chars)
    const eligiblePages: { url: string; sourceName: string; text: string }[] = [];
    for (const url of allUrlsToFetch) {
      const page = fetchedPagesMap.get(url);
      if (page && page.text && page.text.length >= 200) {
        eligiblePages.push({
          url,
          sourceName: pagesToFetchMap.get(url) || "Portal",
          text: page.text,
        });
      }
    }

    const pagesToExtract = eligiblePages.slice(0, 8);
    console.log(`[Pipeline ${jobId}] Extracting in parallel from ${pagesToExtract.length} high-potential pages...`);

    const extractionPromises = pagesToExtract.map((item) =>
      extractOpportunitiesFromPage({
        pageUrl: item.url,
        sourceName: item.sourceName,
        pageText: item.text,
        keywords: understanding.keywords,
        profile,
      }).then((opps) => {
        console.log(`[Pipeline ${jobId}] Extracted ${opps.length} opportunities from ${item.sourceName}`);
        return opps;
      })
    );

    const extractedBatches = await Promise.all(extractionPromises);
    const allExtracted: ExtractedOpportunity[] = extractedBatches.flat();
    console.log(`[Pipeline ${jobId}] Raw extracted opportunities: ${allExtracted.length}`);

    // ----------------------------------------------------
    // STEP 6 - VALIDATE, DEDUPE & RANK -> COMPLETED (Step 6/6)
    // ----------------------------------------------------
    const todayIso = new Date().toISOString().split("T")[0];
    const validOpportunities: ExtractedOpportunity[] = [];
    let droppedExpiredCount = 0;

    for (const opp of allExtracted) {
      if (opp.deadline_iso) {
        const deadlineClean = opp.deadline_iso.trim();
        if (deadlineClean < todayIso) {
          droppedExpiredCount++;
          continue;
        }
      } else {
        if (!opp.deadline_text || opp.deadline_text.toLowerCase().includes("not listed")) {
          opp.deadline_text = "Deadline not listed - check link";
        }
      }
      validOpportunities.push(opp);
    }

    // Dedupe by normalized title + organization
    const dedupedMap = new Map<string, ExtractedOpportunity>();

    for (const opp of validOpportunities) {
      const normKey = `${opp.title} ${opp.organization}`
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");

      const existing = dedupedMap.get(normKey);
      if (!existing) {
        dedupedMap.set(normKey, opp);
      } else {
        const existingInfoLen = (existing.eligibility || "").length + (existing.stipend_or_prize || "").length;
        const newInfoLen = (opp.eligibility || "").length + (opp.stipend_or_prize || "").length;
        if (
          opp.fit_score > existing.fit_score ||
          (opp.fit_score === existing.fit_score && newInfoLen > existingInfoLen)
        ) {
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

    const finalResults = dedupedList.slice(0, 30);

    // Update source opportunity counts
    for (const opp of finalResults) {
      for (const [srcName, stat] of Object.entries(sourceStatusMap)) {
        if (
          opp.link.includes(srcName.toLowerCase().replace(/[^a-z0-9]/g, "")) ||
          (opp.organization && opp.organization.toLowerCase().includes(srcName.toLowerCase()))
        ) {
          stat.foundCount++;
        }
      }
    }

    console.log(`[Pipeline ${jobId}] Finished. Final verified opportunities: ${finalResults.length}`);

    await jobStore.updateJob(jobId, {
      status: "COMPLETED",
      progressMessage: `Completed! Found ${finalResults.length} live matching opportunities (${droppedExpiredCount} expired dropped)`,
      stepNumber: 6,
      opportunities: finalResults,
      sourcesSummary: sourceStatusMap,
    });
  } catch (err: any) {
    console.error(`[Pipeline ${jobId} Error]:`, err);

    let friendlyMessage = err.message || "An unexpected error occurred.";
    if (friendlyMessage.includes("401") || friendlyMessage.includes("API key")) {
      friendlyMessage = "Your API key looks wrong. Please check your .env.local file.";
    } else if (friendlyMessage.includes("429")) {
      friendlyMessage = "Too many requests. Please wait a minute before trying again.";
    } else if (friendlyMessage.includes("402")) {
      friendlyMessage = "Daily free limit reached for live search.";
    } else if (friendlyMessage.includes("timeout") || friendlyMessage.includes("fetch")) {
      friendlyMessage = "Couldn't reach live endpoints. Check your internet connection.";
    }

    await jobStore.updateJob(jobId, {
      status: "FAILED",
      progressMessage: friendlyMessage,
      error: friendlyMessage,
    });
  }
}
