/**
 * testbook.ts — Testbook API client, markdown generation, and PDF conversion.
 *
 * All Testbook API calls go through here so the BEARER_TOKEN stays server-side.
 */

const BASE_SERIES = "https://api.testbook.com/api/v2/test-series/me";
const BASE_TESTS = "https://api.testbook.com/api/v2/test-series";
const BASE_QUESTIONS = "https://api-new.testbook.com/api/v2/tests";
const USER_AGENT = "Mozilla/5.0";

const SERIES_PROJECTION = JSON.stringify({
  testSeries: {
    id: 1, name: 1,
    sections: { id: 1, name: 1, shortName: 1, paidTestCount: 1, freeTestCount: 1, superSectionId: 1 },
    superSections: { id: 1, name: 1 },
    paidTestCount: 1, freeTestCount: 1, languages: 1, isFree: 1,
  },
});

const TESTS_PROJECTION = JSON.stringify({
  tests: {
    id: 1, title: 1, languages: 1, questionCount: 1,
    duration: 1, isFree: 1, isSolutionPresent: 1,
  },
});

const LANG_MAP: Record<string, string> = {
  en: "English", hn: "Hindi", te: "Telugu", mr: "Marathi",
  bn: "Bengali", ml: "Malayalam", gu: "Gujarati", kn: "Kannada",
  ta: "Tamil", or: "Odia", pa: "Punjabi",
};

const LANG_NAME_TO_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(LANG_MAP).map(([k, v]) => [v.toLowerCase(), k])
);

// ── helpers ──────────────────────────────────────────────────────────────

function bearerToken(): string {
  const token = process.env.BEARER_TOKEN || Bun.env.BEARER_TOKEN;
  if (!token) throw new Error("BEARER_TOKEN not set in .env");
  return token;
}

async function apiGet(url: string, auth: boolean = true): Promise<any> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (auth) headers["Authorization"] = `Bearer ${bearerToken()}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const shortUrl = url.replace(/(auth_code=)[^&]+/, "$1***");
    throw new Error(`API ${res.status}: ${res.statusText} for ${shortUrl}`);
  }
  return res.json();
}

function sanitizeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "-").trim();
}

// ── HTML cleaning (replicates md_gen.py clean_html) ──────────────────────

export function cleanHtml(html: string | undefined | null): string {
  if (!html) return "";
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── API: fetch test series list ──────────────────────────────────────────

export interface SeriesMeta {
  id: string;
  name: string;
  totalTests: number;
  sections: { id: string; name: string; testCount: number }[];
}

export async function fetchSeries(): Promise<SeriesMeta[]> {
  const url = `${BASE_SERIES}?__projection=${encodeURIComponent(SERIES_PROJECTION)}&language=English`;
  const data = await apiGet(url);
  if (!data.success) throw new Error(`Series API failed: ${data.message}`);
  const list: any[] = data.data?.testSeries || [];
  return list.map((s: any) => ({
    id: s.id,
    name: s.name || "Unnamed Series",
    totalTests: (s.paidTestCount || 0) + (s.freeTestCount || 0),
    sections: (s.sections || []).map((sec: any) => ({
      id: sec.id,
      name: sec.name || sec.shortName || "Untitled",
      testCount: (sec.paidTestCount || 0) + (sec.freeTestCount || 0),
    })),
  }));
}

// ── API: fetch tests within a series ─────────────────────────────────────

export interface TestEntry {
  id: string;
  title: string;
  questionCount: number;
  duration: number;
  isFree: boolean;
  languages: string[];
  sectionName: string;
}

export interface SeriesTests {
  seriesId: string;
  seriesName: string;
  sections: { name: string; tests: TestEntry[] }[];
}

function resolveLangCodes(languages: string[]): string[] {
  const codes: string[] = [];
  for (const lang of languages) {
    const lower = lang.toLowerCase().trim();
    if (LANG_MAP[lower]) { codes.push(lower); }
    else if (LANG_NAME_TO_CODE[lower]) { codes.push(LANG_NAME_TO_CODE[lower]); }
    else if (lower.length === 2) { codes.push(lower); }
    else { codes.push(lower.slice(0, 2)); }
  }
  return codes.length ? codes : ["en"];
}

/**
 * Strip known suffixes from a single test title to get the subject name.
 * e.g. "UP GK Subject Test 1" → "UP GK"
 */
function inferSingleSubject(title: string): string {
  return title
    .replace(/\s*(Subject Test|Full Test|Previous Year Paper|Mock Test)\s*\d*$/i, "")
    .replace(/\s*\d+$/, "")
    .trim();
}

/**
 * Extract a friendly section name from test titles when the API section
 * name is too generic (e.g. "Subject Test").
 *
 * Heuristic: strip the trailing " Subject Test N" / " Full Test N" /
 * " Previous Year Paper N" suffix from titles and return the most
 * common prefix.
 */
function inferSectionName(tests: any[], fallback: string): string {
  if (!tests.length) return fallback;

  // Try to strip known suffixes
  const stripped = tests.map(t => {
    let title: string = t.title || "";
    // Remove "Subject Test N", "Full Test N", "Previous Year Paper N" etc.
    title = title.replace(/\s*(Subject Test|Full Test|Previous Year Paper)\s*\d*$/i, "").trim();
    return title;
  }).filter(Boolean);

  if (!stripped.length) return fallback;

  // Find the most common prefix among stripped titles
  // If they all share the same prefix, use it; otherwise use the first one
  const first = stripped[0];
  const allSame = stripped.every(s => s === first);
  if (allSame) return first;

  // Try to find a common prefix among all stripped titles
  let commonPrefix = first;
  for (let i = 1; i < stripped.length; i++) {
    while (!stripped[i].startsWith(commonPrefix) && commonPrefix.length > 0) {
      commonPrefix = commonPrefix.slice(0, -1).trim();
    }
  }
  // If subjects are too diverse (short or empty common prefix), keep the
  // original section name so users can still browse by subject pill.
  return commonPrefix.length > 3 ? commonPrefix : fallback;
}

export async function fetchSeriesTests(seriesId: string): Promise<SeriesTests> {
  // First get the series metadata to know the sections
  const metaUrl = `${BASE_SERIES}?__projection=${encodeURIComponent(SERIES_PROJECTION)}&language=English`;
  const metaData = await apiGet(metaUrl);
  const seriesList: any[] = metaData.data?.testSeries || [];
  const series = seriesList.find((s: any) => s.id === seriesId);
  const seriesName = series?.name || "Test Series";
  const sections: any[] = series?.sections || [];

  // Fetch tests for each section
  const result: { name: string; tests: TestEntry[] }[] = [];
  const seen = new Set<string>();

  for (const sec of sections) {
    const secName = sec.name || sec.shortName || "Untitled";
    const secId = sec.id;
    if (!secId) continue;

    const params = new URLSearchParams({
      __projection: TESTS_PROJECTION,
      testType: "all",
      sectionId: secId,
      subSectionId: "",
      skip: "0",
      limit: "200",
      branchId: "",
      language: "English",
    });

    try {
      const testsUrl = `${BASE_TESTS}/${seriesId}/tests/details?${params.toString()}`;
      const data = await apiGet(testsUrl);
      const tests: any[] = data.data?.tests || [];
      const sectionTests: TestEntry[] = [];

      for (const t of tests) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        sectionTests.push({
          id: t.id,
          title: t.title || "Untitled",
          questionCount: t.questionCount || 0,
          duration: t.duration || 0,
          isFree: !!t.isFree,
          languages: resolveLangCodes(t.languages || []),
          sectionName: secName,
        });
      }

      if (sectionTests.length) {
        // For "Subject Test" sections, split into per-subject groups so the
        // frontend pills show real subject names (UP GK, Statistics, etc.)
        if (/subject/i.test(secName) && !/full/i.test(secName)) {
          const bySubject = new Map<string, TestEntry[]>();
          for (const t of sectionTests) {
            const subj = inferSingleSubject(t.title) || secName;
            if (!bySubject.has(subj)) bySubject.set(subj, []);
            bySubject.get(subj)!.push(t);
          }
          for (const [subj, tests] of bySubject) {
            result.push({ name: subj, tests });
          }
        } else {
          result.push({ name: secName, tests: sectionTests });
        }
      }
    } catch {
      // Skip sections that fail to load
    }
  }

  return { seriesId, seriesName, sections: result };
}

// ── API: submit test attempt (required before questions can be fetched) ───

async function submitTestAttempt(testId: string): Promise<void> {
  const token = bearerToken();
  const params = new URLSearchParams({
    auth_code: token,
    "X-Tb-Client": "web,1.3",
    language: "English",
    attemptNo: "1",
  });

  const body = JSON.stringify({
    task: "submit",
    responses: {},
    currentQuestion: "s~1~q~1",
    SSNo: 1,
    SSSNo: -1,
  });

  try {
    const res = await fetch(`${BASE_QUESTIONS}/${testId}?${params.toString()}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": USER_AGENT,
      },
      body,
    });
    // Submit may return success:false for already-submitted tests — that's fine
    const data = await res.json();
    if (!res.ok && !data.success) {
      console.log(`  Submit note: ${data.message || res.statusText}`);
    }
  } catch (e: any) {
    // Non-fatal — proceed to fetch questions anyway
    console.log(`  Submit warning: ${e.message}`);
  }
}

// ── API: fetch questions & answers ───────────────────────────────────────

export async function fetchQuestionsAnswers(testId: string) {
  const token = bearerToken();
  const params = new URLSearchParams({
    "X-Tb-Client": "web,1.2",
    language: "English",
    attemptNo: "1",
    auth_code: token,
  });

  // Submit the test attempt first so the API allows fetching questions.
  // (Tests that haven't been started return empty/error responses.)
  await submitTestAttempt(testId);

  const [qData, aData] = await Promise.all([
    apiGet(`${BASE_QUESTIONS}/${testId}?${params.toString()}`, false),
    apiGet(`${BASE_QUESTIONS}/${testId}/answers?${params.toString()}`, false),
  ]);

  if (!qData.success) throw new Error(`Questions API failed: ${qData.message}`);
  if (!aData.success) throw new Error(`Answers API failed: ${aData.message}`);

  return { questions: qData, answers: aData };
}

// ── Markdown generation (replicates md_gen.py build_markdown) ────────────

function getAnswerLabel(options: any[], correctOption: string): string {
  for (const opt of options) {
    if (String(opt.prompt) === String(correctOption)) {
      return cleanHtml(opt.value);
    }
  }
  return `Option ${correctOption}`;
}

export function buildMarkdown(
  questionsData: any,
  answersData: any,
  lang: string,
  includeSolution: boolean,
  title: string
): string {
  const lines: string[] = [];
  lines.push(`# ${title}\n`);

  // Extract questions
  let allQuestions: any[] = [];
  const data = questionsData.data;
  if (data && typeof data === "object") {
    if (data.sections) {
      for (const section of data.sections) {
        allQuestions.push(...(section.questions || []));
      }
    } else if (Array.isArray(data)) {
      allQuestions = data;
    }
  }

  // Extract answers map
  let answersMap: Record<string, any> = {};
  if (answersData.data && typeof answersData.data === "object") {
    answersMap = answersData.data;
  } else {
    answersMap = answersData;
  }

  if (allQuestions.length) {
    let idx = 0;
    for (const q of allQuestions) {
      idx++;
      const qid = String(q._id || "");
      // Try requested language first, fall back to English
      let langData = q[lang];
      if (!langData || !langData.value) langData = q["en"] || {};
      const questionText = cleanHtml(langData.value);
      const options: any[] = langData.options || [];

      const ansInfo = answersMap[qid] || {};
      const correctOption = String(ansInfo.correctOption || "");
      const correctText = getAnswerLabel(options, correctOption);

      let solLang = ansInfo.sol?.[lang];
      if (!solLang || !solLang.value) solLang = ansInfo.sol?.["en"] || {};
      const solutionText = cleanHtml(solLang.value);

      lines.push(`## Q${idx}.`);
      lines.push(`\n${questionText}\n`);

      if (options.length) {
        lines.push("**Options:**\n");
        for (const opt of options) {
          lines.push(`- (${opt.prompt}) ${cleanHtml(opt.value)}`);
        }
        lines.push("");
      }

      lines.push(`**Answer:** (${correctOption}) ${correctText}\n`);

      if (includeSolution && solutionText) {
        lines.push(`**Solution:**\n\n${solutionText}\n`);
      }

      lines.push("---\n");
    }
  }

  return lines.join("\n");
}

// ── PDF filename builder ─────────────────────────────────────────────────

export function buildPdfFilename(title: string, lang: string, solution: boolean): string {
  const safe = sanitizeFilename(title);
  const parts: string[] = [safe];
  if (lang !== "en") {
    parts.push(` - ${LANG_MAP[lang] || lang}`);
  }
  if (solution) {
    parts.push(" (With Solutions)");
  }
  return parts.join("") + ".pdf";
}

// ── PDF generation (markdown → md-to-pdf) ────────────────────────────────

export async function generatePdf(
  testId: string,
  lang: string,
  includeSolution: boolean
): Promise<{ pdf: Uint8Array; filename: string }> {
  // 1. Fetch data from Testbook API
  const { questions, answers } = await fetchQuestionsAnswers(testId);

  // 2. Extract title
  const title: string =
    questions.data?.title || questions.title || `Test ${testId}`;

  // 3. Generate markdown
  const mdText = buildMarkdown(questions, answers, lang, includeSolution, title);

  // 4. Write to temp file
  const filename = buildPdfFilename(title, lang, includeSolution);
  const stem = filename.replace(/\.pdf$/, "");
  const tmpDir = process.env.TEMP || process.env.TMPDIR || "/tmp";
  const mdPath = `${tmpDir}/${stem}.md`;
  const pdfPath = `${tmpDir}/${filename}`;

  await Bun.write(mdPath, mdText);

  try {
    // 5. Convert to PDF using md-to-pdf
    const proc = Bun.spawn(["md-to-pdf", mdPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`md-to-pdf failed (exit ${exitCode}): ${stderr}`);
    }

    // 6. Read the generated PDF
    const pdf = await Bun.file(pdfPath).bytes();

    // 7. Clean up temp files
    try { await Bun.file(mdPath).delete(); } catch {}
    try { await Bun.file(pdfPath).delete(); } catch {}

    return { pdf, filename };
  } catch (err) {
    // Clean up on error
    try { await Bun.file(mdPath).delete(); } catch {}
    try { await Bun.file(pdfPath).delete(); } catch {}
    throw err;
  }
}
