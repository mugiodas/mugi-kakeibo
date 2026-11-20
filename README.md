# むぎくんのお財布

夫婦共有・家計簿アプリ「むぎくんのお財布」の公開版です。

- 公開URL: https://mugiodas.github.io/mugi-kakeibo/
- 構成: GitHub Pages（静的配信）+ Cloudflare Workers（AIサーバー）+ Firebase（データ共有）
- AIサーバー: https://mugi-kakeibo-ai.smashstats.workers.dev （Worker ソースは `worker/index.ts`）
- アプリ本体のソース（React + Vite）は `~/workspace/mugi-kakeibo/src/` にあり、ここにはビルド済みの `dist` を置いています。更新時はソースで変更して `npm run build`（`VITE_AI_API_URL` 付き）し直して `dist` を差し替えます。
- AI機能には Gemini API キーが必要です。キーは Worker のシークレットに設定してあり、リポジトリには含めません。
