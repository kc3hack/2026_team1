import * as fs from "fs";
import * as path from "path";
import { exec, ChildProcess } from "child_process";
import * as vscode from "vscode";

/**
 * 言語設定インターフェース（langConfig.json の各エントリ相当）
 */
export interface LangConfigEntry {
  command?: string;
  filename?: string;
  deletefile?: string;
  templatecode?: string;
}

/**
 * runCommand
 * - workspaceRoot: 実行時のカレント（ワークスペースルート）
 * - lang: 選択された言語キー（例: "javascript"）
 * - code: 実行するソースコード
 * - userExecCommand: Webview の textarea でユーザーが入力したコマンド（空文字なら config の command を使う）
 * - conf: 言語ごとの設定（LangConfigEntry）
 * - panel: webview のパネル（メッセージ送信用）
 *
 * - panel があれば panel.webview.postMessage で stream/exit/status/error を送る
 * - panel が無ければ stdout/stderr を集めて Promise で返す
 * 戻り値: Promise<{ stdout: string, stderr: string, code: number|null, signal: string|null }>
 */
export async function runCommand(opts: {
  workspaceRoot: string;
  lang: string;
  code: string;
  userExecCommand: string;
  conf: LangConfigEntry;
  panel?: vscode.WebviewPanel;
}): Promise<{ stdout: string; stderr: string; code: number | null; signal: string | null }> {
  const { workspaceRoot, lang, code, userExecCommand, conf, panel } = opts;

  // 決定ファイル名（conf.filename があれば使う。無ければ言語に応じたデフォルト）
  const tmpFileName =
    conf && conf.filename
      ? conf.filename
      : lang === "typescript"
      ? "sandbox_temp.ts"
      : "sandbox_temp.js";
  const tmpFilePath = path.join(workspaceRoot, tmpFileName);

  // 1) ファイル書き込み
  try {
    fs.writeFileSync(tmpFilePath, code, { encoding: "utf8" });
  } catch (err) {
    if (panel)
      panel.webview.postMessage({
        kind: "error",
        text: `一時ファイル書き込みエラー: ${String(err)}`,
      });
    throw err;
  }

  // 2) 実行コマンド決定（優先: userExecCommand 非空 → それを使用。空なら conf.command）
  const baseCmd =
    userExecCommand && userExecCommand.trim().length > 0
      ? userExecCommand.trim()
      : conf && conf.command
      ? conf.command
      : "";
  let execCmd = "";
  if (baseCmd.length === 0) {
    execCmd = `node ${tmpFileName}`;
  } else {
    execCmd = baseCmd.includes("{file}")
      ? baseCmd.replace(/{file}/g, tmpFileName)
      : `${baseCmd} ${tmpFileName}`.trim();
  }

  if (panel) panel.webview.postMessage({ kind: "status", text: `実行: ${execCmd}` });

  // 3) プロセス起動（exec）
  let child: ChildProcess;
  try {
    child = exec(execCmd, { cwd: workspaceRoot, maxBuffer: 40 * 1024 * 1024 });
  } catch (err) {
    if (panel)
      panel.webview.postMessage({
        kind: "error",
        text: `プロセス起動エラー: ${String(err)}`,
      });
    try {
      fs.unlinkSync(tmpFilePath);
    } catch (_) {}
    throw err;
  }

  let stdoutBuf = "";
  let stderrBuf = "";

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer | string) => {
      const s = String(chunk);
      stdoutBuf += s;
      if (panel) panel.webview.postMessage({ kind: "stream", stdout: s });
    });
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer | string) => {
      const s = String(chunk);
      stderrBuf += s;
      if (panel) panel.webview.postMessage({ kind: "stream", stderr: s });
    });
  }

  // wait for close
  const result = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("close", (code: number | null, signal: string | null) => {
      if (panel) panel.webview.postMessage({ kind: "exit", code, signal });

      // cleanup temp file
      try {
        if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
      } catch (_) {}

      // delete additional files listed in conf.deletefile
      try {
        const df = conf && conf.deletefile ? conf.deletefile : "";
        if (typeof df === "string" && df.trim().length > 0) {
          const targets = df
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          for (const t of targets) {
            const targetPath = path.isAbsolute(t)
              ? t
              : path.join(workspaceRoot, t);
            try {
              if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
            } catch (_) {}
          }
        }
      } catch (_) {}

      resolve({ stdout: stdoutBuf, stderr: stderrBuf, code, signal });
    });

    child.on("error", (err: Error) => {
      if (panel)
        panel.webview.postMessage({
          kind: "error",
          text: `実行中のエラー: ${String(err)}`,
        });
      try {
        if (fs.existsSync(tmpFilePath)) fs.unlinkSync(tmpFilePath);
      } catch (_) {}
      resolve({
        stdout: stdoutBuf,
        stderr: stderrBuf + String(err),
        code: null,
        signal: null,
      });
    });
  });

  return result;
}