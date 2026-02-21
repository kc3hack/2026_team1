// sandbox_init.js (auto-observe + manual trigger)
// - 既に読み込まれている場合は即初期化
// - 後で DOM に挿入される #sandbox-root-<n> / .sandbox-embed を監視して初期化
// - window.__sandbox_init() を公開して手動初期化も可能

(() => {
  // --- safe acquire VS Code API ---
  function safeAcquireVsCodeApi() {
    try {
      if (window.__vscodeApi) return window.__vscodeApi;
      if (typeof acquireVsCodeApi === "function") {
        try {
          const api = acquireVsCodeApi();
          window.__vscodeApi = api;
          return api;
        } catch (e) {
          return window.__vscodeApi || null;
        }
      }
    } catch (e) { return window.__vscodeApi || null; }
    return null;
  }
  const vscodeApi = safeAcquireVsCodeApi();

  // --- internal storage ---
  const cells = new Map();
  window.__sandbox_cells = cells;

  /** 現在実行中のセルの index を記録する（stream/exit を正しいセルに届けるため） */
  let activeIndex = null;

  // ── エディタ高さ計算ユーティリティ ──────────────────────────
  //  CSS の --md-editor-* トークンと合わせる
  const EDITOR_LINE_HEIGHT = 24;   // px  (monaco fontSize:13 + 余白)
  const EDITOR_PADDING_V   = 6;    // px  (上下パディング合計の半分)
  const EDITOR_MIN_LINES   = 4;
  const EDITOR_MAX_LINES   = 30;

  /**
   * コード文字列の行数からエディタの最適な高さ (px) を計算する。
   * min: EDITOR_MIN_LINES, max: EDITOR_MAX_LINES でクランプ。
   */
  function calcEditorHeight(code, isModal) {
    const lines = (code || '').split('\n').length;
    const clamped = isModal ? Math.max(EDITOR_MIN_LINES, lines) : Math.max(EDITOR_MIN_LINES, Math.min(EDITOR_MAX_LINES, lines))
    return clamped * EDITOR_LINE_HEIGHT + EDITOR_PADDING_V * 2;
  }

  /**
   * エディタコンテナの高さを更新し、Monaco の layout() を呼んで再描画させる。
   * @param {HTMLElement} containerEl  .sb-editor 要素
   * @param {object|null} monacoRef    { editor } | null
   * @param {string}      code         現在のコード文字列
   */
  /**
   * エディタコンテナの高さを更新する。
   * isModal が true の場合は常に MAX 行数の高さを使う。
   */
  function updateEditorHeight(containerEl, monacoRef, code, isModal) {
    if (!containerEl) return;
    const h = calcEditorHeight(code, isModal);
    containerEl.style.height = h + 'px';
    // Monaco に新しいサイズを伝える
    if (monacoRef && monacoRef.editor) {
      try { monacoRef.editor.layout(); } catch (_) {}
    }
  }

  // --- helper utilities ---
  function findEmbedRootsIn(node = document) {
    const roots = [];
    const single = node.getElementById ? node.getElementById("sandbox-root") : null;
    if (single) roots.push(single);

    const idMatches = node.querySelectorAll ? node.querySelectorAll('[id]') : [];
    idMatches.forEach(el => {
      if (el.id && /^sandbox-root(-\d+)?$/.test(el.id) || /^sandbox-root-\d+$/.test(el.id)) {
        if (!roots.includes(el)) roots.push(el);
      }
    });

    const classRoots = node.querySelectorAll ? node.querySelectorAll('.sandbox-embed') : [];
    classRoots.forEach(el => { if (!roots.includes(el)) roots.push(el); });

    return roots;
  }

  function decodeInitialCode(raw) {
    if (!raw) return '';
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  // --- create UI per root ---
  function initCell(rootEl) {
    // monacoRef はオブジェクトで持つことで updateEditorHeight から参照できる
    const monacoRef = { editor: null, model: null };

    if (!rootEl) return;
    const existing = rootEl.getAttribute('data-sandbox-initialized');
    if (existing === '1') return;

    const index   = rootEl.getAttribute('data-index') || rootEl.id || `auto-${Math.random().toString(36).slice(2)}`;
    const isModal = rootEl.getAttribute('data-is-modal') === '1';
    rootEl.setAttribute('data-sandbox-initialized', '1');

    const initialRaw = rootEl.getAttribute('data-initial-code') || '';
    const initialCode = decodeInitialCode(initialRaw);

    // ---- UI skeleton ----
    rootEl.innerHTML = `
      <div class="sandbox-ui" data-index="${index}">

        <div class="sandbox-toolbar">
          <select class="sb-langSelect"></select>
          <button class="sb-runBtn">▶ Run</button>
          <button class="sb-loadBtn">↺ Load Template</button>
        </div>

        <div class="sb-cmd-area">
          <textarea class="sb-execCommand" placeholder="実行コマンド（{file} にファイルパスが展開されます）"></textarea>
        </div>

        <div class="sb-editor"></div>

        <div class="sb-output">
          <div class="output-header">Output</div>
          <pre class="output-area"></pre>
        </div>

      </div>
    `;

    // UI refs
    const langSelect      = rootEl.querySelector('.sb-langSelect');
    const runBtn          = rootEl.querySelector('.sb-runBtn');
    const loadBtn         = rootEl.querySelector('.sb-loadBtn');
    const execTextarea    = rootEl.querySelector('.sb-execCommand');
    const editorContainer = rootEl.querySelector('.sb-editor');
    const outputPre       = rootEl.querySelector('.output-area');

    // ── 初期高さをコード行数から計算して即セット ──────────────
    updateEditorHeight(editorContainer, null, initialCode, isModal);

    // populate languages
    const LANG_CONFIG = window.LANG_CONFIG || {};
    const langs = Object.keys(LANG_CONFIG).length ? Object.keys(LANG_CONFIG) : ['javascript'];
    langSelect.innerHTML = '';
    langs.forEach(l => {
      const o = document.createElement('option');
      o.value = l; o.textContent = l;
      langSelect.appendChild(o);
    });

    // ── Map the current VSCode language to our sandbox config keys ──
    let targetLang = window.CURRENT_LANG || langs[0];
    const langMap = {
      'typescriptreact': 'typescript',
      'javascriptreact': 'javascript',
      'vue': 'javascript'
    };
    targetLang = langMap[targetLang] || targetLang;

    // If mapped language isn't in LANG_CONFIG, fallback to the first available
    if (!LANG_CONFIG[targetLang]) {
      targetLang = langs[0];
    }
    langSelect.value = targetLang;

    const curLang = langSelect.value || langs[0];
    execTextarea.value = (LANG_CONFIG[curLang] && LANG_CONFIG[curLang].command) || '';

    // 言語切り替え時にコマンドも更新
    langSelect.addEventListener('change', () => {
      const selected = langSelect.value;
      execTextarea.value = (LANG_CONFIG[selected] && LANG_CONFIG[selected].command) || '';
    });

    // cell object
    const cellObj = {
      rootEl,
      index: String(index),
      outputEl: outputPre,
      append(s) {
        if (outputPre) {
          outputPre.textContent += String(s);
          outputPre.scrollTop = outputPre.scrollHeight;
        }
      }
    };
    cells.set(String(index), cellObj);

    // ---- Load Template（初期コードに戻す） ----
    loadBtn.addEventListener('click', () => {
      if (monacoRef.model) {
        try {
          monacoRef.model.setValue(initialCode);
          updateEditorHeight(editorContainer, monacoRef, initialCode, isModal);
        } catch (_) {}
      } else {
        editorContainer.textContent = initialCode;
        updateEditorHeight(editorContainer, null, initialCode, isModal);
      }
    });

    // ---- Run ----
    runBtn.addEventListener('click', () => {
      let code = '';
      if (monacoRef.model) {
        try { code = monacoRef.model.getValue(); } catch (_) {}
      }
      if (!code) code = editorContainer.textContent || '';

      const execCommand = execTextarea ? execTextarea.value : '';

      if (outputPre) outputPre.textContent = '';

      runBtn.disabled = true;
      runBtn.textContent = '… Running';

      const payload = {
        command: 'run',
        language: langSelect.value,
        code,
        execCommand,
        index
      };
      activeIndex = String(index);
      if (vscodeApi) vscodeApi.postMessage(payload);
    });

    // ---- Monaco loader ----
    tryLoadMonaco(editorContainer, initialCode, curLang)
      .then(res => {
        monacoRef.editor = res.editor;
        monacoRef.model  = res.model;

        // 初期値をセット
        try {
          const val = initialCode
            || (LANG_CONFIG[curLang] && LANG_CONFIG[curLang].templatecode)
            || '';
          monacoRef.model.setValue(val);
          // Monaco 描画後に再度高さ調整
          updateEditorHeight(editorContainer, monacoRef, val, isModal);
        } catch (e) {
          console.warn('[sandbox_init] failed to set model value:', e);
        }

        // ── コンテンツ変更時に高さをリアルタイム更新 ──────────
        monacoRef.model.onDidChangeContent(() => {
          try {
            const code = monacoRef.model.getValue();
            updateEditorHeight(editorContainer, monacoRef, code, isModal);
          } catch (_) {}
        });
      })
      .catch(e => {
        console.warn('[sandbox_init] Monaco load failed (non-fatal):', e);
      });
    // ── ヘッダークリックでモーダルを開くリスナーを登録 ──
    attachHeaderClickListener(rootEl);
  }

  // Monaco loader — overflow:hidden コンテナでも正しくレイアウトされるよう
  // automaticLayout: true にしてリサイズ対応
  function tryLoadMonaco(containerEl, code, lang) {
    return new Promise((resolve, reject) => {
      if (!containerEl) return reject(new Error('no container'));

      function createEditor(mon) {
        const monLang = lang === 'typescript' ? 'typescript' : 'javascript';
        const model = mon.editor.createModel(code || '', monLang);
        const editor = mon.editor.create(containerEl, {
          model,
          automaticLayout: true,
          theme: 'vs-dark',
          fontSize: 13,
          lineHeight: 20,
          lineNumbers: 'on',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          overviewRulerLanes: 0,
          scrollbar: {
            verticalScrollbarSize: 6,
            horizontalScrollbarSize: 6,
            alwaysConsumeMouseWheel: false,
            // 高さが可変なのでスクロールバーを非表示にする
            vertical: 'hidden',
          },
          padding: { top: 8, bottom: 8 },
          // コンテナ高さ = コード行数なのでスクロールなしで全行表示できる
          wordWrap: 'on',
        });
        return { mon, model, editor };
      }

      if (window.monaco) {
        return resolve(createEditor(window.monaco));
      }

      if (document.querySelector('script[data-monaco-loader]')) {
        let tries = 0;
        const wait = setInterval(() => {
          if (window.monaco) { clearInterval(wait); resolve(createEditor(window.monaco)); }
          if (++tries > 50) { clearInterval(wait); reject(new Error('monaco timeout')); }
        }, 200);
        return;
      }

      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js';
      s.setAttribute('data-monaco-loader', '1');
      s.onload = () => {
        const base = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.39.0/min';
        try {
          window.require.config({ paths: { vs: base + '/vs' } });
          window.MonacoEnvironment = {
            getWorkerUrl() {
              const blob = new Blob(
                [`self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}/vs/base/worker/workerMain.js');`],
                { type: 'text/javascript' }
              );
              return URL.createObjectURL(blob);
            }
          };
          window.require(['vs/editor/editor.main'], () => {
            try { resolve(createEditor(window.monaco)); } catch (e) { reject(e); }
          }, reject);
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('require.js load failed'));
      document.head.appendChild(s);
    });
  }

  // --- initialization ---
  function initExistingRoots() {
    const roots = findEmbedRootsIn(document);
    if (!roots || roots.length === 0) return false;
    roots.forEach(r => initCell(r));
    return true;
  }

  window.__sandbox_init = function () {
    try {
      const ok = initExistingRoots();
      if (!ok) findEmbedRootsIn(document).forEach(r => initCell(r));
      return true;
    } catch (e) { console.warn('manual __sandbox_init failed', e); return false; }
  };

  const didInit = initExistingRoots();

  if (!didInit && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.matches && (
            node.matches('#sandbox-root') ||
            node.matches('[id^="sandbox-root"]') ||
            node.classList.contains('sandbox-embed')
          )) { initCell(node); }
          findEmbedRootsIn(node).forEach(r => initCell(r));
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { try { window.__sandbox_init(); } catch (e) {} }, 500);
  }

  // ── モーダルシステム ────────────────────────────────────────
  //
  // .example-header クリック → モーダルを開く
  // モーダル内に新規サンドボックスを初期化し、元セルのコードを引き継ぐ
  // オーバーレイクリック / Esc / 閉じるボタン → モーダルを閉じる
  // -------------------------------------------------------

  /** モーダルオーバーレイ DOM（1つだけ生成して使い回す） */
  let modalOverlay = null;
  let modalCard    = null;

  function ensureModal() {
    if (modalOverlay) return;

    modalOverlay = document.createElement('div');
    modalOverlay.className = 'dm-modal-overlay';

    modalCard = document.createElement('div');
    modalCard.className = 'dm-modal-card';

    modalOverlay.appendChild(modalCard);
    document.body.appendChild(modalOverlay);

    // オーバーレイ（カード外）クリックで閉じる
    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) closeModal();
    });

    // Esc キーで閉じる
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  }

  function openModal(sourceRoot) {
    ensureModal();

    // 元セルからタイトル・説明・初期コードを取得
    const cell     = sourceRoot.closest('.example-cell');
    const titleEl  = cell ? cell.querySelector('.example-header strong')      : null;
    const descEl   = cell ? cell.querySelector('.example-header .description') : null;
    const title    = titleEl ? titleEl.textContent : '';
    const desc     = descEl  ? descEl.textContent  : '';
    const initialRaw = sourceRoot.getAttribute('data-initial-code') || '';
    const srcIndex   = sourceRoot.getAttribute('data-index') || '0';
    const modalIndex = `modal-${srcIndex}`;

    // カード内 HTML を構築
    // .dm-modal-body がスクロールコンテナになる
    modalCard.innerHTML = `
      <div class="dm-modal-header">
        <div class="dm-modal-header-text">
          <strong>${title}</strong>
          ${desc ? `<div class="description">${desc}</div>` : ''}
        </div>
        <button class="dm-modal-close" title="閉じる">&#x2715;</button>
      </div>
      <div class="dm-modal-body">
        <div
          id="sandbox-root-${modalIndex}"
          class="sandbox-embed"
          data-initial-code="${initialRaw}"
          data-index="${modalIndex}"
          data-is-modal="1"
        ></div>
      </div>
    `;

    // 閉じるボタン
    modalCard.querySelector('.dm-modal-close').addEventListener('click', closeModal);

    // モーダルを表示してからサンドボックスを初期化
    modalOverlay.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    // 少し遅延させて DOM が確定してから初期化
    requestAnimationFrame(() => {
      const newRoot = document.getElementById(`sandbox-root-${modalIndex}`);
      if (newRoot) initCell(newRoot);
    });
  }

  function closeModal() {
    if (!modalOverlay) return;
    modalOverlay.classList.remove('is-open');
    document.body.style.overflow = '';

    // モーダル内の Monaco インスタンスをクリーンアップ（メモリリーク防止）
    if (modalCard) {
      const idx = (() => {
        const el = modalCard.querySelector('[data-index]');
        return el ? el.getAttribute('data-index') : null;
      })();
      if (idx) cells.delete(String(idx));
      try {
        if (window.monaco) {
          window.monaco.editor.getModels().forEach(m => {
            if (m.uri.toString().includes('modal')) m.dispose();
          });
        }
      } catch (_) {}
      modalCard.innerHTML = '';
    }
  }

  /** .example-header へのクリックリスナーを登録（initCell 完了後に呼ぶ） */
  function attachHeaderClickListener(rootEl) {
    const cell   = rootEl.closest('.example-cell');
    if (!cell) return;
    const header = cell.querySelector('.example-header');
    if (!header || header.dataset.dmModal) return;
    header.dataset.dmModal = '1';
    header.addEventListener('click', () => openModal(rootEl));
  }

  // ---- メッセージルーティング（extension → webview） ----
  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};

    function restoreRunBtn(index) {
      const root = document.getElementById(`sandbox-root-${index}`)
        || document.querySelector(`[data-index="${index}"]`);
      if (!root) return;
      const btn = root.querySelector('.sb-runBtn');
      if (btn) { btn.disabled = false; btn.textContent = '▶ Run'; }
    }

    if (msg.command === 'result' && typeof msg.index !== 'undefined') {
      const index = String(msg.index);
      const c = cells.get(index);
      if (c && c.append) c.append(msg.output || '');
      else {
        const fallback = document.getElementById(`sandbox-root-${index}`);
        if (fallback) {
          const out = fallback.querySelector('.output-area');
          if (out) out.textContent = (out.textContent || '') + (msg.output || '');
        }
      }
      restoreRunBtn(msg.index);
      return;
    }
    if (msg.kind === 'stream') {
      const ac = activeIndex !== null ? cells.get(activeIndex) : null;
      if (ac) {
        if (msg.stdout) ac.append(msg.stdout);
        if (msg.stderr) ac.append(msg.stderr);
      }
      return;
    }
    if (msg.kind === 'exit') {
      const ac = activeIndex !== null ? cells.get(activeIndex) : null;
      if (ac) ac.append(`\n[process exited, code=${msg.code}, signal=${msg.signal}]\n`);
      if (activeIndex !== null) restoreRunBtn(activeIndex);
      activeIndex = null;
      return;
    }
    if (msg.kind === 'status') {
      const ac = activeIndex !== null ? cells.get(activeIndex) : null;
      if (ac) ac.append(`[status] ${msg.text}\n`);
      return;
    }
    if (msg.kind === 'error' && msg.text) {
      const ac = activeIndex !== null ? cells.get(activeIndex) : null;
      if (ac) ac.append(`[error] ${msg.text}\n`);
      if (activeIndex !== null) restoreRunBtn(activeIndex);
      activeIndex = null;
      return;
    }
  });

})();