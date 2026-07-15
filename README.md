# 快速背單字

一個像 Anki 的網頁背單字工具。把歐路詞典的搜尋結果貼上來，讓 **Gemini** 幫你整理成結構化卡片，再用「間隔重複（SRS）」有效率地背誦。純前端、免安裝、資料只存在你自己的瀏覽器。

## 功能

- **AI 整理**：貼上歐路詞典（英漢、劍橋英英/英漢、有道、柯林斯、朗文、牛津、詞根詞源、例句…）整段內容，Gemini 會整理出：
  - 中英釋義 + 例句
  - 💡 助記法（諧音／拆解／聯想，例如 melancholy →「沒人 call 你」）
  - 詞根詞源
  - 搭配詞、片語
  - 同義詞、反義詞
  - 情境詞（常一起出現的前後文單詞）
  - 形近／易混淆詞
  - 例句庫
- **多種背誦模式**（可複選）：
  - 英 → 中（看單字回想意思）
  - 中 → 英（看意思回想單字）
  - 搭配詞 / 情境詞 / 同義詞 / 片語
- **間隔重複 SRS**：像 Anki 一樣用「重來 / 困難 / 良好 / 簡單」評分，自動安排下次複習時間。
- **白色 / 深色主題**：預設白色，右上角一鍵切換。
- **資料備份**：可匯出／匯入 JSON。

## 使用方式

1. 用瀏覽器直接打開 `index.html`。
2. 到「設定」頁確認 **API 金鑰**（已預先帶入你提供的 3 組 Vertex AI Express 金鑰，會自動輪詢；某組額度用完會自動換下一組）。
   - `AQ.` 開頭的金鑰會自動走 Vertex Express 端點；一般 AI Studio 金鑰（到 [Google AI Studio](https://aistudio.google.com/app/apikey) 申請）會走 AI Studio 端點。
   - 端點可用「供應端點」下拉手動指定。預設模型 `gemini-3-flash-preview`。
   - 按「測試連線」會逐一測試每組金鑰是否可用。
3. 到「新增單字」頁：輸入單字 → 貼上歐路詞典內容 → 按「用 Gemini 整理」→ 確認預覽 → 「存入詞庫」。
4. 到「背誦」頁：勾選要背的模式 → 開始背誦 → 空白鍵顯示答案、按 1/2/3/4 或點按鈕評分。

## 鍵盤快捷鍵（背誦時）

- `空白鍵`：顯示答案
- `1` 重來、`2` 困難、`3` 良好、`4` 簡單

## 隱私

- API 金鑰與所有單字資料都只存在瀏覽器的 `localStorage`，不會上傳到任何第三方伺服器。
- 整理單字時，內容會直接從你的瀏覽器送到 Google Gemini API。

## 雲端同步（Firestore）

單字卡片會自動同步到 Firebase Firestore，不需登入，手機／電腦開同一個網址即會即時同步。

- **只同步單字卡片**，API 金鑰不會上雲，留在各裝置的瀏覽器（手機第一次用需到「設定」輸入一次金鑰）。
- 設定檔在 `db.js`（使用專案 `english-32702`）。

### 必要設定：啟用 Firestore 並設定規則

1. 到 [Firebase Console](https://console.firebase.google.com/) → 專案 `english-32702` → Build → Firestore Database → 建立資料庫（正式或測試模式皆可，之後用下方規則覆蓋）。
2. Rules 分頁貼上以下規則後發布（允許不需登入讀寫 `cards` 集合）：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /cards/{id} {
      allow read, write: if true;
    }
  }
}
```

> ⚠️ 這代表任何知道專案設定的人都能讀寫你的單字資料。若要更安全，可改用 Firebase 匿名登入或加上密鑰欄位限制。

## 部署到 GitHub + Vercel

本專案是純靜態網站，不需 build。

1. 已推送到 GitHub：`https://github.com/chentu030/english`
2. 到 [Vercel](https://vercel.com/new) → Import 這個 GitHub repo → Framework 選「Other」→ Deploy。
3. 之後每次 `git push`，Vercel 會自動重新部署。

> `config.local.js`（含金鑰）與 `gemini api.txt` 已被 `.gitignore` 忽略，不會上傳。部署後的網站請到「設定」頁輸入金鑰。

## 檔案結構

- `index.html`：頁面結構
- `styles.css`：樣式與雙主題
- `app.js`：邏輯（Gemini 呼叫、資料儲存、SRS 背誦）
- `db.js`：Firestore 雲端同步
- `config.local.js`：本機金鑰（不上傳）
