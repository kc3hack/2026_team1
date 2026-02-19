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
          // 競合している場合などに備える
          return window.__vscodeApi || null;
        }
      }
    } catch (e) { return window.__vscodeApi || null; }
    return null;
  }
  const vscodeApi = safeAcquireVsCodeApi();

  // --- internal storage ---
  const cells = new Map();
  window.__sandbox_cells = cells; // for debug

  // --- helper utilities ---
  function findEmbedRootsIn(node = document) {
    const roots = [];
    const single = node.getElementById ? node.getElementById("sandbox-root") : null;
    if (single) roots.push(single);

    // id pattern sandbox-root-N
    const idMatches = node.querySelectorAll ? node.querySelectorAll('[id]') : [];
    idMatches.forEach(el => {
      if (el.id && /^sandbox-root(-\d+)?$/.test(el.id) || /^sandbox-root-\d+$/.test(el.id)) {
        if (!roots.includes(el)) roots.push(el);
      }
    });

    // class .sandbox-embed
    const classRoots = node.querySelectorAll ? node.querySelectorAll('.sandbox-embed') : [];
    classRoots.forEach(el => { if (!roots.includes(el)) roots.push(el); });

    return roots;
  }

  function decodeInitialCode(raw) {
    if (!raw) return '';
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }

  // --- create simple UI per root (keeps minimal, uses Monaco if available later) ---
  function initCell(rootEl) {

    let monacoInstance = null;

    if (!rootEl) return;
    const existing = rootEl.getAttribute('data-sandbox-initialized');
    if (existing === '1') return;

    const index = rootEl.getAttribute('data-index') || rootEl.id || `auto-${Math.random().toString(36).slice(2)}`;

    // mark initialized
    rootEl.setAttribute('data-sandbox-initialized', '1');

    const initialRaw = rootEl.getAttribute('data-initial-code') || '';
    const initialCode = decodeInitialCode(initialRaw);

    // build minimal skeleton (Monaco loader can later replace the editor area)
    rootEl.innerHTML = `
      <div class="sandbox-ui" data-index="${index}">
        <div class="sandbox-toolbar">
          <select class="sb-langSelect"></select>
          <button class="sb-runBtn">Run</button>
          <button class="sb-loadBtn">Load Template</button>
        </div>
        <div class="sb-cmd-area">
          <textarea class="sb-execCommand" placeholder="実行コマンド ({file})"></textarea>
        </div>
        <div class="sb-editor" style="height:260px;"></div>
        <div class="sb-output"><div class="output-header">Output</div><pre class="output-area"></pre></div>
      </div>
    `;

    // fill UI references
    const langSelect = rootEl.querySelector('.sb-langSelect');
    const runBtn = rootEl.querySelector('.sb-runBtn');
    const loadBtn = rootEl.querySelector('.sb-loadBtn');
    const execTextarea = rootEl.querySelector('.sb-execCommand');
    const editorContainer = rootEl.querySelector('.sb-editor');
    const outputPre = rootEl.querySelector('.output-area');

    // populate languages from window.LANG_CONFIG
    const LANG_CONFIG = window.LANG_CONFIG || {};
    const langs = Object.keys(LANG_CONFIG).length ? Object.keys(LANG_CONFIG) : ['javascript'];
    langSelect.innerHTML = '';
    langs.forEach(l => {
      const o = document.createElement('option'); o.value = l; o.textContent = l; langSelect.appendChild(o);
    });
    const curLang = langSelect.value || langs[0];
    execTextarea.value = (window.LANG_CONFIG && window.LANG_CONFIG[curLang] && window.LANG_CONFIG[curLang].command) || '';

    // create minimal text model (no Monaco required for now)
    const cellObj = {
      rootEl,
      index: String(index),
      outputEl: outputPre,
      append(s) { if (outputPre) { outputPre.textContent += String(s); outputPre.scrollTop = outputPre.scrollHeight; } }
    };
    cells.set(String(index), cellObj);

    // load template handler
    loadBtn.addEventListener('click', () => {
      const conf = (window.LANG_CONFIG && window.LANG_CONFIG[langSelect.value]) || {};
      const tmpl = conf.templatecode || '';
      // if Monaco present and editor model available we would set model; otherwise replace editorContainer text
      editorContainer.textContent = tmpl;
    });

    // Run handler
    runBtn.addEventListener("click", () => {
      // Run ボタン押下部分の直前に追加（既にある runBtn.addEventListener の中）
      let code = "";

      if (monacoInstance && monacoInstance.model) {
        code = monacoInstance.model.getValue();
      } else {
        code = editorContainer.textContent || "";
      }

      const execCommand = execTextarea ? execTextarea.value : "";

      if (outputPre) outputPre.textContent = "";

      const payload = {
        command: "run",
        language: langSelect.value,
        code,
        execCommand,
        index
      };

      if (vscodeApi) {
        vscodeApi.postMessage(payload);
      }
    });

    // attempt to load Monaco editor for nicer UI non-blocking (if allowed)
    // (we don't block if Monaco fails — skeleton UI is usable)
    // 既存: tryLoadMonaco(editorContainer, initialCode, curLang).catch(...);
    tryLoadMonaco(editorContainer, initialCode, curLang)
      .then(res => {
        // res: { mon, model, editor }
        monacoInstance = res;
        // もし初期コードを editorContainer に入れていた場合は model に反映する
        try {
          if (monacoInstance && monacoInstance.model && typeof monacoInstance.model.setValue === 'function') {
            monacoInstance.model.setValue(initialCode || (window.LANG_CONFIG && window.LANG_CONFIG[curLang] && window.LANG_CONFIG[curLang].templatecode) || '');
          }
        } catch (e) {
          console.warn('[sandbox_init] failed to set model value:', e);
        }
      })
      .catch(e => {
        console.warn('[sandbox_init] Monaco load failed (non-fatal):', e);
      });
  }

  // try to load monaco non-blocking; resolves if loaded, rejects otherwise
  function tryLoadMonaco(containerEl, code, lang) {
    return new Promise((resolve, reject) => {
      if (!containerEl) return reject(new Error('no container'));
      if (window.monaco) {
        // create model & editor
        const mon = window.monaco;
        const monLang = (lang === 'typescript') ? 'typescript' : 'javascript';
        const model = mon.editor.createModel(code || '', monLang);
        const editor = mon.editor.create(containerEl, { model, automaticLayout: true, theme: 'vs-dark' });
        return resolve({ mon, model, editor });
      }
      // load require.js once
      if (document.querySelector('script[data-monaco-loader]')) {
        // wait for monaco
        let tries = 0;
        const wait = setInterval(() => {
          if (window.monaco) { clearInterval(wait); tryLoadMonaco(containerEl, code, lang).then(resolve).catch(reject); }
          if (++tries > 50) { clearInterval(wait); reject(new Error('monaco timeout')); }
        }, 200);
        return;
      }
      // insert loader
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/require.js/2.3.6/require.min.js';
      s.setAttribute('data-monaco-loader', '1');
      s.onload = () => {
        const base = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.39.0/min';
        try {
          window.require.config({ paths: { vs: base + '/vs' } });
          window.MonacoEnvironment = { getWorkerUrl() {
            const proxy = URL.createObjectURL(new Blob([`self.MonacoEnvironment={baseUrl:'${base}'};importScripts('${base}/vs/base/worker/workerMain.js');`], { type: 'text/javascript' }));
            return proxy;
          } };
          window.require(['vs/editor/editor.main'], () => {
            try {
              const mon = window.monaco;
              const monLang = (lang === 'typescript') ? 'typescript' : 'javascript';
              const model = mon.editor.createModel(code || '', monLang);
              const editor = mon.editor.create(containerEl, { model, automaticLayout: true, theme: 'vs-dark' });
              resolve({ mon, model, editor });
            } catch (e) { reject(e); }
          }, reject);
        } catch (e) { reject(e); }
      };
      s.onerror = () => reject(new Error('require.js load failed'));
      document.head.appendChild(s);
    });
  }

  // --- initialization logic: try immediate, otherwise observe DOM mutations ---
  function initExistingRoots() {
    const roots = findEmbedRootsIn(document);
    if (!roots || roots.length === 0) return false;
    roots.forEach(r => initCell(r));
    return true;
  }

  // expose manual init
  window.__sandbox_init = function() {
    try {
      const ok = initExistingRoots();
      if (!ok) {
        // attempt to find anywhere in document again
        const roots = findEmbedRootsIn(document);
        roots.forEach(r => initCell(r));
      }
      return true;
    } catch (e) { console.warn('manual __sandbox_init failed', e); return false; }
  };

  // auto init now
  const didInit = initExistingRoots();

  // If not initialized, set up MutationObserver to watch for elements being added
  if (!didInit && typeof MutationObserver !== 'undefined') {
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          // if the added node itself is a root or contains root(s)
          if (node.matches && (node.matches('#sandbox-root') || node.matches('[id^="sandbox-root"]') || node.classList.contains('sandbox-embed'))) {
            initCell(node);
          }
          // also scan descendants
          const found = findEmbedRootsIn(node);
          found.forEach(r => initCell(r));
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

    // also safety timer: try manual init after short delay in case elements are inserted asynchronously
    setTimeout(() => { try { window.__sandbox_init(); } catch (e) {} }, 500);
  }

  // message routing from extension
  window.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.command === 'result' && typeof msg.index !== 'undefined') {
      const index = String(msg.index);
      const c = cells.get(index);
      if (c && c.append) c.append(msg.output || '');
      else {
        // fallback: try element with id
        const fallback = document.getElementById(`sandbox-root-${index}`);
        if (fallback) {
          const out = fallback.querySelector('.output-area');
          if (out) out.textContent = (out.textContent || '') + (msg.output || '');
        }
      }
      return;
    }
    if (msg.kind === 'stream' && msg.stdout) {
      cells.forEach(c => c.append(msg.stdout));
      return;
    }
    if (msg.kind === 'exit') {
      cells.forEach(c => c.append(`\n[process exited, code=${msg.code}, signal=${msg.signal}]\n`));
      return;
    }
    if (msg.kind === 'status') {
      cells.forEach(c => c.append(`[status] ${msg.text}\n`));
      return;
    }
    if (msg.kind === 'error' && msg.text) {
      cells.forEach(c => c.append(`[error] ${msg.text}\n`));
      return;
    }
  });

  // finished
})();
