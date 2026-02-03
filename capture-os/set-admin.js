/**
 * set-admin.js - 设置超级管理员
 * 
 * 使用方法：node set-admin.js
 * 
 * 将前 5 个用户设置为超级管理员，不受限速和过期限制
 */

const userRepo = require('./db/userRepo');

console.log('========================================');
console.log('  🔐 设置超级管理员');
console.log('========================================\n');

const result = userRepo.setFirstNAsAdmin(5);

console.log('');
console.log('========================================');
console.log(`✅ 完成！共设置 ${result.updated} 个管理员`);
console.log('========================================');
console.log('');
console.log('管理员权限：');
console.log('  - 跳过 API 限速');
console.log('  - 跳过过期检查');
console.log('========================================');
