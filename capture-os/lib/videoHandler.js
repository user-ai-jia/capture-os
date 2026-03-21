/**
 * 视频处理管线 - puppeteer-core 版（Sealos 专用）
 *
 * 使用系统 Chromium（由 entrypoint.sh 安装），通过 puppeteer-core 驱动。
 * 不依赖 puppeteer 全量包，避免 npm install 时下载 Chromium 导致 OOM。
 *
 * 使用无头浏览器加载页面 → 拦截网络请求找到视频 URL → 下载 → ASR
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const xfyunAsr = require('./xfyunAsr');

const TMP_DIR = path.join(os.tmpdir(), 'capture-os-video');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// puppeteer-core 懒加载（避免未安装时崩溃）
let puppeteer = null;
function getPuppeteer() {
    if (!puppeteer) {
        try {
            puppeteer = require('puppeteer-core');
        } catch (e) {
            console.warn('[Puppeteer] puppeteer-core 未安装，视频提取功能不可用');
            return null;
        }
    }
    return puppeteer;
}

// 自动探测系统 Chromium 路径
function getChromiumExecutablePath() {
    // 优先使用 entrypoint.sh 导出的环境变量
    if (process.env.CHROMIUM_EXECUTABLE_PATH) {
        return process.env.CHROMIUM_EXECUTABLE_PATH;
    }

    // 扫描持久化存储卷中的 Chrome for Testing 二进制（entrypoint.sh 下载到此处）
    const chromeCacheDir = '/home/node/.puppeteer-cache';
    if (fs.existsSync(chromeCacheDir)) {
        try {
            // 递归找 chrome 可执行文件
            const findChrome = (dir, depth = 0) => {
                if (depth > 4) return null;
                const entries = fs.readdirSync(dir);
                for (const entry of entries) {
                    const fullPath = `${dir}/${entry}`;
                    if (entry === 'chrome' && fs.statSync(fullPath).isFile()) return fullPath;
                    if (fs.statSync(fullPath).isDirectory()) {
                        const found = findChrome(fullPath, depth + 1);
                        if (found) return found;
                    }
                }
                return null;
            };
            const found = findChrome(chromeCacheDir);
            if (found) return found;
        } catch { }
    }

    // 常见系统路径回退
    const candidates = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/snap/bin/chromium'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    console.warn('[Puppeteer] 未找到 Chrome，请确认 entrypoint.sh 已成功下载');
    return null;
}


// ===== 浏览器单例管理 =====
let browserInstance = null;

async function getBrowser() {
    if (browserInstance && browserInstance.connected) {
        return browserInstance;
    }

    const pptr = getPuppeteer();
    if (!pptr) throw new Error('Puppeteer 未安装');

    const executablePath = getChromiumExecutablePath();
    if (!executablePath) throw new Error('未找到 Chromium，无法启动浏览器');

    console.log('[Puppeteer] 启动浏览器:', executablePath);
    browserInstance = await pptr.launch({
        headless: true,
        executablePath,                    // 使用系统 Chromium
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',     // 避免 /dev/shm 不足
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--single-process',            // 节省内存
            '--no-zygote'
        ],
        timeout: 30000
    });

    console.log('[Puppeteer] 浏览器已启动');
    return browserInstance;
}

// ===== 视频 URL 提取（多策略） =====

/**
 * 使用 Puppeteer 从页面提取视频 URL
 * 策略：
 * 1. 拦截网络请求，捕获 video/audio 资源
 * 2. 等待页面加载后从 DOM 提取
 * 3. 从页面 JS 变量中提取
 */
async function extractVideoWithBrowser(pageUrl, platform) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let videoUrl = null;

    try {
        // 设置移动端 UA（平台移动版更容易暴露视频 URL）
        await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
        await page.setViewport({ width: 375, height: 812 });

        // 策略 1：网络拦截 — 捕获视频资源 URL
        const videoUrls = [];
        page.on('response', async (response) => {
            const url = response.url();
            const contentType = response.headers()['content-type'] || '';

            // 匹配视频/音频资源
            if (contentType.includes('video/') || contentType.includes('audio/')) {
                videoUrls.push(url);
                console.log(`[网络拦截] 视频资源: ${url.substring(0, 80)}...`);
            }

            // 匹配常见视频 CDN URL 模式
            if (/\.(mp4|m3u8|mp3|m4a|flv)(\?|$)/i.test(url)) {
                videoUrls.push(url);
            }

            // 抖音特征：API 返回中的 play_addr
            if (url.includes('play_addr') || url.includes('video/play')) {
                videoUrls.push(url);
            }
        });

        // 加载页面
        console.log(`[Puppeteer] 加载页面: ${pageUrl.substring(0, 60)}...`);
        await page.goto(pageUrl, {
            waitUntil: 'networkidle2',
            timeout: 25000
        });

        // 等一会让视频加载
        await page.waitForTimeout(3000);

        // 策略 2：从 DOM 提取 video 标签
        if (videoUrls.length === 0) {
            const domVideo = await page.evaluate(() => {
                const video = document.querySelector('video');
                if (video) {
                    return video.src || video.querySelector('source')?.src || null;
                }
                // meta 标签
                const ogVideo = document.querySelector('meta[property="og:video"]');
                if (ogVideo) return ogVideo.content;
                return null;
            });

            if (domVideo) {
                videoUrls.push(domVideo);
                console.log(`[DOM提取] 视频: ${domVideo.substring(0, 80)}...`);
            }
        }

        // 策略 3：平台特定提取
        if (videoUrls.length === 0 && platform === '小红书') {
            const xhsVideo = await page.evaluate(() => {
                // 小红书 SSR 状态数据
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const text = s.textContent || '';
                    const match = text.match(/"originVideoKey"\s*:\s*"([^"]+)"/);
                    if (match) return `https://sns-video-bd.xhscdn.com/${match[1]}`;
                }
                return null;
            });
            if (xhsVideo) videoUrls.push(xhsVideo);
        }

        if (videoUrls.length === 0 && platform === '抖音') {
            const dyVideo = await page.evaluate(() => {
                // 抖音页面 JSON 数据
                const scripts = document.querySelectorAll('script');
                for (const s of scripts) {
                    const text = s.textContent || '';
                    const match = text.match(/"playApi"\s*:\s*"([^"]+)"/);
                    if (match) return match[1].replace(/\\u002F/g, '/');
                }
                return null;
            });
            if (dyVideo) {
                const fullUrl = dyVideo.startsWith('http') ? dyVideo : 'https:' + dyVideo;
                videoUrls.push(fullUrl);
            }
        }

        // 选最佳 URL（优先 mp4）
        videoUrl = videoUrls.find(u => u.includes('.mp4')) || videoUrls[0] || null;

        if (videoUrl) {
            console.log(`[视频提取] 成功: ${videoUrl.substring(0, 80)}...`);
        } else {
            console.log(`[视频提取] 未找到视频 URL`);
        }

    } catch (e) {
        console.error(`[Puppeteer] 页面加载失败: ${e.message}`);
    } finally {
        await page.close().catch(() => { });
    }

    return videoUrl;
}

/**
 * 从静态 HTML 提取视频 URL（cheerio，作为 Puppeteer 的回退）
 */
function extractVideoFromHtml($, pageUrl) {
    if (!$) return null;

    const ogVideo = $('meta[property="og:video"]').attr('content')
        || $('meta[property="og:video:url"]').attr('content');
    if (ogVideo) return ogVideo;

    const videoSrc = $('video source').first().attr('src') || $('video').first().attr('src');
    if (videoSrc) {
        if (videoSrc.startsWith('//')) return 'https:' + videoSrc;
        return videoSrc;
    }

    return null;
}

// ===== 下载 + 时长 + 清理 =====

async function downloadMedia(videoUrl) {
    const ext = getExtFromUrl(videoUrl);
    const fileName = `capture_${Date.now()}${ext}`;
    const filePath = path.join(TMP_DIR, fileName);

    console.log(`[视频下载] ${videoUrl.substring(0, 80)}...`);

    const response = await axios({
        method: 'GET',
        url: videoUrl,
        responseType: 'stream',
        timeout: 60000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
            'Referer': videoUrl
        },
        maxContentLength: 500 * 1024 * 1024
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
        if (['.mp4', '.mp3', '.m4a', '.wav', '.aac', '.ogg', '.flac'].includes(ext)) return ext;
    } catch { }
    return '.mp4';
}

async function getMediaDuration(filePath) {
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
        if (!isNaN(duration) && duration > 0) return Math.ceil(duration * 1000);
    } catch { }

    // 估算
    const size = fs.statSync(filePath).size;
    const ext = path.extname(filePath).toLowerCase();
    if (['.mp3', '.m4a', '.aac', '.wav'].includes(ext)) {
        return Math.ceil((size * 8) / 128000 * 1000);
    }
    return Math.ceil((size * 8) / 2000000 * 1000);
}

function cleanupFile(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch { }
}

function isVideoPlatform(url, platform) {
    if (!url) return false;
    const u = url.toLowerCase();
    if (platform === '抖音' || platform === '小红书') return true;
    if (u.includes('douyin.com') || u.includes('kuaishou.com') || u.includes('kwai.com')) return true;
    if (u.includes('bilibili.com') || u.includes('b23.tv')) return true;
    if (u.includes('xiaohongshu.com') || u.includes('xhslink.com')) return true;
    if (u.includes('/video/') || u.includes('/video?')) return true;
    return false;
}

// ===== 完整管线 =====

/**
 * 完整的视频处理管线
 * Puppeteer 提取 → 下载 → ASR → 返回文本
 */
async function processVideo(pageUrl, $, platform, asrConfig) {
    let mediaPath = null;

    try {
        // 1. 先尝试 Puppeteer 提取视频 URL
        let videoUrl = null;

        if (getPuppeteer()) {
            videoUrl = await extractVideoWithBrowser(pageUrl, platform);
        }

        // 2. 回退到静态 HTML 提取
        if (!videoUrl && $) {
            videoUrl = extractVideoFromHtml($, pageUrl);
        }

        if (!videoUrl) {
            console.log('[视频管线] 未找到视频 URL');
            return null;
        }

        // 3. 下载视频
        mediaPath = await downloadMedia(videoUrl);

        // 4. 获取时长
        const durationMs = await getMediaDuration(mediaPath);
        console.log(`[视频管线] 时长: ${Math.round(durationMs / 1000)}秒`);

        // 5. ASR 转写
        const transcript = await xfyunAsr.transcribe(mediaPath, durationMs, asrConfig);
        return transcript || null;

    } catch (e) {
        console.error(`[视频管线] 失败: ${e.message}`);
        return null;

    } finally {
        cleanupFile(mediaPath);
    }
}

// 优雅关闭浏览器
process.on('exit', () => {
    if (browserInstance) browserInstance.close().catch(() => { });
});

module.exports = {
    processVideo,
    extractVideoWithBrowser,
    isVideoPlatform,
    cleanupFile
};
