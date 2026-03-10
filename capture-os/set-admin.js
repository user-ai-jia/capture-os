/**
 * set-admin.js - 管理员说明
 * 
 * 管理员判断已改为通过密钥前缀自动识别：
 * - VIP- 开头 = 超级管理员（跳过限速、跳过过期检查）
 * - CAP- 开头 = 普通用户
 * 
 * 此脚本不再需要手动执行。保留仅作说明用途。
 */

const userRepo = require('./db/userRepo');

console.log('========================================');
console.log('  🔐 管理员识别规则');
console.log('========================================\n');
console.log('  VIP-xxxx = 超级管理员（自动识别，无需手动设置）');
console.log('  CAP-xxxx = 普通用户');
console.log('');

const allUsers = userRepo.getAll();
allUsers.forEach(u => {
    const role = u.license_key.toUpperCase().startsWith('VIP') ? '👑 管理员' : '👤 普通';
    console.log(`  ${role} | ${u.license_key} | ${u.status}`);
});

console.log(`\n  共 ${allUsers.length} 个密钥`);
console.log('========================================');
