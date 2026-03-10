/**
 * set-admin.js - 设置超级管理员
 * 
 * 使用方法：node set-admin.js
 * 
 * 只将 vip-888 设置为超级管理员，其他用户全部降为普通用户
 */

const userRepo = require('./db/userRepo');

console.log('========================================');
console.log('  🔐 设置超级管理员');
console.log('========================================\n');

const ADMIN_KEYS = ['vip-888'];

// 先把所有用户降为普通用户
const allUsers = userRepo.getAll();
for (const user of allUsers) {
    if (!ADMIN_KEYS.includes(user.license_key)) {
        userRepo.setAdmin(user.license_key, false);
    }
}
console.log(`[UserRepo] 已重置 ${allUsers.length - ADMIN_KEYS.length} 个用户的管理员权限`);

// 再设置指定用户为管理员
let updated = 0;
for (const key of ADMIN_KEYS) {
    const user = userRepo.findByKey(key);
    if (user) {
        userRepo.setAdmin(key, true);
        console.log(`[UserRepo] 设置管理员: ${key}`);
        updated++;
    } else {
        console.log(`[UserRepo] ⚠️ 未找到用户: ${key}`);
    }
}

console.log('');
console.log('========================================');
console.log(`✅ 完成！共设置 ${updated} 个管理员`);
console.log('========================================');
console.log('');
console.log('管理员权限：');
console.log('  - 跳过 API 限速');
console.log('  - 跳过过期检查');
console.log('========================================');
