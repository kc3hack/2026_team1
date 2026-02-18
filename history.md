
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