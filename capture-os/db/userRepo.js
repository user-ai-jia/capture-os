/**
 * 用户数据仓库 - 封装所有用户相关的数据库操作
 * 
 * 设计原则：
 * - 隔离 SQL 逻辑，便于未来迁移到其他数据库
 * - 使用预编译语句，防止 SQL 注入
 * - 统一的返回格式
 */

const db = require('./database');

// ============================================
// 预编译 SQL 语句（提升性能）
// ============================================

const stmts = {
    findByKey: db.prepare(`
        SELECT license_key, owner, connected, expire, notion_token, status, batch_id, is_admin, created_at, updated_at
        FROM users 
        WHERE license_key = ?
    `),

    create: db.prepare(`
        INSERT INTO users (license_key, owner, expire) 
        VALUES (?, ?, ?)
    `),

    createWithBatch: db.prepare(`
        INSERT INTO users (license_key, batch_id, status) 
        VALUES (?, ?, 'unused')
    `),

    updateToken: db.prepare(`
        UPDATE users 
        SET notion_token = ?, connected = 1, status = 'active', updated_at = CURRENT_TIMESTAMP 
        WHERE license_key = ?
    `),

    setConnected: db.prepare(`
        UPDATE users 
        SET connected = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE license_key = ?
    `),

    activate: db.prepare(`
        UPDATE users 
        SET status = 'active', updated_at = CURRENT_TIMESTAMP 
        WHERE license_key = ?
    `),

    getAll: db.prepare(`
        SELECT license_key, owner, connected, expire, notion_token, status, batch_id, is_admin, created_at, updated_at
        FROM users
    `),

    count: db.prepare(`SELECT COUNT(*) as total FROM users`),

    countByBatch: db.prepare(`SELECT COUNT(*) as total FROM users WHERE batch_id = ?`),

    countByStatus: db.prepare(`SELECT COUNT(*) as total FROM users WHERE status = ?`),

    setAdmin: db.prepare(`
        UPDATE users 
        SET is_admin = ?, updated_at = CURRENT_TIMESTAMP 
        WHERE license_key = ?
    `),

    getFirstN: db.prepare(`
        SELECT license_key FROM users ORDER BY created_at ASC LIMIT ?
    `)
};

// ============================================
// 导出的 API 方法
// ============================================

/**
 * 根据 License Key 查询用户
 * @param {string} licenseKey 
 * @returns {object|undefined} 用户对象，不存在则返回 undefined
 */
function findByKey(licenseKey) {
    const row = stmts.findByKey.get(licenseKey);
    if (!row) return undefined;

    // 转换 connected 和 is_admin 为布尔值（SQLite 存储为 0/1）
    return {
        ...row,
        connected: Boolean(row.connected),
        is_admin: Boolean(row.is_admin)
    };
}

/**
 * 创建新用户
 * @param {string} licenseKey 
 * @param {string} owner 
 * @param {string} expire 过期日期，格式 YYYY-MM-DD
 * @returns {object} 插入结果
 */
function create(licenseKey, owner = '', expire = null) {
    const result = stmts.create.run(licenseKey, owner, expire);
    return { success: result.changes > 0, licenseKey };
}

/**
 * 创建激活码（KeyGen 专用）
 * @param {string} licenseKey 
 * @param {string} batchId 批次号
 * @returns {object} 插入结果
 */
function createWithBatch(licenseKey, batchId) {
    const result = stmts.createWithBatch.run(licenseKey, batchId);
    return { success: result.changes > 0, licenseKey };
}

/**
 * 更新用户的 Notion Token（同时设置 connected = true, status = 'active'）
 * @param {string} licenseKey 
 * @param {string} token 
 * @returns {object} 更新结果
 */
function updateToken(licenseKey, token) {
    const result = stmts.updateToken.run(token, licenseKey);
    return { success: result.changes > 0 };
}

/**
 * 设置用户连接状态
 * @param {string} licenseKey 
 * @param {boolean} status 
 * @returns {object} 更新结果
 */
function setConnected(licenseKey, status) {
    const result = stmts.setConnected.run(status ? 1 : 0, licenseKey);
    return { success: result.changes > 0 };
}

/**
 * 激活 License Key
 * @param {string} licenseKey 
 * @returns {object} 更新结果
 */
function activate(licenseKey) {
    const result = stmts.activate.run(licenseKey);
    return { success: result.changes > 0 };
}

/**
 * 检查用户是否已过期
 * @param {object} user 用户对象（需包含 expire 字段）
 * @returns {boolean} 是否过期
 */
function isExpired(user) {
    if (!user || !user.expire) return false;
    return new Date(user.expire) < new Date();
}

/**
 * 获取所有用户
 * @returns {array} 用户列表
 */
function getAll() {
    return stmts.getAll.all().map(row => ({
        ...row,
        connected: Boolean(row.connected)
    }));
}

/**
 * 获取用户总数
 * @returns {number}
 */
function count() {
    return stmts.count.get().total;
}

/**
 * 获取某批次的 Key 数量
 * @param {string} batchId 
 * @returns {number}
 */
function countByBatch(batchId) {
    return stmts.countByBatch.get(batchId).total;
}

/**
 * 获取某状态的用户数量
 * @param {string} status 'unused' | 'active'
 * @returns {number}
 */
function countByStatus(status) {
    return stmts.countByStatus.get(status).total;
}

/**
 * 批量插入用户（用于迁移）
 * @param {array} users 用户数组
 * @returns {object} 迁移结果
 */
function bulkInsert(users) {
    const insertMany = db.transaction((items) => {
        let inserted = 0;
        for (const user of items) {
            try {
                db.prepare(`
                    INSERT OR REPLACE INTO users (license_key, owner, connected, expire, notion_token, status, batch_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(
                    user.license_key,
                    user.owner || '',
                    user.connected ? 1 : 0,
                    user.expire || null,
                    user.notion_token || null,
                    user.status || 'active',
                    user.batch_id || null
                );
                inserted++;
            } catch (err) {
                console.error(`[UserRepo] 插入失败: ${user.license_key}`, err.message);
            }
        }
        return inserted;
    });

    const count = insertMany(users);
    return { success: true, inserted: count };
}

/**
 * 设置用户管理员状态
 * @param {string} licenseKey 
 * @param {boolean} isAdmin 
 * @returns {object} 更新结果
 */
function setAdmin(licenseKey, isAdmin) {
    const result = stmts.setAdmin.run(isAdmin ? 1 : 0, licenseKey);
    return { success: result.changes > 0 };
}

/**
 * 将前 N 个用户设置为管理员
 * @param {number} n 
 * @returns {object} 设置结果
 */
function setFirstNAsAdmin(n) {
    const rows = stmts.getFirstN.all(n);
    let updated = 0;
    for (const row of rows) {
        const result = stmts.setAdmin.run(1, row.license_key);
        if (result.changes > 0) {
            updated++;
            console.log(`[UserRepo] 设置管理员: ${row.license_key}`);
        }
    }
    return { success: true, updated };
}

/**
 * 检查用户是否为管理员
 * @param {object} user 用户对象
 * @returns {boolean}
 */
function isAdmin(user) {
    return user && user.is_admin === true;
}

module.exports = {
    findByKey,
    create,
    createWithBatch,
    updateToken,
    setConnected,
    activate,
    isExpired,
    isAdmin,
    setAdmin,
    setFirstNAsAdmin,
    getAll,
    count,
    countByBatch,
    countByStatus,
    bulkInsert
};
