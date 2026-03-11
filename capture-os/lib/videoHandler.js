/**
 * 视频处理管线
 * 
 * 从页面提取视频 URL → 下载 → 获取时长 → 送入 ASR
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const xfyunAsr = require('./xfyunAsr');

const TMP_DIR = path.join(os.tmpdir(), 'capture-os-video');

// 确保临时目录存在
if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * 从页面 HTML 提取视频 URL
 * 支持：og:video meta、video 标签、JSON 内的视频链接
 */
function extractVideoUrl($, pageUrl) {
    if (!$) return null;

    // 1. og:video meta 标签
    const ogVideo = $('meta[property="og:video"]').attr('content')
        || $('meta[property="og:video:url"]').attr('content')
        || $('meta[property="og:video:secure_url"]').attr('content');
    if (ogVideo) {
        console.log(`[视频提取] og:video: ${ogVideo.substring(0, 80)}...`);
        return ogVideo;
    }

    // 2. video 标签的 src
    const videoSrc = $('video source').first().attr('src')
        || $('video').first().attr('src');
    if (videoSrc) {
        console.log(`[视频提取] video src: ${videoSrc.substring(0, 80)}...`);
        // 处理相对 URL
        if (videoSrc.startsWith('//')) return 'https:' + videoSrc;
        if (videoSrc.startsWith('/')) {
            const base = new URL(pageUrl);
            return base.origin + videoSrc;
        }
        return videoSrc;
    }

    // 3. 页面 script 中的视频 URL（通用模式）
    const scripts = [];
    $('script').each((_, el) => {
        const text = $(el).html();
        if (text && text.length > 100) scripts.push(text);
    });

    for (const script of scripts) {
        // 小红书 SSR 状态数据
        const xhsMatch = script.match(/"originVideoKey"\s*:\s*"([^"]+)"/);
        if (xhsMatch) {
            const videoKey = xhsMatch[1];
            const videoUrl = `https://sns-video-bd.xhscdn.com/${videoKey}`;
            console.log(`[视频提取] 小红书 video key: ${videoKey}`);
            return videoUrl;
        }

        // 通用视频 URL 模式
        const urlMatch = script.match(/https?:\/\/[^"'\s]+\.(?:mp4|m3u8|mp3|m4a)[^"'\s]*/i);
        if (urlMatch) {
            console.log(`[视频提取] script 中找到: ${urlMatch[0].substring(0, 80)}...`);
            return urlMatch[0];
        }
    }

    return null;
}

/**
 * 下载视频/音频文件到临时目录
 * @param {string} videoUrl 
 * @returns {string} 本地文件路径
 */
async function downloadMedia(videoUrl) {
    const ext = getExtFromUrl(videoUrl);
    const fileName = `capture_${Date.now()}${ext}`;
    const filePath = path.join(TMP_DIR, fileName);

    console.log(`[视频下载] 开始下载: ${videoUrl.substring(0, 80)}...`);

    const response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        timeout: 60000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
            'Referer': videoUrl
        },
        maxContentLength: 500 * 1024 * 1024 // 500MB
    });

    const writer = fs.createWriteStream(filePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    const size = fs.statSync(filePath).size;
    console.log(`[视频下载] 完成: ${fileName} (${(size / 1024 / 1024).toFixed(1)}MB)`);

    return filePath;
}

function getExtFromUrl(url) {
    try {
        const pathname = new URL(url).pathname;
        const ext = path.extname(pathname).split('?')[0];
        return ext || '.mp4';
    } catch {
        return '.mp4';
    }
}

/**
 * 获取媒体文件时长（毫秒）
 * 尝试多种方法：ffprobe → 估算
 */
async function getMediaDuration(filePath) {
    // 方法 1：尝试 ffprobe
    try {
        const duration = await new Promise((resolve, reject) => {
            exec(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
                { timeout: 10000 },
                (err, stdout) => {
                    if (err) reject(err);
                    else resolve(parseFloat(stdout.trim()));
                }
            );
        });
        if (!isNaN(duration) && duration > 0) {
            return Math.ceil(duration * 1000);
        }
    } catch (e) {
        console.log('[时长检测] ffprobe 不可用，使用估算');
    }

    // 方法 2：根据文件大小估算（假设 128kbps 音频或 2Mbps 视频）
    const size = fs.statSync(filePath).size;
    const ext = path.extname(filePath).toLowerCase();

    if (['.mp3', '.m4a', '.aac', '.wav', '.ogg'].includes(ext)) {
        // 音频：假设平均 128kbps
        return Math.ceil((size * 8) / 128000 * 1000);
    } else {
        // 视频：假设平均 2Mbps
        return Math.ceil((size * 8) / 2000000 * 1000);
    }
}

/**
 * 清理临时文件
 */
function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[清理] 删除临时文件: ${path.basename(filePath)}`);
        }
    } catch (e) {
        console.warn(`[清理] 删除失败: ${e.message}`);
    }
}

/**
 * 判断 URL 是否可能含有视频内容
 */
function isVideoPlatform(url, platform) {
    if (!url) return false;
    const u = url.toLowerCase();

    // 明确的视频平台
    if (platform === '抖音' || platform === '小红书') return true;
    if (u.includes('douyin.com')) return true;
    if (u.includes('kuaishou.com') || u.includes('kwai.com')) return true;
    if (u.includes('bilibili.com') || u.includes('b23.tv')) return true;

    // 小红书需要进一步判断（可能是图文也可能是视频）
    if (u.includes('xiaohongshu.com') || u.includes('xhslink.com')) return true;

    // URL 路径包含 video
    if (u.includes('/video/') || u.includes('/video?')) return true;

    return false;
}

/**
 * 完整的视频处理管线
 * @param {string} pageUrl - 页面 URL
 * @param {object} $ - cheerio 对象（已解析的页面）
 * @param {string} platform - 平台名称
 * @param {object} asrConfig - { appId, apiKey, apiSecret }
 * @returns {string|null} 转写文本，失败返回 null
 */
async function processVideo(pageUrl, $, platform, asrConfig) {
    let mediaPath = null;

    try {
        // 1. 从页面提取视频 URL
        const videoUrl = extractVideoUrl($, pageUrl);
        if (!videoUrl) {
            console.log('[视频管线] 未找到视频 URL，跳过');
            return null;
        }

        // 2. 下载视频
        mediaPath = await downloadMedia(videoUrl);

        // 3. 获取时长
        const durationMs = await getMediaDuration(mediaPath);
        console.log(`[视频管线] 时长: ${Math.round(durationMs / 1000)}秒`);

        // 4. ASR 转写
        const transcript = await xfyunAsr.transcribe(mediaPath, durationMs, asrConfig);

        return transcript || null;

    } catch (e) {
        console.error(`[视频管线] 处理失败: ${e.message}`);
        return null;

    } finally {
        // 5. 清理临时文件
        cleanupFile(mediaPath);
    }
}

module.exports = {
    processVideo,
    extractVideoUrl,
    downloadMedia,
    getMediaDuration,
    isVideoPlatform,
    cleanupFile
};
