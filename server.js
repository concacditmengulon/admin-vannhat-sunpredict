const express = require("express");
const axios = require("axios");
const cors = require("cors");

const PORT = process.env.PORT || 3000;
const SOURCE_URL = "https://fullsrc-daynesun.onrender.com/api/taixiu/history";

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------- UTILITIES ----------------------

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
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function sum(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0);
}
function streakOfEnd(arr) {
  if (!arr || !arr.length) return 0;
  const last = arr[arr.length - 1];
  let s = 1;
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i] === last) s++;
    else break;
  }
  return s;
}

// ---------------------- LAYER 0: LOAD & SHAPE ----------------------

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
      ket_qua: normResult(r.Ket_qua), // 'T' or 'X'
      raw: r,
    }))
    .filter((r) => r.ket_qua === "T" || r.ket_qua === "X")
    .sort((a, b) => a.phien - b.phien);
}

// ---------------------- LAYER 1: RULES (Heuristic) ----------------------

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
    return { pred: "T", conf: 0.86, why: ["5 phiên gần nhất nghiêng Tài (≥4/5)"] };
  }
  if (last5.filter((r) => r === "X").length >= 4) {
    return { pred: "X", conf: 0.86, why: ["5 phiên gần nhất nghiêng Xỉu (≥4/5)"] };
  }

  if (last3.length === 3 && last3.every((r) => r === "T")) {
    return { pred: "X", conf: 0.8, why: ["3 Tài liên tiếp → ưu tiên đảo Xỉu"] };
  }
  if (last3.length === 3 && last3.every((r) => r === "X")) {
    return { pred: "T", conf: 0.8, why: ["3 Xỉu liên tiếp → ưu tiên đảo Tài"] };
  }

  const zigzag = last5.length === 5 && last5.every((v, i, arr) => i === 0 || v !== arr[i - 1]);
  if (zigzag) {
    return {
      pred: last === "T" ? "X" : "T",
      conf: 0.78,
      why: ["Cầu zigzag rõ ràng → lặp tiếp"],
    };
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
      score.T += 2;
      explain.push("Tổng tăng đều 3 phiên → nghiêng Tài");
    } else if (total3[2] < total3[1] && total3[1] < total3[0]) {
      score.X += 2;
      explain.push("Tổng giảm đều 3 phiên → nghiêng Xỉu");
    }
  }

  const lastTotal = totals.at(-1) ?? 10;
  if (lastTotal >= 17) {
    score.T += 3;
    explain.push("Tổng gần nhất rất cao (≥17) → Tài mạnh");
  }
  if (lastTotal <= 6) {
    score.X += 3;
    explain.push("Tổng gần nhất rất thấp (≤6) → Xỉu mạnh");
  }
  if (total5.length === 5 && total5.every((t) => t >= 12)) {
    score.T += 3;
    explain.push("5 phiên liên tiếp tổng cao (≥12) → Tài");
  }
  if (total5.length === 5 && total5.every((t) => t <= 9)) {
    score.X += 3;
    explain.push("5 phiên liên tiếp tổng thấp (≤9) → Xỉu");
  }

  let pred = null;
  let conf = 0.62;
  if (score.T > score.X) {
    pred = "T";
    conf = 0.68 + Math.min(0.12, (score.T - score.X) * 0.04);
    explain.push("Điểm score nghiêng Tài");
  } else if (score.X > score.T) {
    pred = "X";
    conf = 0.68 + Math.min(0.12, (score.X - score.T) * 0.04);
    explain.push("Điểm score nghiêng Xỉu");
  } else {
    if (avg5 >= 11) {
      pred = "T";
      conf = 0.64;
      explain.push("Score cân bằng → bias tổng cao → Tài");
    } else if (avg5 <= 10) {
      pred = "X";
      conf = 0.64;
      explain.push("Score cân bằng → bias tổng thấp → Xỉu");
    } else {
      pred = last === "T" ? "X" : "T";
      conf = 0.6;
      explain.push("Không nghiêng rõ → đảo chiều so với gần nhất");
    }
  }

  return { pred, conf, why: explain };
}

// ---------------------- LAYER 2: MODEL-BASED ----------------------

function markovPrediction(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const use = lastN(rs, 60);
  let tt = 1,
    tx = 1,
    xt = 1,
    xx = 1;

  for (let i = 1; i < use.length; i++) {
    const prev = use[i - 1];
    const cur = use[i];
    if (prev === "T" && cur === "T") tt++;
    if (prev === "T" && cur === "X") tx++;
    if (prev === "X" && cur === "T") xt++;
    if (prev === "X" && cur === "X") xx++;
  }

  const last = use.at(-1);
  let pT = 0.5,
    pX = 0.5,
    why = [];
  if (last === "T") {
    const s = tt + tx;
    pT = tt / s;
    pX = tx / s;
    why.push(`Markov từ T: P(T)=${pT.toFixed(2)}, P(X)=${pX.toFixed(2)}`);
  } else if (last === "X") {
    const s = xt + xx;
    pT = xt / s;
    pX = xx / s;
    why.push(`Markov từ X: P(T)=${pT.toFixed(2)}, P(X)=${pX.toFixed(2)}`);
  }

  const pred = pT >= pX ? "T" : "X";
  const conf = Math.max(pT, pX);
  return { pred, conf: 0.6 + (conf - 0.5) * 0.8, why };
}

function recentPatternPrediction(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const use = lastN(rs, 20);
  let why = [];

  const pat3Counts = {};
  for (let i = 0; i <= use.length - 3; i++) {
    const k = use.slice(i, i + 3).join("");
    pat3Counts[k] = (pat3Counts[k] || 0) + 1;
  }
  const pat4Counts = {};
  for (let i = 0; i <= use.length - 4; i++) {
    const k = use.slice(i, i + 4).join("");
    pat4Counts[k] = (pat4Counts[k] || 0) + 1;
  }

  function bestEntry(obj) {
    return Object.entries(obj).sort((a, b) => b[1] - a[1])[0];
  }

  const b3 = bestEntry(pat3Counts);
  const b4 = bestEntry(pat4Counts);

  let pred = null;
  let conf = 0.58;

  if (b4 && b4[1] >= 3) {
    const patt = b4[0];
    const next = patt[3];
    pred = next === "T" ? "T" : "X";
    conf = 0.72 + Math.min(0.12, (b4[1] - 3) * 0.04);
    why.push(`Pattern 4 bước lặp nhiều: ${patt} x${b4[1]}`);
  } else if (b3 && b3[1] >= 4) {
    const patt = b3[0];
    const next = patt[2];
    pred = next === "T" ? "T" : "X";
    conf = 0.68 + Math.min(0.1, (b3[1] - 4) * 0.03);
    why.push(`Pattern 3 bước lặp nhiều: ${patt} x${b3[1]}`);
  } else {
    const weights = use.map((_, i) => Math.pow(1.15, i));
    const tScore = use.reduce((s, v, i) => s + (v === "T" ? weights[i] : 0), 0);
    const xScore = use.reduce((s, v, i) => s + (v === "X" ? weights[i] : 0), 0);
    pred = tScore >= xScore ? "T" : "X";
    const dom = Math.abs(tScore - xScore) / (tScore + xScore || 1);
    conf = 0.6 + Math.min(0.2, dom * 0.8);
    why.push("Trọng số gần đây nghiêng " + (pred === "T" ? "Tài" : "Xỉu"));
  }

  return { pred, conf, why };
}

function breakStreakFilter(hist) {
  const rs = hist.map((h) => h.ket_qua);
  const s = streakOfEnd(rs);
  const cur = rs.at(-1);

  let breakProb = 0;
  if (s >= 8) breakProb = 0.78;
  else if (s >= 6) breakProb = 0.7;
  else if (s >= 4) breakProb = 0.62;

  if (breakProb >= 0.62) {
    const pred = cur === "T" ? "X" : "T";
    return {
      pred,
      conf: breakProb,
      why: [`Chuỗi ${s} ${cur === "T" ? "Tài" : "Xỉu"} → xác suất bẻ cầu ${Math.round(breakProb * 100)}%`],
    };
  }
  return {
    pred: cur,
    conf: 0.55,
    why: [`Chuỗi ${s} chưa đủ dài để bẻ → theo cầu`],
  };
}

// ---------------------- ENSEMBLE: LOGISTIC ONLINE + HEURISTIC ----------------------

// feature extractor for logistic ensemble
function extractFeaturesForEnsemble(hist) {
  const N = hist.length;
  const rs = hist.map(h => h.ket_qua);
  const totals = hist.map(h => h.tong);

  const last5 = lastN(rs, 5);
  const last10 = lastN(rs, 10);
  const last20 = lastN(rs, 20);

  const freqT_5 = last5.filter(r => r === 'T').length / (last5.length || 1);
  const freqT_10 = last10.filter(r => r === 'T').length / (last10.length || 1);
  const avg5 = avg(lastN(totals, 5));
  const avg10 = avg(lastN(totals, 10));
  const run = Math.min(1, streakOfEnd(rs) / 10);

  const switchRate12 = (() => {
    const s = lastN(rs, 12);
    if (s.length <= 1) return 0.5;
    let sw = 0;
    for (let i=1;i<s.length;i++) if (s[i] !== s[i-1]) sw++;
    return sw / (s.length - 1);
  })();

  const parityRatio5 = lastN(totals,5).filter(t=>t%2===0).length / (last5.length || 1);
  const markov = markovTransitionFeature(rs);
  const r1 = rulesPrediction(hist);
  const r2 = markovPrediction(hist);
  const r3 = recentPatternPrediction(hist);
  const r4 = breakStreakFilter(hist);

  return {
    f_freqT_5: freqT_5,
    f_freqT_10: freqT_10,
    f_avg5: avg5 / 18,
    f_avg10: avg10 / 18,
    f_run: run,
    f_switch12: switchRate12,
    f_parity5: parityRatio5,
    m_markov_Tprob: markov.pT || 0.5,
    model_r1_T: r1.pred === 'T' ? r1.conf : 1 - r1.conf,
    model_r2_T: r2.pred === 'T' ? r2.conf : 1 - r2.conf,
    model_r3_T: r3.pred === 'T' ? r3.conf : 1 - r3.conf,
    model_r4_T: r4.pred === 'T' ? r4.conf : 1 - r4.conf,
  };
}

function markovTransitionFeature(rs) {
  const use = lastN(rs, 120);
  if (use.length < 2) return { pT: 0.5, pX: 0.5 };
  let tt=1, tx=1, xt=1, xx=1;
  for (let i=1;i<use.length;i++){
    const a=use[i-1], b=use[i];
    if (a==='T'&&b==='T') tt++;
    if (a==='T'&&b==='X') tx++;
    if (a==='X'&&b==='T') xt++;
    if (a==='X'&&b==='X') xx++;
  }
  const last = use.at(-1);
  if (last==='T'){ const s=tt+tx; return { pT: tt/s, pX: tx/s }; }
  const s=xt+xx; return { pT: xt/s, pX: xx/s };
}

// Online logistic classifier
class OnlineLogisticEnsemble {
  constructor(featureKeys, lr = 0.02, reg = 1e-3) {
    this.keys = featureKeys;
    this.lr = lr;
    this.reg = reg;
    this.w = {};
    featureKeys.forEach(k => this.w[k] = (Math.random() * 0.02) - 0.01);
    this.bias = 0;
    this._warmed = false;
  }

  _dot(features) {
    let s = this.bias;
    this.keys.forEach(k => { s += (this.w[k] || 0) * (features[k] || 0);});
    return s;
  }

  predictProb(features) {
    const z = this._dot(features);
    const p = 1 / (1 + Math.exp(-z));
    return p;
  }

  update(features, label) {
    const p = this.predictProb(features);
    const err = p - label;
    this.keys.forEach(k => {
      const g = err * (features[k] || 0) + this.reg * (this.w[k] || 0);
      this.w[k] = (this.w[k] || 0) - this.lr * g;
    });
    this.bias = this.bias - this.lr * err;
  }

  batchFitWalkForward(history, featureFn, warm=50) {
    const N = history.length;
    if (N < warm + 5) return;
    for (let i = warm; i < N-1; i++) {
      const past = history.slice(0, i+1);
      const features = featureFn(past);
      const label = history[i+1].ket_qua === 'T' ? 1 : 0;
      this.update(features, label);
    }
    this._warmed = true;
  }
}

const ensembleFeatureKeys = [
  'f_freqT_5','f_freqT_10','f_avg5','f_avg10','f_run','f_switch12','f_parity5',
  'm_markov_Tprob','model_r1_T','model_r2_T','model_r3_T','model_r4_T'
];
const LOGISTIC_ENSEMBLE = new OnlineLogisticEnsemble(ensembleFeatureKeys, 0.02, 1e-3);

// ensemblePredict wrapper
function ensemblePredict(hist) {
  if (!hist || hist.length < 5) {
    // fallback trivial
    return { pred: hist.at(-1)?.ket_qua || "T", conf: 0.55, why: ["Không đủ dữ liệu, fallback"] };
  }

  // warm logistic on first pass
  if (hist.length > 120 && !LOGISTIC_ENSEMBLE._warmed) {
    LOGISTIC_ENSEMBLE.batchFitWalkForward(hist, extractFeaturesForEnsemble, 60);
  }

  const features = extractFeaturesForEnsemble(hist);
  const pT = LOGISTIC_ENSEMBLE.predictProb(features);
  const pX = 1 - pT;
  const predLog = pT >= pX ? 'T' : 'X';
  const confLog = Math.max(pT, pX);

  // heuristic ensemble as second opinion
  const r1 = rulesPrediction(hist);
  const r2 = markovPrediction(hist);
  const r3 = recentPatternPrediction(hist);
  const r4 = breakStreakFilter(hist);

  const votes = [
    { p: r1.pred, c: r1.conf * 0.25, why: r1.why },
    { p: r2.pred, c: r2.conf * 0.2, why: r2.why },
    { p: r3.pred, c: r3.conf * 0.3, why: r3.why },
    { p: r4.pred, c: r4.conf * 0.15, why: r4.why },
    { p: predLog, c: confLog * 0.4, why: [`Logistic ensemble pT=${pT.toFixed(3)}`] }
  ];

  const scoreT = sum(votes.map(v => v.p === 'T' ? v.c : 0));
  const scoreX = sum(votes.map(v => v.p === 'X' ? v.c : 0));
  const pred = scoreT >= scoreX ? 'T' : 'X';
  const rawConf = Math.max(scoreT, scoreX) / (scoreT + scoreX || 1);
  const agree = votes.filter(v => v.p === pred).length / votes.length;
  const conf = Math.min(0.99, 0.65 + (rawConf - 0.5) * 0.7 + agree * 0.12);

  const why = votes.filter(v => v.p === pred).flatMap(v => v.why).concat([`Đồng thuận ${Math.round(agree*100)}%`]);

  return { pred, conf, why, pieces: { logistic: { pT, pX }, votes } };
}

// ---------------------- BACKTEST + KELLY ----------------------

function overallBacktest(hist, lookback = 100, betUnit = 1) {
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 10) return { acc: 0, sample: n, bankroll: null, details: [] };

  let correct = 0;
  let bankroll = 1000;
  const details = [];
  for (let i = hist.length - 1 - n; i < hist.length - 1; i++) {
    const past = hist.slice(0, i+1);
    const res = ensemblePredict(past);
    const actualNext = hist[i+1].ket_qua;
    const betSize = kellyBetSize(res.conf, 0.95, bankroll, betUnit); // suggested bet
    // simplified payout: 1:1 on win
    if (res.pred === actualNext) {
      correct++;
      bankroll += betSize;
    } else {
      bankroll -= betSize;
    }
    details.push({ idx: i+1, pred: res.pred, actual: actualNext, conf: res.conf, bet: betSize, bankroll: bankroll });
  }
  const acc = correct / n;
  return { acc, sample: n, bankroll, details: details.slice(-200) };
}

function kellyBetSize(confidence, payout = 0.95, bankroll = 1000, baseUnit = 1) {
  // confidence: prob of win (0..1). payout: net odds (e.g., 0.95 for near even)
  // Kelly fraction = (bp - q)/b where b = payout, p=confidence, q=1-p
  const p = Math.max(0.01, Math.min(0.99, confidence));
  const b = payout;
  const q = 1 - p;
  const k = (b * p - q) / b;
  if (k <= 0) return baseUnit; // no edge -> minimal unit
  // cap fraction to avoid overbetting
  const frac = Math.min(0.2, k); // max 20% bankroll on single bet
  return Math.max(1, Math.round(bankroll * frac)); // at least 1 unit
}

// ---------------------- RISK LEVEL ----------------------

function riskLevel(conf, hist) {
  const rs = hist.map((h) => h.ket_qua);
  const last12 = lastN(rs, 12);
  let switches = 0;
  for (let i = 1; i < last12.length; i++) {
    if (last12[i] !== last12[i - 1]) switches++;
  }
  const switchRate = last12.length > 1 ? switches / (last12.length - 1) : 0.5;
  const s = streakOfEnd(rs);

  let risk = 1 - conf;
  risk += switchRate * 0.15;
  if (s >= 6) risk += 0.05;

  if (risk <= 0.22) return "Thấp";
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
    const { pred, conf, why, pieces } = ensemblePredict(hist);
    const bt = overallBacktest(hist, 120);
    const tyLe = Math.round(bt.acc * 100);
    const kelly = kellyBetSize(conf, 0.95, 1000, 1);

    const out = {
      phien: last.phien,
      xuc_xac: `${last.dice[0]}-${last.dice[1]}-${last.dice[2]}`,
      tong: last.tong,
      ket_qua: last.ket_qua === "T" ? "Tài" : "Xỉu",
      phien_sau: last.phien + 1,
      du_doan: pred === "T" ? "Tài" : "Xỉu",
      ty_le_thanh_cong: `${tyLe}% (backtest ${bt.sample} mẫu)`,
      do_tin_cay: `${Math.round(conf * 100)}%`,
      goi_y_cuoc_kelly: kelly,
      giai_thich: why.join(" | "),
      muc_do_rui_ro: riskLevel(conf, hist),
      meta: {
        logistic_pieces: pieces ? pieces.logistic : null,
        votes: pieces ? pieces.votes : null
      }
    };

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

app.get("/api/du-doan/full", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const detail = [];
    const start = Math.max(5, hist.length - 20);
    for (let i = start; i < hist.length; i++) {
      const past = hist.slice(0, i);
      const cur = hist[i];
      const predRes = ensemblePredict(past);
      detail.push({
        phien: cur.phien,
        ket_qua_thuc: cur.ket_qua === "T" ? "Tài" : "Xỉu",
        du_doan_tai_thoi_diem_do: predRes.pred === "T" ? "Tài" : "Xỉu",
        dung_khong: predRes.pred === cur.ket_qua,
        do_tin_cay: Math.round(predRes.conf * 100) + "%",
      });
    }

    const final = ensemblePredict(hist);
    const bt = overallBacktest(hist, 200);

    res.json({
      now: hist.at(-1)?.phien,
      next: hist.at(-1)?.phien + 1,
      du_doan_tiep: final.pred === "T" ? "Tài" : "Xỉu",
      do_tin_cay: Math.round(final.conf * 100) + "%",
      muc_do_rui_ro: riskLevel(final.conf, hist),
      giai_thich: final.why,
      backtest: {
        ty_le_thanh_cong: Math.round(bt.acc * 100) + "%",
        so_mau: bt.sample,
        final_bankroll: bt.bankroll
      },
      chi_tiet_20_phien_gan: detail,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

app.get("/api/backtest", async (req, res) => {
  // optional query: ?lookback=200
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });
    const lookback = Math.min(Number(req.query.lookback) || 200, hist.length - 1);
    const bt = overallBacktest(hist, lookback);
    res.json({
      lookback,
      acc: Math.round(bt.acc * 10000) / 100,
      sample: bt.sample,
      final_bankroll: bt.bankroll,
      recent_details: bt.details.slice(-50)
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

// ---------------------- START ----------------------

app.listen(PORT, () => {
  console.log(`VIP-ish Predictor running at http://localhost:${PORT}`);
});
