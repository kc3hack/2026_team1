
# DocMate 実装履歴

## 2026-02-18: 初回実装

### 実装した機能
1. **アプリケーション基盤**: VS Code拡張機能の基本構成を作成 (`src` ディレクトリ構造など)。
2. **サービス (Services)**:
    - `DocService`: MDN検索およびコンテンツ取得 (ライブラリ: `jsdom`, `turndownを使用`)。
    - `GeminiService`: AIによる要約・コード生成 (ライブラリ: `@google/generative-ai`を使用)。
    - `ExecutionService`: ローカルNode.js環境でのコード実行 (`child_process`を使用)。
3. **コントローラー**: `DocMateController` を実装し、検索 → 要約 → 実行 → 自動修正のフローを制御。
4. **UI**: `WebviewProvider` を実装し、サイドパネルに結果を表示。
5. **コマンド**: `docmate.explain` コマンドを登録し、右クリックメニューから呼び出せるように設定。
6. **設定**: `docmate.apiKey` (APIキー) と `docmate.model` (モデル名) の設定項目を追加。

### 実行したコマンド (主なもの)
- `npx --package yo --package generator-code -- yo code` (プロジェクトの雛形作成)
    - **選択オプション**:
        - Extension Type: **New Extension (TypeScript)**
        - Bundler: **webpack**
        - Package Manager: **npm**
- `npm install @google/generative-ai jsdom turndown marked` (依存ライブラリのインストール)
- `npm install --save-dev @types/jsdom @types/turndown @types/marked` (型定義ファイルのインストール)
- `npm run compile` (TypeScriptのビルド)

### 発生した問題と対処
1. **ファイル移動時の競合エラー**:
   - *問題*: 初期セットアップ時に `mv` コマンドと `npm install` が並行して走り、ファイルロック等の競合が発生した。
   - *対処*: バックグラウンドプロセスを停止し、`rsync` コマンドを使用して安全にファイルを移動した。

2. **Markedライブラリの互換性**:
   - *問題*: `marked` v12以降はESM専用であり、VS Code拡張機能（CommonJS）で `require` するとエラーになった。
   - *対処*: CommonJSをサポートしている `marked@4` にダウングレード (`npm install marked@4`) した。

3. **Geminiモデルの利用可能性**:
   - *問題*: デフォルト設定の `gemini-1.5-flash` でAPI呼び出しを行うと404エラーが発生した（APIバージョンの違いや地域制限の可能性）。
   - *対処*: 利用可能な `gemini-2.5-flash` にデフォルトモデルを変更し、設定ファイル (`package.json`) とコードを更新した。

4. **Webviewのセキュリティ**:
   - *対処*: 外部スクリプトやスタイルの読み込みを制限し、基本的なCSP (Content Security Policy) に準拠する形にした（スタイルはインラインで記述）。

## 2026-02-18: 対話型サンドボックス機能の実装

### 実装した機能
1. **複数サンプルコードの対応**:
   - `GeminiService` のプロンプトを改修し、単一のコードではなく `examples` 配列（タイトル、説明、コード）を含むJSON形式でレスポンスを受け取るように変更。

2.  **Google Colab風UI (Webview)**:
   - `WebviewProvider` を大幅に改修。各サンプルコードを独立した「セル」として表示。
   - コードエディタ（textarea）、実行ボタン、実行結果表示エリア（トグル開閉式）をセットにしたUIを実装。
   - 実行結果エリアはデフォルトで折りたたまれ、実行時またはクリック時に展開される仕様とした。

3.  **対話的なコード実行**:
   - Webview内の「Run」ボタンから、編集後のコードを拡張機能本体に送信 (`postMessage`) する仕組みを実装。
   - `DocMateController` に `runCode` メソッドを追加し、受け取ったコードを即座に実行して結果を返すようにした。
   - これにより、ユーザーはサンプルコードを自由に書き換えて試行錯誤できるようになった。

## 2026-02-21: 多言語対応に向けた調査とデバッグ実装

### 実装した機能
1. **デバッグ用スクリプトの作成**:
   - `src/debug_jsdom.ts` を作成し、MDN以外のドキュメントサイト（Python, Javaなど）のHTML構造や検索結果をJSDOMでパースしてMarkdown化する挙動を手元で素早くテストできるようにした。
   - 言語別（`languageId`ごと）に検索先やセレクタを振り分けるロジックの基盤となる知識を得た。

### 調査から得られた重要な知見 (今後の多言語対応に向けて)
- **Python / Java の公式検索ページの仕様**:
  - `docs.python.org/search.html` や `docs.oracle.com/.../search.html` のような検索ページは、検索結果のリストをサーバーサイドで静的なHTMLとして返すのではなく、クライアントサイドのJavaScriptを使って動的に描画する仕様になっている。
  - そのため、JSDOMのような静的なパーサーで単純にURLを読み込んでも「JavaScriptを有効にしてください」といったメッセージしか取得できず、検索結果のリンク一覧を取得することができない。
- **今後のAPI選定の方針**:
  - MDNのように `api/v1/search` という扱いやすい専用APIを提供してくれているサイトは実は少数派である。
  - 多言語対応を本格的に進める場合、各公式サイトのスクレイピングに依存するとJS必須のサイトで詰むため、**DuckDuckGo API** のサイト内検索や、全言語のドキュメントをJSONで返してくれる **DevDocs API** のような汎用的な検索APIの導入を検討する必要がある。
## 2026-02-21: DevDocs APIの統合と多言語対応の強化

### 実装した機能
1. **DevDocs APIの連携**:
   - MDNで提供されていない言語（Python, Java, C, C++, Go, PHP, Ruby, Rust, Kotlin, Dart）のドキュメント検索のために、**DevDocs API** (`https://devdocs.io/docs/{slug}/index.json`) を `docService.ts` に統合した。
   - `devDocsSlugs` 言語マップを作成し、各言語とDevDocs上の最新バージョンslug（例: `python~3.14`, `openjdk~25`）を紐付けた。
   - C#はDevDocsに存在しないためサポート対象外とし、Swiftは現在未提供であることを確認した。

2. **ハッシュベースの正確なHTML抽出**:
   - `fetchContent` メソッドを拡張し、DevDocsのURLに含まれるハッシュ値（例: `#print`）を利用して、ページ全体ではなく**目的のクラスや関数の定義部分（`<dt>`）とその説明部分（直後の`<dd>`要素など）のみをピンポイントで抽出**するロジックを実装した。
   - 不要なサイドバーなどを削除する `querySelectorAll` 処理を JSDOM のパースエラー回避のために `try...catch` で保護した。

3. **React / Vue などのハイブリッド言語のフォールバック検索**:
   - `javascriptreact` (React) や `vue` ファイルにおいて、`useState` などの特有のAPIはDevDocs(React/Vue)から正常に引けるように設定した。
   - しかし `const` や `map` などの「JavaScriptの標準機能」を検索した際にReact/Vueの辞書でエラー（null）になる仕様上の落とし穴を解決するため、**「React/Vueの辞書で見つからなかった場合、自動的に言語設定を 'javascript' に書き換えてMDNに再検索（再帰処理）しにいく最強のフォールバック仕組み」** を導入した。

4. **未対応言語と通知のUX改善**:
   - 対応していない言語（例: `plaintext`）の検索が走った際に、単に結果なし（null）を返すのではなく `throw new Error` で明示的に弾くように修正。
   - `docMateController.ts` のプログレス通知のメッセージを `Searching MDN ...` から汎用的な `Searching documentation ...` に変更し、DevDocs検索時にも違和感がないように改善した。
