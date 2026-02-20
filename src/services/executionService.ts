import * as os from "os";
import * as vscode from "vscode";
import { runCommand, LangConfigEntry } from "./runner";

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
}

// JavaScript 用のデフォルト設定（langConfig.json の "javascript" エントリ相当）
const DEFAULT_JS_CONF: LangConfigEntry = {
  command: "node {file}",
  filename: "docmate_exec.js",
  deletefile: "",
  templatecode: "",
};

/** VS Code のワークスペースルートを取得。未開放なら os.tmpdir() にフォールバック */
function resolveWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.tmpdir();
}

export class ExecutionService {
  async execute(
    code: string,
    opts?: {
      lang?: string;
      conf?: LangConfigEntry;
      userExecCommand?: string;
      panel?: vscode.WebviewPanel;
    },
  ): Promise<ExecutionResult> {
    const lang = opts?.lang ?? "javascript";
    const conf = opts?.conf ?? DEFAULT_JS_CONF;
    const userExecCommand = opts?.userExecCommand ?? "";
    const panel = opts?.panel;

    const workspaceRoot = resolveWorkspaceRoot();

    try {
      const result = await runCommand({
        workspaceRoot,
        lang,
        code,
        userExecCommand,
        conf,
        panel,
      });

      const success = result.code === 0;
      return {
        success,
        output: result.stdout,
        error: success
          ? undefined
          : result.stderr || `Exit code: ${result.code}`,
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: String(err),
      };
    }
  }
}
