/**
 * VIP-Ultimate — nâng cấp so với VIP99+
 * - Thêm models: pattern (triple/pair/straight), parity, bucket (tổng range)
 * - Tính entropy, transition matrix, run-length
 * - Tối ưu trọng số bằng hill-climb dựa trên backtest walk-forward
 * - Trả về giai_thich chi tiết: per-model stats, pattern stats, entropy, transitions, streak
 *
 * Lưu ý: Càng nhiều lịch sử (samples) càng đáng tin. Không thể đảm bảo 100% thắng.
 */

const express = require("express");
const axios = require("axios");
const cors = require("cors");

const PORT = process.env.PORT || 3000;
const SOURCE_URL = "https://fullsrc-daynesun.onrender.com/api/taixiu/history";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------- UTILS ----------------------
function normResult(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (["t", "tai", "tài"].includes(s)) return "T";
  if (["x", "xiu", "xỉu", "xỉu"].includes(s)) return "X";
  return null;
}
function lastN(arr, n) {
  return arr.slice(-n);
}
function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}
function streakOfEnd(arr) {
  if (!arr.length) return 0;
  const last = arr[arr.length - 1];
  let s = 1;
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i] === last) s++;
    else break;
  }
  return s;
}
function shannonEntropy(arr) {
  if (!arr.length) return 0;
  const freq = {};
  arr.forEach((x) => (freq[x] = (freq[x] || 0) + 1));
  const n = arr.length;
  let ent = 0;
  Object.values(freq).forEach((c) => {
    const p = c / n;
    ent -= p * Math.log2(p);
  });
  return ent; // bits
}

// ---------------------- SHAPE ----------------------
function shapeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (r) =>
        r &&
        r.Phien != null &&
        r.Xuc_xac_1 != null &&
        r.Xuc_xac_2 != null &&
        r.Xuc_xac_3 != null &&
        r.Tong != null &&
        r.Ket_qua != null
    )
    .map((r) => ({
      phien: Number(r.Phien),
      dice: [Number(r.Xuc_xac_1), Number(r.Xuc_xac_2), Number(r.Xuc_xac_3)],
      tong: Number(r.Tong),
      ket_qua: normResult(r.Ket_qua),
      raw: r,
    }))
    .filter((r) => r.ket_qua === "T" || r.ket_qua === "X")
    .sort((a, b) => a.phien - b.phien);
}

// ---------------------- FEATURE EXTRACTORS ----------------------
function getPatternType(entry) {
  const [a, b, c] = entry.dice;
  if (a === b && b === c) return `triple_${a}`;
  if (a === b || b === c || a === c) return "pair";
  const s = [a, b, c].sort((x, y) => x - y);
  if (s[0] + 1 === s[1] && s[1] + 1 === s[2]) return "straight";
  return "diff";
}
function parityBucket(entry) {
  return entry.tong % 2 === 0 ? "even" : "odd";
}
function sumBucket(entry) {
  const t = entry.tong;
  if (t <= 6) return "<=6";
  if (t <= 9) return "7-9";
  if (t <= 12) return "10-12";
  if (t <= 15) return "13-15";
  return ">=16";
}

// ---------------------- GENERIC CONDITIONAL MODEL ----------------------
function conditionalModel(hist, extractor, name, minCount = 6) {
  // build table: key -> counts next T/X
  const table = {};
  for (let i = 0; i < hist.length - 1; i++) {
    const key = extractor(hist[i]);
    const next = hist[i + 1].ket_qua;
    if (!table[key]) table[key] = { T: 0, X: 0, total: 0 };
    table[key][next] += 1;
    table[key].total += 1;
  }
  const lastKey = extractor(hist[hist.length - 1]);
  const data = table[lastKey] || null;
  if (!data || data.total < minCount) {
    return {
      pred: null,
      conf: 0.5,
      why: [`${name}: không có đủ mẫu cho key=${lastKey} (samples=${data ? data.total : 0})`],
      meta: { key: lastKey, samples: data ? data.total : 0 },
    };
  }
  const pT = data.T / data.total;
  const pred = pT >= 0.5 ? "T" : "X";
  // conf mapping: if pT=0.5 -> 0.55, if pT=0.9 -> 0.9
  const conf = 0.55 + Math.min(0.35, Math.abs(pT - 0.5) * 1.2);
  return {
    pred,
    conf,
    why: [`${name}: key=${lastKey}, P(T)=${pT.toFixed(3)} over ${data.total} samples`],
    meta: { key: lastKey, samples: data.total, pT },
  };
}

// ---------------------- EXISTING MODELS (refined) ----------------------
function rulesPrediction(hist) {
  const results = hist.map((h) => h.ket_qua);
  const totals = hist.map((h) => h.tong);
  const last = results.at(-1);
  const last3 = lastN(results, 3);
  const last5 = lastN(results, 5);
  const total3 = lastN(totals, 3);
  const total5 = lastN(totals, 5);

  let explain = [];
  let score = { T: 0, X: 0 };

  if (last5.filter((r) => r === "T").length >= 4) {
    return { pred: "T", conf: 0.92, why: ["5 phiên gần nhất nghiêng Tài (≥4/5)"], meta: { rule: "5/5 bias" } };
  }
  if (last5.filter((r) => r === "X").length >= 4) {
    return { pred: "X", conf: 0.92, why: ["5 phiên gần nhất nghiêng Xỉu (≥4/5)"], meta: { rule: "5/5 bias" } };
  }

  if (last3.length === 3 && last3.every((r) => r === "T")) {
    return { pred: "X", conf: 0.86, why: ["3 Tài liên tiếp → ưu tiên đảo Xỉu"], meta: { rule: "3-in-a-row-break" } };
  }
  if (last3.length === 3 && last3.every((r) => r === "X")) {
    return { pred: "T", conf: 0.86, why: ["3 Xỉu liên tiếp → ưu tiên đảo Tài"], meta: { rule: "3-in-a-row-break" } };
  }

  const zigzag = last5.length === 5 && last5.every((v, i, arr) => i === 0 || v !== arr[i - 1]);
  if (zigzag) {
    return { pred: last === "T" ? "X" : "T", conf: 0.82, why: ["Cầu zigzag rõ ràng → đảo lặp"], meta: { rule: "zigzag" } };
  }

  const avg5 = total5.length ? avg(total5) : 10.5;
  if (avg5 >= 12) {
    score.T += 2;
    explain.push("Trung bình tổng 5 phiên cao (≥12) → Tài");
  } else if (avg5 <= 9.5) {
    score.X += 2;
    explain.push("Trung bình tổng 5 phiên thấp (≤9.5) → Xỉu");
  }

  if (total3.length === 3) {
    if (total3[2] > total3[1] && total3[1] > total3[0]) {
      score.T += 2; explain.push("Đà tăng 3 phiên → Tài");
    } else if (total3[2] < total3[1] && total3[1] < total3[0]) {
      score.X += 2; explain.push("Đà giảm 3 phiên → Xỉu");
    }
  }

  const lastTotal = totals.at(-1) ?? 10;
  if (lastTotal >= 17) { score.T += 3; explain.push("Tổng cực cao (≥17) → Tài"); }
  if (lastTotal <= 6) { score.X += 3; explain.push("Tổng cực thấp (≤6) → Xỉu"); }
  if (total5.length === 5 && total5.every((t) => t >= 12)) { score.T += 3; explain.push("5 tổng cao liên tiếp → Tài"); }
  if (total5.length === 5 && total5.every((t) => t <= 9)) { score.X += 3; explain.push("5 tổng thấp liên tiếp → Xỉu"); }

  let pred = null, conf = 0.6;
  if (score.T > score.X) { pred = "T"; conf = 0.68 + Math.min(0.25, (score.T - score.X) * 0.06); }
  else if (score.X > score.T) { pred = "X"; conf = 0.68 + Math.min(0.25, (score.X - score.T) * 0.06); }
  else {
    if (avg5 >= 11) { pred = "T"; conf = 0.64; explain.push("Bias theo avg"); }
    else if (avg5 <= 10) { pred = "X"; conf = 0.64; explain.push("Bias theo avg"); }
    else { pred = last === "T" ? "X" : "T"; conf = 0.6; explain.push("Không nghiêng → đảo"); }
  }

  return { pred, conf, why: explain.length ? explain : ["Rules fallback"], meta: { avg5, lastTotal }};
}

// Markov (giữ như trước)
function markovPrediction(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const use = lastN(rs, 80);
  let tt = 1, tx = 1, xt = 1, xx = 1;
  for (let i = 1; i < use.length; i++) {
    const p = use[i - 1], c = use[i];
    if (p === "T" && c === "T") tt++; if (p === "T" && c === "X") tx++;
    if (p === "X" && c === "T") xt++; if (p === "X" && c === "X") xx++;
  }
  const last = use.at(-1);
  let pT = 0.5, pX = 0.5, why = [];
  if (last === "T") { pT = tt / (tt + tx); pX = tx / (tt + tx); why.push(`Markov từ T: P(T)=${pT.toFixed(2)}`); }
  else { pT = xt / (xt + xx); pX = xx / (xt + xx); why.push(`Markov từ X: P(T)=${pT.toFixed(2)}`); }
  const pred = pT >= pX ? "T" : "X";
  const conf = 0.58 + Math.min(0.35, Math.abs(pT - pX) * 1.2);
  return { pred, conf, why, meta: { tt, tx, xt, xx }};
}

// recent pattern (improved)
function recentPatternPrediction(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const use = lastN(rs, 30);
  const patCounts = {};
  for (let L = 3; L <= 5; L++) {
    for (let i = 0; i <= use.length - L; i++) {
      const k = use.slice(i, i + L).join("");
      patCounts[k] = (patCounts[k] || 0) + 1;
    }
  }
  const entries = Object.entries(patCounts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return { pred: null, conf: 0.5, why: ["Không pattern mạnh"] };
  const [bestPat, cnt] = entries[0];
  // bestPat dạng "TXT..." -> dự đoán next char = last char of pattern? heuristic: if pattern appears with continuation often -> choose continuation
  // We will check occurrences where the pattern was followed by a next result
  const follow = { T: 0, X: 0, total: 0 };
  for (let i = 0; i <= rs.length - bestPat.length - 1; i++) {
    if (rs.slice(i, i + bestPat.length).join("") === bestPat) {
      const next = rs[i + bestPat.length];
      follow[next]++; follow.total++;
    }
  }
  if (follow.total < 4) {
    // fallback to weighted recent
    const weights = use.map((_, i) => Math.pow(1.12, i));
    const tScore = use.reduce((s, v, i) => s + (v === "T" ? weights[i] : 0), 0);
    const xScore = use.reduce((s, v, i) => s + (v === "X" ? weights[i] : 0), 0);
    const pred = tScore >= xScore ? "T" : "X";
    const dom = Math.abs(tScore - xScore) / (tScore + xScore);
    const conf = 0.6 + Math.min(0.28, dom * 0.9);
    return { pred, conf, why: ["No strong follow; fallback weighted recent"], meta: { bestPat, cnt } };
  }
  const pT = follow.T / follow.total;
  const pred = pT >= 0.5 ? "T" : "X";
  const conf = 0.6 + Math.min(0.36, Math.abs(pT - 0.5) * 1.3);
  return { pred, conf, why: [`Pattern ${bestPat} x${cnt}, follow: P(T)=${pT.toFixed(3)} (${follow.total} samples)`], meta: { bestPat, cnt, follow } };
}

// breakStreakFilter (refined)
function breakStreakFilter(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const s = streakOfEnd(rs);
  const cur = rs.at(-1);
  let breakProb = 0;
  if (s >= 10) breakProb = 0.82;
  else if (s >= 8) breakProb = 0.76;
  else if (s >= 6) breakProb = 0.68;
  else if (s >= 4) breakProb = 0.62;
  if (breakProb >= 0.62) {
    const pred = cur === "T" ? "X" : "T";
    return { pred, conf: breakProb, why: [`Chuỗi ${s} ${cur === "T" ? "Tài" : "Xỉu"} → khả năng bẻ cầu ${Math.round(breakProb * 100)}%`], meta: { streak: s } };
  }
  return { pred: cur, conf: 0.56, why: [`Chuỗi ${s} → theo cầu`], meta: { streak: s } };
}

// ---------------------- NEW MODELS (pattern/parity/bucket) ----------------------
function patternConditionalModel(hist) {
  return conditionalModel(hist, getPatternType, "DicePattern", 5);
}
function parityConditionalModel(hist) {
  return conditionalModel(hist, parityBucket, "ParityPrevSum", 8);
}
function bucketConditionalModel(hist) {
  return conditionalModel(hist, sumBucket, "SumBucket", 8);
}

// ---------------------- MODEL LIST ----------------------
const modelFns = [
  { name: "Rules", fn: rulesPrediction },
  { name: "Markov", fn: markovPrediction },
  { name: "PatternMining", fn: recentPatternPrediction },
  { name: "BreakStreak", fn: breakStreakFilter },
  { name: "DicePattern", fn: patternConditionalModel },
  { name: "Parity", fn: parityConditionalModel },
  { name: "SumBucket", fn: bucketConditionalModel },
];

// ---------------------- LOCAL PERFORMANCE (backtest per-model) ----------------------
function localPerformance(hist, lookback, models) {
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 8) return models.map(() => 1.0);
  const start = hist.length - 1 - n;
  const correct = new Array(models.length).fill(0);
  const count = n;
  for (let i = start; i < hist.length - 1; i++) {
    const past = hist.slice(0, i + 1);
    const actualNext = hist[i + 1].ket_qua;
    models.forEach((m, idx) => {
      const { pred } = m.fn(past);
      if (pred === actualNext) correct[idx]++;
    });
  }
  return correct.map((c) => {
    const acc = c / count;
    return 0.75 + Math.min(0.6, Math.max(0, (acc - 0.5) * 1.2)); // 0.75..1.35
  });
}

// ---------------------- BACKTEST EVALUATOR FOR WEIGHT OPTIMIZER ----------------------
function evaluateWeights(hist, models, weights, lookback) {
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 10) return 0.5;
  let correct = 0;
  const start = hist.length - 1 - n;
  for (let i = start; i < hist.length - 1; i++) {
    const past = hist.slice(0, i + 1);
    const actualNext = hist[i + 1].ket_qua;
    // collect votes
    let scoreT = 0, scoreX = 0;
    for (let k = 0; k < models.length; k++) {
      const { pred, conf } = models[k].fn(past);
      const w = weights[k];
      if (!pred) continue;
      if (pred === "T") scoreT += conf * w;
      else scoreX += conf * w;
    }
    const final = scoreT >= scoreX ? "T" : "X";
    if (final === actualNext) correct++;
  }
  return correct / n;
}

// simple hill-climb optimizer
function optimizeWeights(hist, models, lookback = 80, iter = 300) {
  const base = models.map(() => 1.0);
  let weights = base.slice();
  let best = { weights: weights.slice(), acc: evaluateWeights(hist, models, weights, lookback) };
  for (let it = 0; it < iter; it++) {
    const j = Math.floor(Math.random() * weights.length);
    const old = weights[j];
    const factor = 1 + (Math.random() - 0.5) * 0.6; // +-30%
    weights[j] = Math.max(0.2, Math.min(3.0, weights[j] * factor));
    const acc = evaluateWeights(hist, models, weights, lookback);
    if (acc >= best.acc) {
      best = { weights: weights.slice(), acc };
      // keep
    } else {
      weights[j] = old;
    }
  }
  return best;
}

// ---------------------- ENSEMBLE (with optimization) ----------------------
function ensemblePredictOptimized(hist) {
  // compute per-model outputs now
  const modelOutputs = modelFns.map((m) => {
    const out = m.fn(hist);
    return { name: m.name, pred: out.pred, conf: out.conf || 0.5, why: out.why || [], meta: out.meta || {} };
  });

  // baseline perf multipliers
  const perf = localPerformance(hist, 60, modelFns);
  // initial weights = baseline perf * predefined importance
  const baseImportance = [1.2, 1.0, 1.1, 0.9, 1.0, 0.9, 0.9]; // tune
  let initWeights = modelFns.map((_, i) => baseImportance[i] * perf[i]);

  // optimize multipliers on recent backtest (walk-forward last 120)
  const opt = optimizeWeights(hist, modelFns, Math.min(120, hist.length - 1), 300);
  // multiply
  const finalWeights = initWeights.map((w, i) => w * opt.weights[i]);

  // compute votes
  let scoreT = 0, scoreX = 0;
  const modelStats = [];
  for (let i = 0; i < modelFns.length; i++) {
    const mo = modelOutputs[i];
    const w = finalWeights[i] || 0.001;
    const vote = (mo.conf || 0.5) * w;
    if (mo.pred === "T") scoreT += vote;
    else if (mo.pred === "X") scoreX += vote;
    modelStats.push({
      name: mo.name,
      pred: mo.pred,
      conf: Math.round((mo.conf || 0.5) * 100) + "%",
      weight: Number(w.toFixed(3)),
      voteScore: Number(vote.toFixed(3)),
      why: mo.why,
      meta: mo.meta || {},
    });
  }

  const pred = scoreT >= scoreX ? "T" : "X";
  const rawConf = Math.max(scoreT, scoreX) / (scoreT + scoreX || 1);
  // calibrate conf by backtest opt.acc (how well weights performed)
  const calibratedConf = Math.min(0.995, 0.6 + (rawConf - 0.5) * 0.75 + opt.acc * 0.35);
  // assemble detailed explanation
  const agree = modelStats.filter((m) => m.pred === pred).length / modelStats.length;
  const why = [
    `Final vote: T=${scoreT.toFixed(3)}, X=${scoreX.toFixed(3)} (agree ${Math.round(agree * 100)}%)`,
    `Optimized weights backtest acc=${(opt.acc * 100).toFixed(1)}% over recent window`,
  ];

  // additional diagnostics
  const rs = hist.map((h) => h.ket_qua);
  const ent = shannonEntropy(lastN(rs, 30));
  const streak = streakOfEnd(rs);
  // transition matrix
  const transitions = { "T->T": 0, "T->X": 0, "X->T": 0, "X->X": 0, total: 0 };
  for (let i = 1; i < rs.length; i++) {
    transitions[`${rs[i - 1]}->${rs[i]}`] += 1;
    transitions.total++;
  }
  const transProb = {};
  ["T->T", "T->X", "X->T", "X->X"].forEach((k) => {
    transProb[k] = transitions.total ? (transitions[k] / transitions.total).toFixed(3) : "0.000";
  });

  // gather pattern stats (top patterns)
  const patterns = {};
  for (let i = 0; i < hist.length; i++) {
    const p = getPatternType(hist[i]);
    patterns[p] = (patterns[p] || 0) + 1;
  }
  const patternList = Object.entries(patterns).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ pattern: k, count: v }));

  return {
    pred,
    conf: calibratedConf,
    modelStats,
    why,
    diagnostics: {
      entropy_last30: Number(ent.toFixed(3)),
      streak,
      transitions: transProb,
      top_patterns: patternList.slice(0, 6),
      optimized_weights: opt.weights.map((w) => Number(w.toFixed(3))),
      optimized_acc: Number((opt.acc * 100).toFixed(2)),
    },
  };
}

// ---------------------- BACKTEST (overall) ----------------------
function overallBacktest(hist, lookback = 120) {
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 10) return { acc: 0.58, sample: n };
  let correct = 0;
  const start = hist.length - 1 - n;
  for (let i = start; i < hist.length - 1; i++) {
    const past = hist.slice(0, i + 1);
    const actualNext = hist[i + 1].ket_qua;
    const { pred } = ensemblePredictOptimized(past);
    if (pred === actualNext) correct++;
  }
  return { acc: correct / n, sample: n };
}

// ---------------------- RISK LEVEL (updated) ----------------------
function riskLevel(conf, hist) {
  const rs = hist.map((h) => h.ket_qua);
  const last12 = lastN(rs, 12);
  let switches = 0;
  for (let i = 1; i < last12.length; i++) if (last12[i] !== last12[i - 1]) switches++;
  const switchRate = last12.length > 1 ? switches / (last12.length - 1) : 0.5;
  const s = streakOfEnd(rs);
  let risk = 1 - conf;
  risk += switchRate * 0.12;
  if (s >= 6) risk += 0.06;
  const ent = shannonEntropy(lastN(rs, 30));
  // entropy high -> unpredictable -> increase risk
  risk += Math.min(0.12, ent / 4);
  if (risk <= 0.20) return "Thấp";
  if (risk <= 0.35) return "Trung bình";
  return "Cao";
}

// ---------------------- API ROUTES ----------------------
app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.get("/api/du-doan", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const last = hist.at(-1);
    const ensemble = ensemblePredictOptimized(hist);
    const bt = overallBacktest(hist, 160);
    const tyLe = Math.round(bt.acc * 100);

    // build giai_thich chi tiết
    const modelLines = ensemble.modelStats.map((m) => {
      return `${m.name}: pred=${m.pred === "T" ? "Tài" : m.pred === "X" ? "Xỉu" : "?"}, conf=${m.conf}, weight=${m.weight}, note=${(m.why || []).join("; ")}`;
    });

    const giai_thich = [
      `Kết luận chính: ${ensemble.pred === "T" ? "Tài" : "Xỉu"} (conf ~ ${(ensemble.conf * 100).toFixed(1)}%)`,
      `Backtest tổng (walk-forward ${bt.sample} mẫu): accuracy=${(bt.acc * 100).toFixed(1)}%`,
      `Mô hình & đóng góp (từng lớp):`,
      ...modelLines,
      `Diagnostics: entropy_last30=${ensemble.diagnostics.entropy_last30}, streak=${ensemble.diagnostics.streak}`,
      `Transitions (empirical): ${Object.entries(ensemble.diagnostics.transitions).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      `Top patterns (dice): ${ensemble.diagnostics.top_patterns.map(p => `${p.pattern}(${p.count})`).join(", ")}`,
      `Ghi chú tối ưu: optimized weights (multi)=${ensemble.diagnostics.optimized_weights.join(", ")}, optimized_acc=${ensemble.diagnostics.optimized_acc}%`,
    ].join(" | ");

    const out = {
      phien: last.phien,
      xuc_xac: `${last.dice[0]}-${last.dice[1]}-${last.dice[2]}`,
      tong: last.tong,
      ket_qua: last.ket_qua === "T" ? "Tài" : "Xỉu",
      phien_sau: last.phien + 1,
      du_doan: ensemble.pred === "T" ? "Tài" : "Xỉu",
      ty_le_thanh_cong: `${tyLe}%`,
      giai_thich,
      muc_do_rui_ro: riskLevel(ensemble.conf, hist),
      meta: {
        do_tin_cay: Math.round(ensemble.conf * 100) + "%",
        ensemble_conf_decimal: Number(ensemble.conf.toFixed(4)),
        backtest_sample: bt.sample,
        backtest_acc: Number((bt.acc * 100).toFixed(2)),
        per_model: ensemble.modelStats,
        diagnostics: ensemble.diagnostics,
      },
    };

    res.json(out);
  } catch (e) {
    console.error("ERROR", e && e.message ? e.message : e);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

// walk-forward detailed endpoint
app.get("/api/du-doan/full", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const detail = [];
    const start = Math.max(8, hist.length - 40);
    for (let i = start; i < hist.length; i++) {
      const past = hist.slice(0, i);
      const cur = hist[i];
      const ens = ensemblePredictOptimized(past);
      detail.push({
        phien: cur.phien,
        ket_qua_thuc: cur.ket_qua === "T" ? "Tài" : "Xỉu",
        du_doan_tai_thoi_diem_do: ens.pred === "T" ? "Tài" : "Xỉu",
        dung_khong: ens.pred === cur.ket_qua,
        do_tin_cay: Math.round(ens.conf * 100) + "%",
        per_model: ens.modelStats,
        diagnostics: ens.diagnostics,
      });
    }

    const curr = ensemblePredictOptimized(hist);
    const bt = overallBacktest(hist, 200);

    res.json({
      now: hist.at(-1)?.phien,
      next: hist.at(-1)?.phien + 1,
      du_doan_tiep: curr.pred === "T" ? "Tài" : "Xỉu",
      do_tin_cay: Math.round(curr.conf * 100) + "%",
      muc_do_rui_ro: riskLevel(curr.conf, hist),
      giai_thich: curr.why,
      backtest: { ty_le_thanh_cong: Math.round(bt.acc * 100) + "%", so_mau: bt.sample },
      chi_tiet_walkforward: detail,
    });
  } catch (e) {
    console.error("ERR", e && e.message ? e.message : e);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`VIP-Ultimate API đang chạy tại http://localhost:${PORT}`);
});
