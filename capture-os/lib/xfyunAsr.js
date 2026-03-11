/**
 * 讯飞录音文件转写大模型 API 封装
 * 
 * 流程：上传音频 → 获取 orderId → 轮询结果 → 解析文本
 * 文档：录音文件转写大模型 WebAPI
 */

const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://office-api-ist-dx.iflyaisol.com';

// ===== 签名工具 =====

function getDateTime() {
    const now = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    const offset = -now.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const hh = pad(Math.floor(Math.abs(offset) / 60));
    const mm = pad(Math.abs(offset) % 60);
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${hh}${mm}`;
}

function randomString(len) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < len; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * 生成 HMAC-SHA1 签名
 * 按照讯飞文档：参数排序 → 值 URL 编码 → HMAC-SHA1 → Base64
 */
function generateSignature(params, apiSecret) {
    const sortedKeys = Object.keys(params).filter(k => k !== 'signature').sort();
    const pairs = [];
    for (const key of sortedKeys) {
        const val = params[key];
        if (val !== undefined && val !== null && val !== '') {
            pairs.push(`${key}=${encodeURIComponent(val)}`);
        }
    }
    const baseString = pairs.join('&');
    const hmac = crypto.createHmac('sha1', Buffer.from(apiSecret, 'utf8'));
    hmac.update(Buffer.from(baseString, 'utf8'));
    return hmac.digest('base64');
}

// ===== 核心接口 =====

/**
 * 上传音频文件
 * @param {string} filePath - 音频/视频文件路径
 * @param {number} durationMs - 音频时长（毫秒）
 * @param {object} config - { appId, apiKey, apiSecret }
 * @returns {object} { orderId, taskEstimateTime }
 */
async function uploadAudio(filePath, durationMs, config) {
    const { appId, apiKey, apiSecret } = config;
    const stat = fs.statSync(filePath);

    const params = {
        appId,
        accessKeyId: apiKey,
        dateTime: getDateTime(),
        signatureRandom: randomString(16),
        fileSize: stat.size.toString(),
        fileName: path.basename(filePath),
        duration: durationMs.toString(),
        language: 'autodialect'
    };

    const signature = generateSignature(params, apiSecret);

    const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

    const url = `${BASE_URL}/v2/upload?${queryString}&signature=${encodeURIComponent(signature)}`;

    const fileData = fs.readFileSync(filePath);

    const response = await axios.post(url, fileData, {
        headers: { 'Content-Type': 'application/octet-stream' },
        maxContentLength: 500 * 1024 * 1024,
        maxBodyLength: 500 * 1024 * 1024,
        timeout: 120000
    });

    if (response.data.code !== '000000') {
        throw new Error(`ASR 上传失败: ${response.data.descInfo} (code: ${response.data.code})`);
    }

    return response.data.content;
}

/**
 * 查询转写结果
 * @param {string} orderId - 订单 ID
 * @param {object} config - { apiKey, apiSecret }
 * @returns {object} API 响应
 */
async function queryResult(orderId, config) {
    const { apiKey, apiSecret } = config;

    const params = {
        accessKeyId: apiKey,
        dateTime: getDateTime(),
        signatureRandom: randomString(16),
        orderId,
        resultType: 'transfer'
    };

    const signature = generateSignature(params, apiSecret);

    const queryString = Object.entries(params)
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join('&');

    const url = `${BASE_URL}/v2/getResult?${queryString}&signature=${encodeURIComponent(signature)}`;

    const response = await axios.post(url, {}, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
    });

    if (response.data.code !== '000000') {
        throw new Error(`ASR 查询失败: ${response.data.descInfo} (code: ${response.data.code})`);
    }

    return response.data.content;
}

/**
 * 解析讯飞转写结果 JSON → 纯文本
 * lattice[].json_1best.st.rt[].ws[].cw[].w
 */
function parseTranscript(orderResult) {
    try {
        const result = typeof orderResult === 'string' ? JSON.parse(orderResult) : orderResult;
        const lattice = result.lattice || [];
        let text = '';

        for (const item of lattice) {
            const json1best = typeof item.json_1best === 'string'
                ? JSON.parse(item.json_1best)
                : item.json_1best;

            const st = json1best?.st;
            if (!st || !st.rt) continue;

            for (const rt of st.rt) {
                if (!rt.ws) continue;
                for (const ws of rt.ws) {
                    if (!ws.cw) continue;
                    for (const cw of ws.cw) {
                        if (cw.w && cw.wp !== 'g') { // g = 分段标记，跳过
                            text += cw.w;
                        }
                    }
                }
            }
        }

        return text.replace(/\s+/g, ' ').trim();
    } catch (e) {
        console.error('[ASR] 解析转写结果失败:', e.message);
        return '';
    }
}

/**
 * 完整转写流程：上传 → 轮询 → 返回文本
 * @param {string} filePath - 音频/视频文件路径
 * @param {number} durationMs - 时长（毫秒）
 * @param {object} config - { appId, apiKey, apiSecret }
 * @returns {string} 转写文本
 */
async function transcribe(filePath, durationMs, config) {
    console.log(`[ASR] 上传音频: ${path.basename(filePath)} (${(fs.statSync(filePath).size / 1024 / 1024).toFixed(1)}MB, ${Math.round(durationMs / 1000)}秒)`);

    // 1. 上传
    const uploadRes = await uploadAudio(filePath, durationMs, config);
    const orderId = uploadRes.orderId;
    console.log(`[ASR] 订单创建: ${orderId}, 预估耗时: ${Math.round(uploadRes.taskEstimateTime / 1000)}秒`);

    // 2. 轮询结果（最多等 5 分钟）
    const maxWait = 300000; // 5 分钟
    const interval = 5000;  // 每 5 秒查一次
    let elapsed = 0;

    while (elapsed < maxWait) {
        await new Promise(r => setTimeout(r, interval));
        elapsed += interval;

        const result = await queryResult(orderId, config);
        const status = result.orderInfo?.status;

        if (status === 4) {
            // 转写完成
            const text = parseTranscript(result.orderResult);
            console.log(`[ASR] 转写完成 (${Math.round(elapsed / 1000)}秒), 文本长度: ${text.length}`);
            return text;
        } else if (status === -1) {
            const failType = result.orderInfo?.failType;
            throw new Error(`ASR 转写失败 (failType: ${failType})`);
        }

        console.log(`[ASR] 处理中... ${Math.round(elapsed / 1000)}秒`);
    }

    throw new Error('ASR 转写超时（超过 5 分钟）');
}

module.exports = { transcribe, parseTranscript, generateSignature };
