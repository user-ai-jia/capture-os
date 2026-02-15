/**
 * SQLite 数据库连接和初始化模块
 * 
 * 特性：
 * - WAL 模式：提升并发读写性能
 * - busy_timeout：避免数据库锁冲突
 * - 自动创建 users 表
 */

const Database = require('better-sqlite3');
const path = require('path');

// 数据库文件路径
const DB_PATH = path.join(__dirname, '..', 'data', 'capture-os.db');

// 创建数据库连接
const db = new Database(DB_PATH);

// 启用 WAL 模式 - 提升并发性能
db.pragma('journal_mode = WAL');

// 设置忙等待超时 - 避免 SQLITE_BUSY 错误
db.pragma('busy_timeout = 5000');

// 初始化 users 表
const initTable = () => {
    // 1. 创建表（如果不存在）- 基础字段
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            license_key TEXT PRIMARY KEY,
            owner TEXT,
            connected INTEGER DEFAULT 0,
            expire TEXT,
            notion_token TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // 2. 兼容旧数据库：添加新字段（如果不存在）
    // 必须在预编译 SQL 语句之前完成
    const columns = db.prepare("PRAGMA table_info(users)").all();
    const columnNames = columns.map(c => c.name);

    if (!columnNames.includes('status')) {
        db.exec(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'unused'`);
        console.log('[Database] 添加字段: status');
    }

    if (!columnNames.includes('batch_id')) {
        db.exec(`ALTER TABLE users ADD COLUMN batch_id TEXT`);
        console.log('[Database] 添加字段: batch_id');
    }

    if (!columnNames.includes('is_admin')) {
        db.exec(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`);
        console.log('[Database] 添加字段: is_admin');
    }

    if (!columnNames.includes('database_id')) {
        db.exec(`ALTER TABLE users ADD COLUMN database_id TEXT`);
        console.log('[Database] 添加字段: database_id');
    }

    // 3. 创建索引
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_users_connected ON users(connected);
        CREATE INDEX IF NOT EXISTS idx_users_expire ON users(expire);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
        CREATE INDEX IF NOT EXISTS idx_users_batch ON users(batch_id);
    `);

    console.log('[Database] ✅ SQLite 数据库初始化完成');
};

// 执行初始化
initTable();

module.exports = db;
