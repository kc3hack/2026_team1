import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

/**
 * このクラスではユーザーに一意のUUIDの生成、及び取得を可能にするインスタンスです
 * 生成したUUIDはクライアントIDとしてフィールドに保存され、ゲッター{@link getClientId}で取得可能です
 */
export class GenerateUUIDService {
    private context: vscode.ExtensionContext;
    private clientId: string;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.clientId = this.initialize();
    }

    /**
     * クライアントIDを初期化します
     * もしクライアントIDを持っていなかったら新たに生成し、フィールドに保存します。
     * すでに持っている場合読み込んで、保存します。
     */
    private initialize(): string {
        let id = this.context.globalState.get<string>('myExtension.clientId');

        if (!id) {
            id = uuidv4();
            this.context.globalState.update('myExtension.clientId', id).then(
                () => console.log("新しいクライアントIDを発行して、保存しました", id),
                (err) => console.error("クライアントIDの保存に失敗しました", err)
            );
        } else {
            console.log("保存済みのクライアントIDを読み込みました", id);
        }
        return id;
    }

    /**
     * クライアントIDを返します
     * @returns クライアントID
     */
    getClientId(): string {
        return this.clientId;
    }
}
