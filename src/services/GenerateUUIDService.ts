import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

/**
 * このクラスではユーザーに一意のUUIDの生成、及び取得を可能にするインスタンスです
 * 生成したUUIDはクライアントIDとしてフィールドに保存され、ゲッター{@link getClientId}で取得可能です
 */
export class GenerateUUIDService {
    private context: vscode.ExtensionContext;
    private clientId: string | undefined;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    /**
     * クライアントIDを初期化します
     * もしクライアントIDを持っていなかったら新たに生成し、フィールドに保存します。
     * すでに持っている場合読み込んで、保存します。
     */
    async init() {
        this.clientId = this.context.globalState.get<string>('myExtension.clientId');

        if (this.clientId === undefined) {
            this.clientId = uuidv4();
            await this.context.globalState.update('myExtension.clientId', this.clientId);
            console.log("新しいクライアントIDを発行して、保存しました", this.clientId);
        } else {
            console.log("保存済みのクライアントIDを読み込みました", this.clientId);
        }
    }

    /**
     * クライアントIDを返します
     * @throws うまく生成できていない場合はエラーを投げます
     * @returns クライアントID
     */
    getClientId(): string{
        if (!this.clientId){
            throw new Error(
                "Failed generating client ID"
            )
        }
        return this.clientId!;
    }
}