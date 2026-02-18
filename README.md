
# DocMate (ドックメイト)

DocMateは、MDN Web Docsのドキュメントを検索し、AI (Google Gemini) を利用して日本語の要約と実行可能なサンプルコードを提供するVS Code拡張機能です。

## 機能 (Features)

- **ドキュメント解説**: 選択したキーワード（例: `Array.map`）について、MDNのドキュメントを検索し、要約を表示します。
- **実行可能なサンプルコード**: AIが生成したサンプルコードを、拡張機能内で直接実行し、結果を確認できます。
- **自動修正**: コードの実行に失敗した場合、AIがエラー内容を分析し、自動的にコードの修正を試みます。

## 必要条件 (Requirements)

- **Google Gemini APIキー**: この拡張機能を使用するには、Google AI StudioからAPIキーを取得する必要があります。

## 拡張機能の設定 (Extension Settings)

この拡張機能は以下の設定を提供します：

* `docmate.apiKey`: Google Gemini APIキーを設定します。(必須)
* `docmate.model`: 使用するGeminiモデルを指定します。(デフォルト: `gemini-2.5-flash`)

## 使い方 (Usage)

1.  JavaScript/TypeScriptファイルを開きます。
2.  調べたいメソッドやオブジェクト（例: `Array.map`）を選択します。
3.  右クリックメニューから **"DocMate: Explain"** を選択するか、コマンドパレット (`Cmd+Shift+P`) から **"DocMate: Explain"** を実行します。
4.  右側にパネルが開き、要約・サンプルコード・実行結果が表示されます。

## 既知の問題 (Known Issues)

- 現在、JavaScript/TypeScript環境 (Node.js) での実行のみをサポートしています。
- 複雑なDOM操作やブラウザ固有のAPIを含むコードは、Node.js環境では動作しない場合があります。

## リリースノート (Release Notes)

### 0.0.1

- 初回リリース
- MDN検索、Geminiによる要約、ローカルコード実行機能を実装
