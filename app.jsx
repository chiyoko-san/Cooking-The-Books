// ================================================================
//  お問い合わせ先の設定（ここを書き換えてください）
//  ・CONTACT_EMAIL: 表示・mailtoに使うメールアドレス
//  ・CONTACT_FORM_URL: Googleフォーム等のURL（空なら非表示）
// ================================================================
const CONTACT_EMAIL = "your-email@example.com";
const CONTACT_FORM_URL = ""; // 例: "https://forms.gle/xxxxxxxx"

const { useState, useMemo, useRef, useEffect } = React;

// ================================================================
//  Firebase 連携（ログイン＋クラウド成績＋ランキング）
//  ※ window.FIREBASE_CONFIG が設定されていれば有効。未設定なら
//    自動的に「端末内モード」で動作する（ログイン無しでも遊べる）。
// ================================================================
const FB = (() => {
  const cfg = (typeof window !== "undefined") ? window.FIREBASE_CONFIG : null;
  const ready = !!(cfg && cfg.apiKey && window.firebase && window.firebase.initializeApp);
  let auth = null, db = null;
  if (ready) {
    try {
      if (!window.firebase.apps || !window.firebase.apps.length) window.firebase.initializeApp(cfg);
      auth = window.firebase.auth();
      db = window.firebase.firestore();
    } catch (e) { console.warn("Firebase init failed:", e); return { enabled: false }; }
  }
  return { enabled: ready, auth, db, fb: window.firebase };
})();

// 認証ヘルパー
const cloud = {
  enabled: FB.enabled,
  onAuth(cb) { if (!FB.enabled) { cb(null); return () => {}; } return FB.auth.onAuthStateChanged(cb); },
  async signInEmail(email, pw) { return FB.auth.signInWithEmailAndPassword(email, pw); },
  async registerEmail(email, pw) { return FB.auth.createUserWithEmailAndPassword(email, pw); },
  async signInGoogle() { const p = new FB.fb.auth.GoogleAuthProvider(); return FB.auth.signInWithPopup(p); },
  async signOut() { return FB.auth.signOut(); },
  // プロフィール（表示名）保存・取得
  async getProfile(uid) { try { const d = await FB.db.collection("users").doc(uid).get(); return d.exists ? d.data() : null; } catch { return null; } },
  async setDisplayName(uid, name) { try { await FB.db.collection("users").doc(uid).set({ displayName: name }, { merge: true }); } catch {} },
  // 成績の集計ドキュメントを更新（1ユーザー1ドキュメント）
  async pushResult(uid, displayName, rec) {
    if (!FB.enabled || !uid) return;
    const ref = FB.db.collection("stats").doc(uid);
    try {
      await FB.db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const cur = snap.exists ? snap.data() : { attempts: 0, wins: 0, draws: 0, loses: 0, totalFakes: 0, totalHits: 0, scoreSum: 0 };
        cur.attempts += 1;
        cur.wins += rec.result === "win" ? 1 : 0;
        cur.draws += rec.result === "draw" ? 1 : 0;
        cur.loses += rec.result === "lose" ? 1 : 0;
        cur.totalFakes += rec.fakeTotal || 0;
        cur.totalHits += rec.hits || 0;
        cur.scoreSum += rec.score || 0;
        cur.displayName = displayName || cur.displayName || "匿名";
        cur.updatedAt = Date.now();
        tx.set(ref, cur, { merge: true });
      });
    } catch (e) { console.warn("pushResult failed", e); }
  },
  async getMyStats(uid) { if (!FB.enabled || !uid) return null; try { const d = await FB.db.collection("stats").doc(uid).get(); return d.exists ? d.data() : null; } catch { return null; } },
  async getRanking(limit = 20) {
    if (!FB.enabled) return [];
    try {
      const q = await FB.db.collection("stats").orderBy("wins", "desc").limit(limit).get();
      return q.docs.map((d) => ({ uid: d.id, ...d.data() }));
    } catch (e) { console.warn("ranking failed", e); return []; }
  },

  // ===== 公開出題（投稿） =====
  REPORT_THRESHOLD: 3, // 通報がこの数に達すると自動非表示
  async publishPost(uid, ownerName, meta, code) {
    if (!FB.enabled || !uid) throw new Error("not-logged-in");
    const doc = {
      title: sanitizeText(meta.title || "出題", 60),
      code, ownerUid: uid, ownerName: sanitizeText(ownerName || "匿名", 24),
      companyCount: meta.companyCount || 0, hasFx: !!meta.hasFx, periodCount: meta.periodCount || 1, clean: !!meta.clean,
      likeCount: 0, reportCount: 0, hidden: false, createdAt: Date.now(),
    };
    const ref = await FB.db.collection("posts").add(doc);
    return ref.id;
  },
  async listPosts({ sort = "new", limit = 40 } = {}) {
    if (!FB.enabled) return [];
    try {
      let q = FB.db.collection("posts").where("hidden", "==", false);
      q = q.orderBy(sort === "popular" ? "likeCount" : "createdAt", "desc").limit(limit);
      const snap = await q.get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (e) { console.warn("listPosts failed", e); return []; }
  },
  async hasLiked(postId, uid) {
    if (!FB.enabled || !uid) return false;
    try { const d = await FB.db.collection("posts").doc(postId).collection("likes").doc(uid).get(); return d.exists; } catch { return false; }
  },
  // ===== 保存（ブックマーク） =====
  async hasSaved(postId, uid) {
    if (!FB.enabled || !uid) return false;
    try { const d = await FB.db.collection("users").doc(uid).collection("saved").doc(postId).get(); return d.exists; } catch { return false; }
  },
  async toggleSave(postId, uid, meta) {
    if (!FB.enabled || !uid) throw new Error("not-logged-in");
    const ref = FB.db.collection("users").doc(uid).collection("saved").doc(postId);
    const snap = await ref.get();
    if (snap.exists) { await ref.delete(); return false; }
    await ref.set({ postId, savedAt: Date.now(), title: sanitizeText(meta?.title || "出題", 60), ownerName: sanitizeText(meta?.ownerName || "匿名", 24), companyCount: meta?.companyCount || 0, periodCount: meta?.periodCount || 1, clean: !!meta?.clean, code: meta?.code || "" });
    return true;
  },
  async listSaved(uid, limit = 60) {
    if (!FB.enabled || !uid) return [];
    try { const snap = await FB.db.collection("users").doc(uid).collection("saved").orderBy("savedAt", "desc").limit(limit).get(); return snap.docs.map((d) => ({ id: d.id, ...d.data() })); } catch (e) { console.warn("listSaved failed", e); return []; }
  },
  async toggleLike(postId, uid, meta) {
    if (!FB.enabled || !uid) throw new Error("not-logged-in");
    const postRef = FB.db.collection("posts").doc(postId);
    const likeRef = postRef.collection("likes").doc(uid);
    const myLikeRef = FB.db.collection("users").doc(uid).collection("liked").doc(postId);
    const nowLiked = await FB.db.runTransaction(async (tx) => {
      const likeSnap = await tx.get(likeRef);
      const postSnap = await tx.get(postRef);
      const cur = postSnap.exists ? (postSnap.data().likeCount || 0) : 0;
      if (likeSnap.exists) { tx.delete(likeRef); tx.update(postRef, { likeCount: Math.max(0, cur - 1) }); return false; }
      else { tx.set(likeRef, { at: Date.now() }); tx.update(postRef, { likeCount: cur + 1 }); return true; }
    });
    // マイページ用に自分のlikedリストも更新（本体の成否と別に）
    try {
      if (nowLiked) await myLikeRef.set({ postId, likedAt: Date.now(), title: sanitizeText(meta?.title || "出題", 60), ownerName: sanitizeText(meta?.ownerName || "匿名", 24), companyCount: meta?.companyCount || 0, periodCount: meta?.periodCount || 1, clean: !!meta?.clean, code: meta?.code || "" });
      else await myLikeRef.delete();
    } catch (e) { console.warn("liked list sync failed", e); }
    return nowLiked;
  },
  async listLiked(uid, limit = 60) {
    if (!FB.enabled || !uid) return [];
    try { const snap = await FB.db.collection("users").doc(uid).collection("liked").orderBy("likedAt", "desc").limit(limit).get(); return snap.docs.map((d) => ({ id: d.id, ...d.data() })); } catch (e) { console.warn("listLiked failed", e); return []; }
  },
  async reportPost(postId, uid, reason) {
    if (!FB.enabled || !uid) throw new Error("not-logged-in");
    const postRef = FB.db.collection("posts").doc(postId);
    const repRef = postRef.collection("reports").doc(uid);
    return FB.db.runTransaction(async (tx) => {
      const repSnap = await tx.get(repRef);
      if (repSnap.exists) return "already";
      const postSnap = await tx.get(postRef);
      const cur = postSnap.exists ? (postSnap.data().reportCount || 0) : 0;
      const next = cur + 1;
      tx.set(repRef, { at: Date.now(), reason: sanitizeText(reason || "", 200) });
      const upd = { reportCount: next };
      if (next >= cloud.REPORT_THRESHOLD) upd.hidden = true; // 自動非表示
      tx.update(postRef, upd);
      return "ok";
    });
  },
  // ===== 管理者 =====
  async isAdmin(uid) {
    if (!FB.enabled || !uid) return false;
    try { const d = await FB.db.collection("admins").doc(uid).get(); return d.exists; } catch { return false; }
  },
  async adminListReported(limit = 60) {
    if (!FB.enabled) return [];
    try {
      const snap = await FB.db.collection("posts").orderBy("reportCount", "desc").limit(limit).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => (p.reportCount || 0) > 0 || p.hidden);
    } catch (e) { console.warn("adminListReported failed", e); return []; }
  },
  async adminSetHidden(postId, hidden) {
    if (!FB.enabled) return;
    try { await FB.db.collection("posts").doc(postId).update({ hidden: !!hidden }); } catch (e) { console.warn(e); }
  },
  async adminDelete(postId) {
    if (!FB.enabled) return;
    try { await FB.db.collection("posts").doc(postId).delete(); } catch (e) { console.warn(e); }
  },
  async deleteOwnPost(postId, uid) {
    if (!FB.enabled || !uid) return;
    try { await FB.db.collection("posts").doc(postId).delete(); } catch (e) { console.warn(e); }
  },
};

// 入力文字の無害化（HTMLタグ除去・長さ制限・制御文字除去）
function sanitizeText(s, maxLen) {
  let t = String(s == null ? "" : s);
  t = t.replace(/[<>]/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (maxLen && t.length > maxLen) t = t.slice(0, maxLen);
  return t;
}

// ブラウザ単体(GitHub Pages)で動かすためのストレージ＆共有リンク基盤
// window.storage が無い環境では localStorage を使うシムを提供
const storage = (typeof window !== "undefined" && window.storage && typeof window.storage.get === "function") ? window.storage : {
  async get(key) { const v = localStorage.getItem(key); return v == null ? null : { key, value: v }; },
  async set(key, value) { localStorage.setItem(key, value); return { key, value }; },
  async delete(key) { localStorage.removeItem(key); return { key, deleted: true }; },
};
// 共有リンク: 常にトップ（ベース）URL + #データ。サブページ(/build/等)からでも安定。
function baseSiteUrl() {
  let p = location.pathname.replace(/(build|library|rules|explore|admin|practice)\/?$/, "");
  if (!p.endsWith("/")) p += "/";
  return location.origin + p;
}
function makeShareLink(code) {
  return baseSiteUrl() + "#play=" + encodeURIComponent(code);
}
// URLの#からプレイ用コードを取り出す
function readHashCode() {
  const h = location.hash || "";
  const m = h.match(/[#&]play=([^&]+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
function clearHash() {
  history.replaceState(null, "", location.origin + location.pathname);
}

// ================================================================
//  連結粉飾 対局 v4 —— 粉飾者 VS 調査官
//  v4: PL/BSフル科目化 / 基本+詳細トグル / 科目説明ポップアップ /
//      新科目（特別損益・税金・固定資産・借入金等）も粉飾対象
// ================================================================

const C = {
  bg: "#ffffff", panel: "#f6f8fa", panel2: "#eef1f5", edge: "#dfe4ea",
  ink: "#1a2230", dim: "#5a6675", faint: "#9aa4b2",
  amber: "#1f3a5f", teal: "#1f6f8b", red: "#c0392b", green: "#2e7d52",
};
const MONO = "'Courier New', ui-monospace, monospace";
const DISP = "-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic', Meiryo, sans-serif";

// ---- 科目スキーマ ---------------------------------------------
// statement: pl|bs / tier: basic|detail / sign: 利益への寄与(+/-/0)
// desc: タップで出る説明
const ACCOUNTS = [
  // ===== 損益計算書 PL =====
  { key: "sales",        label: "売上高",       stmt: "pl", tier: "basic",  hint: "本業の総収入", desc: "本業で得た収益の総額。架空売上（実在しない取引の計上）の典型的ターゲット。膨らませると売掛金や利益にも波及する。" },
  { key: "cogs",         label: "売上原価",     stmt: "pl", tier: "basic",  hint: "仕入・製造の直接費", desc: "売った商品・サービスにかかった直接費用。意図的に小さく見せる（在庫へ付け替える）と粗利が水増しされる。" },
  { key: "sga",          label: "販管費",       stmt: "pl", tier: "basic",  hint: "人件費・広告・家賃など", desc: "販売費及び一般管理費。人件費・広告費・家賃など本業の間接費。費用の先送りや簿外化で利益操作に使われる。" },
  { key: "nonOpInc",     label: "営業外収益",   stmt: "pl", tier: "detail", hint: "受取利息・配当など", desc: "受取利息・配当金・為替差益など本業以外の収益。経常利益を底上げするために水増しされることがある。" },
  { key: "nonOpExp",     label: "営業外費用",   stmt: "pl", tier: "detail", hint: "支払利息など", desc: "支払利息など本業以外の費用。隠したり過小計上して経常利益をよく見せる操作の対象。" },
  { key: "extraInc",     label: "特別利益",     stmt: "pl", tier: "detail", hint: "資産売却益など臨時", desc: "固定資産売却益など一時的・臨時の利益。実体のない利益計上や、本業不振を覆い隠す目的で使われやすい。" },
  { key: "extraLoss",    label: "特別損失",     stmt: "pl", tier: "detail", hint: "減損・災害など臨時損", desc: "減損損失・災害損失など臨時の損失。計上を先送り・隠蔽して純利益を大きく見せる粉飾の対象。" },
  { key: "tax",          label: "法人税等",     stmt: "pl", tier: "detail", hint: "利益にかかる税金", desc: "利益に課される税金。過小計上すると当期純利益が不自然に膨らむ。税引前利益との比率（実効税率）が手がかり。" },

  // ===== 貸借対照表 BS（資産） =====
  { key: "cash",         label: "現金預金",     stmt: "bs", tier: "basic",  hint: "手元の資金", desc: "手元資金。最も操作しにくい科目。利益は出ているのに現金が乏しい場合、利益が架空である疑いが強まる。" },
  { key: "receivables",  label: "売掛金",       stmt: "bs", tier: "basic",  hint: "未回収の売上代金", desc: "未回収の販売代金。架空売上の受け皿。売上比で異常に膨らんでいれば回収されない（実在しない）売上の疑い。" },
  { key: "inventory",    label: "棚卸資産",     stmt: "bs", tier: "basic",  hint: "在庫", desc: "在庫。原価を付け替えて隠す先。原価率が不自然に低く在庫が膨張していれば、費用の繰延べ（粉飾）の疑い。" },
  { key: "fixedAssets",  label: "固定資産",     stmt: "bs", tier: "detail", hint: "建物・機械・土地など", desc: "建物・機械・土地など長期保有資産。減損を回避（簿価据え置き）して資産・利益を過大に見せる操作の対象。" },
  // ===== BS（負債・純資産） =====
  { key: "payables",     label: "買掛金",       stmt: "bs", tier: "detail", hint: "未払いの仕入代金", desc: "未払いの仕入代金。過小計上すると負債が軽く見え、財務健全性を装える。仕入・原価との整合が手がかり。" },
  { key: "shortDebt",    label: "短期借入金",   stmt: "bs", tier: "detail", hint: "1年内返済の借入", desc: "1年以内返済の借入。簿外債務として隠されることがある。利息（営業外費用）との対応が崩れていれば疑わしい。" },
  { key: "longDebt",     label: "長期借入金",   stmt: "bs", tier: "detail", hint: "長期の借入", desc: "長期の借入。隠れ債務の温床。資産規模に比べ不自然に少なければ簿外化の疑い。" },
  { key: "equity",       label: "純資産",       stmt: "bs", tier: "detail", hint: "資本金＋利益剰余金など", desc: "資産から負債を引いた正味の持ち分。水増しした利益はここに積み上がる。資産＝負債＋純資産の均衡が崩れていないかが鍵。" },
];
const A_BY_KEY = Object.fromEntries(ACCOUNTS.map((a) => [a.key, a]));
const PL_KEYS = ACCOUNTS.filter((a) => a.stmt === "pl").map((a) => a.key);
const BS_ASSET_KEYS = ["cash", "receivables", "inventory", "fixedAssets"];
const BS_LIAB_KEYS = ["payables", "shortDebt", "longDebt", "equity"];
const DETAIL_KEYS = ACCOUNTS.filter((a) => a.tier === "detail").map((a) => a.key);

const emptyFin = () => Object.fromEntries(ACCOUNTS.map((a) => [a.key, 0]));

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ja-JP");
const num = (f, k) => Number(f[k]) || 0;

// ---- 集計（PL段階利益 / BS均衡） ------------------------------
function grossProfit(f) { return num(f, "sales") - num(f, "cogs"); }
function opProfit(f) { return grossProfit(f) - num(f, "sga"); }
function ordProfit(f) { return opProfit(f) + num(f, "nonOpInc") - num(f, "nonOpExp"); }
function pretaxProfit(f) { return ordProfit(f) + num(f, "extraInc") - num(f, "extraLoss"); }
function netIncome(f) { return pretaxProfit(f) - num(f, "tax"); }
function totalAssets(f) { return BS_ASSET_KEYS.reduce((s, k) => s + num(f, k), 0); }
function totalLiabEquity(f) { return BS_LIAB_KEYS.reduce((s, k) => s + num(f, k), 0); }
function bsGap(f) { return totalAssets(f) - totalLiabEquity(f); }

// ---- キャッシュフロー計算書（間接法・簡易）-------------------
// 当期fin と 前期prevFin の差分から3区分CFを導く。
// 減価償却は固定資産の一定率(depRate)を仮定し、営業CFに足し戻す＝現実に近い形。
// 戻り値の cashDelta（=営業+投資+財務）は、現金の期差に概ね一致するよう設計。
function cashFlow(fin, prevFin, depRate = 0.05) {
  if (!prevFin) return null;
  const d = (k) => num(fin, k) - num(prevFin, k); // 当期増加（プラス＝増えた）
  const ni = netIncome(fin);
  // 減価償却費（前期末固定資産 × 率）。投資CFと営業CFで整合させる。
  const dep = Math.max(0, Math.round(num(prevFin, "fixedAssets") * depRate));
  // 営業CF：純利益 ＋ 減価償却 − 運転資本の増加（売掛・在庫の増は現金流出、買掛の増は現金流入）
  const wcUp = d("receivables") + d("inventory") - d("payables");
  const cfo = ni + dep - wcUp;
  // 投資CF：固定資産の純増 ＋ 当期減価償却 ＝ おおよその設備投資（流出）
  const capex = d("fixedAssets") + dep;
  const cfi = -capex;
  // 財務CF：借入金の純増（流入）＋ 増資など（ここでは純資産のうち利益剰余以外の動き＝近似で0）
  const cff = d("shortDebt") + d("longDebt");
  const cashDelta = cfo + cfi + cff;
  return {
    cfo, cfi, cff, cashDelta, dep,
    niMinusCfo: ni - cfo,           // 利益と営業CFの乖離（プラス大＝危険サイン）
    actualCashDelta: d("cash"),     // 実際の現金増減（参考）
  };
}

const rnd = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const uid = () => Math.random().toString(36).slice(2, 8);

// ---- 通貨 -----------------------------------------------------
const CURRENCIES = {
  JPY: { name: "円", sym: "¥", market: 1, band: 0 },
  USD: { name: "米ドル", sym: "$", market: 150, band: 8 },
  EUR: { name: "ユーロ", sym: "€", market: 162, band: 8 },
  CNY: { name: "人民元", sym: "元", market: 21, band: 10 },
  THB: { name: "バーツ", sym: "฿", market: 4.3, band: 12 },
};
const CURRENCY_KEYS = Object.keys(CURRENCIES);

const INDUSTRIES = {
  manufacturing: { name: "製造業", icon: "⚙", cogs: [62,75], recvDays:[45,75], invDays:[50,90], sgaRate:[40,60], salesRange:[800,1600], note:"在庫・売掛とも厚め。原価率は高い。" },
  retail:        { name: "小売業", icon: "🛒", cogs: [68,82], recvDays:[5,25],  invDays:[30,60], sgaRate:[55,80], salesRange:[1000,2200], note:"現金商売で売掛が薄い。原価率高い。" },
  software:      { name: "ソフトウェア", icon: "⌘", cogs:[15,35], recvDays:[40,70], invDays:[0,10], sgaRate:[45,70], salesRange:[600,1400], note:"在庫ほぼ無し。原価率が低い。" },
  construction:  { name: "建設業", icon: "🏗", cogs:[78,90], recvDays:[70,130], invDays:[40,100], sgaRate:[30,50], salesRange:[1200,2800], note:"原価率が非常に高い。売掛回収が長い。" },
  trading:       { name: "商社", icon: "⇄", cogs:[85,95], recvDays:[40,80], invDays:[20,55], sgaRate:[25,45], salesRange:[2000,5000], note:"原価率が極めて高い。内部取引が多い。" },
  services:      { name: "サービス業", icon: "✦", cogs:[35,55], recvDays:[25,55], invDays:[0,15], sgaRate:[50,75], salesRange:[500,1200], note:"在庫ほぼ無し。原価率は中〜低。" },
};
const INDUSTRY_KEYS = Object.keys(INDUSTRIES);

function rateOf(c) { return c.currency === "JPY" ? 1 : (Number(c.fxRate) || CURRENCIES[c.currency].market); }
function finJPY(c) { const r = rateOf(c); const o = {}; const f = curFin(c); for (const k of Object.keys(emptyFin())) o[k] = num(f, k) * r; return o; }
function fxAbusive(c) {
  if (c.currency === "JPY") return false;
  const m = CURRENCIES[c.currency], r = rateOf(c);
  const hi = m.market * (1 + (m.band + 12) / 100), lo = m.market * (1 - (m.band + 12) / 100);
  return r > hi || r < lo;
}

// ---- 業種に沿った健全決算（PL/BSフル） ------------------------
function genHealthyFin(industryKey) {
  const p = INDUSTRIES[industryKey];
  const f = emptyFin();
  const sales = rnd(p.salesRange[0], p.salesRange[1]);
  const cogs = Math.round(sales * (rnd(p.cogs[0], p.cogs[1]) / 100));
  const gross = sales - cogs;
  const sga = Math.round(gross * (rnd(p.sgaRate[0], p.sgaRate[1]) / 100));
  f.sales = sales; f.cogs = cogs; f.sga = sga;
  // 営業外・特別・税金
  f.nonOpInc = Math.round(sales * (rnd(0, 3) / 100));
  f.nonOpExp = Math.round(sales * (rnd(1, 4) / 100));
  f.extraInc = Math.random() < 0.3 ? rnd(10, 80) : 0;
  f.extraLoss = Math.random() < 0.3 ? rnd(10, 80) : 0;
  const pretax = (sales - cogs - sga) + f.nonOpInc - f.nonOpExp + f.extraInc - f.extraLoss;
  f.tax = Math.max(0, Math.round(pretax * (rnd(28, 34) / 100)));
  // BS資産
  f.receivables = Math.round(sales * (rnd(p.recvDays[0], p.recvDays[1]) / 365));
  f.inventory = Math.round(cogs * (rnd(p.invDays[0], p.invDays[1]) / 365));
  f.fixedAssets = Math.round(sales * (rnd(30, 80) / 100));
  const op = sales - cogs - sga;
  f.cash = Math.max(40, Math.round(op * (rnd(50, 110) / 100)) + rnd(50, 200));
  // BS負債・純資産（資産に完全一致させる＝貸借差額0を保証）
  const assets = f.cash + f.receivables + f.inventory + f.fixedAssets;
  f.payables = Math.round(cogs * (rnd(8, 18) / 100));
  let debtTotal = Math.round(assets * (rnd(25, 50) / 100));
  // 純資産が資産の15%以上残るよう負債を上限調整
  const maxDebt = assets - f.payables - Math.round(assets * 0.15);
  if (debtTotal > maxDebt) debtTotal = Math.max(0, maxDebt);
  f.shortDebt = Math.round(debtTotal * (rnd(30, 55) / 100));
  f.longDebt = debtTotal - f.shortDebt;
  f.equity = assets - f.payables - f.shortDebt - f.longDebt; // 残差＝必ず均衡
  return f;
}

// ===== 超級: 循環取引型・複数期の生成 =====
// 設計: parent(親) と sub(連結子会社) の2社。子会社で架空循環取引による売上を計上。
// 架空売上は現金を生まず売掛金に滞留 → 営業CFが利益から乖離 → 不足を親会社からのグループ融資(長期借入)で穴埋め。
// これを3期、規模を年々拡大させて、CFの悪化が時系列で見える形にする。
// 返り値: { companies, internalTxns, fakes, fxFakes, periodCount, clean:false }
function genCircularElite(periodCount = 3) {
  const pcount = Math.max(2, Math.min(4, periodCount));
  const parentInd = "services";   // 広告代理など
  const subInd = "software";
  // --- 子会社の各期を生成（健全ベース → 架空循環を年々上乗せ）---
  const subBase = genHealthyFin(subInd);
  const subPeriods = [];
  let prevSub = null;
  for (let t = 0; t < pcount; t++) {
    // 健全な事業の自然成長（年5〜12%）
    const g = 1 + (rnd(5, 12) / 100) * t;
    const f = emptyFin();
    f.sales = Math.round(subBase.sales * g);
    f.cogs = Math.round(f.sales * (num(subBase, "cogs") / num(subBase, "sales")));
    f.sga = Math.round(subBase.sga * g);
    f.nonOpInc = Math.round(subBase.nonOpInc * g);
    f.nonOpExp = Math.round(subBase.nonOpExp * g);
    f.receivables = Math.round(subBase.receivables * g);
    f.inventory = Math.round(subBase.inventory * g);
    f.fixedAssets = Math.round(subBase.fixedAssets * g);
    f.payables = Math.round(subBase.payables * g);

    // --- 架空循環取引の上乗せ（規模は年々拡大: t=0でも少し、t増で大きく）---
    const fakeRate = 0.18 + 0.10 * t; // 売上に対する架空比率が年々増加
    const fakeSales = Math.round(f.sales * fakeRate);
    f.sales += fakeSales;
    f.cogs += Math.round(fakeSales * 0.85); // 循環なので原価もほぼ同額計上（利益は薄い）
    // 架空売上は現金回収されず売掛金に滞留（全額＋既存売掛）
    f.receivables += Math.round(fakeSales * 1.05);

    // 税金（架空利益にも課税される＝現金流出）
    const pretax = (f.sales - f.cogs - f.sga) + f.nonOpInc - f.nonOpExp;
    f.tax = Math.max(0, Math.round(pretax * (rnd(30, 34) / 100)));

    // --- 資金繰り: 売掛膨張で不足する現金を、親会社グループ融資(長期借入)で補填 ---
    // まず現金を健全水準に置き、不足分を長期借入で賄う構造にする
    f.cash = Math.max(30, Math.round(subBase.cash * g * 0.4)); // 現金は薄い（循環で枯渇気味）
    const assets = f.cash + f.receivables + f.inventory + f.fixedAssets;
    // 借入: 売掛膨張に連動して年々拡大（グループ融資の原資）
    f.shortDebt = Math.round(subBase.sales * 0.05 * g);
    f.longDebt = Math.round(fakeSales * 1.1 * (1 + 0.2 * t)); // 架空売上を借入で支える
    // 純資産は残差で均衡（薄利なので積み上がりは小さい）
    f.equity = assets - f.payables - f.shortDebt - f.longDebt;
    // 純資産が極端なマイナスにならないよう、不足は長期借入を圧縮して調整
    if (f.equity < Math.round(assets * 0.05)) {
      const need = Math.round(assets * 0.05) - f.equity;
      f.longDebt = Math.max(0, f.longDebt - need);
      f.equity = assets - f.payables - f.shortDebt - f.longDebt;
    }
    subPeriods.push(f);
    prevSub = f;
  }

  // --- 親会社の各期（健全。子会社へのグループ融資を貸付として持つ）---
  const parentBase = genHealthyFin(parentInd);
  // 親は子より規模大きめに
  const scale = 1.6;
  const parentPeriods = [];
  for (let t = 0; t < pcount; t++) {
    const g = 1 + (rnd(4, 9) / 100) * t;
    const f = emptyFin();
    f.sales = Math.round(parentBase.sales * scale * g);
    f.cogs = Math.round(f.sales * (num(parentBase, "cogs") / num(parentBase, "sales")));
    f.sga = Math.round(parentBase.sga * scale * g);
    f.nonOpInc = Math.round(parentBase.nonOpInc * scale * g);
    f.nonOpExp = Math.round(parentBase.nonOpExp * scale * g);
    const pretax = (f.sales - f.cogs - f.sga) + f.nonOpInc - f.nonOpExp;
    f.tax = Math.max(0, Math.round(pretax * (rnd(30, 34) / 100)));
    f.receivables = Math.round(parentBase.receivables * scale * g);
    f.inventory = Math.round(parentBase.inventory * scale * g);
    f.fixedAssets = Math.round(parentBase.fixedAssets * scale * g);
    f.payables = Math.round(parentBase.payables * scale * g);
    f.cash = Math.max(60, Math.round(parentBase.cash * scale * g));
    const assets = f.cash + f.receivables + f.inventory + f.fixedAssets;
    let debtTotal = Math.round(assets * (rnd(25, 40) / 100));
    f.shortDebt = Math.round(debtTotal * 0.4);
    f.longDebt = debtTotal - f.shortDebt;
    f.equity = assets - f.payables - f.shortDebt - f.longDebt;
    parentPeriods.push(f);
  }

  const pcid = "pe" + Math.random().toString(36).slice(2, 6);
  const scid = "se" + Math.random().toString(36).slice(2, 6);
  // 内部取引（循環取引の痕跡として、親子間の取引額を提示）
  const lastSub = subPeriods[pcount - 1];
  const internalTxns = [{ from: pcid, to: scid, amount: Math.round(num(lastSub, "longDebt") * 0.6) }];

  return {
    v: 5, periodCount: pcount, elite: true, hasCF: true,
    title: "超級 循環取引の罠",
    companies: [
      { cid: pcid, role: "parent", name: "親会社（持株）", industry: parentInd, currency: "JPY", fxRate: 1, periods: parentPeriods, fin: parentPeriods[pcount - 1], hint: "" },
      { cid: scid, role: "sub", name: "広告子会社", industry: subInd, currency: "JPY", fxRate: 1, periods: subPeriods, fin: subPeriods[pcount - 1],
        hint: "売上は伸びているが…現金の動き（CF）と借入の増え方に注目。" },
    ],
    internalTxns,
    fakes: [{ cid: scid, key: "sales" }, { cid: scid, key: "receivables" }],
    fxFakes: [], circular: true, clean: false,
  };
}

// ---- 粉飾を仕込む（各手口が必ず「調査官に見える痕跡」を残す） -----
// 見える痕跡 = 原価率(cogs)/売掛日数(recv)/在庫日数(inv)/実効税率(tax)/貸借差額(bs)
function injectFraud(fin, industryKey) {
  const tactics = ["fakeSales", "deferCost", "padInventory", "hideExtraLoss", "underTax", "hideDebt"];
  const chosen = [...tactics].sort(() => Math.random() - 0.5).slice(0, rnd(1, 3));
  const fakedKeys = [];
  const f = { ...fin };
  const p = INDUSTRIES[industryKey];
  for (const t of chosen) {
    if (t === "fakeSales") {
      // 売掛日数が業種上限+25日を確実に超えるよう、売掛を上乗せ
      const fake = rnd(Math.round(f.sales * 0.15), Math.round(f.sales * 0.28));
      f.sales += fake;
      const targetRecvDays = p.recvDays[1] + rnd(35, 70);
      const targetRecv = Math.round(f.sales * targetRecvDays / 365);
      f.receivables = Math.max(f.receivables + Math.round(fake * 1.1), targetRecv);
      f.fixedAssets += fake; // 貸借維持（架空売上は資産側に滞留）
      fakedKeys.push("sales", "receivables");
    } else if (t === "deferCost") {
      // 原価を減らし、その分を在庫へ。在庫日数が確実に超過するよう積む
      const hide = rnd(Math.round(f.cogs * 0.12), Math.round(f.cogs * 0.22));
      f.cogs = Math.max(1, f.cogs - hide);
      const targetInvDays = p.invDays[1] + rnd(35, 70);
      const targetInv = Math.round(f.cogs * targetInvDays / 365);
      f.inventory = Math.max(f.inventory + Math.round(hide * 1.1), targetInv);
      fakedKeys.push("cogs", "inventory");
    } else if (t === "padInventory") {
      const targetInvDays = p.invDays[1] + rnd(40, 80);
      const targetInv = Math.round(Math.max(1, f.cogs) * targetInvDays / 365);
      const pad = Math.max(40, targetInv - f.inventory);
      f.inventory += pad;
      f.payables += pad; // 仕入れ未払いとして貸借維持（bsは崩さない＝在庫痕跡で見抜く）
      fakedKeys.push("inventory");
    } else if (t === "hideExtraLoss") {
      // 計上すべき特別損失を消し、固定資産に残す→貸借差額(bs)に必ず出る
      const should = rnd(120, 280);
      f.extraLoss = 0;
      f.fixedAssets += should; // 負債・純資産は動かさない→資産超過＝bs痕跡
      fakedKeys.push("extraLoss", "fixedAssets");
    } else if (t === "underTax") {
      // 税引前利益>50を確保しつつ実効税率を18%未満に
      let pretax = pretaxProfit(f);
      if (pretax <= 60) { // 利益が薄いと痕跡が出ないので、営業利益を少し持ち上げる
        const bump = 80 - Math.min(80, pretax);
        f.sga = Math.max(0, f.sga - bump);
        pretax = pretaxProfit(f);
      }
      f.tax = Math.round(pretax * (rnd(4, 14) / 100)); // 4〜14% に圧縮
      fakedKeys.push("tax");
    } else if (t === "hideDebt") {
      // 負債を消すが純資産で埋めない→貸借差額(bs)が必ず出る
      const totalDebt = f.shortDebt + f.longDebt || 100;
      const hide = rnd(Math.round(totalDebt * 0.3), Math.round(totalDebt * 0.5) + 50);
      if (f.longDebt >= hide) { f.longDebt -= hide; fakedKeys.push("longDebt"); }
      else if (f.longDebt > 0) { fakedKeys.push("longDebt"); f.shortDebt = Math.max(0, f.shortDebt - (hide - f.longDebt)); f.longDebt = 0; }
      else { f.shortDebt = Math.max(0, f.shortDebt - hide); fakedKeys.push("shortDebt"); }
    }
  }
  return { fin: f, fakedKeys: [...new Set(fakedKeys)] };
}

// 修正1: 自動粉飾は「全架空科目が痕跡を残す」ことを保証（最大12回再試行）
function injectFraudWithTrace(baseFin, industryKey, prevFin) {
  let best = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = injectFraud(baseFin, industryKey);
    const co = { industry: industryKey, periods: prevFin ? [prevFin, res.fin] : [res.fin] };
    const fl = flagsWithOp(industryKey, res.fin);
    const cp = prevFin ? crossPeriodTraces(co) : new Set();
    const allTraced = res.fakedKeys.every((k) => {
      const tr = TRACE_BY_KEY[k] || [];
      return tr.some((t) => fl[t] === "warn") || cp.has(k);
    });
    if (allTraced) return res;
    best = res; // 最後の候補は保持
  }
  // 万一痕跡が付かない手口が残った場合、痕跡のある科目だけ採用
  if (best) {
    const fl = flagsWithOp(industryKey, best.fin);
    best.fakedKeys = best.fakedKeys.filter((k) => (TRACE_BY_KEY[k] || []).some((t) => fl[t] === "warn"));
  }
  return best;
}
function consolidate(companies, internalTxns) {
  const sum = emptyFin();
  for (const c of companies) { const j = finJPY(c); for (const k of Object.keys(sum)) sum[k] += j[k]; }
  let elim = 0;
  for (const t of internalTxns) elim += Number(t.amount) || 0;
  const cons = { ...sum };
  cons.sales -= elim; cons.cogs -= elim;
  cons.receivables -= Math.round(elim * 0.5);
  cons.payables -= Math.round(elim * 0.5);
  cons.inventory -= Math.round(elim * 0.3);
  return { sum, cons, elim };
}

// ===== 練習モード: 難易度レベル定義 =====
const PRACTICE_LEVELS = [
  { id: 1, name: "初級① 売上の嘘", tier: "初級", learn: "架空売上を見抜く。売れているのに代金（売掛金）が入っていないのがサイン。", tactics: ["fakeSales"], clean: false, industries: ["retail", "manufacturing"] },
  { id: 2, name: "初級② 原価のごまかし", tier: "初級", learn: "売上原価を在庫に付け替える手口。原価率が下がり在庫が積み上がる。", tactics: ["deferCost"], clean: false, industries: ["manufacturing", "retail"] },
  { id: 3, name: "初級③ 在庫の水増し", tier: "初級", learn: "在庫を過大計上。在庫回転日数が異常に長くなる。", tactics: ["padInventory"], clean: false, industries: ["manufacturing", "trading"] },
  { id: 4, name: "中級① 損失隠し", tier: "中級", learn: "計上すべき特別損失を資産に残す。貸借が一致しなくなる。", tactics: ["hideExtraLoss"], clean: false, industries: ["manufacturing", "construction"] },
  { id: 5, name: "中級② 税金と負債", tier: "中級", learn: "税金の過小計上・借入金の簿外化。税率や貸借差額に出る。", tactics: ["underTax", "hideDebt"], clean: false, industries: ["software", "services"] },
  { id: 6, name: "中級③ 健全を見抜く", tier: "中級", learn: "あえて粉飾の無い決算。むやみに疑わず「シロ」と見抜けるか。", tactics: [], clean: true, industries: ["retail", "software", "services"] },
  { id: 7, name: "上級 実戦（複合）", tier: "上級", learn: "複数の手口がランダムに仕込まれる。総合力が試される本番形式。", tactics: null, clean: false, industries: ["manufacturing", "retail", "software", "construction", "trading", "services"] },
  { id: 8, name: "超級 循環取引の罠", tier: "超級", learn: "KDDI事件型。子会社の架空循環取引で増収増益に見えるが、現金（CF）が伴わない。営業CFと利益の乖離、借入による穴埋めを見抜く。複数期・CF計算書つき。", generator: "circularElite", clean: false, industries: [] },
];

// レベルに対応する称号
const RANK_TITLES = { "初級": "新人調査官", "中級": "会計係", "上級": "公認会計士", "超級": "主任監査人", "最難級": "不正会計のプロ" };

// 指定タクティクスのみで粉飾（痕跡保証つき、最大16回再試行）
function injectFraudTactics(fin, industryKey, tactics) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const f = { ...fin };
    const p = INDUSTRIES[industryKey];
    const fakedKeys = [];
    for (const t of tactics) {
      if (t === "fakeSales") {
        const fake = rnd(Math.round(f.sales * 0.15), Math.round(f.sales * 0.28));
        f.sales += fake;
        const targetRecv = Math.round(f.sales * (p.recvDays[1] + rnd(35, 70)) / 365);
        f.receivables = Math.max(f.receivables + Math.round(fake * 1.1), targetRecv);
        f.fixedAssets += fake; fakedKeys.push("sales", "receivables");
      } else if (t === "deferCost") {
        const hide = rnd(Math.round(f.cogs * 0.12), Math.round(f.cogs * 0.22));
        f.cogs = Math.max(1, f.cogs - hide);
        const targetInv = Math.round(f.cogs * (p.invDays[1] + rnd(35, 70)) / 365);
        f.inventory = Math.max(f.inventory + Math.round(hide * 1.1), targetInv);
        fakedKeys.push("cogs", "inventory");
      } else if (t === "padInventory") {
        const targetInv = Math.round(Math.max(1, f.cogs) * (p.invDays[1] + rnd(40, 80)) / 365);
        const pad = Math.max(40, targetInv - f.inventory);
        f.inventory += pad; f.payables += pad; fakedKeys.push("inventory");
      } else if (t === "hideExtraLoss") {
        const should = rnd(120, 280); f.extraLoss = 0; f.fixedAssets += should; fakedKeys.push("extraLoss", "fixedAssets");
      } else if (t === "underTax") {
        let pretax = pretaxProfit(f);
        if (pretax <= 60) { const bump = 80 - Math.min(80, pretax); f.sga = Math.max(0, f.sga - bump); pretax = pretaxProfit(f); }
        f.tax = Math.round(pretax * (rnd(4, 14) / 100)); fakedKeys.push("tax");
      } else if (t === "hideDebt") {
        const totalDebt = f.shortDebt + f.longDebt || 100;
        const hide = rnd(Math.round(totalDebt * 0.3), Math.round(totalDebt * 0.5) + 50);
        if (f.longDebt >= hide) { f.longDebt -= hide; fakedKeys.push("longDebt"); }
        else if (f.longDebt > 0) { fakedKeys.push("longDebt"); f.shortDebt = Math.max(0, f.shortDebt - (hide - f.longDebt)); f.longDebt = 0; }
        else { f.shortDebt = Math.max(0, f.shortDebt - hide); fakedKeys.push("shortDebt"); }
      }
    }
    const keys = [...new Set(fakedKeys)];
    const fl = flagsWithOp(industryKey, f);
    const allTraced = keys.every((k) => (TRACE_BY_KEY[k] || []).some((tt) => fl[tt] === "warn"));
    if (allTraced) return { fin: f, fakedKeys: keys };
  }
  return null;
}

// レベルから1社の練習出題（payload）を生成
function makePracticeChallenge(level) {
  // 超級: 循環取引×複数期×CF
  if (level.generator === "circularElite") {
    return genCircularElite(3);
  }
  const ind = level.industries[rnd(0, level.industries.length - 1)];
  if (level.clean) {
    const fin = genHealthyFin(ind);
    return practicePayload(ind, fin, [], true, level);
  }
  const base = genHealthyFin(ind);
  let res = null;
  if (level.tactics) {
    res = injectFraudTactics(base, ind, level.tactics);
  }
  if (!res) res = injectFraudWithTrace(base, ind) || injectFraud(base, ind);
  return practicePayload(ind, res.fin, res.fakedKeys, false, level);
}
function practicePayload(ind, fin, fakedKeys, clean, level) {
  const cid = "p" + Math.random().toString(36).slice(2, 7);
  return {
    v: 5, periodCount: 1, practice: true, levelId: level.id,
    title: `練習 ${level.name}`,
    companies: [{ cid, role: "parent", name: "練習カンパニー", industry: ind, currency: "JPY", fxRate: 1, periods: [fin], fin }],
    internalTxns: [], fakes: clean ? [] : fakedKeys.map((k) => ({ cid, key: k })), fxFakes: [],
    circular: false, clean,
  };
}

// ---- 比率 -----------------------------------------------------
function ratios(f) {
  const s = num(f, "sales") || 1;
  const pretax = pretaxProfit(f);
  return {
    cogsRate: (num(f, "cogs") / s) * 100,
    recvDays: (num(f, "receivables") / s) * 365,
    invDays: (num(f, "inventory") / Math.max(1, num(f, "cogs"))) * 365,
    opMargin: (opProfit(f) / s) * 100,
    taxRate: pretax > 0 ? (num(f, "tax") / pretax) * 100 : 0,
    bsGap: bsGap(f),
  };
}
function flagByIndustry(industryKey, r, f) {
  const p = INDUSTRIES[industryKey];
  const out = (val, [lo, hi], slack) => val < lo - slack || val > hi + slack;
  return {
    cogs: out(r.cogsRate, p.cogs, 8) ? "warn" : "ok",
    recv: r.recvDays > p.recvDays[1] + 25 ? "warn" : "ok",
    inv: r.invDays > p.invDays[1] + 25 ? "warn" : "ok",
    tax: (pretaxProfit(f) > 50 && r.taxRate < 18) ? "warn" : "ok",
    bs: Math.abs(r.bsGap) > Math.max(30, num(f, "sales") * 0.03) ? "warn" : "ok",
  };
}

// ---- A: 痕跡判定 ---------------------------------------------
// 各科目の粉飾が「調査官に見える比率」のどれに現れるかを対応づける。
// 見える比率: cogs(原価率) recv(売掛日数) inv(在庫日数) tax(実効税率) bs(貸借差額) op(営業利益率)
// ※ opチップも調査官画面に表示する（修正2）
const TRACE_BY_KEY = {
  sales: ["recv", "tax", "op"],     // 架空売上→売掛異常／税率／利益率
  receivables: ["recv"],            // 売掛膨張→売掛日数
  cogs: ["cogs", "inv", "op"],      // 原価率異常／在庫へ付替え／利益率
  inventory: ["inv"],               // 在庫膨張→在庫日数
  sga: ["op"],                      // 販管費操作→利益率
  nonOpInc: ["op"], nonOpExp: ["op"],
  extraInc: ["op"], extraLoss: ["bs"],   // 特損隠し→固定資産に残る→貸借差額
  tax: ["tax"],                     // 実効税率異常
  fixedAssets: ["bs"],              // 簿価据置→貸借不均衡
  payables: ["bs"], shortDebt: ["bs"], longDebt: ["bs"], equity: ["bs"],
  cash: ["op"],
};
function flagsWithOp(industryKey, f) {
  const r = ratios(f);
  const base = flagByIndustry(industryKey, r, f);
  // 営業利益率が業種実態から大きく外れていれば op 痕跡
  const p = INDUSTRIES[industryKey];
  const expMax = (100 - p.cogs[0]) * (1 - p.sgaRate[0] / 100) + 6;
  base.op = (r.opMargin > expMax + 6 || r.opMargin < -3) ? "warn" : "ok";
  return base;
}
// 科目keyが痕跡を残しているか
function keyHasTrace(company, key) {
  const f = curFin(company);
  const fl = flagsWithOp(company.industry, f);
  const traces = TRACE_BY_KEY[key] || [];
  if (traces.some((t) => fl[t] === "warn")) return true;
  // 期別: 推移で現れる痕跡も有効とみなす
  const cp = crossPeriodTraces(company);
  return cp.has(key);
}
// 業種別の営業利益率の妥当上限（調査官表示用）
function opMarginMax(industryKey) {
  const p = INDUSTRIES[industryKey];
  return (100 - p.cogs[0]) * (1 - p.sgaRate[0] / 100) + 12;
}

function enc(o) { try { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); } catch { return ""; } }
function dec(s) { try { return JSON.parse(decodeURIComponent(escape(atob(s.trim())))); } catch { return null; } }

// 期ラベル（末尾が当期）
function periodLabels(n) {
  const labels = ["当期", "前期", "前々期", "前々々期"];
  return labels.slice(0, n).reverse(); // 古い→新しい
}
function makeCompany(role, idx, industryKey, periodCount = 1) {
  return {
    cid: uid(), role,
    name: role === "parent" ? "親会社" : `子会社${String.fromCharCode(64 + idx)}`,
    industry: industryKey || pick(INDUSTRY_KEYS),
    currency: "JPY", fxRate: 1,
    extraKeys: [],
    periods: Array.from({ length: periodCount }, () => emptyFin()),
  };
}
// 当期（編集・連結・採点の主対象）
function curFin(c) { return c.periods[c.periods.length - 1]; }
function periodCountOf(c) { return c.periods.length; }
// 期別の推移痕跡: 当期と前期を比較し、期間でしか見えない不自然さを検出
// 返り値: warn対象キーの集合
function crossPeriodTraces(c) {
  const traces = new Set();
  if (c.periods.length < 2) return traces;
  const cur = c.periods[c.periods.length - 1];
  const prev = c.periods[c.periods.length - 2];
  const g = (f, k) => Number(f[k]) || 0;
  const salesPrev = g(prev, "sales") || 1;
  const salesGrow = (g(cur, "sales") - salesPrev) / salesPrev; // 売上成長率
  // 1) 売上急増(>35%)に対し、売掛が売上以上のペースで膨張 → 架空売上の疑い
  const recvPrev = g(prev, "receivables") || 1;
  const recvGrow = (g(cur, "receivables") - recvPrev) / recvPrev;
  if (salesGrow > 0.35 && recvGrow > salesGrow * 1.5 + 0.1) { traces.add("sales"); traces.add("receivables"); }
  // 2) 在庫だけが売上の伸びを大きく超えて増加 → 原価隠し/在庫水増し
  const invPrev = g(prev, "inventory") || 1;
  const invGrow = (g(cur, "inventory") - invPrev) / invPrev;
  if (invGrow > Math.max(0.4, salesGrow * 2 + 0.2)) { traces.add("inventory"); }
  // 3) 利益(営業利益)は伸びているのに現金が減少 → 利益の質が低い(架空利益)
  const opPrev = opProfit(prev), opCur = opProfit(cur);
  if (opCur > opPrev * 1.2 && opPrev > 0 && g(cur, "cash") < g(prev, "cash") * 0.85) { traces.add("cash"); traces.add("sales"); }
  return traces;
}

// ================================================================
//  ストレージ（履歴＋ライブラリ）
// ================================================================
const HISTORY_KEY = "fraudduel:history:v2";
const LIBRARY_KEY = "fraudduel:library:v2";

async function loadHistory() { try { const r = await storage.get(HISTORY_KEY); return r && r.value ? JSON.parse(r.value) : []; } catch { return []; } }
async function saveHistoryRecord(rec) {
  let list = []; try { const r = await storage.get(HISTORY_KEY); if (r && r.value) list = JSON.parse(r.value); } catch {}
  list.unshift(rec); list = list.slice(0, 50);
  try { await storage.set(HISTORY_KEY, JSON.stringify(list)); } catch {}
  return list;
}
function codeHash(code) { let h = 0; for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) | 0; return "L" + (h >>> 0).toString(36); }
async function loadLibrary() { try { const r = await storage.get(LIBRARY_KEY); return r && r.value ? JSON.parse(r.value) : []; } catch { return []; } }
async function writeLibrary(list) { try { await storage.set(LIBRARY_KEY, JSON.stringify(list.slice(0, 60))); } catch {} return list; }
async function addToLibrary(code, meta) {
  const lid = codeHash(code); let list = await loadLibrary();
  if (!list.some((e) => e.lid === lid)) {
    list.unshift({ lid, code, title: meta.title || "出題", addedAt: Date.now(), companyCount: meta.companyCount || 0, hasFx: !!meta.hasFx, attempts: 0, bestRate: null, lastScore: null });
    await writeLibrary(list);
  }
  return { list, lid };
}
async function recordLibraryAttempt(lid, rate, score) {
  let list = await loadLibrary();
  list = list.map((e) => e.lid !== lid ? e : { ...e, attempts: (e.attempts || 0) + 1, bestRate: e.bestRate == null ? rate : Math.max(e.bestRate, rate), lastScore: score });
  await writeLibrary(list); return list;
}
async function deleteFromLibrary(lid) { let list = await loadLibrary(); list = list.filter((e) => e.lid !== lid); await writeLibrary(list); return list; }

// ---- マイ出題（粉飾者が作った出題の保存リスト） ----
const MINE_KEY = "fraudduel:mine:v1";
async function loadMine() { try { const r = await storage.get(MINE_KEY); return r && r.value ? JSON.parse(r.value) : []; } catch { return []; } }
async function writeMine(list) { try { await storage.set(MINE_KEY, JSON.stringify(list.slice(0, 60))); } catch {} return list; }
async function addToMine(code, meta) {
  const mid = codeHash(code); let list = await loadMine();
  if (!list.some((e) => e.mid === mid)) {
    list.unshift({ mid, code, title: meta.title || "出題", createdAt: Date.now(), companyCount: meta.companyCount || 0, hasFx: !!meta.hasFx, periodCount: meta.periodCount || 1, clean: !!meta.clean });
    await writeMine(list);
  }
  return list;
}
async function deleteFromMine(mid) { let list = await loadMine(); list = list.filter((e) => e.mid !== mid); await writeMine(list); return list; }

// ================================================================
function App() {
  const VALID_START = ["home", "build", "library", "rules", "explore", "admin", "practice"];
  const startRoute = (typeof window !== "undefined" && VALID_START.includes(window.__START_ROUTE__)) ? window.__START_ROUTE__ : "home";
  const [route, setRoute] = useState(startRoute);
  const [companies, setCompanies] = useState([makeCompany("parent", 0, "manufacturing"), makeCompany("sub", 1, "retail")]);
  const [internalTxns, setInternalTxns] = useState([]);
  const [fakes, setFakes] = useState([]);
  const [isClean, setIsClean] = useState(false);
  const [periodCount, setPeriodCount] = useState(1);
  const [code, setCode] = useState("");

  const [loaded, setLoaded] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [accusations, setAccusations] = useState([]);
  const [accuseCircular, setAccuseCircular] = useState(false);
  const [accuseFx, setAccuseFx] = useState([]);
  const [result, setResult] = useState(null);
  const [currentLid, setCurrentLid] = useState(null);

  const [history, setHistory] = useState([]);
  const [library, setLibrary] = useState([]);
  const [mine, setMine] = useState([]);
  const [tip, setTip] = useState(null); // 科目説明ポップアップ {label, desc}
  const [user, setUser] = useState(null);       // Firebaseログインユーザー
  const [profile, setProfile] = useState(null); // {displayName}
  const [isAdmin, setIsAdmin] = useState(false); // 管理者か

  useEffect(() => { loadHistory().then(setHistory); loadLibrary().then(setLibrary); loadMine().then(setMine); }, []);

  // ログイン状態を監視
  useEffect(() => {
    const unsub = cloud.onAuth(async (u) => {
      setUser(u || null);
      if (u) {
        const p = await cloud.getProfile(u.uid); setProfile(p || { displayName: u.displayName || (u.email ? u.email.split("@")[0] : "匿名") });
        setIsAdmin(await cloud.isAdmin(u.uid));
      } else { setProfile(null); setIsAdmin(false); }
    });
    return () => unsub && unsub();
  }, []);

  // ---- ブラウザの戻る/進む対応 ＋ クリーンURL同期 ----
  // route が変わったら履歴に積む。popstate(戻る)で route を復元。
  const popping = useRef(false);
  // 独立URLを持つページ → パス。それ以外はベース(トップ)のパスを使う。
  const BASE_PATH = (() => {
    // 例: /Cooking-The-Books/ または /Cooking-The-Books/build/ から末尾ページ名を除いたベースを得る
    let p = window.location.pathname;
    p = p.replace(/(build|library|rules|explore|admin|practice)\/?$/, ""); // 既知のサブページ名を除去
    if (!p.endsWith("/")) p += "/";
    return p;
  })();
  const pathForRoute = (r) => {
    if (["build", "library", "rules", "explore", "admin", "practice"].includes(r)) return BASE_PATH + r + "/";
    return BASE_PATH; // home とその他（投稿審査など）はトップのURL
  };
  useEffect(() => {
    window.history.replaceState({ route: startRoute }, "", pathForRoute(startRoute));
    const onPop = (e) => {
      popping.current = true;
      const r = (e.state && e.state.route) || "home";
      setRoute(r);
      setTip(null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (popping.current) { popping.current = false; return; }
    const cur = window.history.state && window.history.state.route;
    if (cur !== route) window.history.pushState({ route }, "", pathForRoute(route));
  }, [route]);

  // URLの#play=... があれば、その出題を自動で審査開始
  useEffect(() => {
    const hc = readHashCode();
    if (!hc) return;
    const o = dec(hc);
    if (o && o.companies) {
      o.companies = o.companies.map((c) => c.periods ? c : { ...c, periods: [c.fin || emptyFin()] });
      // ライブラリにも追加して記録を残す
      const meta = { title: o.title || "出題", companyCount: o.companies.length, hasFx: o.companies.some((c) => c.currency && c.currency !== "JPY"), periodCount: o.periodCount || (o.companies[0].periods?.length || 1) };
      addToLibrary(hc.trim(), meta).then(({ list, lid }) => { setLibrary(list); setCurrentLid(lid); });
      setLoaded(o); setAccusations([]); setAccuseCircular(false); setAccuseFx([]); setResult(null);
      setRoute("investigate");
    }
    clearHash();
  }, []);

  function resetBuild() {
    setCompanies([makeCompany("parent", 0, "manufacturing"), makeCompany("sub", 1, "retail")]);
    setInternalTxns([]); setFakes([]); setIsClean(false); setPeriodCount(1); setCode(""); setPreviewMode(false);
  }
  // 期数を変更（全社のperiods長を揃える）
  function changePeriodCount(n) {
    const clamped = Math.max(1, Math.min(4, n));
    setPeriodCount(clamped);
    setCompanies((prev) => prev.map((c) => {
      const cur = c.periods;
      let next;
      if (clamped > cur.length) {
        // 古い期を先頭に追加（空）
        next = [...Array.from({ length: clamped - cur.length }, () => emptyFin()), ...cur];
      } else {
        // 古い期から削る（末尾=当期は保持）
        next = cur.slice(cur.length - clamped);
      }
      return { ...c, periods: next };
    }));
    // 期数が1になったら期別痕跡に依存する架空指定はそのまま（buildCodeで再検証）
  }
  const [buildWarn, setBuildWarn] = useState(null);
  const [previewMode, setPreviewMode] = useState(false);
  const [lastLevel, setLastLevel] = useState(null); // 直近に遊んだ練習レベル

  // ===== 下書き保存・プレビュー =====
  const DRAFT_KEY = "fraudduel:draft:v1";
  const [hasDraft, setHasDraft] = useState(false);
  const [draftMsg, setDraftMsg] = useState("");
  useEffect(() => { storage.get(DRAFT_KEY).then((r) => setHasDraft(!!(r && r.value))).catch(() => {}); }, []);
  function buildDraftObj() {
    return { companies, internalTxns, fakes, isClean, periodCount, savedAt: Date.now() };
  }
  async function saveDraft() {
    try { await storage.set(DRAFT_KEY, JSON.stringify(buildDraftObj())); setHasDraft(true); setDraftMsg("下書きを保存しました ✓"); }
    catch { setDraftMsg("保存に失敗しました"); }
    setTimeout(() => setDraftMsg(""), 2200);
  }
  async function loadDraft() {
    try {
      const r = await storage.get(DRAFT_KEY);
      if (!r || !r.value) { setDraftMsg("下書きがありません"); setTimeout(() => setDraftMsg(""), 2000); return; }
      const d = JSON.parse(r.value);
      if (d.companies) setCompanies(d.companies);
      if (d.internalTxns) setInternalTxns(d.internalTxns);
      if (d.fakes) setFakes(d.fakes);
      if (typeof d.isClean === "boolean") setIsClean(d.isClean);
      if (d.periodCount) setPeriodCount(d.periodCount);
      setDraftMsg("下書きを読み込みました ✓");
    } catch { setDraftMsg("読み込みに失敗しました"); }
    setTimeout(() => setDraftMsg(""), 2200);
  }
  // プレビュー: 現在の入力を「答え合わせ無し」で調査官の見え方で確認
  function previewChallenge() {
    const fxFakes = isClean ? [] : companies.filter(fxAbusive).map((c) => c.cid);
    const o = {
      v: 5, periodCount, preview: true,
      title: "プレビュー",
      companies: companies.map((c) => ({ cid: c.cid, role: c.role, name: sanitizeText(c.name || "会社", 30), industry: c.industry, currency: c.currency, fxRate: c.fxRate, periods: c.periods, fin: curFin(c), hint: sanitizeText(c.hint || "", 120) })),
      internalTxns: internalTxns.map((t) => ({ from: t.from, to: t.to, amount: t.amount })),
      fakes: isClean ? [] : fakes, fxFakes, circular: false, clean: isClean,
    };
    o.companies = o.companies.map((c) => c.periods ? c : { ...c, periods: [c.fin || emptyFin()] });
    setLoaded(o); setCurrentLid(null);
    setAccusations([]); setAccuseCircular(false); setAccuseFx([]); setResult(null);
    setPreviewMode(true);
    setRoute("investigate");
  }

  function buildCode() {
    // A: 痕跡のない架空指定をチェック（数字を不自然にしていない架空はNG）
    if (!isClean && fakes.length > 0) {
      const traceless = fakes.filter((fk) => {
        const co = companies.find((c) => c.cid === fk.cid);
        return co && !keyHasTrace(co, fk.key);
      });
      if (traceless.length > 0) {
        const names = traceless.map((fk) => {
          const co = companies.find((c) => c.cid === fk.cid);
          return `${co?.name || ""}の${A_BY_KEY[fk.key]?.label || fk.key}`;
        });
        setBuildWarn(names);
        return;
      }
    }
    setBuildWarn(null);
    doBuildCode();
  }
  function doBuildCode() {
    const fxFakes = isClean ? [] : companies.filter(fxAbusive).map((c) => c.cid);
    const multi = periodCount > 1;
    const payload = {
      v: 5,
      periodCount,
      title: (multi ? `${periodCount}期 ` : "") + companies.map((c) => INDUSTRIES[c.industry].icon).join("") + " " + companies.length + "社",
      companies: companies.map((c) => ({ cid: c.cid, role: c.role, name: sanitizeText(c.name || "会社", 30), industry: c.industry, currency: c.currency, fxRate: c.fxRate, periods: c.periods, fin: curFin(c), hint: sanitizeText(c.hint || "", 120) })),
      internalTxns: internalTxns.map((t) => ({ from: t.from, to: t.to, amount: t.amount })), fakes: isClean ? [] : fakes, fxFakes,
      circular: isClean ? false : internalTxns.some((t) => t.amount > (t.real || 0)),
      clean: isClean,
    };
    const codeStr = enc(payload);
    setCode(codeStr);
    const meta = { title: payload.title, companyCount: companies.length, hasFx: companies.some((c) => c.currency !== "JPY"), periodCount, clean: isClean };
    addToMine(codeStr, meta).then(setMine);
    // 自分でも挑戦できるよう調査一覧にも追加
    addToLibrary(codeStr, meta).then(({ list }) => setLibrary(list));
    setRoute("share");
  }
  async function addCode(raw) {
    const o = dec(raw);
    if (!o || !o.companies) { setLoadError("コードを読み取れませんでした。"); return; }
    setLoadError("");
    // 後方互換: periodsが無い旧コードはfinから1期を作る
    o.companies = o.companies.map((c) => c.periods ? c : { ...c, periods: [c.fin || emptyFin()] });
    const meta = { title: o.title || "出題", companyCount: o.companies.length, hasFx: o.companies.some((c) => c.currency && c.currency !== "JPY"), periodCount: o.periodCount || (o.companies[0].periods?.length || 1) };
    const { list } = await addToLibrary(raw.trim(), { ...meta }); setLibrary(list); setRoute("library");
  }
  function startChallenge(entry) {
    const o = dec(entry.code);
    if (!o || !o.companies) { setLoadError("この出題は読み込めませんでした。"); return; }
    o.companies = o.companies.map((c) => c.periods ? c : { ...c, periods: [c.fin || emptyFin()] });
    setLoaded(o); setCurrentLid(entry.lid);
    setAccusations([]); setAccuseCircular(false); setAccuseFx([]); setResult(null);
    setRoute("investigate");
  }
  async function removeChallenge(lid) { const list = await deleteFromLibrary(lid); setLibrary(list); }
  function toggleFxAccuse(cid) { setAccuseFx((p) => p.includes(cid) ? p.filter((x) => x !== cid) : [...p, cid]); }

  // 練習モード: レベルを選んで開始
  function startPractice(level) {
    setLastLevel(level);
    const o = makePracticeChallenge(level);
    o.companies = o.companies.map((c) => c.periods ? c : { ...c, periods: [c.fin || emptyFin()] });
    setLoaded(o); setCurrentLid(null);
    setAccusations([]); setAccuseCircular(false); setAccuseFx([]); setResult(null); setPreviewMode(false);
    setRoute("investigate");
  }
  // 「次の問題へ」: 直近と同じくらいの難易度で1問
  function nextPractice(level) {
    const lv = level || lastLevel || PRACTICE_LEVELS[0];
    startPractice(lv);
  }
  // 今日の1問: 日付シードで全員共通の1問（レベル4〜7のどれか＝歯ごたえあり）
  function startDaily() {
    const today = new Date();
    const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    const pool = PRACTICE_LEVELS.filter((l) => l.id >= 4); // 中級以上
    const lv = pool[seed % pool.length];
    setLastLevel(lv);
    const o = makePracticeChallenge(lv);
    o.title = "今日の1問";
    o.companies = o.companies.map((c) => c.periods ? c : { ...c, periods: [c.fin || emptyFin()] });
    setLoaded(o); setCurrentLid(null);
    setAccusations([]); setAccuseCircular(false); setAccuseFx([]); setResult(null); setPreviewMode(false);
    setRoute("investigate");
  }
  // 公開出題（投稿）を遊ぶ
  function playPost(post) {
    const o = dec(post.code);
    if (!o || !o.companies) { return; }
    o.companies = o.companies.map((c) => c.periods ? c : { ...c, periods: [c.fin || emptyFin()] });
    setLoaded(o); setCurrentLid(null);
    setAccusations([]); setAccuseCircular(false); setAccuseFx([]); setResult(null);
    setRoute("investigate");
  }
  // 出題を公開board に投稿
  async function publishCurrent() {
    if (!user) { setRoute("login"); return; }
    const meta = { title: (dec(code) || {}).title || "出題", companyCount: (dec(code) || {}).companies?.length || 0, hasFx: false, periodCount: (dec(code) || {}).periodCount || 1, clean: !!(dec(code) || {}).clean };
    try { await cloud.publishPost(user.uid, profile && profile.displayName, meta, code); return true; }
    catch (e) { return false; }
  }

  async function grade() {
    const o = loaded;
    const trueFakes = o.fakes || [], trueFx = o.fxFakes || [], trueCircular = !!o.circular, cleanCo = !!o.clean;
    const fakeSet = new Set(trueFakes.map((f) => `${f.cid}:${f.key}`));
    const fxSet = new Set(trueFx);
    const accSet = accusations.map((a) => `${a.cid}:${a.key}`);
    let score = 0; const detail = [];
    const fakeTotal = fakeSet.size + fxSet.size + (trueCircular ? 1 : 0);

    if (cleanCo) {
      const wrong = accusations.length + (accuseCircular ? 1 : 0) + accuseFx.length;
      if (wrong === 0) { score += 15; detail.push({ ok: true, txt: "健全な企業を見抜き、一切告発せず信頼を守った。 +15" }); }
      else { score -= 12 * wrong; detail.push({ ok: false, txt: `健全企業を ${wrong} 件誤告発。信頼失墜。 -${12 * wrong}` }); }
      return finishGrade(score, detail, { trueFakes, trueFx, trueCircular, cleanCo, companies: o.companies }, o, 0, fakeTotal, wrong === 0);
    }
    const hits = accSet.filter((a) => fakeSet.has(a));
    const misses = accSet.filter((a) => !fakeSet.has(a));
    const missed = [...fakeSet].filter((f) => !accSet.includes(f));
    score += hits.length * 10; score -= misses.length * 9;
    if (hits.length) detail.push({ ok: true, txt: `架空科目を ${hits.length} 件命中。 +${hits.length * 10}` });
    if (misses.length) detail.push({ ok: false, txt: `的外れな指摘 ${misses.length} 件。 -${misses.length * 9}` });
    const fxHits = accuseFx.filter((c) => fxSet.has(c)), fxMiss = accuseFx.filter((c) => !fxSet.has(c)), fxMissed = [...fxSet].filter((c) => !accuseFx.includes(c));
    score += fxHits.length * 12; score -= fxMiss.length * 6;
    if (fxHits.length) detail.push({ ok: true, txt: `不当な為替換算 ${fxHits.length} 件を看破。 +${fxHits.length * 12}` });
    if (fxMiss.length) detail.push({ ok: false, txt: `為替の誤指摘 ${fxMiss.length} 件。 -${fxMiss.length * 6}` });
    if (fxMissed.length) detail.push({ ok: false, txt: `為替操作 ${fxMissed.length} 件を見逃した。` });
    if (trueCircular && accuseCircular) { score += 14; detail.push({ ok: true, txt: "循環取引を看破。 +14" }); }
    if (trueCircular && !accuseCircular) detail.push({ ok: false, txt: "循環取引を見逃した。" });
    if (!trueCircular && accuseCircular) { score -= 8; detail.push({ ok: false, txt: "循環取引は無かったのに指摘。 -8" }); }
    if (missed.length) detail.push({ ok: false, txt: `架空科目 ${missed.length} 件を見逃した。` });
    const allHit = missed.length === 0 && misses.length === 0 && fxMissed.length === 0 && fxMiss.length === 0 && (!trueCircular || accuseCircular);
    if (allHit && fakeTotal > 0) { score += 15; detail.push({ ok: true, txt: "完全摘発。すべての嘘を過不足なく暴いた。 +15" }); }
    const totalHits = hits.length + fxHits.length + (trueCircular && accuseCircular ? 1 : 0);
    return finishGrade(score, detail, { trueFakes, trueFx, trueCircular, cleanCo, companies: o.companies }, o, totalHits, fakeTotal, allHit);
  }
  async function finishGrade(score, detail, truth, o, hits, fakeTotal, perfect) {
    setResult({ score, detail, truth, hits, fakeTotal, perfect });
    const rec = { id: uid(), title: o.title || "出題", ts: Date.now(), cleanCo: !!o.clean, fakeTotal, hits, score, result: score >= 10 ? "win" : score >= -5 ? "draw" : "lose" };
    setHistory(await saveHistoryRecord(rec));
    // ログイン中ならクラウドにも集計を反映
    if (user) { cloud.pushResult(user.uid, profile && profile.displayName, rec); }
    if (currentLid) {
      const rate = o.clean ? (score >= 0 ? 100 : 0) : (fakeTotal > 0 ? Math.round((hits / fakeTotal) * 100) : 0);
      setLibrary(await recordLibraryAttempt(currentLid, rate, score));
    }
    setRoute("result");
  }

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.ink }}>
      <div className="wrap">
        <header className="top">
          <div className="top-main">
            <div className="brand" onClick={() => setRoute("home")}><span className="brand-mark">¥</span> 連結粉飾 <span className="brand-vs">対局</span></div>
            <div className="top-right">
              {cloud.enabled && (
                user
                  ? <button className="acct-chip" onClick={() => setRoute("mypage")}>{(profile && profile.displayName) || "マイページ"}</button>
                  : <button className="acct-chip login" onClick={() => setRoute("login")}>ログイン</button>
              )}
            </div>
          </div>
          <nav className="topnav">
            <button className={`nav-link ${route === "home" ? "active" : ""}`} onClick={() => setRoute("home")}>トップ</button>
            <button className={`nav-link ${route === "build" ? "active" : ""}`} onClick={() => { resetBuild(); setRoute("build"); }}>作成</button>
            <button className={`nav-link ${route === "practice" ? "active" : ""}`} onClick={() => setRoute("practice")}>練習</button>
            <button className={`nav-link ${route === "explore" ? "active" : ""}`} onClick={() => setRoute("explore")}>公開出題</button>
            <button className={`nav-link ${route === "library" ? "active" : ""}`} onClick={() => { setLoadError(""); setRoute("library"); }}>調査一覧</button>
            <button className={`nav-link ${route === "rules" ? "active" : ""}`} onClick={() => setRoute("rules")}>あそびかた</button>
            {isAdmin && <button className={`nav-link admin ${route === "admin" ? "active" : ""}`} onClick={() => setRoute("admin")}>管理</button>}
          </nav>
        </header>

        {route === "home" && <Home history={history} user={user} profile={profile} onBuild={() => { resetBuild(); setRoute("build"); }} onLoad={() => { setLoadError(""); setRoute("library"); }} onRules={() => setRoute("rules")} onMine={() => setRoute("mine")} onLogin={() => setRoute("login")} onMypage={() => setRoute("mypage")} onPractice={() => setRoute("practice")} onDaily={startDaily} onExplore={() => setRoute("explore")} />}
        {route === "login" && <Login onBack={() => setRoute("home")} onDone={() => setRoute("mypage")} />}
        {route === "explore" && <Explore user={user} onPlay={playPost} onBack={() => setRoute("home")} onLogin={() => setRoute("login")} />}
        {route === "practice" && <Practice onStart={startPractice} onBack={() => setRoute("home")} />}
        {route === "admin" && <AdminPanel isAdmin={isAdmin} onBack={() => setRoute("home")} />}
        {route === "mypage" && <MyPage user={user} profile={profile} history={history} onBack={() => setRoute("home")} onLogin={() => setRoute("login")} onProfileSaved={setProfile} onPlay={playPost} />}
        {route === "rules" && <Rules onBack={() => setRoute("home")} onTip={setTip} />}
        {route === "build" && (
          <Builder companies={companies} setCompanies={setCompanies} internalTxns={internalTxns} setInternalTxns={setInternalTxns}
            fakes={fakes} setFakes={setFakes} isClean={isClean} setIsClean={setIsClean} onDone={buildCode} onTip={setTip}
            periodCount={periodCount} changePeriodCount={changePeriodCount}
            buildWarn={buildWarn} onForceBuild={() => { setBuildWarn(null); doBuildCode(); }} onDismissWarn={() => setBuildWarn(null)}
            onPreview={previewChallenge} onSaveDraft={saveDraft} onLoadDraft={loadDraft} hasDraft={hasDraft} draftMsg={draftMsg} />
        )}
        {route === "share" && <Share code={code} onBack={() => setRoute("build")} onHome={() => setRoute("home")} onMine={() => setRoute("mine")} user={user} cloudEnabled={cloud.enabled} onPublish={publishCurrent} onExplore={() => setRoute("explore")} onLogin={() => setRoute("login")} />}
        {route === "mine" && <MineList mine={mine} onBack={() => setRoute("home")} onShare={(e) => { setCode(e.code); setRoute("share"); }} onRemove={(mid) => deleteFromMine(mid).then(setMine)} />}
        {route === "library" && <Library library={library} onStart={startChallenge} onAdd={() => { setLoadError(""); setRoute("load"); }} onRemove={removeChallenge} onBack={() => setRoute("home")} />}
        {route === "load" && <Load onLoad={addCode} error={loadError} onBack={() => setRoute("library")} />}
        {route === "investigate" && loaded && (
          <Investigate data={loaded} accusations={accusations} setAccusations={setAccusations}
            accuseCircular={accuseCircular} setAccuseCircular={setAccuseCircular} accuseFx={accuseFx} toggleFxAccuse={toggleFxAccuse} onSubmit={grade} onTip={setTip}
            previewMode={previewMode} onExitPreview={() => { setPreviewMode(false); setRoute("build"); }} />
        )}
        {route === "result" && result && <Result result={result} onHome={() => setRoute("home")} onLibrary={() => setRoute("library")} onTip={setTip} onNextPractice={nextPractice} onDaily={startDaily} lastLevel={lastLevel} />}

        <footer className="site-footer">
          <div className="footer-cols">
            <div className="footer-col">
              <div className="footer-brand"><span className="brand-mark">¥</span> 連結粉飾 対局</div>
              <div className="footer-tag">Cooking the Books — 決算書の粉飾を作って暴く学習ゲーム</div>
            </div>
            <div className="footer-col">
              <div className="footer-h">メニュー</div>
              <button className="footer-link" onClick={() => setRoute("home")}>トップ</button>
              <button className="footer-link" onClick={() => { resetBuild(); setRoute("build"); }}>出題を作る</button>
              <button className="footer-link" onClick={() => { setLoadError(""); setRoute("library"); }}>調査一覧</button>
              <button className="footer-link" onClick={() => setRoute("rules")}>あそびかた</button>
            </div>
            <div className="footer-col">
              <div className="footer-h">アカウント</div>
              {cloud.enabled
                ? (user
                    ? <button className="footer-link" onClick={() => setRoute("mypage")}>マイページ・ランキング</button>
                    : <button className="footer-link" onClick={() => setRoute("login")}>ログイン / 新規登録</button>)
                : <span className="footer-muted">ログイン機能は準備中</span>}
            </div>
            <div className="footer-col">
              <div className="footer-h">お問い合わせ</div>
              <a className="footer-link" href={`mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent("【連結粉飾 対局】お問い合わせ")}`}>メールで問い合わせ</a>
              {CONTACT_FORM_URL && <a className="footer-link" href={CONTACT_FORM_URL} target="_blank" rel="noopener noreferrer">お問い合わせフォーム</a>}
            </div>
          </div>
          <div className="footer-bottom">
            <span>© {new Date().getFullYear()} 連結粉飾 対局</span>
            <span className="footer-note">本ゲームは教育用に簡略化したモデルです。実際の会計基準とは異なります。</span>
          </div>
        </footer>
      </div>

      {tip && <TipModal tip={tip} onClose={() => setTip(null)} />}
    </div>
  );
}

// ================================================================
function TipModal({ tip, onClose }) {
  return (
    <div className="tip-overlay" onClick={onClose}>
      <div className="tip-card" onClick={(e) => e.stopPropagation()}>
        <div className="tip-head"><span className="tip-label">{tip.label}</span><button className="tip-x" onClick={onClose}>✕</button></div>
        <div className="tip-desc">{tip.desc}</div>
      </div>
    </div>
  );
}

// ================================================================
//  あそびかた＆例題ページ
// ================================================================
function ExampleCard({ tag, title, story, before, after, changes, clue, sym = "¥" }) {
  return (
    <div className="ex-card">
      <div className="ex-head"><span className="ex-tag">{tag}</span><span className="ex-title">{title}</span></div>
      <p className="ex-story">{story}</p>
      <div className="ex-compare">
        <div className="ex-col"><div className="ex-col-h normal">正常な決算</div>
          {before.map((b, i) => <div className="ex-line" key={i}><span>{b[0]}</span><b>{sym}{b[1]}</b></div>)}
        </div>
        <div className="ex-arrow">→</div>
        <div className="ex-col"><div className="ex-col-h fraud">粉飾後</div>
          {after.map((a, i) => <div className={`ex-line ${a[2] ? "changed" : ""}`} key={i}><span>{a[0]}</span><b>{sym}{a[1]}{a[2] && <span className="ex-up"> {a[2]}</span>}</b></div>)}
        </div>
      </div>
      <div className="ex-clue"><span className="ex-clue-label">調査官の手がかり</span>{clue}</div>
    </div>
  );
}

function Rules({ onBack, onTip }) {
  return (
    <div className="screen">
      <div className="section-head">
        <h2 className="h2">あそびかた</h2>
        <p className="muted">粉飾決算を「作る人」と「暴く人」で対戦する、数字の推理ゲームです。会計を知らなくても遊べます。</p>
      </div>

      {/* 概要 */}
      <div className="rules-block">
        <div className="rb-title">① これはどんなゲーム？</div>
        <div className="rb-body">
          会社の成績表（決算書）には、ときどき<b>嘘</b>が混じります。売上を大きく見せたり、損を隠したり。
          <b>粉飾者</b>はその嘘を仕込んだ決算書を作り、<b>調査官</b>はどこが嘘かを数字の矛盾から見つけ出します。
          ——ただし、嘘をつかない正直な決算（罠）もあります。むやみに疑うと調査官の負けです。
        </div>
      </div>

      {/* 流れ */}
      <div className="rules-block">
        <div className="rb-title">② 対戦の流れ</div>
        <div className="flow">
          <div className="flow-step"><span className="flow-n">1</span><div><b>粉飾者</b>が決算書を作り、嘘を仕込む。「出題コード」が発行される。</div></div>
          <div className="flow-step"><span className="flow-n">2</span><div>そのコードを<b>LINEなどで相手に送る</b>。</div></div>
          <div className="flow-step"><span className="flow-n">3</span><div><b>調査官</b>がコードを読み込み、決算書を調べて「ここが嘘だ」と指摘。自動採点。</div></div>
        </div>
      </div>

      {/* 用語ミニ辞典 */}
      <div className="rules-block">
        <div className="rb-title">③ 最低限の言葉（タップで詳しく）</div>
        <div className="term-chips">
          {["sales", "cogs", "receivables", "inventory", "tax", "fixedAssets"].map((k) => (
            <button key={k} className="term-chip" onClick={() => onTip({ label: A_BY_KEY[k].label, desc: A_BY_KEY[k].desc })}>
              {A_BY_KEY[k].label} <span className="term-q">?</span>
            </button>
          ))}
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>※ ゲーム中も、科目名の「?」マークでいつでも説明が読めます。</p>
      </div>

      {/* 粉飾の手口（例題） */}
      <div className="rules-block">
        <div className="rb-title">④ 粉飾の手口と見抜き方（例題）</div>
        <p className="muted small" style={{ marginBottom: 14 }}>代表的な5つの手口を、具体的な数字で。「正常→粉飾後」で何が不自然になるかが、調査官のヒントです。</p>

        <ExampleCard
          tag="手口1" title="架空売上（売上の水増し）"
          story="実在しない取引を売上に計上。でも現金は入ってこないので、未回収の「売掛金」だけが異常に膨らむ。"
          before={[["売上高", "1,000"], ["売掛金", "160"]]}
          after={[["売上高", "1,250", "↑+250"], ["売掛金", "420", "↑+260"]]}
          changes
          clue="売掛金回転日数が業種の常識を大きく超える（例：58日→123日）。「売れているのにお金が入っていない」のは嘘のサイン。"
        />

        <ExampleCard
          tag="手口2" title="原価の付け替え（利益の水増し）"
          story="本当はかかった原価を小さく見せ、その分を在庫に隠す。利益が大きく見える。"
          before={[["売上原価", "680"], ["棚卸資産", "120"]]}
          after={[["売上原価", "560", "↓−120"], ["棚卸資産", "260", "↑+140"]]}
          changes
          clue="原価率が業種より不自然に低く、同時に在庫日数が異常に長い。在庫が膨らんでいたら、費用を隠した疑い。"
        />

        <ExampleCard
          tag="手口3" title="特別損失の隠蔽"
          story="本来計上すべき損失（古い設備の価値下落など）を計上せず、資産に残したまま利益を守る。"
          before={[["特別損失", "120"], ["固定資産", "500"]]}
          after={[["特別損失", "0", "↓計上せず"], ["固定資産", "620", "↑残したまま"]]}
          changes
          clue="利益率が同業よりやけに高い。資産が不自然に重い。損を先送りしている可能性。"
        />

        <ExampleCard
          tag="手口4" title="法人税の過小計上"
          story="利益が出ているのに、納めるべき税金を小さく見せて、最終利益を膨らませる。"
          before={[["税引前利益", "130"], ["法人税等", "40"]]}
          after={[["税引前利益", "130"], ["法人税等", "10", "↓−30"]]}
          changes
          clue="実効税率（税金÷税引前利益）が異常に低い（例：31%→8%）。利益のわりに税が軽すぎる。"
        />

        <ExampleCard
          tag="手口5" title="借入金の簿外化（負債隠し）"
          story="返さなければいけない借金を帳簿から消し、財務を健全に見せる。"
          before={[["長期借入金", "300"], ["（貸借差額）", "0"]]}
          after={[["長期借入金", "100", "↓−200"], ["（貸借差額）", "200", "⚑不均衡"]]}
          changes
          clue="「資産の合計」と「負債＋純資産の合計」が一致しない（貸借差額が出る）。バランスが崩れたら隠し事の痕跡。"
        />

        <div className="ex-more">
          このほかに、海外子会社の<b>為替レートを不当に高く換算</b>して利益を膨らませる手口や、
          グループ会社どうしで商品を回す<b>循環取引</b>（架空の売上回し）もあります。
        </div>
      </div>

      {/* 大事なルール */}
      <div className="rules-block highlight">
        <div className="rb-title">⑤ ここが大事（フェアプレイの仕組み）</div>
        <div className="rb-body">
          粉飾するには、<b>必ずどこかの数字を不自然にしなければなりません</b>。
          数字を一切いじらずに「ここは嘘」と指定することはできない仕組みです（痕跡のない嘘は出題時にブロックされます）。
          だから調査官は、<b>必ず手がかりから論理的に見抜ける</b>——運ではなく推理のゲームです。
        </div>
      </div>

      {/* 採点 */}
      <div className="rules-block">
        <div className="rb-title">⑥ 採点（調査官の得点）</div>
        <div className="score-table">
          <div className="score-row ok"><span>架空科目を正しく指摘</span><b>+10 / 件</b></div>
          <div className="score-row ok"><span>為替操作を看破</span><b>+12 / 件</b></div>
          <div className="score-row ok"><span>循環取引を看破</span><b>+14</b></div>
          <div className="score-row ok"><span>すべて完璧に摘発</span><b>+15 ボーナス</b></div>
          <div className="score-row ok"><span>健全企業を正しく「適正」と判断</span><b>+15</b></div>
          <div className="score-row ng"><span>的外れな指摘</span><b>−9 / 件</b></div>
          <div className="score-row ng"><span>健全企業を誤って告発</span><b>−12 / 件</b></div>
        </div>
        <p className="muted small" style={{ marginTop: 10 }}>むやみに疑うと大きく減点。確信を持って指摘するのがコツです。</p>
      </div>

      <div className="btn-row" style={{ justifyContent: "center", marginTop: 8 }}>
        <button className="btn primary big" onClick={onBack}>わかった！ゲームへ戻る</button>
      </div>
    </div>
  );
}

// ================================================================
function Login({ onBack, onDone }) {
  const [mode, setMode] = useState("login"); // login | register
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!cloud.enabled) {
    return (
      <div className="screen">
        <div className="section-head"><h2 className="h2">ログイン</h2></div>
        <div className="lib-empty">ログイン機能はまだ設定されていません（Firebaseの構成が未登録）。設定すると、メールやGoogleでログインして全端末で成績を共有できます。</div>
        <div className="btn-row"><button className="btn ghost" onClick={onBack}>戻る</button></div>
      </div>
    );
  }
  async function submit() {
    setErr(""); setBusy(true);
    try {
      if (mode === "login") await cloud.signInEmail(email.trim(), pw);
      else await cloud.registerEmail(email.trim(), pw);
      onDone();
    } catch (e) { setErr(translateAuthErr(e)); } finally { setBusy(false); }
  }
  async function google() {
    setErr(""); setBusy(true);
    try { await cloud.signInGoogle(); onDone(); }
    catch (e) { setErr(translateAuthErr(e)); } finally { setBusy(false); }
  }
  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">{mode === "login" ? "ログイン" : "新規登録"}</h2>
        <p className="muted">ログインすると、成績がクラウドに保存され、どの端末からでもマイページとランキングが見られます。</p></div>
      <div className="auth-card">
        <button className="btn google-btn" onClick={google} disabled={busy}>Googleでログイン</button>
        <div className="auth-or">または メールで</div>
        <input className="auth-input" type="email" placeholder="メールアドレス" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="auth-input" type="password" placeholder="パスワード（6文字以上）" value={pw} onChange={(e) => setPw(e.target.value)} />
        {err && <div className="error-msg">{err}</div>}
        <button className="btn primary" onClick={submit} disabled={busy || !email || pw.length < 6}>{busy ? "処理中…" : (mode === "login" ? "ログイン" : "登録する")}</button>
        <button className="auth-switch" onClick={() => { setErr(""); setMode(mode === "login" ? "register" : "login"); }}>
          {mode === "login" ? "アカウントが無い方はこちら（新規登録）" : "すでにアカウントをお持ちの方（ログイン）"}
        </button>
      </div>
      <div className="btn-row"><button className="btn ghost" onClick={onBack}>トップへ戻る</button></div>
    </div>
  );
}
function translateAuthErr(e) {
  const c = (e && e.code) || "";
  if (c.includes("invalid-email")) return "メールアドレスの形式が正しくありません。";
  if (c.includes("user-not-found")) return "このメールのアカウントが見つかりません。新規登録してください。";
  if (c.includes("wrong-password")) return "パスワードが違います。";
  if (c.includes("email-already-in-use")) return "このメールは既に登録済みです。ログインしてください。";
  if (c.includes("weak-password")) return "パスワードは6文字以上にしてください。";
  if (c.includes("popup-closed")) return "ログインがキャンセルされました。";
  return "うまくいきませんでした。時間をおいて再度お試しください。";
}

function MyPage({ user, profile, history, onBack, onLogin, onProfileSaved, onPlay }) {
  const [cloudStats, setCloudStats] = useState(null);
  const [ranking, setRanking] = useState([]);
  const [likedList, setLikedList] = useState([]);
  const [savedList, setSavedList] = useState([]);
  const [tab, setTab] = useState("liked"); // liked | saved
  const [loading, setLoading] = useState(true);
  const [nameInput, setNameInput] = useState((profile && profile.displayName) || "");
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      if (user) {
        const s = await cloud.getMyStats(user.uid);
        const r = await cloud.getRanking(20);
        const lk = await cloud.listLiked(user.uid, 60);
        const sv = await cloud.listSaved(user.uid, 60);
        if (alive) { setCloudStats(s); setRanking(r); setLikedList(lk); setSavedList(sv); }
      }
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [user]);

  // 端末内の成績（未ログイン時 or 補助表示）
  const local = useMemo(() => {
    const attempts = history.length;
    const tf = history.reduce((s, h) => s + (h.fakeTotal || 0), 0);
    const th = history.reduce((s, h) => s + (h.hits || 0), 0);
    const wins = history.filter((h) => h.result === "win").length;
    return { attempts, discRate: tf > 0 ? Math.round((th / tf) * 100) : 0, wins };
  }, [history]);

  if (!cloud.enabled) {
    return (
      <div className="screen">
        <div className="section-head"><h2 className="h2">マイページ</h2></div>
        <div className="lib-empty">クラウド機能は未設定のため、端末内の成績のみ表示します。</div>
        <LocalStatBlock local={local} />
        <div className="btn-row"><button className="btn ghost" onClick={onBack}>トップへ</button></div>
      </div>
    );
  }
  if (!user) {
    return (
      <div className="screen">
        <div className="section-head"><h2 className="h2">マイページ</h2><p className="muted">ログインすると、勝率の記録とランキング参加ができます。</p></div>
        <LocalStatBlock local={local} />
        <div className="btn-row"><button className="btn primary" onClick={onLogin}>ログイン / 新規登録</button><button className="btn ghost" onClick={onBack}>トップへ</button></div>
      </div>
    );
  }

  const s = cloudStats || { attempts: 0, wins: 0, draws: 0, loses: 0, totalFakes: 0, totalHits: 0, scoreSum: 0 };
  const winRate = s.attempts > 0 ? Math.round((s.wins / s.attempts) * 100) : 0;
  const discRate = s.totalFakes > 0 ? Math.round((s.totalHits / s.totalFakes) * 100) : 0;
  const avgScore = s.attempts > 0 ? Math.round(s.scoreSum / s.attempts) : 0;

  async function saveName() {
    if (!nameInput.trim()) return;
    setSavingName(true);
    await cloud.setDisplayName(user.uid, nameInput.trim());
    onProfileSaved && onProfileSaved({ ...(profile || {}), displayName: nameInput.trim() });
    setSavingName(false);
  }

  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">マイページ</h2><p className="muted">{user.email || "ログイン中"}</p></div>

      <div className="name-edit">
        <span className="name-label">表示名（ランキングに出る名前）</span>
        <div className="name-row">
          <input className="auth-input" value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="表示名" />
          <button className="btn ghost small-btn" onClick={saveName} disabled={savingName}>{savingName ? "保存中…" : "保存"}</button>
        </div>
      </div>

      <div className="mypage-stats">
        <div className="ms-card"><div className="ms-v" style={{ color: "#2e7d52" }}>{winRate}%</div><div className="ms-l">勝率</div></div>
        <div className="ms-card"><div className="ms-v" style={{ color: "#1f6f8b" }}>{discRate}%</div><div className="ms-l">粉飾発見率</div></div>
        <div className="ms-card"><div className="ms-v">{s.attempts}</div><div className="ms-l">挑戦数</div></div>
        <div className="ms-card"><div className="ms-v" style={{ color: avgScore >= 0 ? "#2e7d52" : "#c0392b" }}>{avgScore >= 0 ? "+" : ""}{avgScore}</div><div className="ms-l">平均スコア</div></div>
      </div>
      <div className="mypage-sub">
        <span>勝 {s.wins}</span><span>分 {s.draws}</span><span>負 {s.loses}</span>
      </div>

      <div className="collection-section">
        <div className="coll-tabs">
          <button className={`coll-tab ${tab === "liked" ? "on" : ""}`} onClick={() => setTab("liked")}>いいねした出題 ({likedList.length})</button>
          <button className={`coll-tab ${tab === "saved" ? "on" : ""}`} onClick={() => setTab("saved")}>保存した出題 ({savedList.length})</button>
        </div>
        {(() => {
          const list = tab === "liked" ? likedList : savedList;
          if (loading) return <div className="muted small">読み込み中…</div>;
          if (list.length === 0) return <div className="lib-empty">{tab === "liked" ? "まだ「いいね」した出題はありません。公開出題でを押すと、ここに集まります。" : "まだ保存した出題はありません。公開出題でを押すと、ここに集まります。"}</div>;
          return (
            <div className="lib-list">
              {list.map((e) => (
                <div className="post-card" key={e.id}>
                  <div className="post-main" onClick={() => e.code ? onPlay({ code: e.code }) : null}>
                    <div className="post-info">
                      <div className="lib-title">{e.title}{e.clean && <span className="post-clean">健全かも</span>}{e.periodCount > 1 && <span className="lib-period">{e.periodCount}期</span>}</div>
                      <div className="lib-meta"><span>作: {e.ownerName || "匿名"}</span>{e.companyCount ? <><span className="lib-dot">·</span><span>{e.companyCount}社</span></> : null}</div>
                    </div>
                    <div className="post-play">{e.code ? "挑む →" : "（本文なし）"}</div>
                  </div>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      <div className="rank-section">
        <h3 className="rank-title">勝利数ランキング</h3>
        {loading ? <div className="muted small">読み込み中…</div> : ranking.length === 0 ? (
          <div className="muted small">まだランキングデータがありません。挑戦すると反映されます。</div>
        ) : (
          <div className="rank-list">
            {ranking.map((e, i) => {
              const wr = e.attempts > 0 ? Math.round((e.wins / e.attempts) * 100) : 0;
              const me = e.uid === user.uid;
              return (
                <div className={`rank-row ${me ? "me" : ""}`} key={e.uid}>
                  <span className="rank-no">{i + 1}</span>
                  <span className="rank-name">{e.displayName || "匿名"}{me && <span className="rank-me-tag">あなた</span>}</span>
                  <span className="rank-wins">{e.wins || 0}勝</span>
                  <span className="rank-wr">勝率{wr}%</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="btn-row">
        <button className="btn ghost" onClick={onBack}>トップへ</button>
        <button className="btn ghost danger-text" onClick={() => cloud.signOut()}>ログアウト</button>
      </div>
    </div>
  );
}
function LocalStatBlock({ local }) {
  return (
    <div className="mypage-stats">
      <div className="ms-card"><div className="ms-v" style={{ color: "#2e7d52" }}>{local.wins}</div><div className="ms-l">勝利数</div></div>
      <div className="ms-card"><div className="ms-v" style={{ color: "#1f6f8b" }}>{local.discRate}%</div><div className="ms-l">発見率</div></div>
      <div className="ms-card"><div className="ms-v">{local.attempts}</div><div className="ms-l">挑戦数</div></div>
    </div>
  );
}

function Home({ history, user, profile, onBuild, onLoad, onRules, onMine, onLogin, onMypage, onPractice, onDaily, onExplore }) {
  const stats = useMemo(() => {
    const attempts = history.length;
    const tf = history.reduce((s, h) => s + (h.fakeTotal || 0), 0);
    const th = history.reduce((s, h) => s + (h.hits || 0), 0);
    const wins = history.filter((h) => h.result === "win").length;
    return { attempts, discRate: tf > 0 ? Math.round((th / tf) * 100) : 0, wins };
  }, [history]);
  const isNew = history.length === 0; // 初めての人か
  return (
    <div className="screen">
      <div className="hero">
        <h1 className="hero-title">決算書のウソを、<br/>見抜けるか？</h1>
        <p className="hero-lede">会社の成績表「決算書」に隠された粉飾（数字のウソ）を探す推理ゲーム。会計を知らなくても、遊びながら数字に強くなれます。1問3分から。</p>
      </div>

      {/* まずここから（初心者の入口を1本に） */}
      <div className="start-here">
        <div className="start-label">{isNew ? "まずはここから" : "今日も1問どうぞ"}</div>
        <div className="start-cards">
          <button className="start-card primary" onClick={onPractice}>
            <div className="sc-title">練習モードで遊ぶ</div>
            <div className="sc-desc">レベル1から1つずつ。これが一番やさしい入口です。</div>
          </button>
          <button className="start-card" onClick={onDaily}>
            <div className="sc-title">今日の1問</div>
            <div className="sc-desc">毎日変わる1問。みんな同じ問題に挑戦。</div>
          </button>
        </div>
        <button className="rules-link" onClick={onRules}>ルールと例題を読む（初めての方へ）</button>
      </div>

      <div className="role-divider"><span>もっと遊ぶ</span></div>

      <div className="role-grid">
        <button className="role-card invest" onClick={onExplore}>
<div className="role-name">公開出題に挑む</div>
          <div className="role-desc">みんなが作った出題に挑戦。いいね・保存もできます。</div>
          <div className="role-go">公開出題へ →</div>
        </button>
        <button className="role-card fraud" onClick={onBuild}>
<div className="role-name">出題を作る</div>
          <div className="role-desc">自分で決算書を作り、ウソを仕込んで出題。リンクで送る・公開する。</div>
          <div className="role-go">作る →</div>
        </button>
      </div>
      <div className="mine-link-row">
        <button className="mine-link" onClick={onMine}>マイ出題一覧（作った出題を再送信）</button>
        {cloud.enabled && <button className="mine-link" onClick={user ? onMypage : onLogin}>{user ? "マイページ・ランキング" : "ログインして成績を記録"}</button>}
      </div>
      <div className="hist-section">
        <div className="hist-head">
          <h2 className="hist-title">調査官カルテ</h2>
          <div className="hist-stats">
            <div className="stat"><span className="stat-v">{stats.attempts}</span><span className="stat-l">挑戦数</span></div>
            <div className="stat"><span className="stat-v" style={{ color: C.teal }}>{stats.discRate}%</span><span className="stat-l">発見率</span></div>
            <div className="stat"><span className="stat-v" style={{ color: C.green }}>{stats.wins}</span><span className="stat-l">勝利数</span></div>
          </div>
        </div>
        {history.length === 0 ? (
          <div className="hist-empty">まだ挑戦記録がありません。調査一覧から出題に挑むと、挑戦数と発見率がここに記録されます。</div>
        ) : (
          <div className="hist-list">
            {history.slice(0, 8).map((h) => {
              const rate = h.fakeTotal > 0 ? Math.round((h.hits / h.fakeTotal) * 100) : (h.cleanCo ? 100 : 0);
              const cls = h.result === "win" ? "win" : h.result === "lose" ? "lose" : "draw";
              return (
                <div className={`hist-row ${cls}`} key={h.id}>
                  <span className="hr-title">{h.title}</span>
                  <span className="hr-meta">{h.cleanCo ? "健全企業" : `架空${h.hits}/${h.fakeTotal}`}</span>
                  <span className="hr-rate">{h.cleanCo ? (h.result === "win" ? "看破" : "誤認") : `発見${rate}%`}</span>
                  <span className="hr-score" style={{ color: h.score >= 0 ? C.green : C.red }}>{h.score >= 0 ? "+" : ""}{h.score}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ================================================================
function AccountRow({ a, value, onChange, faked, onToggleFake, showFake, sym, onTip, removable, onRemove }) {
  return (
    <div className={`fin-row ${faked ? "faked" : ""} ${removable ? "is-extra" : ""}`}>
      <div className="fin-label-col">
        <button className="fin-label tip-trigger" onClick={() => onTip({ label: a.label, desc: a.desc })} title="説明を見る">
          {a.label}<span className="tip-mark">?</span>
        </button>
        {a.hint && <span className="fin-hint">{a.hint}</span>}
      </div>
      <div className="fin-right">
        <div className="fin-input-wrap">
          <span className="fin-sym">{sym}</span>
          <input className="fin-input" inputMode="numeric" value={value === 0 ? "" : value} placeholder="0" onChange={(e) => onChange(e.target.value)} />
        </div>
        {showFake && (
          <button className={`fake-btn ${faked ? "on" : ""}`} onClick={onToggleFake} title="この数字を架空（粉飾）にする">{faked ? "架空中" : "架空にする"}</button>
        )}
        {removable && <button className="row-remove" onClick={onRemove} title="この科目を外す">✕</button>}
      </div>
    </div>
  );
}

function AddAccountMenu({ keys, onAdd }) {
  if (!keys || keys.length === 0) return null;
  return (
    <div className="add-acc">
      <span className="add-acc-label">＋ 科目を追加:</span>
      <div className="add-acc-chips">
        {keys.map((k) => (
          <button key={k} className="add-acc-chip" onClick={() => onAdd(k)}>{A_BY_KEY[k].label}</button>
        ))}
      </div>
    </div>
  );
}

function DerivedLine({ label, value, strong, sym }) {
  return (
    <div className={`derived ${strong ? "strong" : ""} ${value < 0 ? "neg" : ""}`}>
      <span>{label}</span><b>{sym}{fmt(value)}</b>
    </div>
  );
}

// ================================================================
function Builder({ companies, setCompanies, internalTxns, setInternalTxns, fakes, setFakes, isClean, setIsClean, onDone, onTip, periodCount, changePeriodCount, buildWarn, onForceBuild, onDismissWarn, onPreview, onSaveDraft, onLoadDraft, hasDraft, draftMsg }) {
  const [tab, setTab] = useState(companies[0]?.cid);
  const activeCid = companies.some((c) => c.cid === tab) ? tab : companies[0]?.cid;
  const active = companies.find((c) => c.cid === activeCid);
  const nPeriods = periodCountOf(active || companies[0]);
  // 編集中の期インデックス（既定は当期=末尾）
  const [editPeriod, setEditPeriod] = useState(nPeriods - 1);
  const pIdx = Math.min(editPeriod, nPeriods - 1);
  const labels = periodLabels(nPeriods);

  // 当期(末尾)に対してのみ架空指定・痕跡判定を行う
  const lastIdx = nPeriods - 1;

  function setPeriodFin(cid, idx, key, value) {
    const v = value === "" ? 0 : Math.max(0, parseInt(String(value).replace(/[^\d]/g, ""), 10) || 0);
    setCompanies((p) => p.map((c) => {
      if (c.cid !== cid) return c;
      const periods = c.periods.map((f, i) => i === idx ? { ...f, [key]: v } : f);
      return { ...c, periods };
    }));
  }
  function setField(cid, field, val) { setCompanies((p) => p.map((c) => c.cid === cid ? { ...c, [field]: val } : c)); }
  function setIndustry(cid, ind) { setField(cid, "industry", ind); }
  function setName(cid, name) { setField(cid, "name", name); }
  function addExtra(cid, key) { setCompanies((p) => p.map((c) => c.cid === cid ? { ...c, extraKeys: c.extraKeys.includes(key) ? c.extraKeys : [...c.extraKeys, key] } : c)); }
  function removeExtra(cid, key) {
    setCompanies((p) => p.map((c) => c.cid === cid ? { ...c, extraKeys: c.extraKeys.filter((k) => k !== key), periods: c.periods.map((f) => ({ ...f, [key]: 0 })) } : c));
    setFakes((p) => p.filter((f) => !(f.cid === cid && f.key === key)));
  }
  function addAllExtras(cid) { setCompanies((p) => p.map((c) => c.cid === cid ? { ...c, extraKeys: [...DETAIL_KEYS] } : c)); }
  function clearExtras(cid) {
    setCompanies((p) => p.map((c) => c.cid === cid ? { ...c, extraKeys: [], periods: c.periods.map((f) => ({ ...f, ...Object.fromEntries(DETAIL_KEYS.map((k) => [k, 0])) })) } : c));
    setFakes((p) => p.filter((f) => !(f.cid === cid && DETAIL_KEYS.includes(f.key))));
  }
  function setCurrency(cid, cur) { setCompanies((p) => p.map((c) => c.cid === cid ? { ...c, currency: cur, fxRate: cur === "JPY" ? 1 : CURRENCIES[cur].market } : c)); }
  function setFxRate(cid, val) { const v = val === "" ? 0 : Math.max(0, parseFloat(String(val).replace(/[^\d.]/g, "")) || 0); setField(cid, "fxRate", v); }

  function addSub() {
    if (companies.length >= 6) return;
    const subCount = companies.filter((c) => c.role === "sub").length;
    const nc = makeCompany("sub", subCount + 1, pick(INDUSTRY_KEYS), nPeriods);
    setCompanies((p) => [...p, nc]); setTab(nc.cid);
  }
  function removeCompany(cid) {
    const t = companies.find((c) => c.cid === cid); if (!t || t.role === "parent") return;
    setCompanies((p) => p.filter((c) => c.cid !== cid));
    setFakes((p) => p.filter((f) => f.cid !== cid));
    setInternalTxns((p) => p.filter((x) => x.from !== cid && x.to !== cid));
    if (activeCid === cid) setTab(companies[0].cid);
  }
  function toggleFake(cid, key) {
    if (isClean) return; const id = `${cid}:${key}`;
    setFakes((p) => p.some((f) => `${f.cid}:${f.key}` === id) ? p.filter((f) => `${f.cid}:${f.key}` !== id) : [...p, { cid, key }]);
  }
  const isFake = (cid, key) => fakes.some((f) => f.cid === cid && f.key === key);

  // 健全な複数期データを生成（緩やかな成長トレンド）
  function genHealthyPeriods(industryKey, n) {
    const latest = genHealthyFin(industryKey);
    const periods = [latest];
    let ref = latest;
    for (let i = 1; i < n; i++) {
      // 1期さかのぼるごとに全科目を 88〜97% に縮小（過去ほど小さい＝自然な成長）
      const factor = rnd(88, 97) / 100;
      const older = {};
      for (const k of Object.keys(ref)) older[k] = Math.round(num(ref, k) * factor);
      periods.unshift(older);
      ref = older;
    }
    return periods;
  }
  function autoHealthyAll() {
    setIsClean(true); setFakes([]);
    setCompanies((p) => p.map((c) => ({ ...c, periods: genHealthyPeriods(c.industry, nPeriods), extraKeys: [...DETAIL_KEYS], fxRate: c.currency === "JPY" ? 1 : CURRENCIES[c.currency].market })));
  }
  function autoFraudAll() {
    setIsClean(false); const nf = [];
    setCompanies((p) => p.map((c, i) => {
      const periods = genHealthyPeriods(c.industry, nPeriods);
      const fraud = i === 0 || Math.random() < 0.6;
      let fxRate = c.currency === "JPY" ? 1 : CURRENCIES[c.currency].market;
      if (c.currency !== "JPY" && Math.random() < 0.4) fxRate = Math.round(CURRENCIES[c.currency].market * (1 + rnd(20, 40) / 100) * 100) / 100;
      if (!fraud) return { ...c, periods, extraKeys: [...DETAIL_KEYS], fxRate };
      // 当期に粉飾を仕込む（痕跡が必ず出るよう保証）
      const prev = periods.length > 1 ? periods[periods.length - 2] : null;
      const { fin, fakedKeys } = injectFraudWithTrace(periods[periods.length - 1], c.industry, prev);
      const np = periods.slice(0, -1).concat([fin]);
      fakedKeys.forEach((k) => nf.push({ cid: c.cid, key: k }));
      return { ...c, periods: np, extraKeys: [...DETAIL_KEYS], fxRate };
    }));
    setFakes(nf);
  }
  function autoHealthyOne(cid) {
    setCompanies((p) => p.map((c) => c.cid === cid ? { ...c, periods: genHealthyPeriods(c.industry, nPeriods), extraKeys: [...DETAIL_KEYS], fxRate: c.currency === "JPY" ? 1 : CURRENCIES[c.currency].market } : c));
    setFakes((p) => p.filter((f) => f.cid !== cid));
  }

  function addTxn() { setInternalTxns((p) => [...p, { from: companies[1]?.cid || companies[0].cid, to: companies[0].cid, amount: 0, real: 0 }]); }
  function updTxn(i, field, val) { setInternalTxns((p) => p.map((t, idx) => idx === i ? { ...t, [field]: (field === "amount" || field === "real") ? (parseInt(String(val).replace(/[^\d]/g, ""), 10) || 0) : val } : t)); }
  function delTxn(i) { setInternalTxns((p) => p.filter((_, idx) => idx !== i)); }

  const { cons, sum, elim } = useMemo(() => consolidate(companies, internalTxns), [companies, internalTxns]);
  const anyInput = companies.some((c) => c.periods.some((f) => Object.values(f).some((v) => v > 0)));
  const cur = active ? CURRENCIES[active.currency] : CURRENCIES.JPY;
  const efin = active ? active.periods[pIdx] : emptyFin(); // 編集中の期の決算
  const editingCurrent = pIdx === lastIdx;
  const visiblePL = (c) => PL_KEYS.filter((k) => A_BY_KEY[k].tier === "basic" || c.extraKeys.includes(k));
  const visibleAssets = (c) => BS_ASSET_KEYS.filter((k) => A_BY_KEY[k].tier === "basic" || c.extraKeys.includes(k));
  const visibleLiab = (c) => BS_LIAB_KEYS.filter((k) => A_BY_KEY[k].tier === "basic" || c.extraKeys.includes(k));
  // 追加可能（まだ表示していない詳細科目）
  const addablePL = (c) => PL_KEYS.filter((k) => A_BY_KEY[k].tier === "detail" && !c.extraKeys.includes(k));
  const addableBS = (c) => [...BS_ASSET_KEYS, ...BS_LIAB_KEYS].filter((k) => A_BY_KEY[k].tier === "detail" && !c.extraKeys.includes(k));

  return (
    <div className="screen">
      <div className="section-head">
        <h2 className="h2">出題を作る — 粉飾者</h2>
        <p className="muted">最低限の基本科目から入力。必要なら「詳細科目を追加」でPL/BSをフル展開。科目名をタップで説明。架空にする数字は「架空指定」でマーク。</p>
      </div>

      <div className="period-panel">
        <div className="period-head">
          <span className="period-title">期数</span>
          <span className="period-sub">{nPeriods === 1 ? "単期（やさしい）" : `${nPeriods}期比較（むずかしい）`}</span>
        </div>
        <div className="period-opts">
          {[1, 2, 3, 4].map((n) => (
            <button key={n} className={`period-opt ${nPeriods === n ? "on" : ""}`} onClick={() => { changePeriodCount(n); setEditPeriod(n - 1); }}>
              {n === 1 ? "単期" : `${n}期`}
            </button>
          ))}
        </div>
        {nPeriods > 1 && <p className="muted small">期別では、売上急増に売掛が追従、利益は伸びるのに現金が減る等「年度をまたいで見える粉飾」が作れます。架空指定は<b>当期</b>に対して行います。</p>}
      </div>

      <div className="auto-panel">
        <div className="auto-title">自動入力（初心者向け）</div>
        <div className="auto-btns">
          <button className="auto-btn green" onClick={autoHealthyAll}>全社・健全データ生成</button>
          <button className="auto-btn red" onClick={autoFraudAll}>全社・粉飾データ生成<span className="auto-sub">架空＋為替操作 自動</span></button>
        </div>
        <p className="muted small">業種・通貨に沿ったPL/BSを生成。{nPeriods > 1 ? "複数期は成長トレンド付きで生成。" : ""}生成後の手調整も可能。</p>
      </div>

      <label className={`clean-toggle ${isClean ? "on" : ""}`}>
        <input type="checkbox" checked={isClean} onChange={(e) => { setIsClean(e.target.checked); if (e.target.checked) setFakes([]); }} />
        <span className="clean-box">{isClean ? "✓" : ""}</span>
        <span><b>健全決算で出題する（罠モード）</b><br/><span className="muted small">嘘を仕込まない。調査官が誤告発すれば粉飾者の勝ち。</span></span>
      </label>

      <div className="tabs">
        {companies.map((c) => {
          const fc = fakes.filter((f) => f.cid === c.cid).length;
          return (
            <button key={c.cid} className={`tab ${activeCid === c.cid ? "active" : ""}`} onClick={() => setTab(c.cid)}>
              <span className="tab-ind">{INDUSTRIES[c.industry].icon}</span>{c.name}
              {c.currency !== "JPY" && <span className="tab-cur">{CURRENCIES[c.currency].sym}</span>}
              {!isClean && fc > 0 && <span className="tab-badge">{fc}</span>}
            </button>
          );
        })}
        {companies.length < 6 && <button className="tab add" onClick={addSub}>＋ 子会社</button>}
      </div>

      {active && (
        <div className="form-card">
          <div className="form-head">
            <div className="co-id">
              <input className="co-name" value={active.name} onChange={(e) => setName(active.cid, e.target.value)} />
              <span className="co-role">{active.role === "parent" ? "親会社" : "子会社"}</span>
            </div>
            <div className="form-head-r">
              {active.role !== "parent" && <button className="rm-btn" onClick={() => removeCompany(active.cid)}>削除</button>}
            </div>
          </div>

          <div className="ind-row">
            <span className="ind-label">業種</span>
            <div className="ind-chips">
              {INDUSTRY_KEYS.map((k) => <button key={k} className={`ind-chip ${active.industry === k ? "on" : ""}`} onClick={() => setIndustry(active.cid, k)}>{INDUSTRIES[k].icon} {INDUSTRIES[k].name}</button>)}
            </div>
          </div>
          <div className="ind-row">
            <span className="ind-label">通貨</span>
            <div className="ind-chips">
              {CURRENCY_KEYS.map((k) => <button key={k} className={`ind-chip ${active.currency === k ? "on" : ""}`} onClick={() => setCurrency(active.cid, k)}>{CURRENCIES[k].sym} {CURRENCIES[k].name}</button>)}
            </div>
          </div>
          {active.currency !== "JPY" && (
            <div className="fx-row">
              <span className="fx-label">換算レート (1{cur.sym}=?円)</span>
              <input className="fx-input" inputMode="decimal" value={active.fxRate || ""} onChange={(e) => setFxRate(active.cid, e.target.value)} />
              <span className="fx-market">市場目安 {cur.market}円 (±{cur.band}%)</span>
              {fxAbusive(active) && <span className="fx-warn">⚑ 不当な高レート</span>}
            </div>
          )}
          <p className="ind-note">{INDUSTRIES[active.industry].note}<button className="inline-auto" onClick={() => autoHealthyOne(active.cid)}>この社だけ自動生成</button></p>

          <div className="hint-row">
            <span className="hint-label">この会社へのヒント（任意・調査官に表示されます）</span>
            <textarea className="hint-input" maxLength={120} rows={2} placeholder="例: この会社、売上の伸びがちょっと不自然かも…？（最大120字）"
              value={active.hint || ""} onChange={(e) => setField(active.cid, "hint", e.target.value)} />
            <span className="hint-count">{(active.hint || "").length}/120</span>
          </div>

          {/* 期タブ（複数期のとき） */}
          {nPeriods > 1 && (
            <div className="period-tabs">
              {labels.map((lab, i) => (
                <button key={i} className={`ptab ${pIdx === i ? "active" : ""} ${i === lastIdx ? "current" : ""}`} onClick={() => setEditPeriod(i)}>
                  {lab}{i === lastIdx ? "（架空指定可）" : ""}
                </button>
              ))}
            </div>
          )}

          {/* PL */}
          <div className="stmt-block">
            <div className="stmt-title">損益計算書（PL）{nPeriods > 1 && <span className="stmt-period">{labels[pIdx]}</span>}</div>
            <div className="form-grid">
              {visiblePL(active).map((k) => (
                <AccountRow key={k} a={A_BY_KEY[k]} value={efin[k]} sym={cur.sym}
                  onChange={(v) => setPeriodFin(active.cid, pIdx, k, v)} faked={isFake(active.cid, k)}
                  onToggleFake={() => toggleFake(active.cid, k)} showFake={!isClean && editingCurrent} onTip={onTip}
                  removable={A_BY_KEY[k].tier === "detail"} onRemove={() => removeExtra(active.cid, k)} />
              ))}
            </div>
            <AddAccountMenu keys={addablePL(active)} onAdd={(k) => addExtra(active.cid, k)} />
            <div className="derived-box">
              <DerivedLine label="売上総利益" value={grossProfit(efin)} sym={cur.sym} />
              <DerivedLine label="営業利益" value={opProfit(efin)} sym={cur.sym} />
              {(active.extraKeys.includes("nonOpInc") || active.extraKeys.includes("nonOpExp")) && <DerivedLine label="経常利益" value={ordProfit(efin)} sym={cur.sym} />}
              {(active.extraKeys.includes("extraInc") || active.extraKeys.includes("extraLoss") || active.extraKeys.includes("tax")) && <DerivedLine label="税引前利益" value={pretaxProfit(efin)} sym={cur.sym} />}
              <DerivedLine label="当期純利益" value={netIncome(efin)} sym={cur.sym} strong />
            </div>
          </div>

          {/* BS */}
          <div className="stmt-block">
            <div className="stmt-title">貸借対照表（BS）{nPeriods > 1 && <span className="stmt-period">{labels[pIdx]}</span>}</div>
            <div className="bs-cols">
              <div className="bs-col">
                <div className="bs-h">資産の部</div>
                <div className="form-grid one">
                  {visibleAssets(active).map((k) => (
                    <AccountRow key={k} a={A_BY_KEY[k]} value={efin[k]} sym={cur.sym}
                      onChange={(v) => setPeriodFin(active.cid, pIdx, k, v)} faked={isFake(active.cid, k)}
                      onToggleFake={() => toggleFake(active.cid, k)} showFake={!isClean && editingCurrent} onTip={onTip}
                      removable={A_BY_KEY[k].tier === "detail"} onRemove={() => removeExtra(active.cid, k)} />
                  ))}
                </div>
                <div className="derived-box"><DerivedLine label="資産合計" value={totalAssets(efin)} sym={cur.sym} strong /></div>
              </div>
              <div className="bs-col">
                <div className="bs-h">負債・純資産の部</div>
                <div className="form-grid one">
                  {visibleLiab(active).map((k) => (
                    <AccountRow key={k} a={A_BY_KEY[k]} value={efin[k]} sym={cur.sym}
                      onChange={(v) => setPeriodFin(active.cid, pIdx, k, v)} faked={isFake(active.cid, k)}
                      onToggleFake={() => toggleFake(active.cid, k)} showFake={!isClean && editingCurrent} onTip={onTip}
                      removable={A_BY_KEY[k].tier === "detail"} onRemove={() => removeExtra(active.cid, k)} />
                  ))}
                </div>
                <div className="derived-box"><DerivedLine label="負債・純資産合計" value={totalLiabEquity(efin)} sym={cur.sym} strong /></div>
              </div>
            </div>
            <AddAccountMenu keys={addableBS(active)} onAdd={(k) => addExtra(active.cid, k)} />
            {(active.extraKeys.some((k) => BS_LIAB_KEYS.includes(k))) && Math.abs(bsGap(efin)) > 0 && (
              <div className={`bs-balance ${Math.abs(bsGap(efin)) > Math.max(30, num(efin, "sales") * 0.03) ? "off" : "ok"}`}>
                貸借差額: {cur.sym}{fmt(bsGap(efin))}
                {Math.abs(bsGap(efin)) > Math.max(30, num(efin, "sales") * 0.03)
                  ? "（資産と負債・純資産が不均衡。粉飾の痕跡になり得ます）"
                  : "（ほぼ均衡）"}
              </div>
            )}
          </div>

          {/* 一括操作 */}
          <div className="bulk-extras">
            <button className="bulk-btn" onClick={() => addAllExtras(active.cid)}>詳細科目をすべて追加</button>
            {active.extraKeys.length > 0 && <button className="bulk-btn ghost" onClick={() => clearExtras(active.cid)}>詳細科目をすべて外す</button>}
          </div>
        </div>
      )}

      {/* 内部取引 */}
      <div className="form-card">
        <div className="form-head"><span className="form-co">グループ内部取引（円建て・連結で消去）</span><button className="mini-btn" onClick={addTxn}>+ 取引を追加</button></div>
        <p className="muted small">計上額を実際額より大きくすると<span style={{ color: C.amber }}>循環取引</span>になります。</p>
        {internalTxns.length === 0 && <div className="muted small empty">内部取引なし</div>}
        {internalTxns.map((t, i) => (
          <div className="txn-row" key={i}>
            <select value={t.from} onChange={(e) => updTxn(i, "from", e.target.value)}>{companies.map((c) => <option key={c.cid} value={c.cid}>{c.name}</option>)}</select>
            <span className="txn-arrow">→</span>
            <select value={t.to} onChange={(e) => updTxn(i, "to", e.target.value)}>{companies.map((c) => <option key={c.cid} value={c.cid}>{c.name}</option>)}</select>
            <div className="txn-amt"><span>計上</span><input inputMode="numeric" value={t.amount || ""} placeholder="0" onChange={(e) => updTxn(i, "amount", e.target.value)} /></div>
            <div className="txn-amt"><span>実際</span><input inputMode="numeric" value={t.real || ""} placeholder="0" onChange={(e) => updTxn(i, "real", e.target.value)} /></div>
            {t.amount > (t.real || 0) && <span className="txn-flag">循環</span>}
            <button className="txn-del" onClick={() => delTxn(i)}>✕</button>
          </div>
        ))}
      </div>

      <div className="cons-preview">
        <div className="cons-title">連結決算（円換算・自動計算）</div>
        <div className="cons-grid">
          <div className="cons-col"><div className="cons-h">円換算 単純合算（{companies.length}社）</div>
            <div className="cons-line"><span>売上高</span><b>¥{fmt(sum.sales)}</b></div>
            <div className="cons-line"><span>営業利益</span><b>¥{fmt(opProfit(sum))}</b></div>
            <div className="cons-line"><span>当期純利益</span><b>¥{fmt(netIncome(sum))}</b></div>
            <div className="cons-line"><span>資産合計</span><b>¥{fmt(totalAssets(sum))}</b></div>
          </div>
          <div className="cons-col"><div className="cons-h">内部消去後＝連結</div>
            <div className="cons-line"><span>売上高</span><b>¥{fmt(cons.sales)}</b></div>
            <div className="cons-line"><span>営業利益</span><b>¥{fmt(opProfit(cons))}</b></div>
            <div className="cons-line"><span>当期純利益</span><b>¥{fmt(netIncome(cons))}</b></div>
            <div className="cons-line"><span>資産合計</span><b>¥{fmt(totalAssets(cons))}</b></div>
          </div>
        </div>
        {elim > 0 && <div className="muted small">消去された内部売上：¥{fmt(elim)}</div>}
      </div>

      {buildWarn && (
        <div className="build-warn">
          <div className="bw-title">⚠ 痕跡のない架空指定があります</div>
          <div className="bw-body">
            次の科目は数字を不自然にしていないため、調査官にはまったく手がかりが残りません（運ゲーになります）:
            <ul className="bw-list">{buildWarn.map((n, i) => <li key={i}>{n}</li>)}</ul>
            該当科目の金額を業種の常識から外れる値にするか、架空指定を外してください。
          </div>
          <div className="bw-actions">
            <button className="btn ghost" onClick={onDismissWarn}>戻って修正する</button>
            <button className="btn danger" onClick={onForceBuild}>かまわず発行（高難度）</button>
          </div>
        </div>
      )}

      <div className="builder-actions">
        <button className="btn primary big" disabled={!anyInput} onClick={onDone}>出題コードを発行する →</button>
        <div className="builder-sub-actions">
          <button className="btn ghost" disabled={!anyInput} onClick={onPreview}>プレビュー（調査官の見え方）</button>
          <button className="btn ghost" disabled={!anyInput} onClick={onSaveDraft}>下書き保存</button>
          {hasDraft && <button className="btn ghost" onClick={onLoadDraft}>下書きを開く</button>}
        </div>
        {!anyInput && <span className="muted small">数字を入力すると発行・保存できます</span>}
        {draftMsg && <span className="draft-msg">{draftMsg}</span>}
      </div>
    </div>
  );
}

// ================================================================
// ===== 練習モード（レベル選択） =====
function Practice({ onStart, onBack }) {
  const tierColor = { "初級": "#2e7d52", "中級": "#1f6f8b", "上級": "#1f3a5f", "超級": "#c0392b", "最難級": "#b15be0" };
  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">練習モード</h2><p className="muted">初級から超級まで段階別。やさしい入口から、KDDI事件型の循環取引まで。各段位をクリアして称号を集めよう。数字が苦手でも初級から大丈夫。</p></div>
      <div className="practice-list">
        {PRACTICE_LEVELS.map((lv) => (
          <button className="practice-card" key={lv.id} onClick={() => onStart(lv)} style={{ borderLeftColor: tierColor[lv.tier] || "#dfe4ea", borderLeftWidth: 4 }}>
            <div className="pc-badge" style={{ borderColor: tierColor[lv.tier], color: tierColor[lv.tier] }}>{lv.id}</div>
            <div className="pc-body">
              <div className="pc-name">{lv.name}{lv.clean && <span className="pc-clean">シロ</span>}{lv.tactics === null && <span className="pc-real">実戦</span>}{lv.generator && <span className="pc-elite">CF・複数期</span>}</div>
              <div className="pc-tier" style={{ color: tierColor[lv.tier] }}>{lv.tier}　称号「{RANK_TITLES[lv.tier]}」</div>
              <div className="pc-learn">{lv.learn}</div>
            </div>
            <div className="pc-go">挑戦 →</div>
          </button>
        ))}
      </div>
      <div className="practice-note">練習はランキングに影響しません。何度でも挑戦OK。<b>超級</b>はキャッシュフロー計算書つきの本格問題です。慣れたら「作成」で自作したり「公開出題」でみんなの問題に挑みましょう。</div>
      <div className="btn-row"><button className="btn ghost" onClick={onBack}>トップへ</button></div>
    </div>
  );
}

// ===== 公開出題板 =====
function Explore({ user, onPlay, onBack, onLogin }) {
  const [posts, setPosts] = useState([]);
  const [sort, setSort] = useState("new");
  const [loading, setLoading] = useState(true);
  const [liked, setLiked] = useState({});      // postId -> bool
  const [saved, setSaved] = useState({});       // postId -> bool
  const [busy, setBusy] = useState({});         // postId -> bool（連打防止）
  const [reportFor, setReportFor] = useState(null); // 通報対象post
  const [msg, setMsg] = useState("");
  const [onlySaved, setOnlySaved] = useState(false); // 保存したものだけ表示

  async function load() {
    setLoading(true);
    const list = await cloud.listPosts({ sort, limit: 40 });
    setPosts(list);
    if (user) {
      const lk = {}, sv = {};
      for (const p of list) { lk[p.id] = await cloud.hasLiked(p.id, user.uid); sv[p.id] = await cloud.hasSaved(p.id, user.uid); }
      setLiked(lk); setSaved(sv);
    }
    setLoading(false);
  }
  useEffect(() => { load(); }, [sort, user]);

  async function like(p) {
    if (!user) { onLogin(); return; }
    if (busy[p.id]) return;
    setBusy((b) => ({ ...b, [p.id]: true }));
    try {
      const nowLiked = await cloud.toggleLike(p.id, user.uid, { title: p.title, ownerName: p.ownerName, companyCount: p.companyCount, periodCount: p.periodCount, clean: p.clean, code: p.code });
      setLiked((l) => ({ ...l, [p.id]: nowLiked }));
      setPosts((ps) => ps.map((x) => x.id === p.id ? { ...x, likeCount: (x.likeCount || 0) + (nowLiked ? 1 : -1) } : x));
    } catch {}
    setBusy((b) => ({ ...b, [p.id]: false }));
  }
  async function save(p) {
    if (!user) { onLogin(); return; }
    try {
      const nowSaved = await cloud.toggleSave(p.id, user.uid, { title: p.title, ownerName: p.ownerName, companyCount: p.companyCount, periodCount: p.periodCount, clean: p.clean, code: p.code });
      setSaved((s) => ({ ...s, [p.id]: nowSaved }));
      setMsg(nowSaved ? "保存しました。" : "保存を解除しました。");
      setTimeout(() => setMsg(""), 1800);
    } catch {}
  }
  async function submitReport(reason) {
    if (!user) { onLogin(); return; }
    const p = reportFor; setReportFor(null);
    const res = await cloud.reportPost(p.id, user.uid, reason);
    setMsg(res === "already" ? "すでに通報済みです。" : "通報を受け付けました。ご協力ありがとうございます。");
    setTimeout(() => setMsg(""), 2600);
    load();
  }

  if (!cloud.enabled) {
    return (<div className="screen"><div className="section-head"><h2 className="h2">公開出題</h2></div>
      <div className="lib-empty">公開機能はログイン設定（Firebase）が必要です。</div>
      <div className="btn-row"><button className="btn ghost" onClick={onBack}>トップへ</button></div></div>);
  }
  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">公開出題</h2><p className="muted">みんなが投稿した出題に挑戦できます。良い出題にはを、不適切なものは通報を。</p></div>
      {msg && <div className="toast">{msg}</div>}
      <div className="lib-controls">
        <div className="lib-ctrl-group"><span className="lib-ctrl-label">並び</span>
          <div className="lib-chips">
            <button className={`lib-chip ${sort === "new" ? "on" : ""}`} onClick={() => setSort("new")}>新着</button>
            <button className={`lib-chip ${sort === "popular" ? "on" : ""}`} onClick={() => setSort("popular")}>人気（順）</button>
          </div>
        </div>
        {user && <div className="lib-ctrl-group"><span className="lib-ctrl-label">表示</span>
          <div className="lib-chips">
            <button className={`lib-chip ${!onlySaved ? "on" : ""}`} onClick={() => setOnlySaved(false)}>すべて</button>
            <button className={`lib-chip ${onlySaved ? "on" : ""}`} onClick={() => setOnlySaved(true)}>保存したもの</button>
          </div>
        </div>}
      </div>
      {(() => {
        const shown = onlySaved ? posts.filter((p) => saved[p.id]) : posts;
        if (loading) return <div className="muted small">読み込み中…</div>;
        if (shown.length === 0) return <div className="lib-empty">{onlySaved ? "保存した出題はまだありません。で保存できます。" : "まだ公開出題がありません。「作成」から出題を作って公開してみましょう。"}</div>;
        return (
        <div className="lib-list">
          {shown.map((p) => (
            <div className="post-card" key={p.id}>
              <div className="post-main" onClick={() => onPlay(p)}>
                <div className="post-info">
                  <div className="lib-title">{p.title}{p.clean && <span className="post-clean">健全かも</span>}{p.periodCount > 1 && <span className="lib-period">{p.periodCount}期</span>}</div>
                  <div className="lib-meta"><span>作: {p.ownerName || "匿名"}</span><span className="lib-dot">·</span><span>{p.companyCount}社</span><span className="lib-dot">·</span><span>{new Date(p.createdAt).toLocaleDateString("ja-JP")}</span></div>
                </div>
                <div className="post-play">挑む →</div>
              </div>
              <div className="post-actions">
                <button className={`like-btn ${liked[p.id] ? "on" : ""}`} onClick={() => like(p)} disabled={busy[p.id]}>{liked[p.id] ? "" : ""} {p.likeCount || 0}</button>
                <button className={`save-btn ${saved[p.id] ? "on" : ""}`} onClick={() => save(p)} title="保存">{saved[p.id] ? "保存済" : "保存"}</button>
                <button className="report-btn" onClick={() => user ? setReportFor(p) : onLogin()} title="通報">⚑ 通報</button>
              </div>
            </div>
          ))}
        </div>
        );
      })()}
      <div className="btn-row"><button className="btn ghost" onClick={onBack}>トップへ</button></div>

      {reportFor && (
        <div className="tip-overlay" onClick={() => setReportFor(null)}>
          <div className="tip-card" onClick={(e) => e.stopPropagation()}>
            <div className="tip-head"><span className="tip-label">通報する</span><button className="tip-x" onClick={() => setReportFor(null)}>✕</button></div>
            <p className="muted small" style={{ marginBottom: 10 }}>「{reportFor.title}」を通報します。理由を選んでください。一定数の通報で自動的に非表示になります。</p>
            <div className="report-reasons">
              {["不適切な表現・誹謗中傷", "スパム・宣伝", "ゲームと無関係", "その他"].map((r) => (
                <button key={r} className="btn ghost report-reason" onClick={() => submitReport(r)}>{r}</button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 管理画面 =====
function AdminPanel({ isAdmin, onBack }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  async function load() { setLoading(true); setPosts(await cloud.adminListReported(80)); setLoading(false); }
  useEffect(() => { if (isAdmin) load(); }, [isAdmin]);

  if (!cloud.enabled || !isAdmin) {
    return (<div className="screen"><div className="section-head"><h2 className="h2">管理画面</h2></div>
      <div className="lib-empty">この画面は管理者のみ利用できます。</div>
      <div className="btn-row"><button className="btn ghost" onClick={onBack}>トップへ</button></div></div>);
  }
  async function setHidden(p, hidden) { await cloud.adminSetHidden(p.id, hidden); load(); }
  async function del(p) { if (window.confirm(`「${p.title}」を完全に削除します。よろしいですか？`)) { await cloud.adminDelete(p.id); load(); } }

  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">管理画面</h2><p className="muted">通報のあった出題の一覧です。非表示／表示の切り替え、削除ができます。</p></div>
      {loading ? <div className="muted small">読み込み中…</div> : posts.length === 0 ? (
        <div className="lib-empty">通報・非表示の出題はありません。秩序は保たれています。</div>
      ) : (
        <div className="lib-list">
          {posts.map((p) => (
            <div className={`admin-card ${p.hidden ? "hidden-post" : ""}`} key={p.id}>
              <div className="admin-info">
                <div className="lib-title">{p.title} {p.hidden && <span className="post-hidden-tag">非表示中</span>}</div>
                <div className="lib-meta"><span>作: {p.ownerName || "匿名"}</span><span className="lib-dot">·</span><span className="report-count">通報 {p.reportCount || 0}</span><span className="lib-dot">·</span><span>{p.likeCount || 0}</span></div>
              </div>
              <div className="admin-actions">
                {p.hidden
                  ? <button className="btn ghost small-btn" onClick={() => setHidden(p, false)}>表示に戻す</button>
                  : <button className="btn ghost small-btn" onClick={() => setHidden(p, true)}>非表示にする</button>}
                <button className="btn ghost small-btn danger-text" onClick={() => del(p)}>削除</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="btn-row"><button className="btn ghost" onClick={onBack}>トップへ</button></div>
    </div>
  );
}

function Share({ code, onBack, onHome, onMine, user, cloudEnabled, onPublish, onExplore, onLogin }) {
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [pubState, setPubState] = useState("idle"); // idle|busy|done|error
  const ref = useRef(null);
  const link = makeShareLink(code);
  const isHosted = location.protocol.startsWith("http"); // file:// だとリンクは機能しない
  function copyCode() { navigator.clipboard?.writeText(code).catch(() => {}); if (ref.current) { ref.current.select(); try { document.execCommand("copy"); } catch {} } setCopiedCode(true); setTimeout(() => setCopiedCode(false), 1800); }
  function copyLink() { navigator.clipboard?.writeText(link).catch(() => {}); setCopiedLink(true); setTimeout(() => setCopiedLink(false), 1800); }
  async function publish() {
    setPubState("busy");
    const ok = await onPublish();
    setPubState(ok ? "done" : "error");
  }
  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">出題ができました</h2><p className="muted">対戦相手に送る、または公開出題に投稿して誰でも遊べるようにできます。</p></div>

      {isHosted ? (
        <div className="share-block">
          <div className="share-label">🔗 共有リンク（おすすめ）</div>
          <div className="code-box"><textarea readOnly value={link} className="code-text link" onFocus={(e) => e.target.select()} /></div>
          <button className="btn primary" onClick={copyLink}>{copiedLink ? "コピーしました ✓" : "リンクをコピー"}</button>
        </div>
      ) : (
        <div className="share-note">このファイルをGitHub Pages等で公開URLから開くと、ここに「共有リンク」が出ます（ローカルのfile://では下のコードを使ってください）。</div>
      )}

      <div className="share-block">
        <div className="share-label">📋 出題コード（リンクが使えない場合）</div>
        <div className="code-box"><textarea ref={ref} readOnly value={code} className="code-text" onFocus={(e) => e.target.select()} /></div>
        <button className="btn ghost" onClick={copyCode}>{copiedCode ? "コピーしました ✓" : "コードをコピー"}</button>
      </div>

      {cloudEnabled && (
        <div className="share-block publish-block">
          <div className="share-label">公開出題に投稿（みんなが遊べる）</div>
          {pubState === "done" ? (
            <div className="pub-done">公開しました！ <button className="btn ghost small-btn" onClick={onExplore}>公開出題を見る</button></div>
          ) : !user ? (
            <>
              <p className="muted small">公開投稿にはログインが必要です。</p>
              <button className="btn ghost" onClick={onLogin}>ログインして公開</button>
            </>
          ) : (
            <>
              <p className="muted small">あなたの名前で公開され、誰でも一覧から挑戦できます。不適切な内容は通報・削除の対象です。</p>
              <button className="btn primary" onClick={publish} disabled={pubState === "busy"}>{pubState === "busy" ? "公開中…" : "この出題を公開する"}</button>
              {pubState === "error" && <div className="error-msg">公開に失敗しました。時間をおいて再度お試しください。</div>}
            </>
          )}
        </div>
      )}

      <div className="btn-row">
        <button className="btn ghost" onClick={onMine}>マイ出題一覧</button>
        <button className="btn ghost" onClick={onBack}>出題を修正</button>
        <button className="btn ghost" onClick={onHome}>トップへ</button>
      </div>
      <p className="muted small warn-note">※ コード/リンクには正解が含まれます。渡す前に覗かれないよう注意。</p>
    </div>
  );
}

// マイ出題一覧（粉飾者が作った出題）
function MineList({ mine, onBack, onShare, onRemove }) {
  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">マイ出題 — 粉飾者</h2><p className="muted">あなたが作った出題の一覧。リンクやコードを再発行して送れます。</p></div>
      {mine.length === 0 ? (
        <div className="lib-empty">まだ出題がありません。「粉飾者になる」から決算を作って発行すると、ここに保存されます。</div>
      ) : (
        <div className="lib-list">
          {mine.map((e) => (
            <div className="lib-card" key={e.mid}>
              <div className="lib-card-main" onClick={() => onShare(e)}>
                <div className="lib-diff" style={{ color: e.clean ? "#2e7d52" : "#c0392b", borderColor: e.clean ? "#2e7d52" : "#c0392b", fontSize: 12 }}>{e.clean ? "健全" : "粉飾"}</div>
                <div className="lib-info">
                  <div className="lib-title">{e.title}{e.hasFx && <span className="lib-fx">為替</span>}{e.periodCount > 1 && <span className="lib-period">{e.periodCount}期</span>}</div>
                  <div className="lib-meta"><span>{new Date(e.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></div>
                </div>
                <div className="lib-go">送る →</div>
              </div>
              <button className="lib-del" onClick={() => onRemove(e.mid)} title="削除">✕</button>
            </div>
          ))}
        </div>
      )}
      <div className="btn-row lib-actions"><button className="btn ghost" onClick={onBack}>トップへ</button></div>
      <p className="muted small">※ 出題はこの端末に保存されます（最大60件）。</p>
    </div>
  );
}

function Load({ onLoad, error, onBack }) {
  const [val, setVal] = useState("");
  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">出題を追加 — 調査官</h2><p className="muted">送られたコードを貼り付けると、調査一覧に追加されます。</p></div>
      <textarea className="code-text input" placeholder="ここに出題コードを貼り付け…" value={val} onChange={(e) => setVal(e.target.value)} />
      {error && <div className="error-msg">{error}</div>}
      <div className="btn-row">
        <button className="btn primary" disabled={!val.trim()} onClick={() => onLoad(val)}>一覧に追加 →</button>
        <button className="btn ghost" onClick={onBack}>戻る</button>
      </div>
    </div>
  );
}

// ================================================================
function diffLabel(e) {
  if (!e.attempts) return { key: "unknown", label: "未挑戦", color: C.faint };
  const r = e.bestRate ?? 0;
  if (r >= 80) return { key: "easy", label: "易", color: C.green };
  if (r >= 40) return { key: "mid", label: "中", color: C.amber };
  return { key: "hard", label: "難", color: C.red };
}
function Library({ library, onStart, onAdd, onRemove, onBack }) {
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("recent");
  const view = useMemo(() => {
    let l = [...library];
    if (filter !== "all") l = l.filter((e) => diffLabel(e).key === filter);
    l.sort((a, b) => {
      if (sort === "recent") return b.addedAt - a.addedAt;
      if (sort === "attempts") return (b.attempts || 0) - (a.attempts || 0);
      const ra = a.bestRate ?? -1, rb = b.bestRate ?? -1;
      if (sort === "rateAsc") return ra - rb;
      if (sort === "rateDesc") return rb - ra;
      return 0;
    });
    return l;
  }, [library, filter, sort]);
  const filters = [{ k: "all", label: "すべて" }, { k: "unknown", label: "未挑戦" }, { k: "hard", label: "難" }, { k: "mid", label: "中" }, { k: "easy", label: "易" }];
  const sorts = [{ k: "recent", label: "新着順" }, { k: "rateAsc", label: "難しい順" }, { k: "rateDesc", label: "易しい順" }, { k: "attempts", label: "挑戦回数順" }];
  return (
    <div className="screen">
      <div className="section-head"><h2 className="h2">調査一覧 — 調査官</h2><p className="muted">受け取った出題から挑むものを選ぶ。発見率・挑戦数で難易度を見極めよう（発見率が低いほど手強い）。</p></div>
      <div className="lib-controls">
        <div className="lib-ctrl-group"><span className="lib-ctrl-label">難易度</span><div className="lib-chips">{filters.map((f) => <button key={f.k} className={`lib-chip ${filter === f.k ? "on" : ""}`} onClick={() => setFilter(f.k)}>{f.label}</button>)}</div></div>
        <div className="lib-ctrl-group"><span className="lib-ctrl-label">並び替え</span><div className="lib-chips">{sorts.map((s) => <button key={s.k} className={`lib-chip ${sort === s.k ? "on" : ""}`} onClick={() => setSort(s.k)}>{s.label}</button>)}</div></div>
      </div>
      {library.length === 0 ? (
        <div className="lib-empty">まだ出題がありません。粉飾者から受け取ったコードを追加すると、ここに一覧で並びます。</div>
      ) : view.length === 0 ? (
        <div className="lib-empty">この条件に合う出題はありません。</div>
      ) : (
        <div className="lib-list">
          {view.map((e) => {
            const d = diffLabel(e);
            return (
              <div className="lib-card" key={e.lid}>
                <div className="lib-card-main" onClick={() => onStart(e)}>
                  <div className="lib-diff" style={{ color: d.color, borderColor: d.color }}>{d.label}</div>
                  <div className="lib-info">
                    <div className="lib-title">{e.title}{e.hasFx && <span className="lib-fx">為替</span>}{e.periodCount > 1 && <span className="lib-period">{e.periodCount}期</span>}</div>
                    <div className="lib-meta"><span>挑戦 {e.attempts || 0}回</span><span className="lib-dot">·</span><span>発見率 {e.bestRate == null ? "—" : `${e.bestRate}%`}</span>{e.lastScore != null && <><span className="lib-dot">·</span><span>前回 {e.lastScore >= 0 ? "+" : ""}{e.lastScore}</span></>}</div>
                  </div>
                  <div className="lib-go">挑む →</div>
                </div>
                <button className="lib-del" onClick={() => onRemove(e.lid)} title="削除">✕</button>
              </div>
            );
          })}
        </div>
      )}
      <div className="btn-row lib-actions">
        <button className="btn primary" onClick={onAdd}>＋ コードから出題を追加</button>
        <button className="btn ghost" onClick={onBack}>トップへ</button>
      </div>
      <p className="muted small">※ 出題と成績はこの端末に保存されます（最大60件）。</p>
    </div>
  );
}

// ================================================================
function GroupDiagram({ companies, internalTxns }) {
  const parent = companies.find((c) => c.role === "parent") || companies[0];
  const subs = companies.filter((c) => c.cid !== parent.cid);
  const W = 680, topY = 60, subY = 210;
  const cx = W / 2;
  // 各社の座標
  const pos = {};
  pos[parent.cid] = { x: cx, y: topY };
  const n = subs.length;
  subs.forEach((s, i) => {
    const span = Math.min(W - 120, Math.max(220, n * 150));
    const x = n === 1 ? cx : (cx - span / 2) + (span / (n - 1)) * i;
    pos[s.cid] = { x, y: subY };
  });
  const boxW = 116, boxH = 50;
  const nameOf = (cid) => companies.find((c) => c.cid === cid)?.name || cid;
  // 取引の矢印（from→to）
  const arrows = internalTxns.map((t, i) => {
    const a = pos[t.from], b = pos[t.to];
    if (!a || !b) return null;
    return { a, b, amount: t.amount || 0, key: i, from: t.from, to: t.to };
  }).filter(Boolean);
  const H = subs.length > 0 ? 290 : 130;

  return (
    <div className="group-diagram">
      <div className="gd-title">グループ構造と資金の流れ</div>
      <div className="gd-legend">
        <span className="gd-leg"><span className="gd-line own"></span>資本関係（親→子）</span>
        <span className="gd-leg"><span className="gd-line flow"></span>内部取引（計上額）</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="gd-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#1f6f8b" /></marker>
        </defs>
        {/* 資本関係の線 */}
        {subs.map((s) => {
          const a = pos[parent.cid], b = pos[s.cid];
          return <line key={"own" + s.cid} x1={a.x} y1={a.y + boxH / 2} x2={b.x} y2={b.y - boxH / 2} stroke="#3a4a5c" strokeWidth="1.5" strokeDasharray="4 3" />;
        })}
        {/* 内部取引の矢印 */}
        {arrows.map((ar) => {
          const x1 = ar.a.x, y1 = ar.a.y, x2 = ar.b.x, y2 = ar.b.y;
          const mx = (x1 + x2) / 2 + (y1 === y2 ? 0 : 26), my = (y1 + y2) / 2;
          return (
            <g key={"fl" + ar.key}>
              <path d={`M${x1},${y1} Q${mx},${my} ${x2},${y2}`} fill="none" stroke="#1f6f8b" strokeWidth="1.8" markerEnd="url(#ah)" opacity="0.9" />
              <text x={mx} y={my - 4} fill="#1f6f8b" fontSize="11" fontFamily="'Courier New', monospace" textAnchor="middle">¥{fmt(ar.amount)}</text>
            </g>
          );
        })}
        {/* 会社ボックス */}
        {companies.map((c) => {
          const p = pos[c.cid]; if (!p) return null;
          const isParent = c.cid === parent.cid;
          return (
            <g key={"box" + c.cid}>
              <rect x={p.x - boxW / 2} y={p.y - boxH / 2} width={boxW} height={boxH} rx="8"
                fill={isParent ? "#eef1f5" : "#f6f8fa"} stroke={isParent ? "#1f3a5f" : "#dfe4ea"} strokeWidth={isParent ? "2" : "1.5"} />
              <text x={p.x} y={p.y - 4} fill="#1a2230" fontSize="13" fontFamily="-apple-system, sans-serif" textAnchor="middle" fontWeight="bold">{c.name}</text>
              <text x={p.x} y={p.y + 13} fill="#5a6675" fontSize="10" fontFamily="'Courier New', monospace" textAnchor="middle">{INDUSTRIES[c.industry].icon} {isParent ? "親会社" : "子会社"}{c.currency !== "JPY" ? " / " + CURRENCIES[c.currency].sym : ""}</text>
            </g>
          );
        })}
      </svg>
      <p className="gd-note">点線はグループの資本関係（親→子）。実線の矢印は内部取引の資金の流れで、数字は計上額です。連結では本来これらは相殺されて消えます。<b>単純合算と連結のズレ</b>が大きい、つまり消去額が不自然に大きいと、実体のない取引を回した<b>循環取引</b>の疑い。下の「連結 vs 単純合算」と照らし合わせて判断しましょう。</p>
    </div>
  );
}

function Investigate({ data, accusations, setAccusations, accuseCircular, setAccuseCircular, accuseFx, toggleFxAccuse, onSubmit, onTip, previewMode, onExitPreview }) {
  const companies = data.companies;
  const internalTxns = data.internalTxns || [];
  const [hintFor, setHintFor] = useState(null); // ヒント(推移グラフ)を開いている会社cid
  const { cons, sum, elim } = useMemo(() => consolidate(companies, internalTxns), [companies, internalTxns]);

  function toggle(cid, key) {
    const id = `${cid}:${key}`;
    setAccusations((p) => p.some((a) => `${a.cid}:${a.key}` === id) ? p.filter((a) => `${a.cid}:${a.key}` !== id) : [...p, { cid, key }]);
  }
  const isAcc = (cid, key) => accusations.some((a) => a.cid === cid && a.key === key);
  // 出題に含まれる科目（詳細が使われているかは値の有無で判定）
  const usedKeys = (fin) => ACCOUNTS.filter((a) => a.tier === "basic" || num(fin, a.key) !== 0).map((a) => a.key);

  return (
    <div className="screen">
      {previewMode && (
        <div className="preview-banner">
          プレビュー中 — これは調査官に見える画面です。架空指定した数字に痕跡（⚑）が出ているか確認しましょう。採点はされません。
          <button className="btn ghost small-btn" onClick={onExitPreview}>作成に戻る</button>
        </div>
      )}
      <div className="section-head"><h2 className="h2">{previewMode ? "プレビュー（調査官の見え方）" : "審査室"}</h2>
        <p className="muted">各科目をタップで指摘。科目名の「?」で説明。業種基準の比率異常・税率の不自然さ・BSの貸借不均衡・為替・連結のズレが手がかり。健全なら何も告発しないのが正解。</p></div>

      {data.hasCF && (
        <div className="cf-guide">
          <div className="cf-guide-title">🗝 超級の鍵：キャッシュフロー（CF）を読む</div>
          <p>循環取引による架空売上は、<b>利益は増えても現金は入りません</b>（売掛金に滞留するだけ）。だから<b>「当期純利益は大きいのに、営業CFが小さい・マイナス」</b>が最大の手がかり。さらにその穴を借入（財務CF＝プラス）で埋めていれば、ほぼ確定です。各社のCF計算書と、売上・利益・営業CFの<b>時系列の食い違い</b>に注目してください。怪しい科目（売上・売掛金）をタップで指摘します。</p>
        </div>
      )}

      <div className="invest-companies">
        {companies.map((c) => {
          const cf = curFin(c);
          const np = c.periods.length;
          const labs = periodLabels(np);
          const r = ratios(cf), fl = flagsWithOp(c.industry, cf), ind = INDUSTRIES[c.industry], cur = CURRENCIES[c.currency];
          const showTax = num(cf, "tax") !== 0 || pretaxProfit(cf) > 50;
          const fxOff = c.currency !== "JPY" ? Math.round(((rateOf(c) / cur.market) - 1) * 100) : 0;
          const keys = usedKeys(cf);
          const plKeys = keys.filter((k) => A_BY_KEY[k].stmt === "pl");
          const assetKeys = keys.filter((k) => BS_ASSET_KEYS.includes(k));
          const liabKeys = keys.filter((k) => BS_LIAB_KEYS.includes(k));
          const valCells = (k) => np > 1
            ? c.periods.map((f, i) => <span key={i} className={`pv ${i === np - 1 ? "cur" : ""}`}>{fmt(f[k])}</span>)
            : <span>{cur.sym}{fmt(cf[k])}</span>;
          const showHint = hintFor === c.cid;
          return (
            <div className="invest-card" key={c.cid}>
              <div className="invest-co">
                <span>{c.name}</span>
                <span className="invest-co-r">
                  <span className="invest-ind">{ind.icon} {ind.name}</span>
                  {np > 1 && <button className={`hint-btn ${showHint ? "on" : ""}`} onClick={() => setHintFor(showHint ? null : c.cid)}>📈 ヒント</button>}
                </span>
              </div>
              <div className="invest-bench">基準: 原価率{ind.cogs[0]}–{ind.cogs[1]}% / 売掛{ind.recvDays[0]}–{ind.recvDays[1]}日 / 在庫{ind.invDays[0]}–{ind.invDays[1]}日</div>
              {c.hint && <div className="invest-hint">出題者より: {c.hint}</div>}
              {np > 1 && (
                <div className="period-head-bar">
                  {labs.map((l, i) => <span key={i} className={`ph-cell ${i === np - 1 ? "cur" : ""}`}>{l}</span>)}
                </div>
              )}
              {showHint && np > 1 && <TrendChart company={c} />}
              {c.currency !== "JPY" && <div className={`fx-badge ${Math.abs(fxOff) > cur.band ? "warn" : ""}`}>{cur.sym}{cur.name}建 / 換算{rateOf(c)}円 (市場{cur.market}円, 乖離{fxOff > 0 ? "+" : ""}{fxOff}%)</div>}

              <div className="inv-stmt-label">損益計算書</div>
              <table className="invest-table"><tbody>
                {plKeys.map((k) => (
                  <tr key={k} className={isAcc(c.cid, k) ? "accd" : ""}>
                    <td className="it-mark" onClick={() => toggle(c.cid, k)}>{isAcc(c.cid, k) ? "☞" : ""}</td>
                    <td className="it-label"><span onClick={() => toggle(c.cid, k)}>{A_BY_KEY[k].label}</span><button className="it-tip" onClick={() => onTip({ label: A_BY_KEY[k].label, desc: A_BY_KEY[k].desc })}>?</button></td>
                    <td className={`it-val ${np > 1 ? "multi" : ""}`} onClick={() => toggle(c.cid, k)}>{valCells(k)}</td>
                  </tr>
                ))}
              </tbody></table>
              <div className="inv-derived">純利益 {cur.sym}{fmt(netIncome(cf))}</div>

              <div className="inv-stmt-label">貸借対照表</div>
              <table className="invest-table"><tbody>
                {assetKeys.map((k) => (
                  <tr key={k} className={isAcc(c.cid, k) ? "accd" : ""}>
                    <td className="it-mark" onClick={() => toggle(c.cid, k)}>{isAcc(c.cid, k) ? "☞" : ""}</td>
                    <td className="it-label"><span onClick={() => toggle(c.cid, k)}>{A_BY_KEY[k].label}</span><button className="it-tip" onClick={() => onTip({ label: A_BY_KEY[k].label, desc: A_BY_KEY[k].desc })}>?</button></td>
                    <td className={`it-val ${np > 1 ? "multi" : ""}`} onClick={() => toggle(c.cid, k)}>{valCells(k)}</td>
                  </tr>
                ))}
                {liabKeys.map((k) => (
                  <tr key={k} className={`liab ${isAcc(c.cid, k) ? "accd" : ""}`}>
                    <td className="it-mark" onClick={() => toggle(c.cid, k)}>{isAcc(c.cid, k) ? "☞" : ""}</td>
                    <td className="it-label"><span onClick={() => toggle(c.cid, k)}>{A_BY_KEY[k].label}</span><button className="it-tip" onClick={() => onTip({ label: A_BY_KEY[k].label, desc: A_BY_KEY[k].desc })}>?</button></td>
                    <td className={`it-val ${np > 1 ? "multi" : ""}`} onClick={() => toggle(c.cid, k)}>{valCells(k)}</td>
                  </tr>
                ))}
              </tbody></table>

              <div className="invest-ratios">
                <Chip label="原価率" v={r.cogsRate} unit="%" warn={fl.cogs === "warn"} infoKey="cogsRate" onTip={onTip} />
                <Chip label="売掛日数" v={r.recvDays} unit="日" warn={fl.recv === "warn"} infoKey="recvDays" onTip={onTip} />
                <Chip label="在庫日数" v={r.invDays} unit="日" warn={fl.inv === "warn"} infoKey="invDays" onTip={onTip} />
                <Chip label="営業利益率" v={r.opMargin} unit="%" warn={fl.op === "warn"} infoKey="opMargin" onTip={onTip} />
                {showTax && <Chip label="実効税率" v={r.taxRate} unit="%" warn={fl.tax === "warn"} infoKey="taxRate" onTip={onTip} />}
                {(liabKeys.length > 0 || Math.abs(r.bsGap) > 0.5) && <Chip label="貸借差額" v={r.bsGap} unit="" warn={fl.bs === "warn"} infoKey="bsGap" onTip={onTip} />}
              </div>

              {data.hasCF && np > 1 && (() => {
                const cfNow = cashFlow(c.periods[np - 1], c.periods[np - 2]);
                if (!cfNow) return null;
                const ni = netIncome(c.periods[np - 1]);
                const danger = cfNow.cfo < ni * 0.5; // 営業CFが利益の半分未満＝危険
                return (
                  <div className={`cf-box ${danger ? "cf-danger" : ""}`}>
                    <div className="cf-title">キャッシュフロー計算書（当期）
                      <button className="it-tip" onClick={() => onTip({ label: "キャッシュフロー計算書", desc: "会社に実際に出入りした現金の流れ。利益は会計操作で作れるが現金は嘘をつきにくい。『利益は大きいのに営業CFが小さい/マイナス』は粉飾の最重要サイン。架空売上は現金を生まず売掛金に滞留するため、営業CFが利益から大きく乖離する。" })}>?</button>
                    </div>
                    <table className="cf-table"><tbody>
                      <tr><td>営業活動によるCF</td><td className={`cf-val ${cfNow.cfo < 0 ? "neg" : ""}`}>{cur.sym}{fmt(cfNow.cfo)}</td></tr>
                      <tr><td>投資活動によるCF</td><td className={`cf-val ${cfNow.cfi < 0 ? "neg" : ""}`}>{cur.sym}{fmt(cfNow.cfi)}</td></tr>
                      <tr><td>財務活動によるCF</td><td className={`cf-val ${cfNow.cff < 0 ? "neg" : ""}`}>{cur.sym}{fmt(cfNow.cff)}</td></tr>
                      <tr className="cf-sum"><td>現金の増減</td><td className="cf-val">{cur.sym}{fmt(cfNow.cashDelta)}</td></tr>
                    </tbody></table>
                    <div className={`cf-flag ${danger ? "on" : ""}`}>
                      {danger
                        ? `⚑ 当期純利益 ${cur.sym}${fmt(ni)} に対し、営業CFは ${cur.sym}${fmt(cfNow.cfo)}。利益ほど現金が入っていない（差 ${cur.sym}${fmt(cfNow.niMinusCfo)}）。架空売上の疑い。`
                        : `利益 ${cur.sym}${fmt(ni)} と営業CF ${cur.sym}${fmt(cfNow.cfo)} は概ね整合。`}
                    </div>
                  </div>
                );
              })()}

              {c.currency !== "JPY" && (
                <label className={`fx-accuse ${accuseFx.includes(c.cid) ? "on" : ""}`}>
                  <input type="checkbox" checked={accuseFx.includes(c.cid)} onChange={() => toggleFxAccuse(c.cid)} />
                  <span className="fx-accuse-box">{accuseFx.includes(c.cid) ? "✓" : ""}</span>換算レートは不当（為替粉飾）だと告発
                </label>
              )}
            </div>
          );
        })}
      </div>

      <GroupDiagram companies={companies} internalTxns={internalTxns} />

      <div className="invest-txn">
        <div className="invest-sub">開示された内部取引</div>
        {internalTxns.length === 0 ? <div className="muted small">内部取引の開示なし</div> : (
          <div className="txn-view-list">{internalTxns.map((t, i) => { const cf = companies.find((c) => c.cid === t.from)?.name || t.from; const ct = companies.find((c) => c.cid === t.to)?.name || t.to; return <div className="txn-view" key={i}><span>{cf} → {ct}</span><span className="txn-view-amt">計上 ¥{fmt(t.amount)}</span></div>; })}</div>
        )}
        <label className={`circ-toggle ${accuseCircular ? "on" : ""}`}>
          <input type="checkbox" checked={accuseCircular} onChange={(e) => setAccuseCircular(e.target.checked)} />
          <span className="circ-box">{accuseCircular ? "✓" : ""}</span>内部取引に<b>循環取引</b>の疑いがあると告発する
        </label>
      </div>

      <div className="cons-preview invest">
        <div className="cons-title">連結 vs 単純合算（円換算）</div>
        {elim > 0 ? (
          <div className="cons-elim-note on">内部消去額 <b>¥{fmt(elim)}</b>。グループ内の取引が連結で相殺されています。消去額が取引の実態に比べて不自然に大きいと、実体のない売上を回す<b>循環取引</b>の疑い。</div>
        ) : (
          <div className="cons-elim-note">この出題はグループ内部取引が無い（または消去額ゼロ）ため、<b>連結と単純合算は一致します</b>。これは正常で、循環取引の手がかりにはなりません。</div>
        )}
        <div className="cons-grid">
          <div className="cons-col"><div className="cons-h">単純合算</div>
            <div className="cons-line"><span>売上高</span><b>¥{fmt(sum.sales)}</b></div>
            <div className="cons-line"><span>営業利益</span><b>¥{fmt(opProfit(sum))}</b></div>
            <div className="cons-line"><span>資産合計</span><b>¥{fmt(totalAssets(sum))}</b></div>
          </div>
          <div className="cons-col"><div className="cons-h">開示された連結</div>
            <div className={`cons-line ${cons.sales !== sum.sales ? "diff" : ""}`}><span>売上高</span><b>¥{fmt(cons.sales)}</b></div>
            <div className={`cons-line ${opProfit(cons) !== opProfit(sum) ? "diff" : ""}`}><span>営業利益</span><b>¥{fmt(opProfit(cons))}</b></div>
            <div className={`cons-line ${totalAssets(cons) !== totalAssets(sum) ? "diff" : ""}`}><span>資産合計</span><b>¥{fmt(totalAssets(cons))}</b></div>
          </div>
        </div>
      </div>

      <div className="builder-actions">
        <div className="acc-count">指摘中：<b>{accusations.length}</b> 科目{accuseCircular ? " ＋循環" : ""}{accuseFx.length ? ` ＋為替${accuseFx.length}` : ""}</div>
        {previewMode
          ? <button className="btn primary big" onClick={onExitPreview}>← 作成に戻る</button>
          : <button className="btn primary big" onClick={onSubmit}>調査結果を確定する</button>}
        <span className="muted small">何も指摘せず確定すれば「適正意見（粉飾なし）」になります</span>
      </div>
    </div>
  );
}

// 指標(チップ)の説明: 何を表し、warn時に何を疑うか
const METRIC_INFO = {
  cogsRate: { label: "原価率", mean: "売上に対する売上原価の割合。商品をいくらで仕入れ・製造して売ったか。", suspect: "業種より極端に低いと、原価を在庫に付け替えて利益を水増しした疑い（原価隠し）。極端に高いと赤字隠しの反動など。" },
  recvDays: { label: "売掛金回転日数", mean: "売った代金が回収されるまでの平均日数。売掛金 ÷ 売上 × 365。", suspect: "業種より異常に長いと、回収できない（実在しない）売上を計上した疑い（架空売上）。" },
  invDays: { label: "在庫回転日数", mean: "在庫が売れるまでに滞留する平均日数。在庫 ÷ 売上原価 × 365。", suspect: "異常に長いと、売れない在庫の積み上がり、または原価隠し・在庫水増しの疑い。" },
  opMargin: { label: "営業利益率", mean: "本業の儲けの率。営業利益 ÷ 売上。", suspect: "業種実態よりやけに高いと、費用の隠蔽や特別損失の先送りで利益を盛った疑い。" },
  taxRate: { label: "実効税率", mean: "税引前利益に対する法人税等の割合。通常はおおむね30%前後。", suspect: "利益が出ているのに極端に低いと、税金を過小計上して最終利益を膨らませた疑い。" },
  bsGap: { label: "貸借差額", mean: "資産合計と（負債＋純資産）合計の差。本来はゼロで一致するはず。", suspect: "ゼロでなければ、計上すべき損失を隠して資産に残した、または借入金を簿外化した疑い。" },
};

function TrendChart({ company }) {
  const periods = company.periods;
  const np = periods.length;
  const labs = periodLabels(np);
  // 表示する系列（金額系と、比率系を分けると分かりやすい）
  const series = [
    { key: "sales", label: "売上高", color: "#1f6f8b", get: (f) => num(f, "sales") },
    { key: "op", label: "営業利益", color: "#2e7d52", get: (f) => opProfit(f) },
    { key: "receivables", label: "売掛金", color: "#1f3a5f", get: (f) => num(f, "receivables") },
    { key: "inventory", label: "棚卸資産", color: "#c0392b", get: (f) => num(f, "inventory") },
  ];
  const W = 660, H = 240, padL = 50, padR = 16, padT = 16, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  // 全系列の最大・最小（0を基準に）
  let maxV = 0, minV = 0;
  series.forEach((s) => periods.forEach((f) => { const v = s.get(f); if (v > maxV) maxV = v; if (v < minV) minV = v; }));
  if (maxV === minV) maxV = minV + 1;
  const x = (i) => padL + (np === 1 ? plotW / 2 : (plotW / (np - 1)) * i);
  const y = (v) => padT + plotH - ((v - minV) / (maxV - minV)) * plotH;
  const ticks = 4;
  return (
    <div className="trend-chart">
      <div className="tc-legend">
        {series.map((s) => <span key={s.key} className="tc-leg"><span className="tc-dot" style={{ background: s.color }}></span>{s.label}</span>)}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="tc-svg" preserveAspectRatio="xMidYMid meet">
        {/* グリッド＋目盛 */}
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const v = minV + ((maxV - minV) / ticks) * i;
          const yy = y(v);
          return (
            <g key={i}>
              <line x1={padL} y1={yy} x2={W - padR} y2={yy} stroke="#dfe4ea" strokeWidth="1" strokeDasharray="2 3" />
              <text x={padL - 6} y={yy + 3} fill="#9aa4b2" fontSize="9" fontFamily="'Courier New', monospace" textAnchor="end">{fmt(v)}</text>
            </g>
          );
        })}
        {/* 期ラベル */}
        {labs.map((l, i) => <text key={i} x={x(i)} y={H - 12} fill={i === np - 1 ? "#1f3a5f" : "#5a6675"} fontSize="11" fontFamily="'Courier New', monospace" textAnchor="middle">{l}</text>)}
        {/* 各系列の折れ線 */}
        {series.map((s) => {
          const pts = periods.map((f, i) => `${x(i)},${y(s.get(f))}`).join(" ");
          return (
            <g key={s.key}>
              <polyline points={pts} fill="none" stroke={s.color} strokeWidth="2" />
              {periods.map((f, i) => <circle key={i} cx={x(i)} cy={y(s.get(f))} r={i === np - 1 ? 4 : 3} fill={s.color} />)}
            </g>
          );
        })}
      </svg>
      <p className="tc-note">期をまたいだ動きが手がかり。<b>売上が急に伸びたのに売掛金だけ不自然に膨らむ</b>、<b>利益は増えたのに在庫ばかり積み上がる</b>——こうした「足並みの乱れ」は粉飾のサイン。健全なら各線はおおむね揃って動きます。</p>
    </div>
  );
}

function Chip({ label, v, unit, warn, infoKey, onTip }) {
  const info = METRIC_INFO[infoKey];
  const handle = () => {
    if (!info || !onTip) return;
    onTip({ label: info.label, desc: `【意味】${info.mean}\n\n${warn ? "⚑ この値は業種の常識から外れています。\n【疑い】" + info.suspect : "現在この指標は正常範囲内です。\n【参考】" + info.suspect}` });
  };
  return (
    <div className={`chip ${warn ? "warn" : ""} ${info ? "tappable" : ""}`} onClick={handle} title={info ? "タップで説明" : ""}>
      <span className="chip-l">{label}{info && <span className="chip-q">?</span>}</span>
      <span className="chip-v">{(v || 0).toFixed(Math.abs(v) > 200 ? 0 : 1)}{unit}{warn && " ⚑"}</span>
    </div>
  );
}

// ================================================================
// ================================================================
//  結果のおさらい解説: 各架空科目について「指標の動き＋見抜き方」を生成
// ================================================================
function explainFake(company, key) {
  const f = curFin(company);
  const ind = INDUSTRIES[company.industry];
  const r = ratios(f);
  const round = (n) => Math.round(n);
  // 科目ごとの解説テンプレ(指標の実測値を埋め込む)
  switch (key) {
    case "sales":
      return {
        what: "架空の売上を計上して、会社を大きく・好調に見せようとした手口です。",
        how: `売上を水増しすると、その分の入金が無いため売掛金だけが不自然に膨らみます。`,
        signal: `売掛金回転日数が ${round(r.recvDays)}日（${ind.name}の目安は ${ind.recvDays[0]}〜${ind.recvDays[1]}日）。「売れているのに代金が入っていない」のが架空売上のサイン。`,
      };
    case "receivables":
      return {
        what: "回収できない（実在しない取引の）売掛金を計上した手口です。",
        how: "架空売上の受け皿として、売掛金が売上の伸び以上に積み上がります。",
        signal: `売掛金回転日数 ${round(r.recvDays)}日 が業種目安（${ind.recvDays[0]}〜${ind.recvDays[1]}日）を超過。`,
      };
    case "cogs":
      return {
        what: "売上原価を小さく見せて、利益を水増しした手口です。",
        how: "本来の原価を在庫に付け替えると、原価率が下がり利益が大きく見えます。",
        signal: `原価率 ${round(r.cogsRate)}%（${ind.name}の目安は ${ind.cogs[0]}〜${ind.cogs[1]}%）。同時に在庫日数 ${round(r.invDays)}日 も膨らんでいれば、費用隠しの疑いが濃厚。`,
      };
    case "inventory":
      return {
        what: "在庫を過大に計上した手口です（原価隠しの受け皿、または資産の水増し）。",
        how: "売れていない在庫が積み上がると、在庫回転日数が異常に長くなります。",
        signal: `在庫回転日数 ${round(r.invDays)}日（${ind.name}の目安は ${ind.invDays[0]}〜${ind.invDays[1]}日）。在庫が滞留しているサイン。`,
      };
    case "extraLoss":
    case "fixedAssets":
      return {
        what: "計上すべき特別損失（資産の価値下落など）を計上せず、資産に残した手口です。",
        how: "損を認識しないことで利益を守りますが、その分だけ資産が過大になり、貸借が崩れます。",
        signal: `貸借差額 ${round(r.bsGap)}（資産合計と負債・純資産合計の不一致）。本来あるべき損失が隠れている痕跡。`,
      };
    case "tax":
      return {
        what: "納めるべき法人税を小さく見せて、最終利益を膨らませた手口です。",
        how: "利益が出ているのに税負担が軽すぎると、実効税率が不自然に低くなります。",
        signal: `実効税率 ${round(r.taxRate)}%（通常は概ね30%前後）。利益のわりに税が軽すぎる。`,
      };
    case "longDebt":
    case "shortDebt":
      return {
        what: "返済義務のある借入金を帳簿から消した手口です（簿外債務）。",
        how: "負債を消すと、資産と負債・純資産のバランスが取れなくなります。",
        signal: `貸借差額 ${round(r.bsGap)}。資産に対して負債が不自然に少ないのが隠し債務のサイン。`,
      };
    default:
      return {
        what: `${A_BY_KEY[key]?.label || key} を不正に操作した手口です。`,
        how: "数字を実態から動かすと、必ずどこかの指標に痕跡が残ります。",
        signal: "業種の常識から外れた指標が手がかりです。",
      };
  }
}

// 結果画面: 出題された決算表のおさらい（折りたたみ・架空科目を赤強調）
function FsReview({ truth }) {
  const [open, setOpen] = React.useState(false);
  const companies = truth.companies || [];
  if (companies.length === 0) return null;
  // この (cid,key) が架空計上されたか
  const isFaked = (cid, key) => (truth.trueFakes || []).some((f) => f.cid === cid && f.key === key);
  const hasAnyFake = (truth.trueFakes || []).length > 0;
  const rowFor = (c, key) => {
    const faked = isFaked(c.cid, key);
    return (
      <tr key={key} className={faked ? "fs-faked" : ""}>
        <td className="fs-label">{A_BY_KEY[key]?.label || key}{faked && <span className="fs-faked-mark">●架空</span>}</td>
        <td className="fs-val">{c.currency && c.currency !== "JPY" ? CURRENCIES[c.currency].sym : "¥"}{fmt(num(c.fin, key))}</td>
      </tr>
    );
  };
  return (
    <div className="fs-review">
      <button className={`fs-toggle ${open ? "open" : ""}`} onClick={() => setOpen(!open)}>
        <span>出題された決算表を見る（おさらい）</span>
        <span className="fs-arrow">▶</span>
      </button>
      {open && (
        <div className="fs-body">
          {companies.map((c) => (
            <div className="fs-co" key={c.cid}>
              <div className="fs-co-name">{c.name}</div>
              <div className="fs-stmt-h">損益計算書 P/L</div>
              <table className="fs-table"><tbody>
                {PL_KEYS.filter((k) => num(c.fin, k) !== 0 || isFaked(c.cid, k)).map((k) => rowFor(c, k))}
                <tr className="fs-sum"><td className="fs-label">当期純利益</td><td className="fs-val">¥{fmt(netIncome(c.fin))}</td></tr>
              </tbody></table>
              <div className="fs-stmt-h">貸借対照表 B/S</div>
              <table className="fs-table"><tbody>
                {BS_ASSET_KEYS.filter((k) => num(c.fin, k) !== 0 || isFaked(c.cid, k)).map((k) => rowFor(c, k))}
                {BS_LIAB_KEYS.filter((k) => num(c.fin, k) !== 0 || isFaked(c.cid, k)).map((k) => rowFor(c, k))}
                <tr className="fs-sum"><td className="fs-label">資産合計</td><td className="fs-val">¥{fmt(totalAssets(c.fin))}</td></tr>
              </tbody></table>
            </div>
          ))}
          {hasAnyFake && <div className="fs-legend"><span className="fs-chip"></span> 赤い行が架空計上された科目です</div>}
        </div>
      )}
    </div>
  );
}

function Result({ result, onHome, onLibrary, onTip, onNextPractice, onDaily, lastLevel }) {
  const { score, detail, truth } = result;
  const nameOf = (cid) => truth.companies.find((c) => c.cid === cid)?.name || cid;
  let verdict, vmsg;
  if (score >= 30) { verdict = "完全勝利・調査官"; vmsg = "嘘も真実も、過たず見抜いた。"; }
  else if (score >= 10) { verdict = "調査官の勝ち"; vmsg = "嘘の核心を捉えた。"; }
  else if (score >= -5) { verdict = "引き分け圏"; vmsg = "詰めが甘い。逃げ道を残した。"; }
  else { verdict = "粉飾者の勝ち"; vmsg = "数字の罠に飲まれた。"; }
  // 前向きな一言（特に負け・引き分けのとき優しく）
  const hits = result.hits || 0, total = result.fakeTotal || 0;
  let encourage = "";
  if (truth.cleanCo && score >= 10) encourage = "「シロ」を冷静に見抜けました。疑いすぎないのも実力です。";
  else if (score >= 30) encourage = "完璧です。もう立派な調査官。次はもっと手強い相手を。";
  else if (score >= 10) encourage = "いい読みでした。この調子でいきましょう。";
  else if (total > 0 && hits > 0) encourage = `惜しい！ ${total}個中 ${hits}個は見抜けました。あと少し。下の「おさらい」で見抜き方を確認して、もう1問。`;
  else if (total > 0) encourage = "今回は難しかったですね。下の「おさらい」に見抜き方が書いてあります。同じ手口は次から分かります。";
  else encourage = "もう1問チャレンジして、感覚をつかみましょう。";
  return (
    <div className="screen">
      <div className="result-head">
        <div className="result-verdict">{verdict}</div>
        <div className="result-score" style={{ color: score >= 0 ? C.green : C.red }}>{score >= 0 ? "+" : ""}{score}</div>
        <div className="muted">{vmsg}</div>
      </div>
      <div className="encourage-box">{encourage}</div>
      {/* 次へ（熱が冷めないうちに） */}
      <div className="next-actions">
        {onNextPractice && <button className="btn primary" onClick={() => onNextPractice(lastLevel)}>▶ 次の問題へ（同じくらいの難しさ）</button>}
        {onDaily && <button className="btn ghost" onClick={onDaily}>今日の1問に挑戦</button>}
      </div>
      <div className="result-detail">{detail.map((d, i) => <div key={i} className={`rd-line ${d.ok ? "ok" : "ng"}`}><span className="rd-icon">{d.ok ? "✓" : "✕"}</span>{d.txt}</div>)}</div>
      <div className="truth-box">
        <div className="truth-title">真相の開示</div>
        {truth.cleanCo ? <div className="truth-clean">この企業グループは完全に健全だった。架空計上は一切無し。むやみに疑わず見抜けたかが勝負どころ。</div> : (
          <>
            {truth.trueFakes.length > 0 ? (
              <ul className="truth-list">{truth.trueFakes.map((f, i) => <li key={i}>{nameOf(f.cid)} の <b>{A_BY_KEY[f.key]?.label || f.key}</b> が架空計上</li>)}</ul>
            ) : <div className="muted small">単体科目の架空計上は無し</div>}
            {truth.trueFx && truth.trueFx.length > 0 && <div className="truth-circ">＋ 為替操作: {truth.trueFx.map(nameOf).join("・")} の換算レートが不当</div>}
            {truth.trueCircular && <div className="truth-circ">＋ 内部取引に循環取引あり</div>}
          </>
        )}
      </div>

      {/* 出題された決算表のおさらい */}
      <FsReview truth={truth} />

      {/* おさらい: 理由つき解説 */}
      {!truth.cleanCo && truth.trueFakes.length > 0 && (
        <div className="recap-box">
          <div className="recap-title">📘 おさらい — どこが粉飾で、なぜ見抜けるか</div>
          {(() => {
            // 同一(cid,key)の重複を除き、会社ごとにまとめる
            const seen = new Set();
            const items = [];
            for (const fk of truth.trueFakes) {
              const id = `${fk.cid}:${fk.key}`;
              if (seen.has(id)) continue; seen.add(id);
              const co = truth.companies.find((c) => c.cid === fk.cid);
              if (!co) continue;
              items.push({ fk, co, ex: explainFake(co, fk.key) });
            }
            return items.map((it, i) => (
              <div className="recap-item" key={i}>
                <div className="recap-head">
                  <span className="recap-co">{it.co.name}</span>
                  <button className="recap-acct" onClick={() => onTip && onTip({ label: A_BY_KEY[it.fk.key]?.label || it.fk.key, desc: A_BY_KEY[it.fk.key]?.desc || "" })}>
                    {A_BY_KEY[it.fk.key]?.label || it.fk.key} <span className="recap-q">?</span>
                  </button>
                </div>
                <div className="recap-row"><span className="recap-tag what">手口</span>{it.ex.what}</div>
                <div className="recap-row"><span className="recap-tag how">なぜ崩れる</span>{it.ex.how}</div>
                <div className="recap-row"><span className="recap-tag signal">見抜き方</span>{it.ex.signal}</div>
              </div>
            ));
          })()}
          {truth.trueFx && truth.trueFx.length > 0 && (
            <div className="recap-item">
              <div className="recap-head"><span className="recap-co">{truth.trueFx.map(nameOf).join("・")}</span><span className="recap-acct">為替操作</span></div>
              <div className="recap-row"><span className="recap-tag what">手口</span>海外子会社の換算レートを市場相場より不当に高くして、円換算後の利益を膨らませる手口です。</div>
              <div className="recap-row"><span className="recap-tag signal">見抜き方</span>各社の換算レートと「市場目安レート」の乖離率を確認。大きく外れていれば為替粉飾の疑い。</div>
            </div>
          )}
          {truth.trueCircular && (
            <div className="recap-item">
              <div className="recap-head"><span className="recap-co">グループ内部取引</span><span className="recap-acct">循環取引</span></div>
              <div className="recap-row"><span className="recap-tag what">手口</span>グループ会社どうしで商品を回し、実体のない売上を水増しする手口です。</div>
              <div className="recap-row"><span className="recap-tag signal">見抜き方</span>内部取引の計上額が実際の取引額より大きいと循環取引。連結では消去されるはずの売上が手がかり。</div>
            </div>
          )}
        </div>
      )}
      <div className="btn-row">
        <button className="btn primary" onClick={onLibrary}>調査一覧へ戻る</button>
        <button className="btn ghost" onClick={onHome}>トップへ</button>
      </div>
    </div>
  );
}

// ================================================================


ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(App));
