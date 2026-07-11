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

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", hellip: "…", dagger: "†",
  // math / symbols
  radic: "√", sigma: "σ", rArr: "⇒", rarr: "→", larr: "←",
  there4: "∴", times: "×", divide: "÷", minus: "−", plusmn: "±",
  ne: "≠", le: "≤", ge: "≥", equiv: "≡", prop: "∝", sim: "∼",
  infin: "∞", int: "∫", sum: "∑", prod: "∏", part: "∂", nabla: "∇",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε",
  theta: "θ", lambda: "λ", mu: "μ", pi: "π", rho: "ρ", phi: "φ",
  omega: "ω", Sigma: "Σ", Pi: "Π", Omega: "Ω", Phi: "Φ", Psi: "Ψ",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ",
  deg: "°", prime: "′", Prime: "″", euro: "€", pound: "£",
  copy: "©", reg: "®", trade: "™", frac12: "½", frac14: "¼", frac34: "¾",
  sup1: "¹", sup2: "²", sup3: "³", perp: "⊥", ang: "∠",
  empty: "∅", cap: "∩", cup: "∪", sub: "⊂", sube: "⊆", sup: "⊃", supe: "⊇",
  and: "∧", or: "∨", not: "¬", forall: "∀", exist: "∃",
  lceil: "⌈", rceil: "⌉", lfloor: "⌊", rfloor: "⌋",
};

// Build a lowercase alias map for case-insensitive lookup
const _ENTITY_LC: Record<string, string> = {};
for (const [k, v] of Object.entries(HTML_ENTITIES)) {
  _ENTITY_LC[k.toLowerCase()] = v;
}

function decodeEntities(text: string): string {
  // Loop until stable — decoding named entities (like &amp;) can
  // reveal new numeric entities (like &#39;) that need another pass.
  for (let pass = 0; pass < 5; pass++) {
    const prev = text;
    text = text.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d)));
    text = text.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    text = text.replace(/&([a-zA-Z0-9]+);/g, (m, name) => HTML_ENTITIES[name] || _ENTITY_LC[name.toLowerCase()] || m);
    if (text === prev) break;
  }
  return text;
}

/**
 * Wrap bare LaTeX commands in \\( … \\) so KaTeX can render them.
 * Only wraps if not already inside delimiters.
 */
export function wrapLatex(text: string): string {
  if (!text) return text;
  if (/\\[\(\[]/.test(text)) return text; // already has delimiters
  // If text contains LaTeX commands, wrap it
  if (/\\[a-zA-Z]+/.test(text)) {
    return `\\(${text}\\)`;
  }
  return text;
}

/**
 * Same as wrapLatex but with double backslashes for markdown.
 * Markdown's parser eats single backslash escapes, so \\( in markdown
 * renders as \( in HTML, which KaTeX then picks up.
 */
export function wrapLatexMd(text: string): string {
  if (!text) return text;
  if (/\\[\(\[]/.test(text)) return text;
  if (/\\[a-zA-Z]+/.test(text)) {
    return `\\\\(${text}\\\\)`;
  }
  return text;
}

export function cleanHtml(html: string | undefined | null): string {
  if (!html) return "";
  let text = html;
  // Decode entities FIRST — the API double-encodes (&lt;p&gt; → <p>)
  text = decodeEntities(text);
  // Convert block-level tags to newlines before stripping all tags
  text = text.replace(/<(p|div|br|li|tr|h[1-6]|ul|ol|table)[^>]*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
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

// ── Full HTML page builder (used by generatePdf) ─────────────────────────

function buildHtml(
  questionsData: any,
  answersData: any,
  lang: string,
  includeSolution: boolean,
  title: string
): string {
  // Extract questions
  let allQuestions: any[] = [];
  const data = questionsData.data;
  if (data?.sections) {
    for (const section of data.sections) {
      allQuestions.push(...(section.questions || []));
    }
  } else if (Array.isArray(data)) {
    allQuestions = data;
  }

  // Extract answers map
  let answersMap: Record<string, any> = {};
  if (answersData.data && typeof answersData.data === "object") {
    answersMap = answersData.data;
  } else {
    answersMap = answersData;
  }

  const langLabel = LANG_MAP[lang] || lang;
  const solLabel = includeSolution ? "With solutions" : "No solutions";

  const bodyParts: string[] = [];
  let idx = 0;
  for (const q of allQuestions) {
    idx++;
    const qid = String(q._id || "");
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

    bodyParts.push(`<div class="qblock">`);
    bodyParts.push(`<div class="qnum">Question ${idx}</div>`);
    bodyParts.push(`<div class="qtext">${wrapLatex(questionText)}</div>`);

    if (options.length) {
      bodyParts.push(`<div class="opts">`);
      for (const opt of options) {
        bodyParts.push(`<div class="opt">(${opt.prompt}) ${wrapLatex(cleanHtml(opt.value))}</div>`);
      }
      bodyParts.push(`</div>`);
    }

    bodyParts.push(`<div class="answer">Answer: (${correctOption}) ${wrapLatex(correctText)}</div>`);

    if (includeSolution && solutionText) {
      bodyParts.push(`<div class="solution">`);
      bodyParts.push(`<div class="sol-title">Solution</div>`);
      bodyParts.push(`<div class="sol-text">${solutionText}</div>`);
      bodyParts.push(`</div>`);
    }

    bodyParts.push(`</div>`);
  }

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
<style>
  body {
    font-family: 'IBM Plex Sans', 'Segoe UI', sans-serif;
    font-size: 13px; line-height: 1.6; color: #1C2B45;
    max-width: 720px; margin: 0 auto; padding: 40px 32px;
  }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .meta { color: #6B7280; font-size: 11px; margin-bottom: 24px; border-bottom: 1px solid #D6D2C4; padding-bottom: 14px; }
  .qblock { border-bottom: 1px solid #D6D2C4; padding: 18px 0; page-break-inside: avoid; }
  .qnum { font-size: 10px; color: #6B7280; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px; }
  .qtext { font-size: 14px; margin-bottom: 10px; }
  .opts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
  .opt { border: 1px solid #D6D2C4; padding: 6px 10px; font-size: 12px; }
  .answer { font-weight: 600; margin-top: 6px; }
  .solution { margin-top: 12px; border-top: 1px dashed #D6D2C4; padding-top: 12px; }
  .sol-title { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #2F6B4F; margin-bottom: 4px; }
  .sol-text { font-size: 12px; color: #3B4A63; }
  .katex { font-size: 1.05em; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="meta">${allQuestions.length} questions &middot; ${langLabel} &middot; ${solLabel}</div>
${bodyParts.join("\n")}
<script>
  renderMathInElement(document.body, {
    delimiters: [
      {left: "\\\\(", right: "\\\\)", display: false},
      {left: "\\\\[", right: "\\\\]", display: true}
    ]
  });
</script>
</body>
</html>`;
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

// ── Chrome path (Windows) ─────────────────────────────────────────────────

const CHROME_PATHS = [
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/snap/bin/chromium",
  "/opt/google/chrome/chrome",
  // Mac
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  // Windows
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

async function findChrome(): Promise<string> {
  for (const p of CHROME_PATHS) {
    if (await Bun.file(p).exists()) return p;
  }
  // Last resort: check $PATH for common names
  for (const name of ["google-chrome", "chromium-browser", "chromium", "chrome"]) {
    const proc = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const path = out.trim();
    if (path && (await Bun.file(path).exists())) return path;
  }
  throw new Error(
    "No Chrome/Chromium found. Install with: sudo apt install chromium-browser"
  );
}

// ── PDF generation (HTML → Chrome headless) ──────────────────────────────

export async function generatePdf(
  testId: string,
  lang: string,
  includeSolution: boolean
): Promise<{ pdf: Uint8Array; filename: string }> {
  const { questions, answers } = await fetchQuestionsAnswers(testId);
  const title: string = questions.data?.title || questions.title || `Test ${testId}`;

  // Generate full HTML page
  const html = buildHtml(questions, answers, lang, includeSolution, title);

  // Write HTML to temp file
  const filename = buildPdfFilename(title, lang, includeSolution);
  const stem = filename.replace(/\.pdf$/, "");
  const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || "/tmp";
  const htmlPath = `${tmpDir}/${stem}.html`;
  const pdfPath = `${tmpDir}/${filename}`;

  await Bun.write(htmlPath, html);

  try {
    const chrome = await findChrome();
    const proc = Bun.spawn([
      chrome,
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--print-to-pdf=${pdfPath}`,
      "--no-pdf-header-footer",
      "--virtual-time-budget=15000",
      htmlPath,
    ], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`Chrome PDF failed (exit ${exitCode}): ${stderr}`);
    }

    // Small wait for filesystem flush
    await Bun.sleep(500);

    const pdf = await Bun.file(pdfPath).bytes();
    if (pdf.length < 100) {
      throw new Error("PDF generation produced an empty or invalid file");
    }

    return { pdf, filename };
  } finally {
    try { await Bun.file(htmlPath).delete(); } catch {}
    try { await Bun.file(pdfPath).delete(); } catch {}
  }
}
