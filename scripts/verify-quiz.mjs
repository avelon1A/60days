// Checks quiz day files: schema, and for code questions, that the code really behaves as claimed.
//   type "output":       code must have fun main(); stdout must equal the correct option exactly.
//   "compiles": false:   code must fail to compile (the question is about a compile error).
//   "compiles": true:    code must compile.
// Usage: node scripts/verify-quiz.mjs [day ...]   (no args = every file in lib/quiz)
// Needs kotlinc and kotlin on PATH. kotlinx-coroutines is put on the classpath when found
// (QUIZ_CLASSPATH, or the newest kotlinx-coroutines-core-jvm jar in ~/.gradle).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const DIR = new URL("../lib/quiz/", import.meta.url).pathname;
const TYPES = new Set(["mcq", "output", "truefalse", "multi"]);
const DIFFS = new Set(["Easy", "Medium", "Hard"]);

const args = process.argv.slice(2).map(Number).filter(Boolean);
const files = fs.readdirSync(DIR).filter(f => /^day-\d\d\.json$/.test(f)).filter(f => !args.length || args.includes(Number(f.slice(4, 6)))).sort();
if (!files.length) { console.error("No quiz files matched."); process.exit(1); }

const SYL = JSON.parse(fs.readFileSync(new URL("../public/quiz-syllabus.json", import.meta.url), "utf8"));
const sylTopic = day => (SYL.days.find(d => d.day === day) || {}).topic;
function findCoroutines() {
  if (process.env.QUIZ_CLASSPATH) return process.env.QUIZ_CLASSPATH;
  const root = path.join(os.homedir(), ".gradle/caches/modules-2/files-2.1/org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm");
  try {
    const ver = fs.readdirSync(root).filter(v => /^\d+\.\d+(\.\d+)?$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).pop();
    for (const h of fs.readdirSync(path.join(root, ver))) {
      const jar = path.join(root, ver, h, `kotlinx-coroutines-core-jvm-${ver}.jar`);
      if (fs.existsSync(jar)) return jar;
    }
  } catch {}
  return "";
}
const LIBS = findCoroutines();
const errors = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);
const norm = s => String(s).replace(/\r/g, "").split("\n").map(l => l.trimEnd()).join("\n").trim();

const outputs = [], compileChecks = [];
for (const f of files) {
  const day = Number(f.slice(4, 6));
  let quiz;
  try { quiz = JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch (e) { err(f, "bad JSON: " + e.message); continue; }
  if (quiz.day !== day) err(f, `"day" should be ${day}`);
  if (!quiz.topic) err(f, "missing topic");
  else if (quiz.topic !== sylTopic(day)) err(f, `topic ${JSON.stringify(quiz.topic)} doesn't match public/quiz-syllabus.json (${JSON.stringify(sylTopic(day))})`);
  if (!Array.isArray(quiz.questions) || quiz.questions.length !== 20) err(f, `needs exactly 20 questions, has ${quiz.questions?.length}`);
  const ids = new Set(), texts = new Set();
  (quiz.questions || []).forEach((q, n) => {
    const want = `d${String(day).padStart(2, "0")}q${String(n + 1).padStart(2, "0")}`;
    const id = q.id || `${f}#${n + 1}`;
    if (q.id !== want) err(id, `id should be ${want}`);
    if (ids.has(q.id)) err(id, "duplicate id"); ids.add(q.id);
    if (texts.has(q.question + (q.code || ""))) err(id, "duplicate question"); texts.add(q.question + (q.code || ""));
    if (!TYPES.has(q.type)) err(id, `bad type ${q.type}`);
    if (!DIFFS.has(q.difficulty)) err(id, `bad difficulty ${q.difficulty}`);
    for (const k of ["topic", "question", "explanation"]) if (!q[k] || typeof q[k] !== "string") err(id, `missing ${k}`);
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) err(id, "needs 2-6 options");
    else {
      if (new Set(q.options.map(norm)).size !== q.options.length) err(id, "duplicate options");
      if (q.options.some(o => typeof o !== "string" || !o.trim())) err(id, "empty option");
    }
    if (!Array.isArray(q.answer) || !q.answer.length || q.answer.some(a => !Number.isInteger(a) || a < 0 || a >= (q.options || []).length)) err(id, "bad answer indices");
    if (q.type !== "multi" && q.answer?.length !== 1) err(id, "single-answer type needs exactly one answer");
    if (q.type === "multi" && q.answer?.length < 2) err(id, "multi should have 2+ correct answers (else use mcq)");
    if (q.type === "truefalse" && JSON.stringify(q.options) !== '["True","False"]') err(id, 'truefalse options must be ["True","False"]');
    if (q.type === "output") {
      if (!q.code || !/\bfun main\s*\(/.test(q.code)) err(id, "output question needs code with fun main()");
      else outputs.push(q);
    }
    if (q.compiles !== undefined) {
      if (!q.code) err(id, "compiles flag without code");
      else compileChecks.push(q);
    }
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "quizkt-"));
const pkg = q => "quiz." + q.id;
const cls = q => `${pkg(q)}.${q.id[0].toUpperCase()}${q.id.slice(1)}Kt`;
const write = (dir, q) => { fs.mkdirSync(dir, { recursive: true }); const p = path.join(dir, q.id + ".kt"); fs.writeFileSync(p, `package ${pkg(q)}\n\n${q.code}\n`); return p; };

async function compile(srcs, out) {
  try { await run("kotlinc", [...srcs, "-nowarn", ...(LIBS ? ["-cp", LIBS] : []), "-d", out], { maxBuffer: 1 << 24 }); return { ok: true }; }
  catch (e) { return { ok: false, msg: String(e.stderr || e.message) }; }
}

async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: n }, async () => { while (queue.length) await fn(queue.shift()); }));
}

if (outputs.length) {
  console.log(`Compiling ${outputs.length} output snippets…`);
  const srcs = outputs.map(q => write(path.join(tmp, "out"), q));
  const jar = path.join(tmp, "out.jar");
  let c = await compile(srcs, jar);
  let good = outputs;
  if (!c.ok) {
    // Find which snippets are broken, then build the rest.
    good = [];
    await pool(outputs, 4, async q => {
      const r = await compile([write(path.join(tmp, "one", q.id), q)], path.join(tmp, "one", q.id, "o.jar"));
      if (r.ok) good.push(q); else err(q.id, "output snippet does not compile:\n" + r.msg.split("\n").filter(l => /error:/.test(l)).slice(0, 3).join("\n"));
    });
    if (good.length) c = await compile(good.map(q => path.join(tmp, "out", q.id + ".kt")), jar);
  }
  const cp = [jar, LIBS].filter(Boolean).join(path.delimiter);
  const once = async q => {
    try { return norm((await run("kotlin", ["-cp", cp, cls(q)], { timeout: 20000 })).stdout); }
    catch (e) { return norm(String(e.stdout || "") + `\n<threw: ${String(e.stderr || "").split("\n")[0]}>`); }
  };
  await pool(good, 6, async q => {
    // Run three times: concurrent code must print the same thing every time.
    const runs = [await once(q), await once(q), await once(q)];
    const actual = runs[0];
    if (runs.some(r => r !== actual)) { err(q.id, "output is not deterministic across runs: " + JSON.stringify([...new Set(runs)])); return; }
    const claimed = norm(q.options[q.answer[0]]);
    if (actual !== claimed) err(q.id, `claimed output ${JSON.stringify(claimed)} but it prints ${JSON.stringify(actual)}`);
    const dup = q.options.filter((o, i) => i !== q.answer[0] && norm(o) === actual);
    if (dup.length) err(q.id, "a wrong option matches the real output");
  });
}

if (compileChecks.length) {
  console.log(`Checking ${compileChecks.length} compile claims…`);
  await pool(compileChecks, 4, async q => {
    const dir = path.join(tmp, "cc", q.id);
    const r = await compile([write(dir, q)], path.join(dir, "o.jar"));
    if (r.ok !== q.compiles) err(q.id, q.compiles ? "claimed to compile but fails:\n" + r.msg.split("\n").filter(l => /error:/.test(l)).slice(0, 3).join("\n") : "claimed NOT to compile, but it compiles");
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
if (errors.length) { console.error(`\n${errors.length} problem(s):\n` + errors.map(e => " ✗ " + e).join("\n")); process.exit(1); }
console.log(`✓ ${files.length} day file(s) OK (${outputs.length} outputs run, ${compileChecks.length} compile claims checked)`);
