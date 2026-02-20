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

  // ── エディタ高さ計算ユーティリティ ──────────────────────────
  //  CSS の --md-editor-* トークンと合わせる
  const EDITOR_LINE_HEIGHT = 21;   // px  (monaco fontSize:13 + 余白)
  const EDITOR_PADDING_V   = 8;    // px  (上下パディング合計の半分)
  const EDITOR_MIN_LINES   = 4;
  const EDITOR_MAX_LINES   = 30;

  /**
   * コード文字列の行数からエディタの最適な高さ (px) を計算する。
   * min: EDITOR_MIN_LINES, max: EDITOR_MAX_LINES でクランプ。
   */
  function calcEditorHeight(code) {
    const lines = (code || '').split('\n').length;
    const clamped = Math.max(EDITOR_MIN_LINES, Math.min(EDITOR_MAX_LINES, lines));
    return clamped * EDITOR_LINE_HEIGHT + EDITOR_PADDING_V * 2;
  }

  /**
   * エディタコンテナの高さを更新し、Monaco の layout() を呼んで再描画させる。
   * @param {HTMLElement} containerEl  .sb-editor 要素
   * @param {object|null} monacoRef    { editor } | null
   * @param {string}      code         現在のコード文字列
   */
  function updateEditorHeight(containerEl, monacoRef, code) {
    if (!containerEl) return;
    const h = calcEditorHeight(code);
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

    const index = rootEl.getAttribute('data-index') || rootEl.id || `auto-${Math.random().toString(36).slice(2)}`;
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
    updateEditorHeight(editorContainer, null, initialCode);

    // populate languages
    const LANG_CONFIG = window.LANG_CONFIG || {};
    const langs = Object.keys(LANG_CONFIG).length ? Object.keys(LANG_CONFIG) : ['javascript'];
    langSelect.innerHTML = '';
    langs.forEach(l => {
      const o = document.createElement('option');
      o.value = l; o.textContent = l;
      langSelect.appendChild(o);
    });
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
          updateEditorHeight(editorContainer, monacoRef, initialCode);
        } catch (_) {}
      } else {
        editorContainer.textContent = initialCode;
        updateEditorHeight(editorContainer, null, initialCode);
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
          updateEditorHeight(editorContainer, monacoRef, val);
        } catch (e) {
          console.warn('[sandbox_init] failed to set model value:', e);
        }

        // ── コンテンツ変更時に高さをリアルタイム更新 ──────────
        monacoRef.model.onDidChangeContent(() => {
          try {
            const code = monacoRef.model.getValue();
            updateEditorHeight(editorContainer, monacoRef, code);
          } catch (_) {}
        });
      })
      .catch(e => {
        console.warn('[sandbox_init] Monaco load failed (non-fatal):', e);
      });
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
      if (msg.stdout) cells.forEach(c => c.append(msg.stdout));
      if (msg.stderr) cells.forEach(c => c.append(msg.stderr));
      return;
    }
    if (msg.kind === 'exit') {
      cells.forEach(c => c.append(`\n[process exited, code=${msg.code}, signal=${msg.signal}]\n`));
      cells.forEach((c, idx) => restoreRunBtn(idx));
      return;
    }
    if (msg.kind === 'status') {
      cells.forEach(c => c.append(`[status] ${msg.text}\n`));
      return;
    }
    if (msg.kind === 'error' && msg.text) {
      cells.forEach(c => c.append(`[error] ${msg.text}\n`));
      cells.forEach((c, idx) => restoreRunBtn(idx));
      return;
    }
  });

})();