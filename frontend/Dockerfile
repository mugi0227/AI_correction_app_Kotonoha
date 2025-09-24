# ステージ1: Reactアプリケーションのビルド
FROM node:18-alpine as build

WORKDIR /app

# ビルド時に渡されるAPI URLをARGで受け取る
ARG REACT_APP_API_BASE_URL

# 受け取ったARGを環境変数として設定する
# これにより、`npm run build`がこの変数を参照できるようになる
ENV REACT_APP_API_BASE_URL=$REACT_APP_API_BASE_URL

COPY package.json ./
COPY package-lock.json ./

RUN npm install

COPY . .

RUN npm run build

# ステージ2: Nginxで静的ファイルを配信
FROM nginx:1.25-alpine

# envsubstコマンドを使用するためにgettextパッケージをインストール
RUN apk add --no-cache gettext

COPY --from=build /app/build /usr/share/nginx/html

# Nginxのテンプレートと起動スクリプトをコピー
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY entrypoint.sh /entrypoint.sh

# 起動スクリプトに実行権限を付与し、改行コードを修正
RUN chmod +x /entrypoint.sh && sed -i 's/$//g' /entrypoint.sh

# コンテナ起動時にentrypoint.shを実行する
ENTRYPOINT ["/entrypoint.sh"]
