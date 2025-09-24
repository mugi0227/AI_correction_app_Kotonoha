#!/bin/sh
# PORT環境変数が設定されていない場合は、デフォルトで8080を使用
export PORT=${PORT:-8080}

# nginx.conf.templateの${PORT}を実際のポート番号に置換して、最終的な設定ファイルを生成
envsubst '$PORT' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

# Nginxをフォアグラウンドで起動
exec nginx -g 'daemon off;'