/**
 * test-chromium.ts — Quick check that Chromium can render HTML → PDF.
 *
 * Usage:  bun run test-chromium.ts
 */

// Load KaTeX locally — no CDN, no network latency.
const KATEX_CSS = await Bun.file(new URL("./vendor/katex.min.css", import.meta.url)).text();
const KATEX_JS = await Bun.file(new URL("./vendor/katex.min.js", import.meta.url)).text();
const KATEX_AUTORENDER_JS = await Bun.file(new URL("./vendor/auto-render.min.js", import.meta.url)).text();

const PATHS = [
  "/usr/bin/google-chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium",
  "/snap/bin/chromium", "/opt/google/chrome/chrome",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
];

async function find(): Promise<string> {
  for (const p of PATHS) if (await Bun.file(p).exists()) return p;
  for (const name of ["google-chrome", "chromium-browser", "chromium", "chrome"]) {
    const p = Bun.spawn(["which", name], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    if (out && (await Bun.file(out).exists())) return out;
  }
  return "";
}

const chrome = await find();
if (!chrome) {
  console.log("❌  No Chrome/Chromium found.");
  console.log("    Install:  sudo apt install chromium-browser");
  process.exit(1);
}
console.log(`✅  Found: ${chrome}`);

const tmp = process.env.TMPDIR || process.env.TEMP || "/tmp";
const htmlPath = `${tmp}/_test_chromium.html`;
const pdfPath = `${tmp}/_test_chromium.pdf`;

const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>${KATEX_CSS}</style>
<script>${KATEX_JS}</script>
<script>${KATEX_AUTORENDER_JS}</script>
<style>
body{font-family:'Segoe UI',sans-serif;max-width:600px;margin:40px auto;font-size:14px;}
h1{font-size:18px;}.ok{color:#2F6B4F;}.katex{font-size:1.1em;}
</style></head><body>
<h1>Chromium PDF Test</h1>
<p class="ok">If you can read this, Chrome launched correctly.</p>
<p>Math test: \\(\\dfrac{1}{N}\\) should render as a fraction.</p>
<p>Hindi test: नमस्ते दुनिया</p>
<p>More math: \\(1 - \\left(1 - \\dfrac{1}{N}\\right)^n\\)</p>
<script>
renderMathInElement(document.body,{delimiters:[
  {left:"\\\\(",right:"\\\\)",display:false},
  {left:"\\\\[",right:"\\\\]",display:true}
]});
</script>
</body></html>`;

await Bun.write(htmlPath, html);
console.log(`📄  HTML: ${htmlPath}`);

const start = Date.now();
const proc = Bun.spawn([
  chrome,
  "--headless=new", "--disable-gpu", "--no-sandbox",
  "--disable-dev-shm-usage",
  `--print-to-pdf=${pdfPath}`,
  "--no-pdf-header-footer",
  "--virtual-time-budget=10000",
  htmlPath,
], { stdout: "pipe", stderr: "pipe" });

const code = await proc.exited;
const stderr = await new Response(proc.stderr).text();

if (code !== 0) {
  console.log(`❌  Chrome exited with code ${code}`);
  if (stderr) console.log(stderr);
  process.exit(1);
}

// Wait for filesystem flush
await Bun.sleep(500);

const pdf = await Bun.file(pdfPath).bytes();

const header = new TextDecoder().decode(pdf.slice(0, 5));
if (pdf.length < 200 || !header.startsWith("%PDF")) {
  console.log(`❌  PDF is invalid (${pdf.length} bytes, header: ${header})`);
  process.exit(1);
}

console.log(`✅  PDF:  ${pdfPath}  (${pdf.length} bytes)`);

// Quick content check
const pdfText = new TextDecoder().decode(pdf);
const hasMath = pdfText.includes("dfrac"); // raw dfrac = bad

if (!hasMath) {
  console.log("✅  Math rendered — no raw LaTeX in PDF.");
} else if (hasMath) {
  console.log("⚠️  Raw LaTeX found in PDF — math may not be rendering.");
}

// Cleanup
await Bun.file(htmlPath).delete();
await Bun.file(pdfPath).delete();
console.log("🧹  Temp files cleaned up.");
const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\n✅  All checks passed — Chromium is ready!  (${elapsed}s)`);
