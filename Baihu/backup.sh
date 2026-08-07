#!/bin/bash
# restore.sh - 数据恢复脚本（修复登录问题）

set -e

# ============================================================
# 0. 配置区
# ============================================================
FIXED_PASSWORD="mickvvw"  # 固定密码（兜底）

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
# 6. 获取密码（优先级：环境变量 > PM2日志 > 日志文件 > 固定密码）
# ============================================================
echo "🔑 正在获取面板密码..."

PASSWORD=""

# 方式1: 从环境变量 ADMIN_PASSWORD 获取
if [ -n "$ADMIN_PASSWORD" ]; then
    PASSWORD="$ADMIN_PASSWORD"
    echo "✅ 从环境变量 ADMIN_PASSWORD 获取密码"
fi

# 方式2: 从 PM2 日志获取
if [ -z "$PASSWORD" ]; then
    echo "📋 尝试从 PM2 日志获取密码..."
    PASSWORD=$(pm2 logs baihu --lines 500 --nostream 2>/dev/null \
        | grep -oP '密\s*码[:：]\s*\K[^,[:space:]]+' \
        | tail -1)
    
    if [ -n "$PASSWORD" ]; then
        echo "✅ 从 PM2 日志获取密码成功"
    fi
fi

# 方式3: 从日志文件获取
if [ -z "$PASSWORD" ]; then
    echo "📋 尝试从日志文件获取密码..."
    PASSWORD=$(cat ~/.pm2/logs/baihu-out.log 2>/dev/null \
        | grep -oP '密\s*码[:：]\s*\K[^,[:space:]]+' \
        | tail -1)
    
    if [ -n "$PASSWORD" ]; then
        echo "✅ 从日志文件获取密码成功"
    fi
fi

# 方式4: 使用固定密码（兜底）
if [ -z "$PASSWORD" ]; then
    PASSWORD="$FIXED_PASSWORD"
    echo "⚠️ 使用固定密码: $FIXED_PASSWORD"
fi

# 如果所有方式都失败
if [ -z "$PASSWORD" ]; then
    echo "❌ 无法获取密码！"
    echo "请确保:"
    echo "  1. 设置了 ADMIN_PASSWORD 环境变量"
    echo "  2. 面板已启动并有 PM2 日志"
    echo "  3. 固定密码配置正确"
    exit 1
fi

echo "✅ 密码获取成功: ${PASSWORD:0:10}..."

# ============================================================
# 7. 登录面板
# ============================================================
echo "🔐 登录面板..."

# 清理旧的 cookies
rm -f /tmp/cookies.txt /tmp/headers.txt

# 尝试登录
LOGIN_RESPONSE=$(curl -v -c /tmp/cookies.txt -D /tmp/headers.txt \
    -s -w "\nHTTP_CODE:%{http_code}" \
    'http://localhost:8052/api/v1/auth/login' \
    -H 'Content-Type: application/json' \
    --data-raw "{\"username\":\"admin\",\"password\":\"$PASSWORD\"}" 2>&1)

echo "$LOGIN_RESPONSE"

# 提取 HTTP 状态码
HTTP_CODE=$(echo "$LOGIN_RESPONSE" | grep "HTTP_CODE:" | cut -d':' -f2)

# 提取 Cookie
BHToken=$(cat /tmp/cookies.txt 2>/dev/null | grep BHToken | awk -F'[=;]' '{print $2}' | tr -d ' ')

if [ -z "$BHToken" ] || [ "$HTTP_CODE" != "200" ]; then
    echo "❌ 登录失败 (HTTP: $HTTP_CODE)"
    echo ""
    echo "===== 调试信息 ====="
    echo "使用的密码来源:"
    if [ -n "$ADMIN_PASSWORD" ]; then
        echo "  - 环境变量 ADMIN_PASSWORD: ${ADMIN_PASSWORD:0:10}..."
    fi
    echo "  - PM2 日志密码: $(pm2 logs baihu --lines 50 --nostream 2>/dev/null | grep -oP '密\s*码[:：]\s*\K[^,[:space:]]+' | tail -1)"
    echo "  - 固定密码: $FIXED_PASSWORD"
    echo ""
    echo "HTTP Headers:"
    cat /tmp/headers.txt 2>/dev/null || echo "无 headers"
    echo ""
    echo "Cookies:"
    cat /tmp/cookies.txt 2>/dev/null || echo "无 cookies"
    echo ""
    echo "登录响应:"
    echo "$LOGIN_RESPONSE" | head -20
    echo "==================="
    
    # 尝试使用固定密码再试一次
    if [ "$PASSWORD" != "$FIXED_PASSWORD" ]; then
        echo "🔄 尝试使用固定密码登录..."
        LOGIN_RESPONSE2=$(curl -v -c /tmp/cookies.txt -D /tmp/headers.txt \
            -s -w "\nHTTP_CODE:%{http_code}" \
            'http://localhost:8052/api/v1/auth/login' \
            -H 'Content-Type: application/json' \
            --data-raw "{\"username\":\"admin\",\"password\":\"$FIXED_PASSWORD\"}" 2>&1)
        
        HTTP_CODE2=$(echo "$LOGIN_RESPONSE2" | grep "HTTP_CODE:" | cut -d':' -f2)
        BHToken2=$(cat /tmp/cookies.txt 2>/dev/null | grep BHToken | awk -F'[=;]' '{print $2}' | tr -d ' ')
        
        if [ -n "$BHToken2" ] && [ "$HTTP_CODE2" == "200" ]; then
            echo "✅ 使用固定密码登录成功"
            PASSWORD="$FIXED_PASSWORD"
            BHToken="$BHToken2"
            HTTP_CODE="$HTTP_CODE2"
        else
            echo "❌ 固定密码也登录失败"
            rm -f /tmp/cookies.txt /tmp/headers.txt
            exit 0
        fi
    else
        rm -f /tmp/cookies.txt /tmp/headers.txt
        exit 0
    fi
fi

echo "✅ 登录成功 (Token: ${BHToken:0:20}...)"

# ============================================================
# 8. 下载备份
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
# 9. 执行恢复
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
# 10. 清理和重启
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