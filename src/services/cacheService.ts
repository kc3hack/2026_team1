import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as vscode from "vscode";

/** キャッシュの1エントリ */
export interface CacheEntry {
  url: string;
  summary: string;
  examples: {
    title: string;
    description: string;
    code: string;
    executionOutput: string;
  }[];
  savedAt: string; // ISO 8601
}

const CACHE_FILENAME = ".vscode/docmate_cache.json";

/**
 * ドキュメントキャッシュの読み書きを担当するサービス。
 * ワークスペースルートが存在すればそこに、なければ os.tmpdir() に保存する。
 */
export class CacheService {
  private cachePath: string;

  constructor() {
    this.cachePath = this.resolveCachePath();
  }

  // ----- パス解決 -----

  private resolveCachePath(): string {
    const folders = vscode.workspace.workspaceFolders;
    const dir =
      folders && folders.length > 0
        ? folders[0].uri.fsPath
        : os.tmpdir();
    return path.join(dir, CACHE_FILENAME);
  }

  /**
   * ワークスペースが切り替わった場合に呼び出してパスを更新する。
   * （通常は不要だが、念のため公開しておく）
   */
  refresh(): void {
    this.cachePath = this.resolveCachePath();
  }

  // ----- 読み込み -----

  /**
   * キャッシュファイル全体を読み込む。
   * ファイルが存在しない・壊れている場合は空配列を返す。
   */
  private readAll(): CacheEntry[] {
    try {
      if (!fs.existsSync(this.cachePath)) {
        return [];
      }
      const raw = fs.readFileSync(this.cachePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as CacheEntry[]) : [];
    } catch (e) {
      console.warn("CacheService: キャッシュの読み込みに失敗しました。", e);
      return [];
    }
  }

  /**
   * URL が一致するキャッシュエントリを返す。
   * 見つからなければ null を返す。
   */
  find(url: string): CacheEntry | null {
    const all = this.readAll();
    return all.find((entry) => entry.url === url) ?? null;
  }

  // ----- 書き込み -----

  /**
   * エントリを保存する。
   * 同じ URL が既に存在する場合は上書き（最新情報で更新）する。
   */
  save(entry: Omit<CacheEntry, "savedAt">): void {
    const all = this.readAll();
    const idx = all.findIndex((e) => e.url === entry.url);
    const newEntry: CacheEntry = { ...entry, savedAt: new Date().toISOString() };

    if (idx >= 0) {
      all[idx] = newEntry; // 上書き
    } else {
      all.push(newEntry); // 追記
    }

    try {
      fs.writeFileSync(this.cachePath, JSON.stringify(all, null, 2), "utf8");
      console.log(`CacheService: 保存しました → ${this.cachePath}`);
    } catch (e) {
      console.error("CacheService: キャッシュの書き込みに失敗しました。", e);
    }
  }

  /** 現在のキャッシュファイルのパスを返す（デバッグ用） */
  getCachePath(): string {
    return this.cachePath;
  }
}