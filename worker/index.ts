// むぎくんのお財布 — AI Worker (Cloudflare Workers)
// server.ts の AI 6エンドポイントを Cloudflare Workers AI 呼び出しで再現したもの。
// プロンプト・JSONスキーマ・後処理は server.ts から verbatim で移植。
// Workers AI は AI バインディング（env.AI）経由で呼び、APIキーは不要。
// 無料枠は 1日 10,000 ニューロン。失敗時はローカル分析にフォールバックする。
// wrangler.toml は使わない（親が cf.py ヘルパーで直接アップロードする）。
import { MUGI_PERSONALITIES, MugiPersonality } from '../src/src/utils/mugiPersonalities';
import { generateInstantBudgetAnalysis } from '../src/src/utils/mugiLocalAnalysis';

// Workers AI バインディングの最小限の型（@cloudflare/workers-types は未導入のため自前定義）
interface Ai {
  run(model: string, inputs: any, options?: any): Promise<any>;
}

export interface Env {
  AI: Ai;
  DB: D1Database;
}

// D1 の最小限の型（@cloudflare/workers-types は未導入のため自前定義）
interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
}
interface D1Database {
  prepare(query: string): D1PreparedStatement;
}

const ALLOWED_ORIGINS = new Set([
  'https://mugiodas.github.io',
  'http://localhost:5173',
]);

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function withCors(res: Response, origin: string | null): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) {
    headers.set(k, v);
  }
  return new Response(res.body, { status: res.status, headers });
}

function formatErrorMessage(err: any): string {
  let msg = err?.message || String(err);
  try {
    const parsed = JSON.parse(msg);
    if (parsed.error && parsed.error.message) {
      msg = parsed.error.message;
    }
  } catch {}

  if (msg.includes('503') || msg.includes('high demand') || msg.includes('UNAVAILABLE')) {
    return '現在AIサービスが一時的に混み合っています。数十秒後に再試行ボタンを押してください。';
  }
  if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED')) {
    return 'リクエスト上限に達しました。少し待ってから再度お試しください。';
  }
  return msg;
}

// --- ローカル分析（Workers AI 失敗時の代替）---
// AIなしでも動く、渡されたデータだけを使った算術的な分析。
// 数字はでっち上げず、文章はむぎくん口調。Workers AI が失敗したら
// 各ハンドラはこのローカル分析にフォールバックする。

function localNum(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function localYen(n: number): string {
  return `${Math.round(n).toLocaleString()}円`;
}

function round500(n: number): number {
  return Math.max(0, Math.round(n / 500) * 500);
}

// personality ごとの語尾（data.personality がなければ通常むぎくん）
function localTone(personality: any): { end: string; endEx: string } {
  switch (personality) {
    case 'super_miser': return { end: 'うさ！', endEx: 'うさ！' };
    case 'wastrel': return { end: 'うさ〜♪', endEx: 'うさ〜♪' };
    case 'gentle': return { end: 'うさねぇ🍀', endEx: 'うさねぇ🍀' };
    case 'strict': return { end: 'うさッ！', endEx: 'うさッ！' };
    case 'frugal': return { end: 'うさ✨', endEx: 'うさ✨' };
    default: return { end: 'うさ', endEx: 'うさ🐰' };
  }
}

function localPersonalityAction(personality: any): string {
  switch (personality) {
    case 'super_miser': return 'コンビニ・自販機への立ち寄りをゼロにして、1円の無駄も出さないうさ！';
    case 'wastrel': return '週末に1回だけ「ご褒美枠」を決めて、メリハリをつけて楽しむうさ〜♪';
    case 'gentle': return '無理しないで、できそうな時に1つだけ試してみてね、うさ🍀';
    case 'strict': return '週に1回は夫婦で家計簿を点検して、ズレが出たら即ブレーキをかけるうさッ！';
    case 'frugal': return '特売日とポイントアップデーを狙って、まとめ買いでコスパを上げるうさ✨';
    default: return '買い出し前に冷蔵庫の在庫をチェックして、必要なものだけリスト化するうさ🐰';
  }
}

// カテゴリ分析のローカル版（analyze-category と同じ JSON 形を返す）
function generateLocalCategoryAnalysis(data: any): any {
  const tone = localTone(data.personality);
  const name: string = data.categoryName || 'このカテゴリ';
  const budget = localNum(data.monthlyBudget);
  const spent = localNum(data.currentSpent);
  const rate = budget > 0 ? Math.round((spent / budget) * 100) : spent > 0 ? 100 : 0;
  const remaining = budget - spent;
  const hist: any[] = Array.isArray(data.historicalMonths) ? data.historicalMonths : [];
  const txs: any[] = Array.isArray(data.recentTransactions) ? data.recentTransactions : [];
  const stores: any[] = Array.isArray(data.topStores) ? data.topStores : [];
  const hasData = spent > 0 || txs.length > 0 || hist.length > 0;

  if (!hasData) {
    return {
      headline: `${name}はまだ支出データがありません${tone.endEx}`,
      statusLevel: 'good',
      spendingPattern: `今月は${name}の支出がまだ記録されていない${tone.end}。記録が増えてきたら、ここで買い方の傾向を分析する${tone.end}。`,
      costTrendAnalysis: `過去のデータもまだないため、推移の分析はこれから${tone.end}。来月以降の記録がたまると比較できるようになる${tone.end}。`,
      wasteDetection: `ムダの指摘ができるほどのデータがまだない${tone.end}。まずは記録を続けて、買い物の全体像をつかむことが第一歩${tone.end}。`,
      savingOpportunities: `まとめ買いや特売日の活用は、記録がたまってから具体的に提案できる${tone.end}。今は無理なく記録を続けることが一番の節約の土台${tone.end}。`,
      coupleActionPlan: [
        `${name}の買い物をしたら、その日のうちに記録する習慣をつける${tone.end}`,
        `買い出し前にメモを作って、必要なものだけ買う${tone.end}`,
        localPersonalityAction(data.personality),
      ],
      forecastAdvice: `来月も今の予算（${localYen(budget)}）を目安にして、記録を続けながら様子を見る${tone.end}。`,
    };
  }

  const txTotal = txs.reduce((s, t) => s + localNum(t.amount), 0);
  const avgTx = txs.length > 0 ? Math.round(txTotal / txs.length) : 0;
  const histAvg = hist.length > 0
    ? Math.round(hist.reduce((s, h) => s + localNum(h.spent), 0) / hist.length)
    : 0;
  const trendPct = histAvg > 0 ? Math.round(((spent - histAvg) / histAvg) * 100) : 0;
  const topStore = stores[0];
  const statusLevel = rate > 100 ? 'danger' : rate > 85 ? 'warning' : 'good';
  const biggest = txs.length > 0
    ? txs.reduce((a, b) => (localNum(b.amount) > localNum(a.amount) ? b : a))
    : null;

  const spendingPattern =
    `今月は合計${localYen(spent)}（予算${localYen(budget)}に対して${rate}%）で、直近の明細は${txs.length}件、1件あたり平均${localYen(avgTx)}${tone.end}。` +
    (topStore
      ? `一番使っているのは${topStore.store}で${localYen(localNum(topStore.total))}・${topStore.count}回${tone.end}。`
      : '');

  let costTrendAnalysis: string;
  if (hist.length >= 2) {
    costTrendAnalysis =
      `過去${hist.length}ヶ月の平均は${localYen(histAvg)}で、今月はそれより${Math.abs(trendPct)}%${trendPct >= 0 ? '多い' : '少ない'}${tone.end}。` +
      (remaining >= 0
        ? `予算に対して残り${localYen(remaining)}あり、このペースなら予算内に収まりそう${tone.end}。`
        : `予算を${localYen(-remaining)}オーバーしているので、来月の予算見直しを検討してほしい${tone.end}。`);
  } else {
    costTrendAnalysis =
      `過去の推移データが少ないため、今月の実績（${localYen(spent)}）を基準に来月を見ていく${tone.end}。` +
      (remaining >= 0
        ? `予算に対して残り${localYen(remaining)}あり、順調なペース${tone.end}。`
        : `予算を${localYen(-remaining)}オーバーしているので、来月の予算見直しを検討してほしい${tone.end}。`);
  }

  let wasteDetection: string;
  if (rate > 100) {
    wasteDetection = `予算を${localYen(-remaining)}オーバーしている${tone.end}。` +
      (biggest
        ? `金額が一番大きいのは${biggest.date || ''}の${biggest.store || name}・${localYen(localNum(biggest.amount))}で、ここから見直すと効果が出やすい${tone.end}。`
        : `まずは金額の大きい明細から見直すと効果が出やすい${tone.end}。`);
  } else if (txs.length >= 8) {
    wasteDetection = `少額の買い物が${txs.length}件と回数が多め${tone.end}。ついで買いが重なっていないか、まとめ買いにできないか見直すと効く${tone.end}。`;
  } else {
    wasteDetection = `今月の明細を見る限り、目立ったムダや重複買いは見つからなかった${tone.end}。この調子をキープする${tone.end}。`;
  }

  const savingOpportunities =
    (topStore
      ? `${topStore.store}をよく使っているなら、特売日やポイント還元日を狙うとお得${tone.end}。`
      : `買い出しの回数を週2回程度にまとめると、ついで買いが減りやすい${tone.end}。`) +
    `買い出し前に在庫とメモを確認して、必要なものだけ買う習慣が一番の節約${tone.end}。`;

  const headline =
    rate > 100
      ? `${name}は予算オーバー注意${tone.endEx} 残りはマイナス${localYen(-remaining)}`
      : rate > 85
        ? `${name}は予算の${rate}%まで到達、ペース配分に注意${tone.endEx}`
        : `${name}は予算内で順調${tone.endEx} 消化率${rate}%`;

  return {
    headline,
    statusLevel,
    spendingPattern,
    costTrendAnalysis,
    wasteDetection,
    savingOpportunities,
    coupleActionPlan: [
      remaining < 0
        ? `今月残りの${name}の買い物は、必要なものだけに絞る${tone.end}`
        : `今月のペース（${localYen(spent)}）をキープして、予算内で収める${tone.end}`,
      topStore
        ? `${topStore.store}の特売日・ポイントデーをチェックしてから買い出しに行く${tone.end}`
        : `買い出しの回数を週2回程度にまとめて、ついで買いを減らす${tone.end}`,
      localPersonalityAction(data.personality),
    ],
    forecastAdvice:
      rate > 100
        ? `来月は予算を${localYen(round500(spent))}程度まで引き上げるか、支出を${localYen(-remaining)}抑える計画を立てる${tone.end}。無理のない方を選ぶ${tone.end}。`
        : `来月も予算${localYen(budget)}を目安に、実績ペース（${localYen(spent)}）をキープする${tone.end}。`,
  };
}

// スマート検索のローカル版（キーワード・期間・金額・支払者で絞り込む）
function generateLocalSmartSearch(data: any): any {
  const tone = localTone(data.personality);
  const query: string = String(data.query || '').trim();
  const txs: any[] = Array.isArray(data.transactions) ? data.transactions : [];
  const currentDate: string = String(data.currentDate || '');
  const today = new Date(currentDate || Date.now());
  const yyyy = today.getFullYear();
  const mm = today.getMonth() + 1;
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const ymKey = (y: number, m: number) => `${y}-${pad2(m)}`;
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);

  // --- 期間の解釈 ---
  let periodLabel = '全期間';
  let periodTest: ((date: string) => boolean) | null = null;
  if (/先月/.test(query)) {
    const d = new Date(yyyy, mm - 2, 1);
    const key = ymKey(d.getFullYear(), d.getMonth() + 1);
    periodLabel = '先月';
    periodTest = (date) => String(date).startsWith(key);
  } else if (/今月/.test(query)) {
    const key = ymKey(yyyy, mm);
    periodLabel = '今月';
    periodTest = (date) => String(date).startsWith(key);
  } else if (/先週/.test(query)) {
    const end = new Date(today.getTime() - 7 * 86400000);
    const start = new Date(today.getTime() - 14 * 86400000);
    periodLabel = '先週';
    periodTest = (date) => date >= isoDay(start) && date < isoDay(end);
  } else if (/今年/.test(query)) {
    periodLabel = '今年';
    periodTest = (date) => String(date).startsWith(String(yyyy));
  } else {
    const mMatch = query.match(/(\d{1,2})月/);
    if (mMatch) {
      const mNum = Number(mMatch[1]);
      const y = mNum > mm ? yyyy - 1 : yyyy;
      const key = ymKey(y, mNum);
      periodLabel = `${mNum}月`;
      periodTest = (date) => String(date).startsWith(key);
    }
  }

  // --- 金額条件 ---
  let minAmount: number | null = null;
  let maxAmount: number | null = null;
  let amountLabel = '';
  const minMatch = query.match(/([\d,]+)\s*円以上/);
  const maxMatch = query.match(/([\d,]+)\s*円以下/);
  if (minMatch) { minAmount = Number(minMatch[1].replace(/,/g, '')); amountLabel = `${minMatch[1]}円以上`; }
  if (maxMatch) { maxAmount = Number(maxMatch[1].replace(/,/g, '')); amountLabel = `${maxMatch[1]}円以下`; }
  if (/高い買い物|高額/.test(query) && minAmount === null) { minAmount = 5000; amountLabel = '5,000円以上'; }

  // --- 支払者条件 ---
  let payerTest: ((t: any) => boolean) | null = null;
  let payerLabel = '';
  if (/父|旦那|お父さん|パパ/.test(query)) {
    payerLabel = '父';
    payerTest = (t) => t.payerRole === 'dad' || /父|旦那/.test(String(t.payerName || ''));
  } else if (/母|妻|お母さん|ママ/.test(query)) {
    payerLabel = '母';
    payerTest = (t) => t.payerRole === 'mom' || /母|妻/.test(String(t.payerName || ''));
  }

  // --- キーワード（意味グループ・カテゴリ名・残りの語） ---
  const SEMANTIC: { triggers: string[]; terms: string[]; category?: string }[] = [
    { triggers: ['バドミントン', '部費', 'ラケット', 'シャトル', 'ガット', 'シューズ', '大会', '試合', '体育館'], terms: ['バドミントン', '部費', 'ラケット', 'シャトル', 'ガット', 'シューズ', '大会', '試合', '体育館'], category: '莉歩費' },
    { triggers: ['外食', 'カフェ', 'レストラン', '居酒屋', 'マクドナルド', 'マック', 'スタバ', 'スターバックス', 'ラーメン', 'すし', '寿司', 'ファミレス'], terms: ['外食', 'カフェ', 'レストラン', '居酒屋', 'マクドナルド', 'マック', 'スタバ', 'スターバックス', 'ラーメン', 'すし', '寿司', 'ファミレス'], category: '外食・レジャー' },
    { triggers: ['コンビニ', 'セブン', 'ローソン', 'ファミマ', 'ファミリーマート', 'ミニストップ'], terms: ['コンビニ', 'セブン', 'ローソン', 'ファミマ', 'ファミリーマート', 'ミニストップ'] },
    { triggers: ['スーパー', '食費', '食材', '食料品'], terms: ['スーパー', '食費', '食材', '食料品'], category: '食費' },
    { triggers: ['日用品', 'ドラッグストア', '薬局'], terms: ['日用品', 'ドラッグストア', '薬局'], category: '日用品' },
    { triggers: ['ガソリン', '給油'], terms: ['ガソリン', '給油', 'ENEOS', 'エネオス'], category: 'ガソリン' },
    { triggers: ['習字'], terms: ['習字'], category: '莉歩費' },
  ];
  const matchedTerms: string[] = [];
  const matchedCategories: string[] = [];
  for (const g of SEMANTIC) {
    if (g.triggers.some((w) => query.includes(w))) {
      for (const w of g.terms) if (!matchedTerms.includes(w)) matchedTerms.push(w);
      if (g.category && !matchedCategories.includes(g.category)) matchedCategories.push(g.category);
    }
  }
  const KNOWN_CATEGORIES = ['食費', '日用品', '衣服・美容', '外食・レジャー', 'その他・交際費', '保険', '光熱費', 'ガソリン', '通信費', 'ETC', '医療費', '母お小遣い', '父お小遣い', '莉歩費', '貯蓄', '旅行積立'];
  for (const c of KNOWN_CATEGORIES) {
    if (query.includes(c) && !matchedCategories.includes(c)) matchedCategories.push(c);
  }
  const STOP = new Set(['の関係', '関係', '買ったもの', '買った', 'もの', '支出', '出費', '先月', '今月', '先週', '今年', '検索', '合計', 'くらい', '以上', '以下', '高い買い物', '高額', '教えて', 'なに', '何', '一覧']);
  const tokens = (query.match(/[ぁ-んァ-ン一-鿐a-zA-Z0-9]{2,}/g) || [])
    .filter((w) => !STOP.has(w) && !/^\d+$/.test(w));
  for (const w of tokens) {
    if (!matchedTerms.includes(w) && !matchedCategories.includes(w)) matchedTerms.push(w);
  }

  const hay = (t: any) =>
    [t.categoryName, t.categoryGroup, t.storeName, t.memo, t.payerName]
      .map((x) => String(x || ''))
      .join(' ');

  const matched = txs.filter((t) => {
    if (periodTest && !periodTest(String(t.date || ''))) return false;
    const amt = localNum(t.amount);
    if (minAmount !== null && amt < minAmount) return false;
    if (maxAmount !== null && amt > maxAmount) return false;
    if (payerTest && !payerTest(t)) return false;
    if (matchedCategories.length === 0 && matchedTerms.length === 0) return true;
    const h = hay(t);
    return (
      matchedCategories.some((c) => h.includes(c)) ||
      matchedTerms.some((w) => h.includes(w))
    );
  });

  const total = matched.reduce((s, t) => s + localNum(t.amount), 0);
  const top3 = [...matched].sort((a, b) => localNum(b.amount) - localNum(a.amount)).slice(0, 3);
  const catCount: Record<string, number> = {};
  for (const t of matched) {
    const c = String(t.categoryName || 'その他');
    catCount[c] = (catCount[c] || 0) + 1;
  }
  const topCat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0]?.[0] || '';

  let aiSummary: string;
  if (matched.length === 0) {
    aiSummary = `「${query}」に合う取引は見つからなかった${tone.end}。期間やキーワードを変えてもう一度試してほしい${tone.end}。`;
  } else {
    aiSummary = `「${query}」に合う取引は${matched.length}件、合計${localYen(total)}見つかった${tone.end}。` +
      (top3.length > 0
        ? `一番大きいのは${top3[0].date || ''}の${top3[0].storeName || top3[0].categoryName}・${localYen(localNum(top3[0].amount))}${tone.end}。`
        : '');
  }

  const intentParts: string[] = [`期間: ${periodLabel}`];
  if (matchedCategories.length > 0) intentParts.push(`カテゴリ: ${matchedCategories.join('・')}`);
  if (matchedTerms.length > 0) intentParts.push(`キーワード: ${matchedTerms.slice(0, 5).join('・')}`);
  if (amountLabel) intentParts.push(`金額: ${amountLabel}`);
  if (payerLabel) intentParts.push(`支払者: ${payerLabel}`);

  return {
    matchedIds: matched.map((t) => t.id),
    aiSummary,
    intentDescription: intentParts.join(' / '),
    suggestedNextQueries: topCat
      ? [`${topCat}の今月分`, `先月の${topCat}`]
      : ['今月の食費', '先月のコンビニ'],
  };
}

// バドミントン分析のローカル版
function generateLocalBadmintonAnalysis(data: any): any {
  const tone = localTone(data.personality);
  const total = localNum(data.totalSpent);
  const avg = localNum(data.monthlyAverage);
  const b = data.breakdown || {};
  const club = localNum(b.clubFees);
  const matches = localNum(b.matches);
  const gear = localNum(b.gear);
  const other = localNum(b.other);
  const trend: any[] = Array.isArray(data.monthlyTrend) ? data.monthlyTrend : [];
  const txs: any[] = Array.isArray(data.recentTransactions) ? data.recentTransactions : [];
  const tour: any[] = Array.isArray(data.tournaments) ? data.tournaments : [];
  const period = data.periodLabel || '全期間';

  if (total <= 0 && txs.length === 0 && tour.length === 0) {
    return {
      headline: `バドミントン関連の支出データがまだありません${tone.endEx}`,
      statusLevel: 'info',
      annualForecast: `まだバドミントン関連の支出が記録されていない${tone.end}。部費や大会参加費、道具代が記録されると、ここで年間ペースを分析する${tone.end}。`,
      gearAdvice: `ラケットやシューズ、ガット張り替えなどの道具代は、買い替えのタイミングが突然来る${tone.end}。月々少しずつ備えておくと安心${tone.end}。`,
      matchAdvice: `大会参加費や遠征費はシーズンによって波がある${tone.end}。大会が決まったら参加費と交通費を先に確保しておく${tone.end}。`,
      familyBudgetPlan: `月5,000円の部費を軸に、遠征や道具代の波に備えた予備費を別枠でプールしておくと安心${tone.end}。`,
      cheerMessage: `莉歩ちゃんの頑張りを、これからもみんなで応援していく${tone.end}！`,
      actionList: [
        `部費や大会参加費、道具代を記録して、バドミントン支出の全体像をつかむ${tone.end}`,
        `次の大会が決まったら、参加費と遠征費を先に確保する${tone.end}`,
        localPersonalityAction(data.personality),
      ],
    };
  }

  const gearShare = total > 0 ? Math.round((gear / total) * 100) : 0;
  const tourTotal = tour.reduce((s, t) => s + localNum(t.amount), 0);
  const maxMonth = trend.length > 0
    ? trend.reduce((a, c) => (localNum(c.amount) > localNum(a.amount) ? c : a))
    : null;
  const statusLevel = avg > 0 && maxMonth && localNum(maxMonth.amount) > avg * 2 ? 'warning' : 'good';

  return {
    headline: `バドミントン支出は${period}で合計${localYen(total)}、月平均${localYen(avg)}${tone.endEx}`,
    statusLevel,
    annualForecast: `月平均${localYen(avg)}ペースだと、年間で約${localYen(avg * 12)}${tone.end}。内訳は部費${localYen(club)}、大会・遠征${localYen(matches)}、道具${localYen(gear)}、その他${localYen(other)}で、${period}の合計は${localYen(total)}${tone.end}。`,
    gearAdvice: gear > 0
      ? `道具・消耗品は${localYen(gear)}で全体の${gearShare}%${tone.end}。ガット張り替えやシャトルはまとめ買いで単価を抑え、セールや型落ちも狙い目${tone.end}。`
      : `この期間の道具代の支出はない${tone.end}。ラケットやシューズの買い替えは突然来るので、月々少しずつ備えておくと安心${tone.end}。`,
    matchAdvice: tour.length > 0
      ? `大会は${tour.length}件（合計${localYen(tourTotal)}）${tone.end}。遠征は交通費と宿泊費がかさむので、早めの予約と乗り合いで抑える${tone.end}。`
      : `この期間の大会参加はない${tone.end}。次の大会が決まったら参加費と遠征費を先に確保しておく${tone.end}。`,
    familyBudgetPlan: `月${localYen(round500(avg * 1.1))}程度をバドミントン枠として別にプールしておくと、遠征や道具の急な出費にも慌てない${tone.end}。特別費の積立も活用する${tone.end}。`,
    cheerMessage: `莉歩ちゃんの頑張りを支えるご両親の努力が素晴らしい${tone.endEx} 一歩ずつ成長する姿を、これからもみんなで応援していく${tone.end}！`,
    actionList: [
      `月${localYen(round500(avg * 1.1))}をバドミントン枠として別にプールする${tone.end}`,
      gear > 0
        ? `シャトルやガットはまとめ買いで単価を抑える${tone.end}`
        : `次の大会日程を確認して、参加費と遠征費を先に確保する${tone.end}`,
      localPersonalityAction(data.personality),
    ],
  };
}

// 予算リバランスのローカル版（実績平均の110%を500円単位に丸める）
function generateLocalRebalance(data: any): any {
  const tone = localTone(data.personality);
  const scope = data.scope === 'all' ? 'all' : 'living';
  const cats: any[] = Array.isArray(data.categories) ? data.categories : [];
  const targets = cats.filter((c) => c.isTargetScope);

  if (targets.length === 0) {
    return {
      headline: `組み替え対象のカテゴリがありません${tone.endEx}`,
      scopeDescription: `対象範囲にカテゴリがなかったため、組み替えは行わなかった${tone.end}。`,
      proposedCategories: [],
      totalBefore: 0,
      totalAfter: 0,
      adviceMessage: `対象カテゴリが入ってきたら、実績に合わせた予算案を作る${tone.end}。`,
      keyChangesSummary: [`変更なし${tone.endEx}`],
    };
  }

  const worked = targets.map((c) => {
    const cur = localNum(c.currentBudget);
    const avg = localNum(c.actualAverage);
    let next = cur;
    let reason = '';
    if (avg <= 0) {
      reason = `直近の実績がないため、現状の${localYen(cur)}を維持する${tone.end}`;
    } else {
      const cand = round500(avg * 1.1);
      if (Math.abs(cand - cur) <= 500) {
        next = cur;
        reason = `実績平均${localYen(avg)}に対して今の${localYen(cur)}がちょうどいいので維持する${tone.end}`;
      } else if (avg > cur) {
        next = cand;
        reason = `実績平均${localYen(avg)}に合わせて${localYen(next)}に増額し、無理のない枠を確保する${tone.end}`;
      } else {
        next = cand;
        reason = `実績平均${localYen(avg)}に合わせて${localYen(next)}にスリム化し、余った分を他に回す${tone.end}`;
      }
    }
    return { categoryId: c.id, name: String(c.name || ''), currentBudget: cur, proposedBudget: next, reason };
  });

  const totalBefore = localNum(data.totalCurrentBudget) > 0
    ? localNum(data.totalCurrentBudget)
    : worked.reduce((s, c) => s + c.currentBudget, 0);
  const totalAfter = worked.reduce((s, c) => s + c.proposedBudget, 0);
  const changes = worked
    .filter((c) => c.proposedBudget !== c.currentBudget)
    .sort((a, b) => Math.abs(b.proposedBudget - b.currentBudget) - Math.abs(a.proposedBudget - a.currentBudget));

  return {
    headline: changes.length > 0
      ? `実績に合わせて予算を組み替え${tone.endEx} 合計は${localYen(totalBefore)}→${localYen(totalAfter)}`
      : `今の予算が実績にぴったり${tone.endEx} 組み替えは不要`,
    scopeDescription: scope === 'living'
      ? `生活変動費（食費・日用品・外食など）の範囲で、${data.referencePeriodLabel || '直近の実績'}をもとに再配分する${tone.end}。`
      : `予算全体を対象に、${data.referencePeriodLabel || '直近の実績'}をもとに再配分する${tone.end}。`,
    proposedCategories: worked.map((c) => ({
      categoryId: c.categoryId,
      proposedBudget: c.proposedBudget,
      reason: c.reason,
    })),
    totalBefore,
    totalAfter,
    adviceMessage: `新しい予算で1ヶ月運用して、実績と比べながら微調整する${tone.end}。莉歩ちゃんのバドミントンや習い事は削りすぎず、部費と遠征の波に備えた枠を残す${tone.end}。`,
    keyChangesSummary: changes.length > 0
      ? changes.slice(0, 3).map((c) => {
          const diff = c.proposedBudget - c.currentBudget;
          return `${c.name} ${diff > 0 ? '+' : ''}${localYen(diff)}（${localYen(c.currentBudget)}→${localYen(c.proposedBudget)}）`;
        })
      : [`変更なし${tone.endEx} 今の予算が実績に合っているので、このままキープする${tone.end}`],
  };
}

// --- Workers AI caller (Cloudflare Workers AI, AI バインディング経由) ---
// テキスト: Llama 3.2 3B Instruct。レシート読取: Llama 3.2 11B Vision。
// 70B (llama-3.3-70b-instruct-fp8-fast) は実測で 1 呼び出し約 11 秒かかり
// アプリの 8 秒タイムアウトに収まらないため、3B にした（同プロンプトで約 3 秒）。
// アプリのタイムアウトは 8 秒なので max_tokens は控えめにし、失敗時は
// 各ハンドラの catch 側でローカル分析にフォールバックする（500 を返さない）。
const WORKERS_AI_TEXT_MODEL = '@cf/meta/llama-3.2-3b-instruct';
// 短い出力だけの smart-search は 70B を使う。3B はプロンプト中の具体例の
// 金額（16,500円など）をそのまま写してしまい、合計が合わなくなるため。
// 70B は短い出力なら約 2 秒で、金額も実データどおりに計算できる。
// 長い JSON（診断・分析・リバランス）では 70B は約 11 秒かかるため 3B を使う。
const WORKERS_AI_TEXT_MODEL_LARGE = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const WORKERS_AI_VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

// Workers AI の返値は { response: string }。モデルが ```json フェンス付きで
// 返すことがあるので、parse 前にフェンスを除去し、{ ... } 部分だけ抜き出す。
function extractJson(text: string): any {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    t = t.slice(start, end + 1);
  }
  return JSON.parse(t);
}

// Workers AI の返値はモデルにより { response } または OpenAI 互換の
// { choices: [{ message: { content } }] } のどちらか。両方に対応する
//（2026-11-21 時点で Llama 系は後者の形で返ってくることを確認済み）。
function extractWorkersAIText(res: any): string {
  if (typeof res?.response === 'string' && res.response) return res.response;
  const c = res?.choices?.[0];
  let content: any = c?.message?.content ?? c?.text ?? '';
  if (Array.isArray(content)) {
    content = content.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('');
  }
  return typeof content === 'string' ? content : '';
}

async function runWorkersAIText(
  env: Env,
  params: {
    systemInstruction?: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
    model?: string;
  },
): Promise<{ text: string }> {
  const messages: any[] = [];
  if (params.systemInstruction) {
    messages.push({ role: 'system', content: params.systemInstruction });
  }
  messages.push({ role: 'user', content: params.userPrompt });
  // アプリのタイムアウトは 8 秒。スマホ回線の遅延も見込んで、AI は 3 秒で
  // 打ち切り、遅れたらローカル分析へフォールバックする（呼び出し自体は放っておく）。
  const aiCall = env.AI.run(params.model ?? WORKERS_AI_TEXT_MODEL, {
    messages,
    temperature: params.temperature ?? 0.4,
    max_tokens: params.maxTokens ?? 1500,
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Workers AI timed out')), 3000),
  );
  const res: any = await Promise.race([aiCall, timeout]);
  const text = extractWorkersAIText(res);
  if (!text) {
    throw new Error('Empty response from Workers AI');
  }
  return { text };
}

async function runWorkersAIVision(
  env: Env,
  params: {
    prompt: string;
    base64Data: string;
    mimeType: string;
    temperature?: number;
    maxTokens?: number;
  },
): Promise<{ text: string }> {
  const res: any = await env.AI.run(WORKERS_AI_VISION_MODEL, {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: params.prompt },
          {
            type: 'image_url',
            image_url: { url: `data:${params.mimeType};base64,${params.base64Data}` },
          },
        ],
      },
    ],
    temperature: params.temperature ?? 0.1,
    max_tokens: params.maxTokens ?? 1200,
  });
  const text = extractWorkersAIText(res);
  if (!text) {
    throw new Error('Empty response from Workers AI');
  }
  return { text };
}

// 1. AI Budget Analysis Endpoint — logic/prompts copied verbatim from server.ts
async function handleAnalyzeBudget(data: any, env: Env): Promise<Response> {
    const personalityKey: MugiPersonality = (data.personality as MugiPersonality) || 'normal';
  const personalityMeta = MUGI_PERSONALITIES[personalityKey] || MUGI_PERSONALITIES.normal;

  try {
    const systemInstruction = `
あなたは夫婦2人の家計をサポートする専任ファイナンシャルアドバイザーのうさぎ「むぎくん」です。
現在の性格・モードは【${personalityMeta.name}】（${personalityMeta.tagline}）です。

${personalityMeta.tonePrompt}

【医療費に関する最重要原則】:
医療費（病院・通院・薬局・歯科等）は不可避の健康維持費です。節約対象にせず温かく受け止め、他の支出（食費・日用品・外食等）を分析してください。

回答は必ず以下のJSONスキーマに従った有効なJSON形式で出力してください：
{
  "headline": "1行の総括（現在の性格の口調を色濃く反映すること）",
  "statusLevel": "good" または "warning" または "danger",
  "currentDiagnosis": "今月何にお金を使いすぎているか、どこが順調かの診断（2〜3文、性格に合わせた語尾とトーンで徹底）",
  "storeInsight": "店舗利用の傾向分析。提供された【主な利用店舗】や【コンビニ利用】の実績データに忠実に分析すること。もし今月のコンビニ利用が0回または少額（数回以内・数千円未満）なら「コンビニをしっかり抑えられている」「スーパーを賢く使えている」と評価し、事実と異なるコンビニ使いすぎ指摘は絶対にしないこと。実際に支出額が大きい上位店舗について言及してください（2文程度、性格の口調で）",
  "specialExpenseAdvice": "定期的な特別支出（車検・自動車保険・賃貸更新等）に関する事前リマインドと月々の適正積立アドバイス",
  "midMonthAdvice": "月の途中で残り日数に何を意識すべきか（1日あたりの目標目安など具体的に、性格の口調で）",
  "nextMonthAction": "今月の結果を踏まえて来月は何を意識・改善すべきか（性格の口調で）",
  "praisePoint": "夫婦で共有して称え合いたいポイント（性格の口調で）",
  "actionList": [
    "改善効果を最大化する具体的アクション1（即実践できること、性格に合わせた語尾）",
    "改善効果を最大化する具体的アクション2",
    "改善効果を最大化する具体的アクション3"
  ]
}
`;

    const userPrompt = `
【家計データ】
対象月: ${data.yearMonth}
本日: ${data.currentDay}日目（今月全${data.daysInMonth}日中、残り${data.remainingDays}日）
集計対象の使える予算: 予算${data.spendableBudget?.toLocaleString()}円、実績${data.spendableActual?.toLocaleString()}円、残り${data.spendableRemaining?.toLocaleString()}円
現在の1日平均ペース: ${data.dailyAverageSpent?.toLocaleString()}円/日
貯蓄実績: ${data.savingsActual?.toLocaleString()}円 / 目標${data.savingsBudget?.toLocaleString()}円
コンビニ利用: ${data.convenienceStoreSummary ? JSON.stringify(data.convenienceStoreSummary) : 'なし'}
主な利用店舗: ${data.topStoresSummary ? JSON.stringify(data.topStoresSummary.slice(0, 4)) : 'なし'}
カテゴリ別進捗: ${JSON.stringify((data.categorySummaries || []).slice(0, 10))}

この夫婦に向けて、【${personalityMeta.name}】としての語り口・視点で即実践できる分析アドバイスを出力してください。
`;

    const response = await runWorkersAIText(env, {
      systemInstruction,
      userPrompt,
      temperature: 0.4,
      maxTokens: 1500,
    });

    const text = response.text || '{}';
    const parsed = extractJson(text);
    parsed.personality = personalityKey;
    parsed.personalityTitle = personalityMeta.name;
    return json(parsed);
  } catch (error: any) {
    console.warn(`[AI Budget Analysis] Cloud AI returned error (${error?.message}). Instantly activating Character Analysis Engine for guaranteed 0ms response.`);
    // 100% Reliable Instant Fallback Engine: Calculates exact spending metrics & personality persona instantly!
    const fallbackResult = generateInstantBudgetAnalysis(data, personalityKey);
    return json(fallbackResult);
  }
}

// 2. Receipt OCR / Scan with Workers AI Endpoint — logic/prompts copied verbatim from server.ts
async function handleScanReceipt(data: any, env: Env): Promise<Response> {
  try {
    const { imageBase64, mimeType = 'image/jpeg', categories = [] } = data;

    if (!imageBase64) {
      return json({ error: '画像データがありません' }, 400);
    }

    // Clean base64 string
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');

    const categoryListText = categories
      .map((c: any) => `ID: "${c.id}", カテゴリ名: "${c.name}", グループ: "${c.group}"`)
      .join('\n');

    const prompt = `
このレシート画像を解析して、日本の家計簿に必要な情報を抽出してください。

【候補カテゴリ一覧】
${categoryListText}

以下のJSON形式で必ず返してください：
{
  "amount": 合計金額（数値型、税込合計額、例: 3280）,
  "date": "購入日付（YYYY-MM-DD形式。読み取れない場合はnull）",
  "storeName": "店舗名（例: イオン〇〇店、セブンイレブン、ENEOS等。読み取れない場合はnull）",
  "suggestedCategoryId": "上記【候補カテゴリ一覧】の中から最も適合するカテゴリのID（文字列）。見つからない場合は最も近いもの",
  "memo": "品目の概要や店舗名を入れた短いメモ（例: スーパー 食料品、ガソリンなど）",
  "confidence": "high" または "medium" または "low"
}
`;

    // レシート読取にローカル代替はない。Workers AI が失敗したら catch 側で
    // 分かりやすい日本語エラーを返す（生エラーを出さない）。
    const response = await runWorkersAIVision(env, {
      prompt,
      base64Data,
      mimeType,
      temperature: 0.1,
      maxTokens: 1200,
    });

    const text = response.text || '{}';
    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      // モデルが JSON ではなく散文だけ返した場合など。生エラーは出さない。
      return json({ error: 'レシートの内容を読み取れませんでした。画像を明るく・まっすぐ撮り直して、もう一度お試しください。' }, 500);
    }
    return json(parsed);
  } catch (error: any) {
    console.error('Error scanning receipt:', error);
    return json({ error: formatErrorMessage(error) }, 500);
  }
}

// 3. Category Deep Dive AI Analysis Endpoint — logic/prompts copied verbatim from server.ts
async function handleAnalyzeCategory(data: any, env: Env): Promise<Response> {
  try {
    const {
      yearMonth,
      categoryName,
      groupName,
      monthlyBudget,
      currentSpent,
      rate,
      historicalMonths = [],
      recentTransactions = [],
      topStores = [],
    } = data;

    const systemInstruction = `
あなたは夫婦2人の家計をサポートする、温かく愛らしいロップイヤーうさぎの「むぎくん」（専任ファイナンシャルアドバイザー）です。
うさぎらしく愛らしい口調として、文章やアドバイス（headline, spendingPattern, costTrendAnalysis, wasteDetection, savingOpportunities, coupleActionPlan, forecastAdvice等）の語尾には必ず「〜うさ」「〜だうさ」「〜するうさ」「〜してほしい、うさ」「〜安心うさ🐰」などを自然につけて話してください。
今回は指定された「特定の1カテゴリ」についての当月の深層分析（ディープダイブ）を行います。
提供された【主な利用店舗 / 内訳】や【直近の支出明細】の実績データに忠実に分析してください。データにない店舗（例: コンビニ利用がないのにコンビニでのついで買いなど）を勝手に決めつけて指摘することは絶対に避けてください。
批判的・説教くさいトーンは絶対に避け、夫婦が前向きに協力し合える、実践的で具体的な改善提案を行ってください。

回答は必ず以下のJSONスキーマに従った有効なJSON形式で出力してください：
{
  "headline": "1行の総括（例: 習い事の固定費が安定！道具代の月ごとのブレを年間で見通せば安心）",
  "statusLevel": "good" または "warning" または "danger",
  "spendingPattern": "このカテゴリの支出特徴・買い方・利用店舗や頻度の分析（2〜3文）",
  "costTrendAnalysis": "過去数ヶ月の推移と予算比の分析。増減の傾向や季節要因など（2〜3文）",
  "wasteDetection": "潜んでいるムダや見直しの可能性（買い物の頻度、まとめ買いの可否、重複買い等、データに基づいた指摘）",
  "savingOpportunities": "このカテゴリに特化した具体的で実践しやすい節約・最適化テクニック（2〜3文）",
  "coupleActionPlan": [
    "夫婦で今日〜今月できる具体的アクション1",
    "夫婦で今日〜今月できる具体的アクション2",
    "夫婦で今日〜今月できる具体的アクション3"
  ],
  "forecastAdvice": "来月以降に向けた予算設定や心構えのアドバイス（1〜2文）"
}
`;

    const userPrompt = `
【対象カテゴリ】: ${categoryName} （グループ: ${groupName}）
対象月: ${yearMonth}
今月の予算: ${monthlyBudget?.toLocaleString()}円
今月の実績: ${currentSpent?.toLocaleString()}円（消化率: ${rate}%）

【過去数ヶ月の推移】:
${JSON.stringify(historicalMonths, null, 2)}

【主な利用店舗 / 内訳】:
${JSON.stringify(topStores, null, 2)}

【このカテゴリの直近の支出明細】:
${JSON.stringify(recentTransactions.slice(0, 20), null, 2)}

このカテゴリの支出動向を徹底的に深掘りし、改善効果を最大化するアドバイスをJSONで回答してください。
`;

    const response = await runWorkersAIText(env, {
      systemInstruction,
      userPrompt,
      temperature: 0.4,
      maxTokens: 1500,
    });

    const text = response.text || '{}';
    const parsed = extractJson(text);
    return json(parsed);
  } catch (error: any) {
    console.error('Error analyzing category:', error);
    // Workers AI 失敗時もローカル分析で返す（生エラーを出さない）。
    return json(generateLocalCategoryAnalysis(data));
  }
}

// 4. AI Natural Language Smart Search Endpoint — logic/prompts copied verbatim from server.ts
async function handleSmartSearch(data: any, env: Env): Promise<Response> {
  try {
    const { query: searchQuery, transactions = [], currentDate } = data;

    if (!searchQuery || typeof searchQuery !== 'string') {
      return json({ error: '検索クエリがありません' }, 400);
    }

    const systemInstruction = `
あなたは家計簿のインテリジェントAI検索エンジンです。
ユーザーが入力した自然言語の検索クエリ（例: 「莉歩のバドミントン関係」「先月ローソンで買ったもの」「5000円以上の外食」「父のお小遣い」「夏休みの出費」）の意図を正確に読み取り、提示された支出リストの中から合致する取引を柔軟かつ高精度に抽出してください。

基準:
- 日時・期間の解釈: 「先月」「今月」「先週」「今年」「9月」などの相対表現を基準日（${currentDate || '現在'}）を元に正しく判定する。
- 意味的・文脈マッチ（セマンティックマッチ）:
  - 「バドミントン関係」➔ カテゴリ名、メモ、店舗名に「バドミントン」「部費」「ラケット」「シャトル」「大会」「試合」などが含まれるもの、または「莉歩費」の中の関連項目。
  - 「外食」➔ 外食カテゴリやカフェ、レストラン、居酒屋、マクドナルド、スターバックスなどの店舗。
  - 「コンビニ」➔ セブン、ローソン、ファミマなど。
- 金額条件: 「5000円以上」「3000円以下」「高い買い物」などを判定する。
- 支払者条件: 「父」「母」「旦那」「妻」などをpayerRole/payerNameから判定する。

回答は必ず以下のJSON形式で出力してください：
{
  "matchedIds": ["マッチしたtransactionのid配列"],
  "aiSummary": "ユーザーの検索意図に沿った分かりやすく温かい要約（例: 莉歩ちゃんのバドミントン関連の出費は全期間で3件、合計16,500円見つかりました。部費10,000円、大会参加費3,500円、道具3,000円です。）",
  "intentDescription": "AIが認識した検索条件の説明（例: 期間: 全期間 / カテゴリ: 莉歩費 / キーワード: バドミントン・部費・大会）",
  "suggestedNextQueries": ["次の検索候補1", "次の検索候補2"]
}
`;

    const txSummary = transactions.slice(0, 150).map((t: any) => ({
      id: t.id,
      date: t.date,
      amount: t.amount,
      category: t.categoryName,
      group: t.categoryGroup,
      store: t.storeName || '',
      memo: t.memo || '',
      payer: t.payerName || (t.payerRole === 'dad' ? '父' : '母'),
    }));

    const userPrompt = `
基準日: ${currentDate}
ユーザーの検索クエリ: "${searchQuery}"

支出データ一覧（最大150件）:
${JSON.stringify(txSummary, null, 2)}

合致する取引ID一覧と要約をJSONで回答してください。該当なしの場合は matchedIds: [] とその旨の要約を返してください。
`;

    const response = await runWorkersAIText(env, {
      systemInstruction,
      userPrompt,
      temperature: 0.2,
      maxTokens: 1500,
      model: WORKERS_AI_TEXT_MODEL_LARGE,
    });

    const text = response.text || '{}';
    const parsed = extractJson(text);
    return json(parsed);
  } catch (error: any) {
    console.error('Error in smart search:', error);
    // Workers AI 失敗時もローカル分析で返す（生エラーを出さない）。
    return json(generateLocalSmartSearch(data));
  }
}

// 5. Badminton-Specialized Deep AI Analysis Endpoint — logic/prompts copied verbatim from server.ts
async function handleAnalyzeBadminton(data: any, env: Env): Promise<Response> {
  try {
    const {
      totalSpent = 0,
      monthlyAverage = 0,
      breakdown = {},
      monthlyTrend = [],
      recentTransactions = [],
      tournaments = [],
      periodLabel = '全期間',
    } = data;

    const systemInstruction = `
あなたはジュニアバドミントンに情熱を注ぐ娘さん（莉歩ちゃん）を持つ家庭を全力で応援する、温かく愛らしいロップイヤーうさぎの「むぎくん」（専任ファイナンシャルアドバイザー）です。
うさぎらしく愛らしい口調として、文章やアドバイス（headline, annualForecast, gearAdvice, matchAdvice, familyBudgetPlan, cheerMessage, actionList等）の語尾には必ず「〜うさ」「〜だうさ」「〜するうさ」「〜応援してるうさ！🐰」などを自然につけて話してください。
部活動やクラブチームでのバドミントン支出（部費、大会参加費・遠征費、ラケット・シューズ・シャトル・ガット張り替え等の道具代）に特化した、実践的で具体的な分析・アドバイスを提供してください。
子どものスポーツにかける熱意を大切にしつつ、家計の負担を軽減し、突然の出費（遠征やラケット破損・シューズ買い替え）に慌てないための賢い資金計画・買い方のコツを提案してください。

回答は必ず以下のJSONスキーマに従った有効なJSON形式で出力してください：
{
  "headline": "1行の総括（例: 部費は月5,000円で計画通り順調！夏・秋の大会遠征やシューズ更新の波に備えれば万全）",
  "statusLevel": "good" または "warning" または "info",
  "annualForecast": "年間の想定総額とペース評価（部費・大会・道具のバランス解説、2〜3文）",
  "gearAdvice": "ラケット・シューズ・ガット張り替え・シャトル等の道具や消耗品の賢い買い方・節約テクニック（まとめ買い、セール活用、メンテナンス等、2〜3文）",
  "matchAdvice": "大会参加費や遠征費、交通費に関するアドバイス（事前準備、乗り合い、シーズンごとの波の乗り切り方等、2〜3文）",
  "familyBudgetPlan": "夫婦でできるバドミントン資金計画（特別費や積立の活用、予備費の確保など、2〜3文）",
  "cheerMessage": "頑張る莉歩ちゃんと支えるご両親への温かい応援メッセージ（1〜2文）",
  "actionList": [
    "今すぐできるバドミントン費用の最適化アクション1",
    "今すぐできるバドミントン費用の最適化アクション2",
    "今すぐできるバドミントン費用の最適化アクション3"
  ]
}
`;

    const userPrompt = `
【バドミントン支出の集計データ（期間: ${periodLabel}）】
集計期間の総支出: ${totalSpent?.toLocaleString()}円
月平均: ${monthlyAverage?.toLocaleString()}円/月

【費目別内訳】:
- 部費・月謝: ${breakdown?.clubFees?.toLocaleString()}円
- 試合・大会・遠征: ${breakdown?.matches?.toLocaleString()}円
- 道具・消耗品（ラケット・シューズ・ガット等）: ${breakdown?.gear?.toLocaleString()}円
- その他（ドリンク・体育館使用料等）: ${breakdown?.other?.toLocaleString()}円

【参加大会・試合一覧】:
${JSON.stringify(tournaments, null, 2)}

【月別推移データ】:
${JSON.stringify(monthlyTrend, null, 2)}

【直近のバドミントン関連支出明細】:
${JSON.stringify(recentTransactions?.slice(0, 20), null, 2)}

この家庭のバドミントン支出を徹底分析し、莉歩ちゃんの活動を無理なく支え続けるための具体的で温かいアドバイスをJSONで回答してください。
`;

    const response = await runWorkersAIText(env, {
      systemInstruction,
      userPrompt,
      temperature: 0.4,
      maxTokens: 1500,
    });

    const text = response.text || '{}';
    const parsed = extractJson(text);
    return json(parsed);
  } catch (error: any) {
    console.error('Error analyzing badminton:', error);
    // Workers AI 失敗時もローカル分析で返す（生エラーを出さない）。
    return json(generateLocalBadmintonAnalysis(data));
  }
}

// 6. AI Budget Rebalance Endpoint — logic/prompts copied verbatim from server.ts
async function handleRebalanceBudget(data: any, env: Env): Promise<Response> {
  try {
    const {
      scope = 'living',
      referencePeriodLabel = '直近3ヶ月平均',
      categories = [],
      totalCurrentBudget = 0,
      totalActualAverage = 0,
    } = data;

    const systemInstruction = `
あなたは夫婦2人の家計をサポートする、温かく愛らしいロップイヤーうさぎの「むぎくん」（専任ファイナンシャルアドバイザー）です。
うさぎらしく愛らしい口調として、文章やアドバイス（headline, scopeDescription, adviceMessage, keyChangesSummary, 各カテゴリのreason等）の語尾には必ず「〜うさ」「〜だうさ」「〜するうさ」「〜安心うさ🐰」などを自然につけて話してください。
家計の過去の実績（終了した単月や直近3ヶ月などの支出データ）に基づき、無理のない現実的で効果的な「予算のリバランス（再配分）」を行います。

【極めて重要なルール: キリのいい数字にすること】
- 提案する新予算の金額は、必ず人間が管理しやすい「キリのいい数字」（原則1,000円単位、または500円単位。端数や1円単位・10円単位・100円単位は絶対禁止！）に丸めてください。
  例: ○ 32,000円, 15,000円, 8,500円, 50,000円
  例: × 31,420円, 23,874円, 14,980円

【リバランスの基本方針】
1. 指定された適用範囲（scope: "living"=生活変動費内のみ、または "all"=予算全体）のカテゴリを対象に再配分します。
   - scopeが "living" の場合: 対象となる生活変動費（食費・日用品・外食など）の中でメリハリをつけ、固定費や貯蓄は変更しません。
   - scopeが "all" の場合: 全カテゴリを対象に見直します。
2. 毎月予算を大幅にオーバーしているカテゴリ（実績 > 予算）は、罪悪感なく暮らせるよう現実的な金額へ増額（バッファ付与）します。
3. 毎月大幅に余っているカテゴリ（実績 < 予算）や無駄が生じやすいカテゴリは、現実的な水準へスリム化・削減します。
4. 対象範囲の総予算（合計金額）は、できる限り現在の総予算と同等、もしくは少し節約（貯蓄増）につながるバランスを目指します。
5. 莉歩ちゃんのバドミントンや習い事など、子どもの成長に関わるカテゴリは無理に削りすぎず、部費（5,000円）＋遠征や道具代の波を考慮したキリのいい額を設定します。

回答は必ず以下のJSONスキーマに従った有効なJSON形式で出力してください：
{
  "headline": "1行の総括（例: 食費にゆとりを持たせつつ、日用品・外食をスリム化！総予算を変えずに実績にフィットさせました）",
  "scopeDescription": "今回のリバランスの適用範囲と狙い（1〜2文）",
  "proposedCategories": [
    {
      "categoryId": "対象カテゴリID",
      "proposedBudget": 35000,
      "reason": "調整理由（例: 直近の実績が平均3.4万円のため、3.5万円に微増して無理のない枠を確保）"
    }
  ],
  "totalBefore": 180000,
  "totalAfter": 180000,
  "adviceMessage": "夫婦でこの新予算を運用するためのアドバイスや心構え（2〜3文）",
  "keyChangesSummary": [
    "変更のポイント1（例: 食費 +5,000円、日用品 -3,000円で生活感を最適化）",
    "変更のポイント2",
    "変更のポイント3"
  ]
}
`;

    const userPrompt = `
【リバランス設定】
適用範囲: ${scope === 'living' ? '生活変動費内のみ（変動費グループで再配分）' : '予算全体（全カテゴリで再配分）'}
参考にした実績期間: ${referencePeriodLabel}
対象カテゴリの現在予算合計: ${totalCurrentBudget.toLocaleString()}円
対象カテゴリの実績平均合計: ${totalActualAverage.toLocaleString()}円

【カテゴリ一覧と実績データ】:
${JSON.stringify(categories, null, 2)}

上記データに基づき、必ず【1,000円単位または500円単位のキリのいい数字】で、各カテゴリの新予算を提案してください。
`;

    const response = await runWorkersAIText(env, {
      systemInstruction,
      userPrompt,
      temperature: 0.3,
      maxTokens: 1500,
    });

    const text = response.text || '{}';
    const parsed = extractJson(text);

    // Ensure all proposed budgets are rounded to clean integers (multiples of 500/1000)
    if (parsed.proposedCategories && Array.isArray(parsed.proposedCategories)) {
      parsed.proposedCategories = parsed.proposedCategories.map((item: any) => {
        let val = Number(item.proposedBudget) || 0;
        val = Math.round(val / 500) * 500;
        return {
          ...item,
          proposedBudget: Math.max(val, 0),
        };
      });
      parsed.totalAfter = parsed.proposedCategories.reduce((sum: number, c: any) => sum + (c.proposedBudget || 0), 0);
    }

    return json(parsed);
  } catch (error: any) {
    console.error('Error rebalancing budget:', error);
    // Workers AI 失敗時もローカル分析で返す（生エラーを出さない）。
    return json(generateLocalRebalance(data));
  }
}

// --- Import queue (購入連携・登録待ち) — D1 に置く。Firestore は使わない ---
interface PendingImportRow {
  id: string;
  householdId: string;
  source: string;
  orderId: string | null;
  orderDate: string;
  storeName: string | null;
  itemsJson: string;
  totalAmount: number;
  suggestedCategoryName: string | null;
  memo: string | null;
  gmailMessageId: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

function rowToPendingImport(row: PendingImportRow): any {
  let items: any[] = [];
  try {
    items = JSON.parse(row.itemsJson || '[]');
    if (!Array.isArray(items)) items = [];
  } catch {
    items = [];
  }
  return {
    id: row.id,
    householdId: row.householdId,
    source: row.source,
    orderId: row.orderId || '',
    orderDate: row.orderDate,
    storeName: row.storeName || '',
    items,
    totalAmount: row.totalAmount,
    suggestedCategoryName: row.suggestedCategoryName || '',
    memo: row.memo || '',
    gmailMessageId: row.gmailMessageId,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function handleListPendingImports(url: URL, env: Env): Promise<Response> {
  const householdId = url.searchParams.get('householdId');
  if (!householdId) {
    return json({ error: 'householdId が必要です' }, 400);
  }
  const res = await env.DB.prepare(
    `SELECT * FROM pending_imports WHERE householdId = ? AND status = 'pending' ORDER BY orderDate DESC, createdAt DESC`,
  )
    .bind(householdId)
    .all<PendingImportRow>();
  return json({ items: (res.results || []).map(rowToPendingImport) });
}

async function handleCreatePendingImport(data: any, env: Env): Promise<Response> {
  const householdId = typeof data?.householdId === 'string' ? data.householdId.trim() : '';
  const source = typeof data?.source === 'string' ? data.source : '';
  const orderDate = typeof data?.orderDate === 'string' ? data.orderDate : '';
  const totalAmount = Number(data?.totalAmount);
  const gmailMessageId = typeof data?.gmailMessageId === 'string' ? data.gmailMessageId.trim() : '';
  if (!householdId || !source || !orderDate || !Number.isFinite(totalAmount) || !gmailMessageId) {
    return json({ error: 'householdId, source, orderDate, totalAmount, gmailMessageId が必要です' }, 400);
  }
  const id = gmailMessageId;
  const existing = await env.DB.prepare(
    `SELECT id FROM pending_imports WHERE gmailMessageId = ?`,
  )
    .bind(gmailMessageId)
    .first();
  if (existing) {
    return json({ deduped: true, id });
  }
  const now = Date.now();
  const itemsJson = JSON.stringify(Array.isArray(data?.items) ? data.items : []);
  await env.DB.prepare(
    `INSERT INTO pending_imports (id, householdId, source, orderId, orderDate, storeName, itemsJson, totalAmount, suggestedCategoryName, memo, gmailMessageId, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
  )
    .bind(
      id,
      householdId,
      source,
      typeof data?.orderId === 'string' ? data.orderId : '',
      orderDate,
      typeof data?.storeName === 'string' ? data.storeName : '',
      itemsJson,
      Math.round(totalAmount),
      typeof data?.suggestedCategoryName === 'string' ? data.suggestedCategoryName : '',
      typeof data?.memo === 'string' ? data.memo : '',
      gmailMessageId,
      now,
      now,
    )
    .run();
  return json({ ok: true, id });
}

async function handleDeletePendingImport(id: string, env: Env): Promise<Response> {
  await env.DB.prepare(`DELETE FROM pending_imports WHERE id = ?`).bind(id).run();
  return json({ ok: true });
}

const ROUTES: Record<string, (data: any, env: Env) => Promise<Response>> = {
  '/api/ai/analyze-budget': handleAnalyzeBudget,
  '/api/ai/scan-receipt': handleScanReceipt,
  '/api/ai/analyze-category': handleAnalyzeCategory,
  '/api/ai/smart-search': handleSmartSearch,
  '/api/ai/analyze-badminton': handleAnalyzeBadminton,
  '/api/ai/rebalance-budget': handleRebalanceBudget,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api/health')) {
      return withCors(json({ ok: true, service: 'mugi-kakeibo-ai' }), origin);
    }

    // Import queue (購入連携・登録待ち) — D1 経由。AIルートとは別系統。
    if (url.pathname === '/api/import/pending' || url.pathname.startsWith('/api/import/pending/')) {
      // Origin が送られてきた場合のみチェック（curl 等の Origin なしは許可）。
      if (origin && !ALLOWED_ORIGINS.has(origin)) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/import/pending') {
        return withCors(await handleListPendingImports(url, env), origin);
      }
      if (request.method === 'POST' && url.pathname === '/api/import/pending') {
        let data: any = {};
        try {
          data = await request.json();
        } catch {
          data = {};
        }
        return withCors(await handleCreatePendingImport(data, env), origin);
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/api/import/pending/')) {
        const id = decodeURIComponent(url.pathname.slice('/api/import/pending/'.length));
        if (!id) {
          return withCors(json({ error: 'id が必要です' }, 400), origin);
        }
        return withCors(await handleDeletePendingImport(id, env), origin);
      }
      return withCors(json({ error: 'Not found' }, 404), origin);
    }

    const handler = ROUTES[url.pathname];
    if (request.method !== 'POST' || !handler) {
      return withCors(json({ error: 'Not found' }, 404), origin);
    }

    // Origin が送られてきた場合のみチェック（curl 等の Origin なしは許可）。
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let data: any = {};
    try {
      data = await request.json();
    } catch {
      data = {};
    }
    const res = await handler(data, env);
    return withCors(res, origin);
  },
};
