/**
 * 数据迁移脚本
 * 
 * 用途：将 users.json 中的数据迁移到 SQLite 数据库
 * 使用方法：node migrate.js
 */

const fs = require('fs');
const path = require('path');
const userRepo = require('./db/userRepo');

const JSON_FILE = path.join(__dirname, 'users.json');

console.log('================================================');
console.log('  Capture OS Pro - 数据迁移工具');
console.log('================================================\n');

// 检查源文件是否存在
if (!fs.existsSync(JSON_FILE)) {
    console.log('❌ 未找到 users.json 文件，无需迁移。');
    process.exit(0);
}

// 读取 JSON 数据
let jsonData;
try {
    const content = fs.readFileSync(JSON_FILE, 'utf8');
    jsonData = JSON.parse(content);
    console.log(`📂 已读取 users.json，共 ${Object.keys(jsonData).length} 条记录\n`);
} catch (err) {
    console.error('❌ 读取 users.json 失败:', err.message);
    process.exit(1);
}

// 转换数据格式
const users = Object.entries(jsonData).map(([key, value]) => ({
    license_key: key,
    owner: value.owner || '',
    connected: value.connected || false,
    expire: value.expire || null,
    notion_token: value.notion_token || null
}));

console.log('📋 准备迁移的用户:');
users.forEach((u, i) => {
    console.log(`   ${i + 1}. ${u.license_key} (${u.owner || '无备注'}) - ${u.connected ? '已连接' : '未连接'}`);
});
console.log('');

// 执行迁移
const result = userRepo.bulkInsert(users);

if (result.success) {
    console.log(`✅ 迁移完成！成功导入 ${result.inserted} 条用户记录`);
    console.log(`\n📊 数据库当前状态: 共 ${userRepo.count()} 位用户`);
} else {
    console.log('❌ 迁移失败');
    process.exit(1);
}

console.log('\n================================================');
console.log('  迁移完成！原 users.json 文件已保留作为备份');
console.log('================================================');
