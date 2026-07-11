/**
 * routes.ts — API route handlers for the Testbook Paper Room server.
 */
import {
  fetchSeries,
  fetchSeriesTests,
  generatePdf,
  fetchQuestionsAnswers,
  cleanHtml,
  wrapLatex,
  type SeriesMeta,
  type SeriesTests,
} from "./testbook";

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function error(msg: string, status = 500): Response {
  return json({ error: msg }, status);
}

// ── Route matching ───────────────────────────────────────────────────────

const routes: {
  pattern: RegExp;
  methods: string[];
  handler: (match: RegExpMatchArray, req: Request) => Promise<Response>;
}[] = [
  // GET /api/series
  {
    pattern: /^\/api\/series$/,
    methods: ["GET"],
    handler: async () => {
      try {
        const series: SeriesMeta[] = await fetchSeries();
        return json(series);
      } catch (e: any) {
        return error(e.message || "Failed to fetch series");
      }
    },
  },

  // GET /api/series/:id/tests
  {
    pattern: /^\/api\/series\/(.+)\/tests$/,
    methods: ["GET"],
    handler: async (m) => {
      try {
        const data: SeriesTests = await fetchSeriesTests(m[1]);
        return json(data);
      } catch (e: any) {
        return error(e.message || "Failed to fetch tests");
      }
    },
  },

  // GET /api/tests/:id/questions?lang=en
  {
    pattern: /^\/api\/tests\/(.+)\/questions$/,
    methods: ["GET"],
    handler: async (m, req) => {
      try {
        const url = new URL(req.url);
        const lang = url.searchParams.get("lang") || "en";
        const { questions, answers } = await fetchQuestionsAnswers(m[1]);

        // Extract relevant language data
        const allQuestions: any[] = [];
        const data = questions.data;
        if (data?.sections) {
          for (const sec of data.sections) {
            allQuestions.push(...(sec.questions || []));
          }
        }

        const answersMap = answers.data || answers;

        const result = allQuestions.map((q: any, i: number) => {
          const qid = String(q._id || "");
          let langData = q[lang];
          if (!langData || !langData.value) langData = q["en"] || {};

          const ansInfo = answersMap[qid] || {};
          let solLang = ansInfo.sol?.[lang];
          if (!solLang || !solLang.value) solLang = ansInfo.sol?.["en"] || {};

          return {
            index: i + 1,
            id: qid,
            question: cleanHtml(langData.value),
            options: (langData.options || []).map((o: any) => ({
              prompt: o.prompt,
              value: wrapLatex(cleanHtml(o.value)),
            })),
            correctOption: ansInfo.correctOption || "",
            solution: cleanHtml(solLang.value),
          };
        });

        return json({ questions: result, total: result.length });
      } catch (e: any) {
        const msg = e.message || "";
        if (msg.includes("404") || msg.includes("Not Found")) {
          return error("This test paper could not be found. It may have been removed.", 404);
        }
        return error("Could not load questions. Please try again.");
      }
    },
  },

  // GET /api/tests/:id/download?lang=en&solution=true
  {
    pattern: /^\/api\/tests\/(.+)\/download$/,
    methods: ["GET"],
    handler: async (m, req) => {
      try {
        const url = new URL(req.url);
        const lang = url.searchParams.get("lang") || "en";
        const solution = url.searchParams.get("solution") === "true";

        const { pdf, filename } = await generatePdf(m[1], lang, solution);

        return new Response(pdf, {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
          },
        });
      } catch (e: any) {
        const msg = e.message || "";
        // Give a friendlier message for common failures
        if (msg.includes("404") || msg.includes("Not Found")) {
          return error("This test paper is not available. It may have been removed.", 404);
        }
        if (msg.includes("400") || msg.includes("Bad Request")) {
          return error("Could not fetch this test paper. The test ID may be invalid.", 400);
        }
        return error("Something went wrong generating the PDF. Please try again later.");
      }
    },
  },
];

// ── Public handler ───────────────────────────────────────────────────────

export async function handleApi(req: Request): Promise<Response | null> {
  const url = new URL(req.url);

  // CORS headers for all API responses
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  for (const route of routes) {
    const match = url.pathname.match(route.pattern);
    if (match && route.methods.includes(req.method)) {
      const res = await route.handler(match, req);
      // Merge CORS headers
      const headers = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) {
        if (!headers.has(k)) headers.set(k, v);
      }
      return new Response(res.body, { status: res.status, headers });
    }
  }

  return null; // Not an API route
}
