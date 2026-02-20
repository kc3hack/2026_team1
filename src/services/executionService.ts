import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { runCommand, LangConfigEntry } from "./runner";

export interface ExecutionResult {
  success: boolean;
  output: string;
  error?: string;
}

/** langConfig.json 全体の型 */
type LangConfig = Record<string, LangConfigEntry>;

/** フォールバック用設定（langConfig.json が読めない場合のみ使用） */
const FALLBACK_CONF: LangConfigEntry = {
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
  private langConfig: LangConfig = {};

  constructor(extensionPath: string) {
    // media/langConfig.json を読み込んで言語設定をキャッシュ
    try {
      const configPath = path.join(extensionPath, "media", "langConfig.json");
      const raw = fs.readFileSync(configPath, "utf8");
      this.langConfig = JSON.parse(raw) as LangConfig;
    } catch (e) {
      console.warn("ExecutionService: langConfig.json の読み込みに失敗しました。", e);
    }
  }

  /** 言語キーに対応する LangConfigEntry を返す。未定義ならフォールバック */
  private resolveConf(lang: string): LangConfigEntry {
    return this.langConfig[lang] ?? FALLBACK_CONF;
  }

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
    // conf が外から渡されない場合は langConfig.json から解決
    const conf = opts?.conf ?? this.resolveConf(lang);
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
