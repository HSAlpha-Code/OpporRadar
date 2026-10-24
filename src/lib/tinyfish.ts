// Concurrency limiter, in-memory cache, and TinyFish API client

export interface TinyFishSearchResult {
  position: number;
  title: string;
  snippet: string;
  url: string;
  site_name?: string;
  date?: string;
}

export interface TinyFishSearchResponse {
  query?: string;
  results: TinyFishSearchResult[];
  total_results?: number;
  page?: number;
}

export interface TinyFishFetchedPage {
  url: string;
  title?: string | null;
  text: string;
  status: "ok" | "thin" | "failed";
  error?: string;
}

interface CacheEntry {
  title?: string | null;
  text: string;
  cachedAt: number;
}

// 30 minute cache for fetched pages
const memoryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000;

// Track first search call logging
let hasLoggedFirstSearch = false;

// Simple concurrency limiter (max 4 parallel calls)
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

const concurrencyLimiter = new ConcurrencyLimiter(4);

// Helper for delay
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class TinyFishClient {
  private apiKey: string;
  private searchUrl = "https://api.search.tinyfish.ai";
  private fetchUrl = "https://api.fetch.tinyfish.ai";

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.TINYFISH_API_KEY || "";
    if (!this.apiKey) {
      console.warn("[TinyFishClient] No TINYFISH_API_KEY set");
    }
  }

  private getAuthHeader() {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }

  private mapStatusError(status: number): Error {
    if (status === 401) {
      return new Error("Your API key looks wrong");
    }
    if (status === 429) {
      return new Error("Too many requests, wait a minute");
    }
    if (status === 402) {
      return new Error("Daily free limit reached");
    }
    return new Error(`TinyFish API returned status ${status}`);
  }

  /**
   * Search TinyFish
   */
  async search(params: {
    query: string;
    location?: string;
    language?: string;
    after_date?: string;
    include_domains?: string[];
    exclude_domains?: string[];
  }): Promise<TinyFishSearchResponse> {
    return concurrencyLimiter.run(async () => {
      const url = new URL(this.searchUrl);
      url.searchParams.set("query", params.query);
      url.searchParams.set("location", params.location || "IN");
      url.searchParams.set("language", params.language || "en");

      if (params.after_date) {
        url.searchParams.set("after_date", params.after_date);
      }
      if (params.include_domains && params.include_domains.length > 0) {
        url.searchParams.set("include_domains", params.include_domains.join(","));
      }
      if (params.exclude_domains && params.exclude_domains.length > 0) {
        url.searchParams.set("exclude_domains", params.exclude_domains.join(","));
      }

      console.log(`[TinyFish Search] Query: "${params.query}" (include: ${params.include_domains?.length || 0} domains)`);

      const executeRequest = async (attempt: number): Promise<Response> => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
        try {
          const res = await fetch(url.toString(), {
            method: "GET",
            headers: this.getAuthHeader(),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);

          if (res.status === 429 && attempt === 0) {
            console.warn("[TinyFish Search] Received 429, retrying after 3 seconds...");
            await delay(3000);
            return executeRequest(1);
          }
          return res;
        } catch (err: any) {
          clearTimeout(timeoutId);
          if (err.name === "AbortError") {
            throw new Error("Couldn't reach TinyFish (Search timed out after 15s)");
          }
          throw new Error("Couldn't reach TinyFish");
        }
      };

      const response = await executeRequest(0);

      if (!response.ok) {
        throw this.mapStatusError(response.status);
      }

      const data = await response.json();

      if (!hasLoggedFirstSearch) {
        console.log("[TinyFish Search] RAW RESPONSE (First Call):", JSON.stringify(data, null, 2));
        hasLoggedFirstSearch = true;
      }

      return {
        query: data.query || params.query,
        results: Array.isArray(data.results) ? data.results : [],
        total_results: data.total_results || (data.results?.length ?? 0),
        page: data.page ?? 0,
      };
    });
  }

  /**
   * Fetch Pages with batching, concurrency limiter, and 30-min cache
   */
  async fetchPages(urls: string[]): Promise<Map<string, TinyFishFetchedPage>> {
    const resultsMap = new Map<string, TinyFishFetchedPage>();
    const urlsToFetch: string[] = [];
    const now = Date.now();

    // Check in-memory cache first
    for (const url of urls) {
      const cached = memoryCache.get(url);
      if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
        const status = cached.text.length >= 500 ? "ok" : "thin";
        resultsMap.set(url, {
          url,
          title: cached.title,
          text: cached.text,
          status,
        });
      } else {
        urlsToFetch.push(url);
      }
    }

    if (urlsToFetch.length === 0) {
      return resultsMap;
    }

    // Batch URLs into chunks of max 10
    const chunks: string[][] = [];
    for (let i = 0; i < urlsToFetch.length; i += 10) {
      chunks.push(urlsToFetch.slice(i, i + 10));
    }

    console.log(`[TinyFish Fetch] Fetching ${urlsToFetch.length} uncached URLs in ${chunks.length} batch(es)`);

    // Fetch batches using concurrency limiter
    await Promise.all(
      chunks.map((batch) =>
        concurrencyLimiter.run(async () => {
          const executeBatch = async (attempt: number): Promise<Response> => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 150000); // 150s timeout
            try {
              const res = await fetch(this.fetchUrl, {
                method: "POST",
                headers: this.getAuthHeader(),
                body: JSON.stringify({ urls: batch }),
                signal: controller.signal,
              });
              clearTimeout(timeoutId);

              if (res.status === 429 && attempt === 0) {
                console.warn("[TinyFish Fetch] Received 429, retrying after 3 seconds...");
                await delay(3000);
                return executeBatch(1);
              }
              return res;
            } catch (err: any) {
              clearTimeout(timeoutId);
              if (err.name === "AbortError") {
                throw new Error("Couldn't reach TinyFish (Fetch timed out after 150s)");
              }
              throw new Error("Couldn't reach TinyFish");
            }
          };

          try {
            const res = await executeBatch(0);
            if (!res.ok) {
              console.error(`[TinyFish Fetch] Batch failed with status ${res.status}`);
              for (const u of batch) {
                resultsMap.set(u, {
                  url: u,
                  text: "",
                  status: "failed",
                  error: `HTTP ${res.status}`,
                });
              }
              return;
            }

            const data = await res.json();
            const results = data.results || [];
            const errors = data.errors || [];

            // Process successes
            for (const item of results) {
              const itemUrl = item.url;
              const text = item.text || "";
              const title = item.title || null;
              const status: "ok" | "thin" = text.length >= 500 ? "ok" : "thin";

              // Cache page
              memoryCache.set(itemUrl, {
                title,
                text,
                cachedAt: Date.now(),
              });

              resultsMap.set(itemUrl, {
                url: itemUrl,
                title,
                text,
                status,
              });
            }

            // Process errors (skip them, never crash)
            for (const errItem of errors) {
              const errUrl = typeof errItem === "string" ? errItem : errItem.url;
              if (errUrl) {
                resultsMap.set(errUrl, {
                  url: errUrl,
                  text: "",
                  status: "failed",
                  error: typeof errItem === "object" ? errItem.error : "Failed to fetch",
                });
              }
            }

            // Any remaining URL in batch that didn't appear in results or errors
            for (const u of batch) {
              if (!resultsMap.has(u)) {
                resultsMap.set(u, {
                  url: u,
                  text: "",
                  status: "failed",
                  error: "No content returned",
                });
              }
            }
          } catch (err: any) {
            console.error("[TinyFish Fetch] Batch error:", err.message);
            for (const u of batch) {
              resultsMap.set(u, {
                url: u,
                text: "",
                status: "failed",
                error: err.message,
              });
            }
          }
        })
      )
    );

    return resultsMap;
  }
}

export const tinyfish = new TinyFishClient();
