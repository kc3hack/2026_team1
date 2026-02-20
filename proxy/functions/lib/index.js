"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.geminiProxy = void 0;
const functions = __importStar(require("firebase-functions"));
const admin = __importStar(require("firebase-admin"));
const generative_ai_1 = require("@google/generative-ai");
functions.setGlobalOptions({
    region: "asia-northeast2"
});
admin.initializeApp();
const db = admin.firestore();
const MAX_REQUESTS_PER_IP = 5;
exports.geminiProxy = functions.https.onRequest(async (req, res) => {
    var _a;
    // CORS関連
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "POST");
    res.set("Access-Control-Allow-Headers", "Content-Type,x-judge-token");
    if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
    }
    try {
        const clientJudgeToken = req.header("x-judge-token");
        const validJudgeToken = process.env.JUDGE_TOKEN;
        const clientId = req.header("x-client-id") || req.ip || "unknown-client"; // クライアントidを取得
        const isJudge = clientJudgeToken === validJudgeToken; // 特権モードを起動しても良いか
        if (!isJudge) {
            const ipRef = db.collection("rate_limits").doc(clientId); // この場合クライアントidが主キー
            const doc = await ipRef.get(); // ドキュメント(dbでいうレコード)のスナップショットを取得
            let currentCount = 0;
            if (doc.exists) {
                currentCount = ((_a = doc.data()) === null || _a === void 0 ? void 0 : _a.count) || 0;
            }
            // 制限オーバー
            if (currentCount >= MAX_REQUESTS_PER_IP) {
                res.status(429).json({
                    error: "体験回数の上限に達しました。展示ブースでお待ちしております！"
                });
                return;
            }
            await ipRef.set({ count: currentCount + 1 }, { merge: true }); // Atomic Increment
        }
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            throw new Error("APIキーが設定されていません");
        }
        const genAI = new generative_ai_1.GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
        const prompt = req.body.prompt;
        if (!prompt) {
            res.status(400).json({ error: "プロンプトが空です。" });
        }
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        res.status(200).json({ response: text });
    }
    catch (error) {
        console.error("Error calling Gemini API:", error);
        res.status(500).json({ error: "サーバー内部でエラーが発生しました。" });
    }
});
//# sourceMappingURL=index.js.map