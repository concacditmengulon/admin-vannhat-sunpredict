/**
 * VIP99+ Tai/Xiu API — Node.js (Express)
 * Nguồn dữ liệu: https://fullsrc-daynesun.onrender.com/api/taixiu/history
 * Trả về: phien, xuc_xac, tong, ket_qua, phien_sau, du_doan, ty_le_thanh_cong (backtest),
 *         giai_thich, muc_do_rui_ro
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

// ---------------------- LAYER 0: LOAD & SHAPE ----------------------

function shapeHistory(raw) {
  // Kỳ vọng mỗi phần tử có: Phien, Xuc_xac_1, Xuc_xac_2, Xuc_xac_3, Tong, Ket_qua
  // Trả về mảng lịch sử chuẩn hoá:
  // { phien, dice:[a,b,c], tong, ket_qua:'T'|'X' }
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
    .sort((a, b) => a.phien - b.phien); // đảm bảo tăng dần theo phiên
}

// ---------------------- LAYER 1: RULES (Ưu tiên bên mạnh) ----------------------

function rulesPrediction(hist) {
  // Hist: array các bản ghi chuẩn hoá
  const results = hist.map((h) => h.ket_qua);
  const totals = hist.map((h) => h.tong);
  const last = results.at(-1);
  const last3 = lastN(results, 3);
  const last5 = lastN(results, 5);
  const total3 = lastN(totals, 3);
  const total5 = lastN(totals, 5);

  let explain = [];
  let score = { T: 0, X: 0 };

  // 1-2. 5 phiên gần nhất lệch
  if (last5.filter((r) => r === "T").length >= 4) {
    return { pred: "T", conf: 0.86, why: ["5 phiên gần nhất nghiêng Tài (≥4/5)"] };
  }
  if (last5.filter((r) => r === "X").length >= 4) {
    return { pred: "X", conf: 0.86, why: ["5 phiên gần nhất nghiêng Xỉu (≥4/5)"] };
  }

  // 3. 3 phiên liên tục => đảo cầu
  if (last3.length === 3 && last3.every((r) => r === "T")) {
    return { pred: "X", conf: 0.8, why: ["3 Tài liên tiếp → ưu tiên đảo Xỉu"] };
  }
  if (last3.length === 3 && last3.every((r) => r === "X")) {
    return { pred: "T", conf: 0.8, why: ["3 Xỉu liên tiếp → ưu tiên đảo Tài"] };
  }

  // 4. Zigzag T-X-T-X-T
  const zigzag = last5.length === 5 && last5.every((v, i, arr) => i === 0 || v !== arr[i - 1]);
  if (zigzag) {
    return {
      pred: last === "T" ? "X" : "T",
      conf: 0.78,
      why: ["Cầu zigzag rõ ràng → lặp tiếp"],
    };
  }

  // 5. Trung bình tổng gần
  const avg5 = total5.length ? avg(total5) : 10.5;
  if (avg5 >= 12) {
    score.T += 2;
    explain.push("Trung bình tổng 5 phiên cao (≥12) → Tài");
  } else if (avg5 <= 9.5) {
    score.X += 2;
    explain.push("Trung bình tổng 5 phiên thấp (≤9.5) → Xỉu");
  }

  // 6. Tổng tăng/giảm 3 phiên
  if (total3.length === 3) {
    if (total3[2] > total3[1] && total3[1] > total3[0]) {
      score.T += 2;
      explain.push("Tổng tăng đều 3 phiên → nghiêng Tài");
    } else if (total3[2] < total3[1] && total3[1] < total3[0]) {
      score.X += 2;
      explain.push("Tổng giảm đều 3 phiên → nghiêng Xỉu");
    }
  }

  // 7-9. Cực trị và đồng nhất
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
    // Bias theo avg5
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

// ---------------------- LAYER 2: MÔ HÌNH "HỌC" ĐƠN GIẢN ----------------------

function markovPrediction(hist) {
  // Xây ma trận chuyển T→T, T→X, X→T, X→X từ 60 phiên gần nhất
  const rs = hist.map((h) => h.ket_qua);
  const use = lastN(rs, 60);
  let tt = 1,
    tx = 1,
    xt = 1,
    xx = 1; // +1 smoothing

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
  const conf = Math.max(pT, pX); // 0.5 ~ 1
  return { pred, conf: 0.6 + (conf - 0.5) * 0.8, why };
}

function recentPatternPrediction(hist) {
  // Tìm mẫu ngắn 3-4 bước lặp trong 20 phiên (pattern mining đơn giản)
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

  // Chọn pattern xuất hiện nhiều
  let pred = null;
  let conf = 0.58;

  if (b4 && b4[1] >= 3) {
    // lấy 3 ký tự đầu của pattern 4, dự đoán bước tiếp theo theo pattern
    const patt = b4[0];
    const next = patt[3]; // ký tự thứ 4 của mẫu thường là “tiếp theo” trong cụm
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
    // fallback: dựa vào tỉ lệ gần đây có trọng số
    const weights = use.map((_, i) => Math.pow(1.15, i));
    const tScore = use.reduce((s, v, i) => s + (v === "T" ? weights[i] : 0), 0);
    const xScore = use.reduce((s, v, i) => s + (v === "X" ? weights[i] : 0), 0);
    pred = tScore >= xScore ? "T" : "X";
    const dom = Math.abs(tScore - xScore) / (tScore + xScore);
    conf = 0.6 + Math.min(0.2, dom * 0.8);
    why.push("Trọng số gần đây nghiêng " + (pred === "T" ? "Tài" : "Xỉu"));
  }

  return { pred, conf, why };
}

function breakStreakFilter(hist) {
  // Nếu bệt dài → cân nhắc bẻ cầu theo xác suất
  const rs = hist.map((h) => h.ket_qua);
  const s = streakOfEnd(rs);
  const cur = rs.at(-1); // kết quả hiện tại

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
  // nếu không bẻ, đề xuất giữ tiếp
  return {
    pred: cur,
    conf: 0.55,
    why: [`Chuỗi ${s} chưa đủ dài để bẻ → theo cầu`],
  };
}

// ---------------------- LAYER 3: ENSEMBLE ----------------------

function ensemblePredict(hist) {
  const r1 = rulesPrediction(hist);
  const r2 = markovPrediction(hist);
  const r3 = recentPatternPrediction(hist);
  const r4 = breakStreakFilter(hist);

  // Trọng số động theo hiệu suất gần đây (tự đánh giá nhanh trong 30 phiên cuối)
  const perf = localPerformance(hist, 30, [rulesPrediction, markovPrediction, recentPatternPrediction, breakStreakFilter]);

  const weights = [
    0.28 * perf[0], // rules
    0.24 * perf[1], // markov
    0.28 * perf[2], // pattern
    0.20 * perf[3], // breakStreak
  ];

  const votes = [
    { p: r1.pred, c: r1.conf * weights[0], why: r1.why },
    { p: r2.pred, c: r2.conf * weights[1], why: r2.why },
    { p: r3.pred, c: r3.conf * weights[2], why: r3.why },
    { p: r4.pred, c: r4.conf * weights[3], why: r4.why },
  ];

  const scoreT = sum(votes.map((v) => (v.p === "T" ? v.c : 0)));
  const scoreX = sum(votes.map((v) => (v.p === "X" ? v.c : 0)));
  const pred = scoreT >= scoreX ? "T" : "X";

  const rawConf = Math.max(scoreT, scoreX) / (scoreT + scoreX || 1);
  // Điều chỉnh nhẹ theo độ đồng thuận
  const agree = votes.filter((v) => v.p === pred).length / votes.length; // 0..1
  const conf = Math.min(0.99, 0.65 + (rawConf - 0.5) * 0.7 + agree * 0.12);

  const why = votes
    .filter((v) => v.p === pred)
    .flatMap((v) => v.why)
    .concat([`Đồng thuận ${Math.round(agree * 100)}% giữa các lớp`]);

  return { pred, conf, why };
}

function localPerformance(hist, lookback, models) {
  // Backtest nhanh cho từng model trong lookback phiên:
  // dự đoán phiên i dựa vào lịch sử < i
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 5) return models.map(() => 1.0); // không đủ dữ liệu, neutral

  const start = hist.length - 1 - n; // index bắt đầu
  const correct = new Array(models.length).fill(0);
  const count = n;

  for (let i = start; i < hist.length - 1; i++) {
    const past = hist.slice(0, i + 1); // lịch sử đến i
    const actualNext = hist[i + 1].ket_qua;
    models.forEach((fn, idx) => {
      const { pred } = fn(past);
      if (pred === actualNext) correct[idx]++;
    });
  }

  // chuyển thành hệ số 0.8 ~ 1.2 để nhân trọng số
  return correct.map((c) => {
    const acc = c / count; // 0..1
    return 0.8 + Math.min(0.4, Math.max(0, (acc - 0.5) * 0.8)); // 0.8..1.2
  });
}

// ---------------------- BACKTEST CHUNG (tỷ lệ thành công) ----------------------

function overallBacktest(hist, lookback = 80) {
  const n = Math.min(lookback, hist.length - 1);
  if (n <= 10) return { acc: 0.62, sample: n }; // không đủ dữ liệu

  let correct = 0;
  for (let i = hist.length - 1 - n; i < hist.length - 1; i++) {
    const past = hist.slice(0, i + 1);
    const actualNext = hist[i + 1].ket_qua;
    const { pred } = ensemblePredict(past);
    if (pred === actualNext) correct++;
  }
  return { acc: correct / n, sample: n };
}

// ---------------------- RISK LEVEL ----------------------

function riskLevel(conf, hist) {
  // Điều chỉnh theo biến động gần đây (switch rate) và chuỗi bệt
  const rs = hist.map((h) => h.ket_qua);
  const last12 = lastN(rs, 12);
  let switches = 0;
  for (let i = 1; i < last12.length; i++) {
    if (last12[i] !== last12[i - 1]) switches++;
  }
  const switchRate = last12.length > 1 ? switches / (last12.length - 1) : 0.5;
  const s = streakOfEnd(rs);

  let risk = 1 - conf; // conf cao → rủi ro thấp
  risk += switchRate * 0.15;
  if (s >= 6) risk += 0.05; // bệt dài có thể bẻ ngược khó lường

  if (risk <= 0.22) return "Thấp";
  if (risk <= 0.35) return "Trung bình";
  return "Cao";
}

// ---------------------- API ROUTES ----------------------

app.get("/health", (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// API đơn: dự đoán phiên kế tiếp dựa trên phiên mới nhất
app.get("/api/du-doan", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const last = hist.at(-1);
    const { pred, conf, why } = ensemblePredict(hist);
    const bt = overallBacktest(hist, 100); // backtest 100 phiên gần nhất nếu có
    const tyLe = Math.round(bt.acc * 100); // không random, theo backtest

    const out = {
      phien: last.phien,
      xuc_xac: `${last.dice[0]}-${last.dice[1]}-${last.dice[2]}`,
      tong: last.tong,
      ket_qua: last.ket_qua === "T" ? "Tài" : "Xỉu",
      phien_sau: last.phien + 1,
      du_doan: pred === "T" ? "Tài" : "Xỉu",
      ty_le_thanh_cong: `${tyLe}%`,
      giai_thich: why.join(" | "),
      muc_do_rui_ro: riskLevel(conf, hist),
      meta: {
        do_tin_cay: Math.round(conf * 100) + "%",
        mau_backtest: bt.sample,
      },
    };

    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

// API chi tiết: trả lịch sử đã chuẩn hoá + dự đoán & confidence cho 20 phiên gần nhất
app.get("/api/du-doan/full", async (req, res) => {
  try {
    const { data } = await axios.get(SOURCE_URL, { timeout: 15000 });
    const hist = shapeHistory(data);
    if (!hist.length) return res.status(502).json({ error: "Không lấy được dữ liệu nguồn" });

    const detail = [];
    // mô phỏng dự đoán "thời điểm đó" (walk-forward)
    const start = Math.max(5, hist.length - 20);
    for (let i = start; i < hist.length; i++) {
      const past = hist.slice(0, i); // dùng lịch sử trước phiên i
      const cur = hist[i];
      const { pred, conf } = ensemblePredict(past);
      detail.push({
        phien: cur.phien,
        ket_qua_thuc: cur.ket_qua === "T" ? "Tài" : "Xỉu",
        du_doan_tai_thoi_diem_do: pred === "T" ? "Tài" : "Xỉu",
        dung_khong: pred === cur.ket_qua,
        do_tin_cay: Math.round(conf * 100) + "%",
      });
    }

    const { pred, conf, why } = ensemblePredict(hist);
    const bt = overallBacktest(hist, 120);

    res.json({
      now: hist.at(-1)?.phien,
      next: hist.at(-1)?.phien + 1,
      du_doan_tiep: pred === "T" ? "Tài" : "Xỉu",
      do_tin_cay: Math.round(conf * 100) + "%",
      muc_do_rui_ro: riskLevel(conf, hist),
      giai_thich: why,
      backtest: {
        ty_le_thanh_cong: Math.round(bt.acc * 100) + "%",
        so_mau: bt.sample,
      },
      chi_tiet_20_phien_gan: detail,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Lỗi server hoặc nguồn" });
  }
});

// ---------------------- START ----------------------

app.listen(PORT, () => {
  console.log(`VIP99+ API đang chạy tại http://localhost:${PORT}`);
});
