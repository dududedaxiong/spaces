#!/bin/sh

# ============================================================
# 白虎面板 - 备份脚本
# 功能：备份面板数据并上传到 Hugging Face Dataset
# ============================================================

# ==================== 配置区 ====================
# 用户名固定为 admin
USERNAME="admin"

# 远程存储路径（从环境变量读取）
# 如果没有设置环境变量，使用默认值
if [ -z "$REMOTE_FOLDER" ]; then
    REMOTE_FOLDER="huggingface:/"
    echo "未设置 REMOTE_FOLDER 环境变量，使用默认值: $REMOTE_FOLDER"
fi

# ==================== 开始备份 ====================
echo "=========================================="
echo "🔄 白虎面板备份开始"
echo "=========================================="
echo "时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "远程存储: $REMOTE_FOLDER"
echo ""

# 1. 登录获取 Token
echo "📝 开始登录面板..."
BHToken=$(
curl -c cookies.txt -s -D - -o /dev/null \
'http://localhost:8052/api/v1/auth/login' \
-H 'content-type: application/json' \
--data-raw "{\"username\":\"$USERNAME\",\"password\":\"$ADMIN_PASSWORD\"}" \
| awk -F'[=;]' '/Set-Cookie: BHToken=/{print $2}'
)

if [ -z "$BHToken" ]; then
    echo "❌ 登录失败！请检查 ADMIN_PASSWORD 环境变量"
    echo "当前 ADMIN_PASSWORD: ${ADMIN_PASSWORD:-未设置}"
    exit 1
fi

echo "✅ 登录成功，Token: ${BHToken:0:20}..."

# 2. 生成备份文件
echo "📦 正在生成备份文件..."
BACKUP_RESPON=$(
    curl -b cookies.txt -X POST "http://localhost:8052/api/v1/settings/backup" \
    -H 'content-type: application/json' \
    --compressed
)

# 检查是否成功
if [ $? -ne 0 ]; then
    echo "❌ 生成备份失败！"
    rm -f cookies.txt
    exit 1
fi

echo "✅ 备份文件生成完成"

# 3. 等待备份文件写入完成
echo "⏳ 等待 10 秒让备份文件写入完成..."
sleep 10

# 4. 获取最新的备份文件
latest_file=$(ls -t /app/data/backups | head -n 1)

if [ -z "$latest_file" ]; then
    echo "❌ 未找到备份文件！"
    rm -f cookies.txt
    exit 1
fi

echo "📁 找到备份文件: $latest_file"
file_size=$(du -h /app/data/backups/$latest_file | cut -f1)
echo "📊 文件大小: $file_size"

# 5. 上传到远程存储
echo "☁️ 正在上传到远程存储..."
echo "   目标: $REMOTE_FOLDER"

# 先测试远程路径是否可访问
rclone ls $REMOTE_FOLDER > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "⚠️ 远程路径不可访问，尝试创建目录..."
    rclone mkdir $REMOTE_FOLDER
    if [ $? -ne 0 ]; then
        echo "❌ 创建远程目录失败！"
        rm -f cookies.txt
        exit 1
    fi
fi

# 执行上传
rclone copy /app/data/backups/$latest_file $REMOTE_FOLDER/

if [ $? -eq 0 ]; then
    echo "✅ 上传成功！"
else
    echo "❌ 上传失败！"
    rm -f cookies.txt
    exit 1
fi

# 6. 验证上传
echo "🔍 验证上传结果..."
rclone ls $REMOTE_FOLDER | grep "$latest_file"
if [ $? -eq 0 ]; then
    echo "✅ 验证成功，文件已在远程存储中"
else
    echo "⚠️ 验证失败，文件可能未完整上传"
fi

# 7. 清理本地备份文件（可选）
echo "🧹 清理本地备份文件..."
rm -f /app/data/backups/$latest_file
if [ $? -eq 0 ]; then
    echo "✅ 本地备份文件已删除"
else
    echo "⚠️ 删除本地备份文件失败"
fi

# 8. 清理 cookies
rm -f cookies.txt

echo ""
echo "=========================================="
echo "✅ 备份完成！"
echo "=========================================="
echo "备份文件: $latest_file"
echo "远程存储: $REMOTE_FOLDER"
echo "完成时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="