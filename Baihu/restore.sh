#!/bin/bash
# restore.sh - 数据恢复脚本（修复登录问题）

set -e

echo "=========================================="
echo "🔄 白虎面板数据恢复"
echo "=========================================="
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"

# ============================================================
# 1. 检查 RCLONE_CONF
# ============================================================
if [ -z "$RCLONE_CONF" ]; then
    echo "⚠️ 未设置 RCLONE_CONF，跳过恢复"
    exit 0
fi

# ============================================================
# 2. 配置 Rclone
# ============================================================
echo "📝 配置 Rclone..."
mkdir -p ~/.config/rclone
echo "$RCLONE_CONF" > ~/.config/rclone/rclone.conf
chmod 600 ~/.config/rclone/rclone.conf

# ============================================================
# 3. 测试 Rclone 连接
# ============================================================
REMOTE_FOLDER="${REMOTE_FOLDER:-huggingface:/baihu}"
echo "☁️ 测试远程存储: $REMOTE_FOLDER"

if ! rclone ls "$REMOTE_FOLDER" &>/dev/null; then
    echo "⚠️ 无法访问远程存储，跳过恢复"
    exit 0
fi

# ============================================================
# 4. 查找备份文件
# ============================================================
echo "📦 查找备份文件..."
OUTPUT=$(rclone ls "$REMOTE_FOLDER" 2>&1)

if [ -z "$OUTPUT" ]; then
    echo "📭 没有备份文件，跳过恢复"
    exit 0
fi

latest_file=$(rclone lsjson "$REMOTE_FOLDER" 2>/dev/null | jq -r 'sort_by(.ModTime) | last | .Path')

if [ -z "$latest_file" ] || [ "$latest_file" = "null" ]; then
    echo "❌ 无法获取备份文件列表"
    exit 0
fi

echo "📁 找到备份: $latest_file"

# ============================================================
# 5. 确保面板运行
# ============================================================
echo "🔍 检查面板状态..."

if ! pm2 list 2>/dev/null | grep -q "baihu.*online"; then
    echo "🚀 启动面板..."
    pm2 start "baihu server" --name baihu
    sleep 10
else
    echo "✅ 面板已在运行"
fi

# 等待面板完全就绪
echo "⏳ 等待面板就绪..."
for i in {1..30}; do
    if curl -s http://localhost:8052/api/v1/health > /dev/null 2>&1; then
        echo "✅ 面板就绪"
        break
    fi
    sleep 1
done

# ============================================================
# 6. 获取密码（多种方式）
# ============================================================
echo "🔑 获取面板密码..."

DEFAULT_PASSWORD=""

# 方式1: 从 PM2 日志
if [ -z "$DEFAULT_PASSWORD" ]; then
    DEFAULT_PASSWORD=$(pm2 logs baihu --lines 500 --nostream 2>/dev/null \
        | grep -oP '密\s*码[:：]\s*\K[^,[:space:]]+' \
        | tail -1)
    echo "方式1结果: ${DEFAULT_PASSWORD:-未找到}"
fi

# 方式2: 从日志文件
if [ -z "$DEFAULT_PASSWORD" ]; then
    DEFAULT_PASSWORD=$(cat ~/.pm2/logs/baihu-out.log 2>/dev/null \
        | grep -oP '密\s*码[:：]\s*\K[^,[:space:]]+' \
        | tail -1)
    echo "方式2结果: ${DEFAULT_PASSWORD:-未找到}"
fi

# 方式3: 使用环境变量
if [ -z "$DEFAULT_PASSWORD" ]; then
    DEFAULT_PASSWORD="$ADMIN_PASSWORD"
    echo "方式3: 使用 ADMIN_PASSWORD"
fi

if [ -z "$DEFAULT_PASSWORD" ]; then
    echo "❌ 无法获取密码，跳过恢复"
    exit 0
fi

echo "✅ 密码: ${DEFAULT_PASSWORD:0:10}..."

# ============================================================
# 7. 登录面板（修复版）
# ============================================================
echo "🔐 登录面板..."

# 清理旧的 cookies
rm -f /tmp/cookies.txt /tmp/headers.txt

# 尝试登录
LOGIN_RESPONSE=$(curl -v -c /tmp/cookies.txt -D /tmp/headers.txt \
    -s -w "\nHTTP_CODE:%{http_code}" \
    'http://localhost:8052/api/v1/auth/login' \
    -H 'Content-Type: application/json' \
    --data-raw "{\"username\":\"admin\",\"password\":\"$DEFAULT_PASSWORD\"}" 2>&1)

echo "$LOGIN_RESPONSE"

# 提取 HTTP 状态码
HTTP_CODE=$(echo "$LOGIN_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)

# 提取 Cookie
BHToken=$(cat /tmp/cookies.txt 2>/dev/null | grep BHToken | awk -F'[=;]' '{print $2}' | tr -d ' ')

if [ -z "$BHToken" ] || [ "$HTTP_CODE" != "200" ]; then
    echo "❌ 登录失败 (HTTP: $HTTP_CODE)"
    echo ""
    echo "===== 调试信息 ====="
    echo "HTTP Headers:"
    cat /tmp/headers.txt 2>/dev/null || echo "无 headers"
    echo ""
    echo "Cookies:"
    cat /tmp/cookies.txt 2>/dev/null || echo "无 cookies"
    echo ""
    echo "登录响应:"
    echo "$LOGIN_RESPONSE" | head -20
    echo "==================="
    
    # 尝试使用 ADMIN_PASSWORD 再试一次
    if [ -n "$ADMIN_PASSWORD" ] && [ "$ADMIN_PASSWORD" != "$DEFAULT_PASSWORD" ]; then
        echo "🔄 尝试使用 ADMIN_PASSWORD 登录..."
        BHToken=$(curl -c /tmp/cookies.txt -s -D - -o /dev/null \
            'http://localhost:8052/api/v1/auth/login' \
            -H 'Content-Type: application/json' \
            --data-raw "{\"username\":\"admin\",\"password\":\"$ADMIN_PASSWORD\"}" \
            | awk -F'[=;]' '/Set-Cookie: BHToken=/{print $2}')
        
        if [ -n "$BHToken" ]; then
            echo "✅ 使用 ADMIN_PASSWORD 登录成功"
            DEFAULT_PASSWORD="$ADMIN_PASSWORD"
        fi
    fi
    
    if [ -z "$BHToken" ]; then
        echo "❌ 所有登录方式都失败，跳过恢复"
        rm -f /tmp/cookies.txt /tmp/headers.txt
        exit 0
    fi
fi

echo "✅ 登录成功 (Token: ${BHToken:0:20}...)"

# ============================================================
# 8. 重置密码（如果需要）
# ============================================================
if [ -n "$ADMIN_PASSWORD" ] && [ "$ADMIN_PASSWORD" != "$DEFAULT_PASSWORD" ]; then
    echo "🔄 重置密码..."
    curl -b /tmp/cookies.txt -s \
        'http://localhost:8052/api/v1/settings/password' \
        -H 'Content-Type: application/json' \
        --data-raw "{\"old_password\":\"$DEFAULT_PASSWORD\",\"new_password\":\"$ADMIN_PASSWORD\"}" \
        > /dev/null
    echo "✅ 密码已重置"
fi

# ============================================================
# 9. 下载备份
# ============================================================
echo "⬇️ 下载备份文件..."
mkdir -p /app/backup_tmp
rclone copy "$REMOTE_FOLDER/$latest_file" /app/backup_tmp/

if [ $? -ne 0 ]; then
    echo "❌ 下载失败"
    rm -rf /app/backup_tmp
    rm -f /tmp/cookies.txt
    exit 0
fi

echo "✅ 下载完成"

# ============================================================
# 10. 执行恢复
# ============================================================
echo "🔄 执行数据恢复..."

./baihu restore "/app/backup_tmp/$latest_file"

RESTORE_EXIT=$?

if [ $RESTORE_EXIT -eq 0 ]; then
    echo "✅✅✅ 数据恢复成功！"
else
    echo "❌❌❌ 数据恢复失败！(退出码: $RESTORE_EXIT)"
fi

# ============================================================
# 11. 清理和重启
# ============================================================
echo "🧹 清理..."
rm -rf /app/backup_tmp
rm -f /tmp/cookies.txt /tmp/headers.txt

echo "🔄 重启面板..."
pm2 restart baihu

echo ""
echo "=========================================="
if [ $RESTORE_EXIT -eq 0 ]; then
    echo "✅ 恢复流程完成"
else
    echo "⚠️ 恢复流程完成（有错误）"
fi
echo "=========================================="

exit $RESTORE_EXIT