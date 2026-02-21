import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { GoogleGenerativeAI } from "@google/generative-ai";

functions.setGlobalOptions({
    region:"asia-northeast2"
})

admin.initializeApp();
const db = admin.firestore();

const MAX_REQUESTS_PER_IP = parseInt(process.env.MAX_REQUEST_LIMIT || "5", 10);

export const geminiProxy = functions.https.onRequest(async(req,res) => {

    // CORS関連
    res.set("Access-Control-Allow-Origin","*");
    res.set("Access-Control-Allow-Methods","POST");
    res.set("Access-Control-Allow-Headers","Content-Type,x-judge-token");

    if (req.method==="OPTIONS"){
        res.status(204).send("");
        return;
    }

    try{
        const clientJudgeToken = req.header("x-judge-token");
        const validJudgeToken = process.env.JUDGE_TOKEN;

        const clientId = req.header("x-client-id") || req.ip || "unknown-client"; // クライアントidを取得

        const isJudge = clientJudgeToken === validJudgeToken; // 特権モードを起動しても良いか

        if(!isJudge) {
            const ipRef = db.collection("rate_limits").doc(clientId); // この場合クライアントidが主キー
            const doc = await ipRef.get(); // ドキュメント(dbでいうレコード)のスナップショットを取得

            let currentCount = 0;
            if(doc.exists) {
                currentCount = doc.data()?.count || 0;
            }

            // 制限オーバー
            if(currentCount >= MAX_REQUESTS_PER_IP){
                res.status(429).json({
                    error: "体験回数の上限に達しました。展示ブースでお待ちしております！"
                });
                return;
            }

            await ipRef.set({count: currentCount + 1},{merge:true}) // Atomic Increment
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if(!apiKey) {
            throw new Error("APIキーが設定されていません");
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({model:'gemini-2.5-flash'});

        const prompt = req.body.prompt;
        if(!prompt) {
            res.status(400).json({error:"プロンプトが空です。"})
        }

        const result = await model.generateContent(prompt);
        const text = result.response.text();

        res.status(200).json({ response: text});
    } catch(error){
        console.error("Error calling Gemini API:",error);
        res.status(500).json({error:"サーバー内部でエラーが発生しました。"})
    }
})