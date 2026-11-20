// むぎくんのお財布 — AI Worker (Cloudflare Workers)
// server.ts の AI 6エンドポイントを Gemini REST 呼び出しで再現したもの。
// プロンプト・JSONスキーマ・後処理は server.ts から verbatim で移植。
// APIキーはコードに書かず、Worker シークレット env.GEMINI_API_KEY から読む。
// wrangler.toml は使わない（親が cf.py ヘルパーで直接アップロードする）。
import { MUGI_PERSONALITIES, MugiPersonality } from '../src/src/utils/mugiPersonalities';
import { generateInstantBudgetAnalysis } from '../src/src/utils/mugiLocalAnalysis';

export interface Env {
  GEMINI_API_KEY?: string;
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

// --- Gemini REST caller (replaces the GenAI SDK) ---
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];

function buildGeminiBody(params: { contents: any; config?: any }): any {
  const contents = params.contents;
  let normalized: any[];
  if (typeof contents === 'string') {
    normalized = [{ role: 'user', parts: [{ text: contents }] }];
  } else if (Array.isArray(contents)) {
    normalized = contents;
  } else {
    normalized = [{ role: 'user', parts: [{ text: String(contents ?? '') }] }];
  }
  const body: any = { contents: normalized };
  const config = params.config || {};
  if (config.systemInstruction) {
    body.system_instruction = { parts: [{ text: config.systemInstruction }] };
  }
  const generationConfig: any = {};
  if (config.responseMimeType) generationConfig.responseMimeType = config.responseMimeType;
  if (typeof config.temperature === 'number') generationConfig.temperature = config.temperature;
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

// Generate content with fast timeout and model fallback cascade
async function generateContentWithFallback(
  apiKey: string,
  params: {
    contents: any;
    config?: any;
    timeoutMs?: number;
  },
): Promise<{ text: string }> {
  const timeoutMs = params.timeoutMs || 3000;
  // Use fast, active models with high quota availability and 1-2s response times
  const models = GEMINI_MODELS;
  let lastError: any = null;

  for (const model of models) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'aistudio-build',
          },
          body: JSON.stringify(buildGeminiBody(params)),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        // Throw the raw error body so formatErrorMessage can extract
        // error.message and detect 503/429, exactly like the SDK errors.
        const t = await res.text().catch(() => '');
        throw new Error(t || `Gemini API error: ${res.status}`);
      }
      const data: any = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? [])
        .map((p: any) => (typeof p?.text === 'string' ? p.text : ''))
        .join('');
      if (text) {
        return { text };
      }
      throw new Error('Empty response from Gemini');
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);
      console.warn(`[Gemini Fast Cascade] Model ${model} failed (${msg.substring(0, 120)}), trying next model...`);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('All AI models failed or timed out');
}

// 1. AI Budget Analysis Endpoint — logic/prompts copied verbatim from server.ts
async function handleAnalyzeBudget(data: any, apiKey: string): Promise<Response> {
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

    const response = await generateContentWithFallback(apiKey, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.4,
      },
      timeoutMs: 3000,
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
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

// 2. Receipt OCR / Scan with Gemini Endpoint — logic/prompts copied verbatim from server.ts
async function handleScanReceipt(data: any, apiKey: string): Promise<Response> {
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

    const response = await generateContentWithFallback(apiKey, {
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType,
              },
            },
            {
              text: prompt,
            },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
    return json(parsed);
  } catch (error: any) {
    console.error('Error scanning receipt:', error);
    return json({ error: formatErrorMessage(error) }, 500);
  }
}

// 3. Category Deep Dive AI Analysis Endpoint — logic/prompts copied verbatim from server.ts
async function handleAnalyzeCategory(data: any, apiKey: string): Promise<Response> {
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

    const response = await generateContentWithFallback(apiKey, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.4,
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
    return json(parsed);
  } catch (error: any) {
    console.error('Error analyzing category:', error);
    return json({ error: formatErrorMessage(error) }, 500);
  }
}

// 4. AI Natural Language Smart Search Endpoint — logic/prompts copied verbatim from server.ts
async function handleSmartSearch(data: any, apiKey: string): Promise<Response> {
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

    const response = await generateContentWithFallback(apiKey, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.2,
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
    return json(parsed);
  } catch (error: any) {
    console.error('Error in smart search:', error);
    return json({ error: formatErrorMessage(error) }, 500);
  }
}

// 5. Badminton-Specialized Deep AI Analysis Endpoint — logic/prompts copied verbatim from server.ts
async function handleAnalyzeBadminton(data: any, apiKey: string): Promise<Response> {
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

    const response = await generateContentWithFallback(apiKey, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.4,
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);
    return json(parsed);
  } catch (error: any) {
    console.error('Error analyzing badminton:', error);
    return json({ error: formatErrorMessage(error) }, 500);
  }
}

// 6. AI Budget Rebalance Endpoint — logic/prompts copied verbatim from server.ts
async function handleRebalanceBudget(data: any, apiKey: string): Promise<Response> {
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

    const response = await generateContentWithFallback(apiKey, {
      contents: userPrompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        temperature: 0.3,
      },
    });

    const text = response.text || '{}';
    const parsed = JSON.parse(text);

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
    return json({ error: formatErrorMessage(error) }, 500);
  }
}

const ROUTES: Record<string, (data: any, apiKey: string) => Promise<Response>> = {
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
    const res = await handler(data, env.GEMINI_API_KEY ?? '');
    return withCors(res, origin);
  },
};
