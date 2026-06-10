import { chromium } from "playwright";

const URL = process.env.PREVIEW_URL || "http://localhost:5173/";
const renderMode = process.argv[2] || "3d";       // 3d | 2d
const focus = process.argv[3] || "";              // coach name to focus, or ""
const out = process.argv[4] || `/tmp/nfl-${renderMode}${focus ? "-focus" : ""}.png`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 840 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

await page.goto(URL, { waitUntil: "load" });
await page.getByRole("heading", { name: /NFL Coaching Tree/i }).waitFor({ timeout: 40000 });
await page.getByRole("button", { name: new RegExp(`^${renderMode.toUpperCase()}$`) }).click();
if (focus) await page.selectOption("select", { label: new RegExp(`^${focus}`) }).catch(() => console.log("WARN: focus not found"));
await page.waitForSelector("canvas", { timeout: 20000 }).catch(() => console.log("WARN: no canvas"));
await page.waitForTimeout(renderMode === "3d" ? 5500 : 4000);

await page.screenshot({ path: out, fullPage: true });
console.log("screenshot:", out, "| render:", renderMode, "| focus:", focus || "(none)");
console.log("errors:", errors.length ? errors.slice(0, 4) : "none");
await browser.close();
