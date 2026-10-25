"use client";

import React, { useState, useEffect, useRef } from "react";
import {
  Search,
  Sparkles,
  ExternalLink,
  Calendar,
  MapPin,
  Award,
  BookOpen,
  Filter,
  CheckCircle2,
  Clock,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Moon,
  Sun,
  Loader2,
  Briefcase,
  Code,
  Trophy,
  GraduationCap,
  Users,
  Compass,
} from "lucide-react";

interface ExtractedOpportunity {
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

interface SourceStatus {
  name: string;
  status: "ok" | "thin" | "failed" | "not_used";
  chars: number;
  foundCount: number;
}

interface UnderstandResult {
  categories: string[];
  keywords: string[];
  skills: string[];
  level: string;
  location_preference: string;
  search_queries: string[];
}

const CATEGORIES = [
  "All",
  "Internships",
  "Hackathons",
  "Competitions",
  "Scholarships",
  "Fellowships",
  "Open Source",
] as const;

export default function Home() {
  // Theme state
  const [darkMode, setDarkMode] = useState(false);

  // Form inputs
  const [lookingFor, setLookingFor] = useState("");
  const [profile, setProfile] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("All");

  // Pipeline states
  const [loading, setLoading] = useState(false);
  const [currentStep, setCurrentStep] = useState<
    "idle" | "understanding" | "searching" | "reading" | "matching" | "done"
  >("idle");
  const [stepNumber, setStepNumber] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [extractedKeywords, setExtractedKeywords] = useState<string[]>([]);
  const [activeReadingPages, setActiveReadingPages] = useState<{ url: string; sourceName?: string }[]>([]);
  const [sourcesSummary, setSourcesSummary] = useState<Record<string, SourceStatus>>({});
  const [opportunities, setOpportunities] = useState<ExtractedOpportunity[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Filter states
  const [filterType, setFilterType] = useState<string>("All");
  const [closingSoonOnly, setClosingSoonOnly] = useState(false);
  const [sortBy, setSortBy] = useState<"match" | "deadline">("match");
  const [showSourcesPanel, setShowSourcesPanel] = useState(false);

  const resultsRef = useRef<HTMLDivElement>(null);

  // Initialize dark mode
  useEffect(() => {
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      setDarkMode(true);
      document.documentElement.classList.add("dark");
    }
  }, []);

  const toggleDarkMode = () => {
    setDarkMode((prev) => {
      const next = !prev;
      if (next) {
        document.documentElement.classList.add("dark");
      } else {
        document.documentElement.classList.remove("dark");
      }
      return next;
    });
  };

  // Example presets
  const applyPreset = (presetNumber: number) => {
    if (presetNumber === 1) {
      setLookingFor("Paid AI/ML internship, remote or Bengaluru");
      setProfile("3rd year B.Tech CSE student at Tier 2 college. Strong in Python, PyTorch, fastNLP, Docker. Built RAG chatbot and image segmentation model. Available for 6-month internship.");
      setSelectedCategory("Internships");
    } else if (presetNumber === 2) {
      setLookingFor("Hackathons for beginners in web dev and AI");
      setProfile("2nd year Computer Engineering student. Familiar with React, Next.js, Node.js, and REST APIs. Looking for team hackathons with good mentorship and prizes.");
      setSelectedCategory("Hackathons");
    } else if (presetNumber === 3) {
      setLookingFor("Scholarships and financial grants for engineering students");
      setProfile("1st year B.E. student, family annual income under 3 LPA. Merit scholarship recipient in 12th CBSE (96%). Studying electrical & electronics engineering.");
      setSelectedCategory("Scholarships");
    }
  };

  // Run Radar pipeline via decoupled trigger and polling
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!lookingFor.trim() || !profile.trim()) {
      alert("Please fill in both fields so we can accurately match live opportunities!");
      return;
    }

    setLoading(true);
    setErrorMessage(null);
    setOpportunities([]);
    setExtractedKeywords([]);
    setActiveReadingPages([]);
    setStepNumber(0);
    setCurrentStep("understanding");
    setStatusMessage("Triggering background discovery pipeline...");

    try {
      // 1. Trigger asynchronous job
      const triggerRes = await fetch("/api/radar/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lookingFor,
          profile,
          category: selectedCategory,
        }),
      });

      if (!triggerRes.ok) {
        const errorData = await triggerRes.json().catch(() => null);
        throw new Error(
          errorData?.error || errorData?.message || `Server returned status ${triggerRes.status}`
        );
      }

      const { jobId } = await triggerRes.json();
      console.log(`[Radar UI] Job triggered with ID: ${jobId}. Beginning status polling...`);

      // 2. Poll job status until COMPLETED or FAILED
      const pollIntervalMs = 1500;
      let isCompleted = false;
      let consecutiveErrors = 0;

      while (!isCompleted) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

        try {
          const statusRes = await fetch(
            `/api/radar/status?jobId=${encodeURIComponent(jobId)}`,
            { cache: "no-store" }
          );

          if (!statusRes.ok) {
            consecutiveErrors++;
            if (consecutiveErrors > 15) {
              throw new Error("Unable to fetch job progress from server.");
            }
            continue;
          }

          consecutiveErrors = 0;
          const job = await statusRes.json();

          if (job.stepNumber !== undefined) setStepNumber(job.stepNumber);
          if (job.progressMessage) setStatusMessage(job.progressMessage);
          if (job.extractedKeywords && job.extractedKeywords.length > 0) {
            setExtractedKeywords(job.extractedKeywords);
          }
          if (job.activeReadingPages && job.activeReadingPages.length > 0) {
            setActiveReadingPages(job.activeReadingPages);
          }
          if (job.sourcesSummary) {
            setSourcesSummary(job.sourcesSummary);
          }

          // Map pipeline state to UI stages
          switch (job.status) {
            case "PENDING":
            case "GENERATING_QUERIES":
              setCurrentStep("understanding");
              break;
            case "GATHERING_LINKS":
            case "TRIAGING":
              setCurrentStep("searching");
              break;
            case "FETCHING_CONTENT":
              setCurrentStep("reading");
              break;
            case "EXTRACTING_OPPORTUNITIES":
              setCurrentStep("matching");
              break;
            case "COMPLETED":
              setCurrentStep("done");
              setOpportunities(job.opportunities || []);
              setLoading(false);
              isCompleted = true;

              setTimeout(() => {
                resultsRef.current?.scrollIntoView({ behavior: "smooth" });
              }, 200);
              break;
            case "FAILED":
              setErrorMessage(job.error || job.progressMessage || "Pipeline execution failed.");
              setLoading(false);
              isCompleted = true;
              break;
          }
        } catch (pollErr: any) {
          console.warn("[Radar UI] Polling tick error:", pollErr.message);
          consecutiveErrors++;
          if (consecutiveErrors > 15) {
            throw pollErr;
          }
        }
      }
    } catch (err: any) {
      console.error("Pipeline submission error:", err);
      let friendly = err.message || "Something went wrong";
      if (friendly.includes("401")) friendly = "Your API key looks wrong. Please check .env.local";
      if (friendly.includes("429")) friendly = "Too many requests, wait a minute";
      if (friendly.includes("402")) friendly = "Daily free limit reached";
      if (friendly.includes("fetch") || friendly.includes("network")) friendly = "Couldn't reach TinyFish or server endpoints";
      setErrorMessage(friendly);
      setLoading(false);
    }
  };

  // Filter & Sort opportunities
  const filteredOpportunities = opportunities.filter((opp) => {
    if (filterType !== "All" && opp.type !== filterType) {
      return false;
    }
    if (closingSoonOnly) {
      if (!opp.deadline_iso) return false;
      const daysUntilDeadline =
        (new Date(opp.deadline_iso).getTime() - new Date().getTime()) /
        (1000 * 60 * 60 * 24);
      if (daysUntilDeadline > 7 || daysUntilDeadline < 0) return false;
    }
    return true;
  });

  const sortedOpportunities = [...filteredOpportunities].sort((a, b) => {
    if (sortBy === "match") {
      return b.fit_score - a.fit_score;
    } else {
      if (a.deadline_iso && b.deadline_iso) {
        return a.deadline_iso.localeCompare(b.deadline_iso);
      }
      if (a.deadline_iso && !b.deadline_iso) return -1;
      if (!a.deadline_iso && b.deadline_iso) return 1;
      return b.fit_score - a.fit_score;
    }
  });

  // Helper for category badge color
  const getTypeBadgeColor = (type: string) => {
    switch (type) {
      case "Internship":
        return "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800";
      case "Hackathon":
        return "bg-purple-50 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300 border-purple-200 dark:border-purple-800";
      case "Competition":
        return "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-800";
      case "Scholarship":
        return "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800";
      case "Fellowship":
        return "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300 border-rose-200 dark:border-rose-800";
      case "Open Source":
        return "bg-cyan-50 text-cyan-700 dark:bg-cyan-950/60 dark:text-cyan-300 border-cyan-200 dark:border-cyan-800";
      default:
        return "bg-slate-50 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-200 dark:border-slate-700";
    }
  };

  // Helper for fit score circle styling
  const getFitScoreBadge = (score: number) => {
    if (score >= 8) {
      return "border-emerald-500 text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40";
    } else if (score >= 5) {
      return "border-amber-500 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40";
    }
    return "border-slate-400 text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800";
  };

  // Helper for deadline urgency
  const isClosingSoon = (deadlineIso: string | null) => {
    if (!deadlineIso) return false;
    const diffDays =
      (new Date(deadlineIso).getTime() - new Date().getTime()) /
      (1000 * 60 * 60 * 24);
    return diffDays >= 0 && diffDays <= 7;
  };

  // Tracker steps definitions
  const stepsList = [
    { key: "understanding", label: "Understanding you" },
    { key: "searching", label: "Searching trusted sites" },
    { key: "reading", label: "Reading pages" },
    { key: "matching", label: "Matching" },
    { key: "done", label: "Done" },
  ];

  const getStepStatus = (stepKey: string) => {
    const order = ["understanding", "searching", "reading", "matching", "done"];
    const currentIndex = order.indexOf(currentStep);
    const stepIndex = order.indexOf(stepKey);

    if (currentStep === "done") return "completed";
    if (stepIndex < currentIndex) return "completed";
    if (stepIndex === currentIndex) return "active";
    return "pending";
  };

  return (
    <div className="min-h-screen bg-slate-50/50 dark:bg-[#090d16] text-slate-900 dark:text-slate-100 transition-colors">
      {/* Top Navbar */}
      <header className="border-b border-slate-200/80 dark:border-slate-800/80 bg-white/70 dark:bg-[#090d16]/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-white shadow-md shadow-indigo-500/20">
              <Compass className="w-5 h-5 animate-spin-slow" />
            </div>
            <div>
              <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-indigo-600 via-indigo-500 to-violet-600 dark:from-indigo-400 dark:to-violet-400 bg-clip-text text-transparent">
                Opportunity Radar
              </span>
              <span className="hidden sm:inline-block ml-2 px-2 py-0.5 text-[11px] font-semibold bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 rounded-full border border-indigo-200/60 dark:border-indigo-800/60">
                Live Web Intel
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={toggleDarkMode}
              className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition"
              aria-label="Toggle theme"
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-8 space-y-10">
        {/* Hero Section */}
        <div className="text-center space-y-3 pt-4">
          <h1 className="text-4xl sm:text-5xl font-extrabold tracking-tight text-slate-900 dark:text-white">
            Opportunity Radar
          </h1>
          <p className="text-base sm:text-lg text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
            Live opportunities from 20 trusted sources, matched to you.
          </p>
        </div>

        {/* Input Form Card */}
        <div className="bg-white dark:bg-slate-900/90 rounded-2xl border border-slate-200/90 dark:border-slate-800 shadow-xl shadow-slate-200/40 dark:shadow-none p-6 sm:p-8 space-y-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Field 1: What are you looking for? */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-800 dark:text-slate-200">
                What are you looking for?
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={lookingFor}
                  onChange={(e) => setLookingFor(e.target.value)}
                  placeholder="e.g. Paid ML internship, remote, or AI hackathons with prizes"
                  className="w-full px-4 py-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/60 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition text-sm sm:text-base"
                />
              </div>
            </div>

            {/* Field 2: About you */}
            <div className="space-y-2">
              <label className="block text-sm font-semibold text-slate-800 dark:text-slate-200">
                About you (Course, Year, Skills, Interests)
              </label>
              <textarea
                rows={3}
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                placeholder="e.g. 3rd year B.Tech CSE student from Pune. Skilled in Python, NLP, PyTorch, React. Interested in LLM agents, open-source, and competitive programming."
                className="w-full px-4 py-3 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/60 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition text-sm sm:text-base resize-none"
              />
            </div>

            {/* Category Chips */}
            <div className="space-y-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                Focus Category
              </label>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition ${
                      selectedCategory === cat
                        ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/30"
                        : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Example Presets */}
            <div className="space-y-2 pt-1 border-t border-slate-100 dark:border-slate-800">
              <span className="text-xs text-slate-500 dark:text-slate-400 flex items-center gap-1">
                <Sparkles className="w-3.5 h-3.5 text-indigo-500" /> Quick examples:
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => applyPreset(1)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                >
                  Paid AI/ML internship, 3rd year B.Tech
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset(2)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                >
                  Hackathons for beginners in web dev
                </button>
                <button
                  type="button"
                  onClick={() => applyPreset(3)}
                  className="px-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-indigo-400 hover:text-indigo-600 dark:hover:text-indigo-400 transition"
                >
                  Scholarships for engineering students
                </button>
              </div>
            </div>

            {/* Big Action Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3.5 px-6 rounded-xl bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-700 hover:to-violet-700 text-white font-semibold text-base shadow-lg shadow-indigo-600/25 transition disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Scanning Live Opportunities...
                </>
              ) : (
                <>
                  <Search className="w-5 h-5" />
                  Find Opportunities
                </>
              )}
            </button>
          </form>
        </div>

        {/* Friendly Error Box */}
        {errorMessage && (
          <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-sm">Notice</p>
              <p className="text-sm mt-0.5">{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Live Progress Tracker */}
        {loading && (
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-6 space-y-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-4">
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 animate-spin" />
                <span className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                  Radar Live Pipeline
                </span>
              </div>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {statusMessage}
              </span>
            </div>

            {/* Real-time Progress Bar */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-600 dark:text-slate-300">
                <span>Phase Progress ({stepNumber}/6 Steps)</span>
                <span>{Math.min(100, Math.round((stepNumber / 6) * 100))}%</span>
              </div>
              <div className="w-full h-2.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-indigo-500 to-violet-600 rounded-full transition-all duration-500 ease-out"
                  style={{ width: `${Math.max(5, Math.min(100, Math.round((stepNumber / 6) * 100)))}%` }}
                />
              </div>
            </div>

            {/* Stepper tracker */}
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              {stepsList.map((step, idx) => {
                const status = getStepStatus(step.key);
                return (
                  <div
                    key={step.key}
                    className={`p-3 rounded-xl border text-center transition flex flex-col items-center justify-center gap-1.5 ${
                      status === "completed"
                        ? "bg-emerald-50/70 border-emerald-200 text-emerald-700 dark:bg-emerald-950/30 dark:border-emerald-800 dark:text-emerald-300"
                        : status === "active"
                        ? "bg-indigo-50/70 border-indigo-300 text-indigo-700 dark:bg-indigo-950/40 dark:border-indigo-700 dark:text-indigo-300 ring-2 ring-indigo-500/20"
                        : "bg-slate-50 border-slate-200 text-slate-400 dark:bg-slate-800/40 dark:border-slate-700"
                    }`}
                  >
                    <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold">
                      {status === "completed" ? (
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                      ) : status === "active" ? (
                        <Loader2 className="w-4 h-4 animate-spin text-indigo-600 dark:text-indigo-400" />
                      ) : (
                        <span>{idx + 1}</span>
                      )}
                    </div>
                    <span className="text-xs font-medium">{step.label}</span>
                  </div>
                );
              })}
            </div>

            {/* Extracted Keywords Chips */}
            {extractedKeywords.length > 0 && (
              <div className="space-y-2 pt-2">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  AI Understood Keywords:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {extractedKeywords.map((kw, i) => (
                    <span
                      key={i}
                      className="px-2.5 py-1 rounded-md text-xs font-medium bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 border border-indigo-200/80 dark:border-indigo-800/80"
                    >
                      #{kw}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Page Reading Pills */}
            {activeReadingPages.length > 0 && (
              <div className="space-y-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                  Pages being fetched & read:
                </span>
                <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto pr-1">
                  {activeReadingPages.map((pg, i) => (
                    <span
                      key={i}
                      className="px-2 py-0.5 rounded text-[11px] bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 flex items-center gap-1.5"
                    >
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                      {pg.sourceName || new URL(pg.url).hostname.replace("www.", "")}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Collapsible Sources Panel */}
        <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
          <button
            type="button"
            onClick={() => setShowSourcesPanel((p) => !p)}
            className="w-full px-6 py-4 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-800/50 transition text-left"
          >
            <div className="flex items-center gap-3">
              <Compass className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
              <span className="font-semibold text-sm text-slate-800 dark:text-slate-200">
                Trusted Opportunity Sources (20 Portals)
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span>{showSourcesPanel ? "Hide details" : "View portal coverage"}</span>
              {showSourcesPanel ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </div>
          </button>

          {showSourcesPanel && (
            <div className="p-6 pt-0 border-t border-slate-100 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {Object.keys(sourcesSummary).length > 0
                ? Object.values(sourcesSummary).map((s, idx) => {
                    const dotColor =
                      s.status === "ok"
                        ? "bg-emerald-500"
                        : s.status === "thin"
                        ? "bg-amber-500"
                        : s.status === "failed"
                        ? "bg-red-500"
                        : "bg-slate-300 dark:bg-slate-600";

                    return (
                      <div
                        key={idx}
                        className="p-2.5 rounded-xl border border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-2 truncate">
                          <span className={`w-2.5 h-2.5 rounded-full ${dotColor} shrink-0`} />
                          <span className="font-medium truncate">{s.name}</span>
                        </div>
                        <span className="text-[11px] text-slate-500 shrink-0 ml-2">
                          {s.foundCount > 0 ? `${s.foundCount} found` : s.status}
                        </span>
                      </div>
                    );
                  })
                : [
                    "Internshala",
                    "AICTE Internship Portal",
                    "PM Internship Scheme",
                    "Devfolio",
                    "Hack2skill",
                    "HackCulture",
                    "MLH",
                    "lablab.ai",
                    "DoraHacks",
                    "Unstop",
                    "Kaggle",
                    "MyGov Innovate India",
                    "Buddy4Study",
                    "National Scholarship Portal",
                    "DAAD India",
                    "IASc Fellowship",
                    "Teach For India",
                    "Google Summer of Code",
                    "GirlScript SoC",
                    "Outreachy",
                  ].map((name, i) => (
                    <div
                      key={i}
                      className="p-2.5 rounded-xl border border-slate-100 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-800/30 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2 truncate">
                        <span className="w-2.5 h-2.5 rounded-full bg-slate-300 dark:bg-slate-600 shrink-0" />
                        <span className="font-medium truncate">{name}</span>
                      </div>
                      <span className="text-[11px] text-slate-400">Ready</span>
                    </div>
                  ))}
            </div>
          )}
        </div>

        {/* Results Section */}
        <div ref={resultsRef} className="space-y-6">
          {opportunities.length > 0 && (
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white dark:bg-slate-900 p-4 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm">
              {/* Type Filter Chips */}
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs font-semibold text-slate-500 mr-1 flex items-center gap-1">
                  <Filter className="w-3.5 h-3.5" /> Type:
                </span>
                {["All", "Internship", "Hackathon", "Competition", "Scholarship", "Fellowship", "Open Source"].map(
                  (t) => (
                    <button
                      key={t}
                      onClick={() => setFilterType(t)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium transition ${
                        filterType === t
                          ? "bg-indigo-600 text-white"
                          : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200"
                      }`}
                    >
                      {t}
                    </button>
                  )
                )}
              </div>

              {/* Toggles & Sort */}
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={closingSoonOnly}
                    onChange={(e) => setClosingSoonOnly(e.target.checked)}
                    className="w-4 h-4 rounded text-indigo-600 focus:ring-indigo-500 border-slate-300"
                  />
                  <span>Closing Soon (≤ 7 days)</span>
                </label>

                <div className="h-4 w-px bg-slate-200 dark:bg-slate-700" />

                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  className="px-2.5 py-1 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none"
                >
                  <option value="match">Sort: Best Match</option>
                  <option value="deadline">Sort: Nearest Deadline</option>
                </select>
              </div>
            </div>
          )}

          {/* Opportunities Cards Grid */}
          {sortedOpportunities.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {sortedOpportunities.map((opp, idx) => {
                const urgent = isClosingSoon(opp.deadline_iso);

                return (
                  <div
                    key={idx}
                    className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/90 dark:border-slate-800/90 p-5 shadow-sm hover:shadow-md transition flex flex-col justify-between space-y-4 group"
                  >
                    <div className="space-y-3">
                      {/* Top Bar: Type Badge & Fit Score Circle */}
                      <div className="flex items-start justify-between gap-3">
                        <span
                          className={`px-2.5 py-1 rounded-md text-xs font-bold border tracking-wide uppercase ${getTypeBadgeColor(
                            opp.type
                          )}`}
                        >
                          {opp.type}
                        </span>

                        <div className="flex items-center gap-1.5" title="Fit Score (1-10)">
                          <div
                            className={`w-9 h-9 rounded-full border-2 flex items-center justify-center text-xs font-extrabold ${getFitScoreBadge(
                              opp.fit_score
                            )}`}
                          >
                            {opp.fit_score}
                          </div>
                        </div>
                      </div>

                      {/* Title & Organization */}
                      <div>
                        <h3 className="text-lg font-bold text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition leading-snug">
                          {opp.title}
                        </h3>
                        <p className="text-sm font-semibold text-slate-600 dark:text-slate-400 mt-0.5">
                          {opp.organization}
                        </p>
                      </div>

                      {/* Mode, Location & Deadline */}
                      <div className="flex flex-wrap items-center gap-y-1.5 gap-x-4 text-xs text-slate-500 dark:text-slate-400">
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3.5 h-3.5 text-slate-400" />
                          {opp.mode} • {opp.location}
                        </span>

                        <span
                          className={`flex items-center gap-1 font-medium ${
                            urgent
                              ? "text-red-600 dark:text-red-400"
                              : !opp.deadline_iso
                              ? "text-slate-400 dark:text-slate-500"
                              : "text-slate-600 dark:text-slate-300"
                          }`}
                        >
                          <Calendar className="w-3.5 h-3.5" />
                          {opp.deadline_text}
                          {urgent && (
                            <span className="ml-1 px-1.5 py-0.2 text-[10px] bg-red-100 dark:bg-red-950 text-red-600 dark:text-red-400 rounded font-bold">
                              Closing Soon
                            </span>
                          )}
                        </span>
                      </div>

                      {/* Stipend / Prize & Eligibility */}
                      <div className="space-y-1.5 bg-slate-50 dark:bg-slate-800/40 p-3 rounded-xl border border-slate-100 dark:border-slate-800">
                        {opp.stipend_or_prize && (
                          <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
                            <Trophy className="w-3.5 h-3.5" />
                            {opp.stipend_or_prize}
                          </div>
                        )}
                        <div className="text-xs text-slate-600 dark:text-slate-300">
                          <span className="font-semibold text-slate-700 dark:text-slate-200">
                            Eligibility:{" "}
                          </span>
                          {opp.eligibility}
                        </div>
                      </div>

                      {/* Why it fits (in italics) */}
                      <p className="text-xs italic text-indigo-900/80 dark:text-indigo-300/80 bg-indigo-50/50 dark:bg-indigo-950/20 px-3 py-2 rounded-lg border border-indigo-100/60 dark:border-indigo-900/30">
                        &ldquo;{opp.why_it_fits}&rdquo;
                      </p>

                      {/* Keyword matches */}
                      {opp.keyword_matches && opp.keyword_matches.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {opp.keyword_matches.map((k, ki) => (
                            <span
                              key={ki}
                              className="px-2 py-0.5 rounded text-[10px] font-medium bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400"
                            >
                              {k}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Bottom Bar: Action link */}
                    <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                      <span className="text-[11px] text-slate-400 truncate max-w-[180px]">
                        via {new URL(opp.link).hostname.replace("www.", "")}
                      </span>

                      <a
                        href={opp.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 shadow-sm transition"
                      >
                        Apply / View
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : currentStep === "done" && opportunities.length === 0 ? (
            <div className="text-center py-16 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-8 space-y-3">
              <Compass className="w-10 h-10 text-slate-400 mx-auto" />
              <h3 className="text-lg font-bold text-slate-800 dark:text-slate-200">
                No active opportunities found matching this exact criteria
              </h3>
              <p className="text-sm text-slate-500 max-w-md mx-auto">
                All reviewed programs were either between cycles or past their registration deadlines.
                Try broadening your keywords or selecting "All" categories!
              </p>
            </div>
          ) : null}
        </div>
      </main>

      <footer className="mt-20 border-t border-slate-200 dark:border-slate-800 py-8 text-center text-xs text-slate-500">
        <p>Opportunity Radar • Powered by TinyFish Live Web Search & NVIDIA Nemotron 3.5 Lightning via OpenRouter</p>
      </footer>
    </div>
  );
}
