import fs from "node:fs";
import crypto from "node:crypto";

const START = Date.UTC(2026, 9, 29, 0, 30);
const DAYMS = 864e5;
// The mobile quiz relaunched with new questions after day 10 had opened. Days that opened
// before the relaunch get a full day from it before an attempt counts as late.
const LAUNCH = Date.UTC(2026, 10, 7, 0, 30);
export const QUIZ_SIZE = 10;

export const quizOpensAt = (day) => START + (day - 1) * DAYMS;
export const lateAfter = (day) => Math.max(quizOpensAt(day), LAUNCH) + DAYMS;

const cache = new Map();
export function quizDay(day) {
  if (!cache.has(day)) {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(new URL(`./quiz/day-${String(day).padStart(2, "0")}.json`, import.meta.url), "utf8"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    cache.set(day, data);
  }
  return cache.get(day);
}

// Same user + question always gets the same option order, so a reload doesn't reshuffle
// and neighbours can't swap "it's B". True/false keeps its natural order.
function order(userId, q) {
  const idx = q.options.map((_, i) => i);
  if (q.type === "truefalse") return idx;
  const seed = crypto.createHash("sha256").update(`${userId}:${q.id}`).digest();
  for (let i = idx.length - 1; i > 0; i--) {
    const j = seed[i % seed.length] % (i + 1);
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx;
}

// Public view of a question for one user. Options come in that user's order. With `reveal`,
// `answer` and `picked` are indices into that same shuffled order.
export function viewQuestion(userId, q, reveal, pickedOriginal) {
  const ord = order(userId, q);
  const out = { id: q.id, type: q.type, topic: q.topic, difficulty: q.difficulty, question: q.question, code: q.code || null, options: ord.map(i => q.options[i]) };
  if (reveal) {
    const toShown = (orig) => ord.indexOf(orig);
    out.answer = q.answer.map(toShown).sort((a, b) => a - b);
    out.picked = (pickedOriginal || []).map(toShown).sort((a, b) => a - b);
    out.correct = sameSet(q.answer, pickedOriginal || []);
    out.explanation = q.explanation;
  }
  return out;
}

const sameSet = (a, b) => {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q), y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => v === y[i]);
};

// `answers` maps question id -> shown indices. Returns picks in original-option indices and the score.
export function grade(userId, quiz, answers) {
  const picks = {};
  let score = 0;
  for (const q of quiz.questions) {
    const ord = order(userId, q);
    const raw = Array.isArray(answers?.[q.id]) ? answers[q.id] : [];
    const shown = [...new Set(raw.filter(i => Number.isInteger(i) && i >= 0 && i < ord.length))];
    const orig = (q.type === "multi" ? shown : shown.slice(0, 1)).map(i => ord[i]).sort((a, b) => a - b);
    picks[q.id] = orig;
    if (sameSet(q.answer, orig)) score++;
  }
  return { picks, score };
}
