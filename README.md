# Auto Correction WebApp

※本READMEはAIにより作成しています。

数学答案PDFの自動処理（PDF→PNG→書き起こし→問題特定→AI添削）と、ブラウザ上での最終チェック・PDF出力をワンストップで実現するフルスタックWebアプリケーションです。バックエンド（FastAPI）とフロントエンド（React）で構成され、Gemini API を活用して答案の抽出・レビューを自動化します。

## 特長
- **自動パイプライン**: PDFアップロード後にPNG変換・文字起こし・試験種特定・レビュー生成までを非同期で処理。
- **AIレビュー支援**: Gemini API によるフィードバック生成と、採点基準に沿ったコメント出力。
- **ブラウザ編集UI**: 加点・コメント・スタンプ・署名などを直感的に配置し、最終PDFを生成。
- **再処理/編集ワークフロー**: 途中ステップのみ再実行、レビュー履歴の保存、ステータス管理をサポート。

## 技術スタック
- Backend: Python 3.10+, FastAPI, PyMuPDF, Google Cloud Storage
- Frontend: Node.js 18+, React (Create React App), html2canvas, jsPDF
- AI: Google Gemini API

## 動作要件
- Python 3.10 以上
- Node.js 18.x 以上 (npm 付属)
- Google Gemini API キー
- （オプション）Google Cloud Storage バケット、Tesseract OCR

## セットアップ手順
1. リポジトリ取得
   ```bash
   git clone https://github.com/mugi0227/AI_correction_app_Kotonoha.git
   cd auto-correction-webapp
   ```
2. バックエンド依存のインストール
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r backend/requirements.txt  # 無い場合は README のライブラリを個別インストール
   ```
3. 環境変数の設定
   ```bash
   cp backend/.env.example backend/.env  # 例がない場合は README を参照して作成
   ```
   必須項目: `GEMINI_API_KEY`。GCS を使う場合は `GCS_BUCKET_NAME` も指定します。
4. フロントエンド依存のインストール
   ```bash
   cd frontend
   npm install
   cd ..
   ```
5. 開発サーバの起動
   - バックエンド: `cd backend && uvicorn main:app --reload`
   - フロントエンド: `cd frontend && npm start`

## 主なコマンド
| 用途 | コマンド |
| ---- | -------- |
| バックエンド開発サーバ | `cd backend && uvicorn main:app --reload`
| フロントエンド開発サーバ | `cd frontend && npm start`
| フロントエンドビルド | `cd frontend && npm run build`
| 型チェック／静的解析 (任意) | `mypy backend` などを適宜設定 |

## 環境変数（backend/.env）
| 変数 | 概要 |
| ---- | ---- |
| `GEMINI_API_KEY` | Gemini API の認証トークン（必須） |
| `GCS_BUCKET_NAME` | 問題資材・成果物を保存する GCS バケット名 |
| `TRANSCRIBE_MODE` | `dummy` を指定すると開発用のダミー書き起こしを使用 |
| `EXTRACT_USE_AI` | 詳細抽出にAIを使用するかどうか (`true`/`false`) |
| `PNG_SCALE` | PDF→PNG 変換時の倍率（既定 2.0） |
| `ANNO_FONT_PATH` | PDF出力時に利用する日本語フォントパス |

## ディレクトリ構成（抜粋）
```
backend/
  main.py               # FastAPI エントリ
  processing.py         # PDF処理・AIレビュー
  gemini_utils.py       # Gemini API ラッパー
  問題_模範解答_オリジナル/ # 問題・採点基準データ
frontend/
  src/                  # React アプリ（UI／状態管理）
cloudbuild.yaml         # GCP Cloud Build 用設定サンプル
```

## テストと品質管理
- 自動テストは未整備です。必要に応じて `pytest` や `vitest` 等を追加してください。
- Lint/フォーマッタ（`ruff`, `eslint`, `prettier` など）を導入することで品質を維持できます。

## デプロイのヒント
- バックエンドは Uvicorn/Gunicorn + FastAPI 構成でデプロイできます。GCS を利用する場合はサービスアカウント認証を事前に設定してください。
- フロントエンドは `npm run build` で生成される `frontend/build/` を静的ホスティングに配置します。
- Cloud Build や Cloud Run を使用する場合は `cloudbuild.yaml` を参照し、必要に応じて Dockerfile を追加してください。

## ライセンス
公開リポジトリにする際は、利用予定のライセンス（例: MIT, Apache-2.0 など）をこのセクションに明記してください。

## 貢献ガイドライン
- Issue や Pull Request を歓迎します。変更提案の前に既存Issueを確認してください。
- 機能追加時はテストや簡単な説明を添付し、既存のコードスタイルに合わせてください。

## セキュリティ
秘密情報（APIキー、個人情報など）は `.env` や外部のシークレットマネージャーで管理し、コミットしないでください。脆弱性を見つけた場合は Issue ではなく、メンテナーに直接連絡する責任ある開示をお願いします。

## サポート
バグ報告・改善要望は GitHub Issue から受け付けています。
