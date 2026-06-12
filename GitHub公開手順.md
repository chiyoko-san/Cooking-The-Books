# 連結粉飾 対局 — GitHub Pages 公開＆出題リンク発行ガイド

このゲームを「URLを開くだけで遊べる／出題リンクを送れる」状態にする手順です。
プログラミングの知識は不要です。`index.html` 一つを GitHub に置くだけです。

---

## 用意するもの
- GitHub アカウント（無料）: https://github.com/signup
- このフォルダにある **3つのファイル**:
  - `index.html` … 骨組み（CDN読み込み）
  - `styles.css` … 見た目（色・レイアウト）
  - `app.jsx` … アプリ本体（ロジック・画面）

> 編集するときは、見た目だけ変えたいなら `styles.css`、
> 機能を変えたいなら `app.jsx` だけを触ればOKです。

---

## 手順（5分）

### 1. リポジトリを作る
1. GitHub にログイン → 右上の「＋」→ **New repository**
2. **Repository name** に好きな名前（例: `fraud-duel`）を入力
3. **Public**（公開）を選ぶ ※ Pages を無料で使うため
4. 「Create repository」をクリック

### 2. 3つのファイルをアップロードする
1. 作ったリポジトリの画面で **Add file → Upload files**
2. `index.html` `styles.css` `app.jsx` の**3つまとめて**ドラッグ＆ドロップ
3. 下の「Commit changes」をクリック

> ※ 3ファイルは同じ階層（同じフォルダ）に置いてください。`index.html` が同じ場所の `styles.css` と `app.jsx` を読み込みます。

### 3. GitHub Pages を有効化する
1. リポジトリの **Settings**（設定）タブを開く
2. 左メニューの **Pages** をクリック
3. 「Build and deployment」→ Source を **Deploy from a branch**
4. Branch を **main**（または master）、フォルダは **/ (root)** を選び **Save**
5. 1〜2分待つと、上部に公開URLが出ます:
   `https://（あなたのID）.github.io/fraud-duel/`

これで完成です。このURLを開けば誰でもゲームで遊べます。

---

## 出題リンクの送り方
1. 公開URLを開く → **粉飾者になる** → 決算を作る → **出題コードを発行**
2. 「🔗 共有リンク」の **リンクをコピー** を押す
3. そのリンクを LINE などで相手に送る
4. 相手がリンクを開くと、**いきなり審査画面が始まります**

> リンクが使えない環境では「📋 出題コード」をコピーして送り、
> 相手は「調査官になる → コードから出題を追加」で読み込めます。

---

## よくある質問

**Q. リンクがすごく長いのですが？**
A. 仕様です。出題データをURLに丸ごと埋め込んでいるため、サーバー無しで動く代わりにURLが長くなります。LINE等では問題なく送れます。

**Q. 成績や出題リストはどこに保存される？**
A. 各自のブラウザ（端末）内です。別の端末や別の人とは共有されません。共有したいときは「リンク／コード」を送ってください。

**Q. パソコンで index.html をダブルクリックしても画面が出ません**
A. 3ファイル構成では、ローカルの `file://` で開くとブラウザのセキュリティ制限で `app.jsx` を読み込めません（白い画面/読み込み中のまま）。**GitHub Pages の公開URLから開けば正常に動きます。** どうしてもローカルで確認したいときは、フォルダ内で簡易サーバーを起動してください（例: ターミナルで `python3 -m http.server` を実行し `http://localhost:8000` を開く）。

**Q. file:// でローカルのindex.htmlを直接開くと？**
A. 上記の通り3ファイル版はローカル直開きでは動きません。公開URL、またはローカルサーバー経由で開いてください。

**Q. スマホでも遊べる？**
A. はい。公開URLをスマホのブラウザで開けばそのまま遊べます。

---

## ページごとの独立URL（ブックマーク・共有用）

公開すると、各ページに直接入れる「きれいなURL」（# なし）が使えます。

- トップ: `https://chiyoko-san.github.io/Cooking-the-Books/`
- 出題を作る: `https://chiyoko-san.github.io/Cooking-the-Books/build/`
- 調査一覧: `https://chiyoko-san.github.io/Cooking-the-Books/library/`
- あそびかた: `https://chiyoko-san.github.io/Cooking-the-Books/rules/`

これらは個別にブックマーク・共有でき、検索エンジンにも別ページとして認識されます（各ページにタイトル・説明文の meta、sitemap.xml、robots.txt を同梱済み）。

### アップロードするファイル/フォルダ

リポジトリ直下に、次の構成で置きます（**フォルダごと**アップロード）。

```
（リポジトリ直下）
├── index.html        ← トップ
├── app.jsx           ← アプリ本体（共通）
├── styles.css        ← スタイル（共通）
├── sitemap.xml       ← SEO用
├── robots.txt        ← SEO用
├── build/index.html      ← /build/ 用
├── library/index.html    ← /library/ 用
└── rules/index.html      ← /rules/ 用
```

GitHubの「Add file → Upload files」に、`build` `library` `rules` の**フォルダごとドラッグ＆ドロップ**すれば、フォルダ構造を保ったままアップロードされます（フォルダ内の index.html も一緒に上がります）。あとは Commit changes。

> ※ サブページの HTML は、共通の `app.jsx` / `styles.css` を絶対パス `/Cooking-the-Books/...` で読み込みます。**リポジトリ名を変えた場合**は、`build/` `library/` `rules/` の各 index.html と sitemap.xml・robots.txt 内のパスを新しい名前に置き換えてください。

---

## ログイン機能の設定（Firebase・任意）

ログイン／マイページ（勝率）／全員ランキングを使うには、無料の Firebase を設定します。**設定しなくてもゲームは動きます**（その場合ログイン機能だけオフになり、成績は端末内のみ）。

### 1. Firebaseプロジェクトを作る
1. https://console.firebase.google.com/ にGoogleアカウントでログイン
2. 「プロジェクトを追加」→ 好きな名前（例: cooking-the-books）→ 作成（Googleアナリティクスは無しでOK）

### 2. ウェブアプリを登録して構成を取得
1. プロジェクトのトップで、ウェブアイコン `</>` をクリック
2. アプリ名を入力して登録
3. 表示される `const firebaseConfig = { ... }` の中身（apiKey など）をコピー

### 3. firebase-config.js に貼り付ける
このフォルダの `firebase-config.js` を開き、コピーした値を該当箇所に貼ります。
```js
window.FIREBASE_CONFIG = {
  apiKey: "ここに貼る",
  authDomain: "ここに貼る",
  projectId: "ここに貼る",
  storageBucket: "ここに貼る",
  messagingSenderId: "ここに貼る",
  appId: "ここに貼る"
};
```
編集した `firebase-config.js` を GitHub にアップロード（直下）。

### 4. ログイン方法を有効化
Firebaseコンソール → 「Authentication」→「始める」→「Sign-in method」で、
- **メール/パスワード** を有効化
- **Google** を有効化（プロジェクトのサポートメールを選ぶだけ）

### 5. データベース（Firestore）を作る
1. コンソール →「Firestore Database」→「データベースの作成」
2. 本番 or テストモード → ロケーションは asia-northeast1（東京）推奨
3. 作成後、「ルール」タブを開き、次に置き換えて公開：
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 自分の成績・プロフィールは自分だけ書き込み可、ランキング表示のため読み取りは全員可
    match /stats/{uid} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
    match /users/{uid} {
      allow read: if true;
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

### 6. 公開ドメインを許可（Googleログイン用）
Authentication →「Settings」→「承認済みドメイン」に
`chiyoko-san.github.io` を追加（無ければ）。

これで、サイト右上に「ログイン」が出ます。ログインすると成績がクラウドに保存され、マイページで勝率、ランキングで全員の順位が見られます。

> 補足: `firebase-config.js` の apiKey は公開されますが、Webアプリでは正常な仕様です（誰でも見えてよい識別子）。不正書き込みは上記 Firestore ルールで防ぎます。

---

## 仕組みのメモ（技術者向け）
- React 18 と Babel Standalone を CDN から読み込み、`app.jsx` をブラウザで変換して実行します（ビルド不要）。
- データ保存は `localStorage`。
- 出題は JSON を Base64 化して URL の `#play=...` に格納。読み込み時にデコードして審査開始します。
- 外部送信は一切なし。すべて閲覧者のブラウザ内で完結します。
- 編集ガイド: 色やレイアウトは `styles.css`、画面やロジックは `app.jsx`。`index.html` は基本さわらなくてOK。
