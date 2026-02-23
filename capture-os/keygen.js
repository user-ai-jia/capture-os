/**
 * keygen.js - Capture OS 商业版激活码生成器
 * 
 * 使用方法：node keygen.js
 * 可选参数：node keygen.js --count=100 --channel=XY
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const userRepo = require('./db/userRepo');

// ================= 配置区 =================
// 可通过命令行参数覆盖
const args = process.argv.slice(2).reduce((acc, arg) => {
    const [key, value] = arg.replace('--', '').split('=');
    acc[key] = value;
    return acc;
}, {});

const BATCH_SIZE = parseInt(args.count) || 50;  // 批量大小
const CHANNEL = args.channel || "TB";           // 渠道：TB=淘宝, XY=闲鱼, MD=面包多
const DATE_STR = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const BATCH_ID = `${CHANNEL}-${DATE_STR}`;      // 批次号，如 TB-20260202

// 默认过期时间（1年后）
const DEFAULT_EXPIRE_DAYS = 365;
// ==========================================

/**
 * 生成随机 Key
 * 格式: CAP-XXXX-XXXX-XXXX
 * 熵值: 16^12 = 281 万亿种组合
 */
function generateRandomKey() {
    const chars = crypto.randomBytes(6).toString('hex').toUpperCase();
    return `CAP-${chars.substring(0, 4)}-${chars.substring(4, 8)}-${chars.substring(8, 12)}`;
}

/**
 * 主程序
 */
function main() {
    console.log('========================================');
    console.log('  🏭 Capture OS 激活码生成器 (KeyGen)');
    console.log('========================================\n');

    console.log(`📋 配置信息:`);
    console.log(`   批次号: ${BATCH_ID}`);
    console.log(`   生成数量: ${BATCH_SIZE}`);
    console.log(`   渠道: ${CHANNEL}`);
    console.log('');

    const newKeys = [];
    let successCount = 0;
    let duplicateCount = 0;

    process.stdout.write('⏳ 生成中: ');

    for (let i = 0; i < BATCH_SIZE; i++) {
        let key = generateRandomKey();
        let attempts = 0;
        const maxAttempts = 10;

        // 防重复检查
        while (userRepo.findByKey(key) && attempts < maxAttempts) {
            duplicateCount++;
            key = generateRandomKey();
            attempts++;
        }

        if (attempts >= maxAttempts) {
            console.warn(`\n⚠️ 警告: 尝试 ${maxAttempts} 次仍有重复，跳过`);
            continue;
        }

        // 写入数据库
        try {
            const result = userRepo.createWithBatch(key, BATCH_ID);
            if (result.success) {
                newKeys.push(key);
                successCount++;
                process.stdout.write('.');
            }
        } catch (err) {
            console.error(`\n❌ 写入失败: ${key}`, err.message);
        }
    }

    console.log('\n');

    // 导出到 TXT 文件
    const exportDir = path.join(__dirname, 'exports');
    if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
    }

    const exportFileName = `keys_${BATCH_ID}_${Date.now()}.txt`;
    const exportPath = path.join(exportDir, exportFileName);

    fs.writeFileSync(exportPath, newKeys.join('\n'));

    // 统计信息
    console.log('========================================');
    console.log('  ✅ 生产完成！');
    console.log('========================================');
    console.log(`📊 成功入库: ${successCount} / ${BATCH_SIZE}`);
    console.log(`🏷️  批次编号: ${BATCH_ID}`);
    console.log(`📂 发货文件: exports/${exportFileName}`);
    console.log(`📈 数据库总用户数: ${userRepo.count()}`);

    if (duplicateCount > 0) {
        console.log(`⚠️  重复跳过: ${duplicateCount} 次`);
    }

    // 打印所有生成的密钥
    console.log('');
    console.log('========================================');
    console.log('  📋 生成的密钥列表：');
    console.log('========================================');
    newKeys.forEach((key, i) => {
        console.log(`  ${String(i + 1).padStart(3)}. ${key}`);
    });
    console.log('========================================');

    console.log('');
    console.log('👉 请下载 exports/ 目录下的 TXT 文件上传至发货后台');
    console.log('========================================');
}

// 执行
main();
