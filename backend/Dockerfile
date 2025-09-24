# Python 3.11をベースイメージとして使用
FROM python:3.11-slim

# Tesseract OCRと日本語言語パックをインストール
RUN apt-get update && apt-get install -y \
    tesseract-ocr \
    tesseract-ocr-jpn \
    && rm -rf /var/lib/apt/lists/*

# 作業ディレクトリを設定
WORKDIR /app

# 依存関係ファイルをコピー
COPY requirements.txt .

# 依存関係をインストール
RUN pip install --no-cache-dir -r requirements.txt

# Google Cloudライブラリを最新版にアップグレードし、IAM署名などの最新機能を利用できるようにする
RUN pip install --upgrade --no-cache-dir google-cloud-storage google-auth

# アプリケーションコードをコピー
COPY . .

# FastAPIアプリケーションを起動 (Cloud Runの$PORT環境変数を尊重する)
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
