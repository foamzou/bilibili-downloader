const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const util = require('util');
const axios = require('axios');

const execPromise = util.promisify(exec);

const app = express();
const port = 5577;

// Use environment variable for content directory, with a fallback for non-Docker environments
const contentDir = process.env.CONTENT_DIR || path.join(__dirname, 'downloaded');
const logDir = path.join(contentDir, '../logs');

// In-memory store for job status
const jobs = {};

if (!fs.existsSync(contentDir)) {
    fs.mkdirSync(contentDir, { recursive: true });
}
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

function log(message, req) {
    const userAgent = req && req.headers ? req.headers['user-agent'] : 'N/A';
    const ip = req && req.ip ? req.ip : 'N/A';
    const datetime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const logMessage = `[${datetime}] [${userAgent}] [${ip}] ${message}\n`;
    const logFile = path.join(logDir, new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.log');
    fs.appendFileSync(logFile, logMessage);
}

function sendResponse(res, msg, data = "", code = -1) {
    if (!res.headersSent) {
        res.json({
            code,
            msg,
            data
        });
    }
}

/**
 * 下载函数
 * @param {string} url - 视频流 URL
 * @param {string} vid - 视频 VID (用于 Referer)
 * @param {string} filename - 保存的文件名
 * @param {function} callback - 进度回调函数，接收参数 { percent, transferred, total }
 */
async function downloadBilibiliAsset(url, vid, filename, callback) {
    const outputPath = path.resolve(__dirname, 'downloaded', filename);
    const writer = fs.createWriteStream(outputPath);
    let throttleCallbackTime = Date.now();

    try {
        const response = await axios.get(url, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36',
                'Referer': `https://www.bilibili.com/video/${vid}`,
                'Accept-Encoding': 'identity' // 禁用压缩以便准确计算字节进度
            }
        });

        const totalBytes = parseInt(response.headers['content-length'], 10);
        let transferredBytes = 0;

        // 监听数据流，计算进度
        response.data.on('data', (chunk) => {
            transferredBytes += chunk.length;
            if (callback && typeof callback === 'function' && Date.now() - throttleCallbackTime > 100) {
                throttleCallbackTime = Date.now();
                const percent = totalBytes ? (transferredBytes / totalBytes * 100).toFixed(2) : 0;
                callback({
                    percent: parseFloat(percent),
                    transferred: transferredBytes,
                    total: totalBytes || 0
                });
            }
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (error) {
        writer.close();
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        throw error;
    }
}

app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', 'https://www.bilibili.com');
    res.header('Access-Control-Allow-Methods', 'POST, GET');
    res.header('Access-Control-Allow-Headers', 'x-requested-with,content-type');
    next();
});

app.set('trust proxy', true);

function formatFilename(format, details) {
    const now = new Date();
    return format
        .replace('{title}', details.name)
        .replace('{vid}', details.vid)
        .replace('{year}', now.getFullYear())
        .replace('{month}', String(now.getMonth() + 1).padStart(2, '0'))
        .replace('{day}', String(now.getDate()).padStart(2, '0'))
        .replace(/[\\/:*?"<>|%&+]/g, '_');
}

function getFinalPath(jobRequest) {
    const { fileNameFormat, name, vid, audioUrl } = jobRequest;
    const isVideo = !!audioUrl;

    let formattedFilename = formatFilename(fileNameFormat, { name, vid });
    // 确保视频文件是 .mp4 后缀
    if (isVideo && !formattedFilename.endsWith('.mp4')) {
        const baseName = formattedFilename.replace(/\.[^/.]+$/, "");
        formattedFilename = `${baseName}.mp4`;
    }
    // 确保音频文件是 .mp3 后缀
    if (!isVideo && !formattedFilename.endsWith('.mp3')) {
        const baseName = formattedFilename.replace(/\.[^/.]+$/, "");
        formattedFilename = `${baseName}.mp3`;
    }

    const safeSavePath = contentDir;
    if (!fs.existsSync(safeSavePath)) {
        fs.mkdirSync(safeSavePath, { recursive: true });
    }
    return path.join(safeSavePath, formattedFilename);
}

// The main download logic, now fully implemented
async function runJob(jobId) {
    const job = jobs[jobId];
    if (!job) {
        log(`任务 ${jobId} 未找到.`);
        return;
    }

    const { videoUrl, audioUrl, vid, startTime, endTime } = job.request;
    const isVideo = !!audioUrl;
    const finalPath = getFinalPath(job.request);
    job.path = finalPath;

    const videoTempPath = isVideo ? path.join(contentDir, `${jobId}-video.m4s`) : null;
    const audioTempPath = path.join(contentDir, `${jobId}-audio.m4s`);
    const tempFiles = [videoTempPath, audioTempPath].filter(Boolean);

    try {
        const filesToDownload = [];
        if (isVideo) {
            filesToDownload.push({ type: 'video', url: videoUrl, path: videoTempPath });
        }
        filesToDownload.push({ type: 'audio', url: isVideo ? audioUrl : videoUrl, path: audioTempPath });

        let totalSize = 0;
        let downloadedSize = 0;

        // 1. Get total size of all files
        for (const file of filesToDownload) {
            let retries = 3;
            let success = false;
            while (retries > 0 && !success) {
                try {
                    const response = await axios.head(file.url, {
                        headers: { 'Referer': `https://www.bilibili.com/video/${vid}` },
                        timeout: 10000 // 10秒超时
                    });
                    file.size = parseInt(response.headers['content-length'], 10);
                    if (isNaN(file.size)) throw new Error(`无法获取 ${file.type} 的文件大小`);
                    totalSize += file.size;
                    success = true;
                } catch (headError) {
                    retries--;
                    log(`[Job ${jobId}] 获取文件头信息失败 (${file.type}), 剩余重试次数: ${retries}. 错误: ${headError.message}`, job.request);
                    if (retries === 0) {
                        throw new Error(`获取文件头信息失败 (${file.type}): ${headError.message}`);
                    }
                    await new Promise(resolve => setTimeout(resolve, 2000)); // 重试前等待2秒
                }
            }
        }
        job.totalSize = totalSize;

        // 2. Download files and track progress
        job.status = 'downloading';
        log(`[Job ${jobId}] 开始下载. 总大小: ${totalSize}`, job.request);

        for (const file of filesToDownload) {
            try {
                await downloadBilibiliAsset(file.url, vid, file.path, ({ transferred, total }) => {
                    job.progress = Math.floor((downloadedSize + transferred) / totalSize * 90);
                    log(`[Job ${jobId}] 下载进度: ${Math.floor((transferred) / total * 100)}%`);
                });
            } catch (error) {
                log(`[Job ${jobId}] 下载失败: ${error.message}`, job.request);
            }

            if (fs.existsSync(file.path)) {
                downloadedSize += fs.statSync(file.path).size;
            }
        }
        log(`[Job ${jobId}] 下载完成.`, job.request);


        // 3. Merge/Convert with ffmpeg
        job.status = isVideo ? 'merging' : 'converting';
        job.progress = 95;
        log(`[Job ${jobId}] 开始使用 FFMPEG 处理...`, job.request);

        let timeArgs = '';
        if (startTime) timeArgs += ` -ss ${startTime}`;
        if (endTime) timeArgs += ` -to ${endTime}`;

        const outputOptions = isVideo ? `-c copy` : `-c:a aac -b:a 192k`;
        const ffmpegCmd = isVideo
            ? `ffmpeg -y -i "${videoTempPath}" -i "${audioTempPath}" ${timeArgs} -c copy "${finalPath}"`
            : `ffmpeg -y -i "${audioTempPath}" ${timeArgs} -c:a libmp3lame -q:a 2 "${finalPath}"`; // Re-encode AAC to MP3

        log(`[Job ${jobId}] FFMPEG 命令: ${ffmpegCmd}`, job.request);
        try {
            const { stdout, stderr } = await execPromise(ffmpegCmd);
            if (stderr) {
                log(`[Job ${jobId}] FFMPEG 处理完成，有标准错误输出: ${stderr}`, job.request);
            }
        } catch (ffmpegError) {
            // Re-throw with detailed stderr
            throw new Error(`FFMPEG 失败: ${ffmpegError.stderr || ffmpegError.message}`);
        }

        job.status = 'completed';
        job.progress = 100;
        log(`[Job ${jobId}] 任务成功完成: ${finalPath}`, job.request);

    } catch (error) {
        log(`[Job ${jobId}] 任务失败: ${error.message}`, job.request);
        job.status = 'failed';
        job.error = error.message; // Store the detailed error message
    } finally {
        // Cleanup temp files
        log(`[Job ${jobId}] 清理临时文件...`, job.request);
        for (const file of tempFiles) {
            if (fs.existsSync(file)) fs.unlinkSync(file);
        }
    }
}

app.post('/download', (req, res) => {
    const { videoUrl, audioUrl, name, vid, startTime, endTime, fileNameFormat } = req.body;

    log('下载请求已收到', req);

    // Basic validation
    if (!videoUrl || !name || !vid) {
        return sendResponse(res, '无效的请求参数');
    }

    const jobId = crypto.randomBytes(8).toString('hex');
    jobs[jobId] = {
        id: jobId,
        status: 'pending',
        progress: 0,
        error: null,
        path: null,
        name: name,
        request: req.body
    };

    runJob(jobId);

    sendResponse(res, '任务已加入队列', { jobId }, 0);
});

app.post('/check-exists', (req, res) => {
    try {
        const finalPath = getFinalPath(req.body);
        if (fs.existsSync(finalPath)) {
            sendResponse(res, '文件已存在', { exists: true, path: finalPath }, 0);
        } else {
            sendResponse(res, '文件不存在', { exists: false }, 0);
        }
    } catch (error) {
        log(`文件检查出错: ${error.message}`, req);
        sendResponse(res, '检查文件是否存在时出错: ' + error.message);
    }
});

app.get('/status/:jobId', (req, res) => {
    const { jobId } = req.params;
    const job = jobs[jobId];

    if (job) {
        // Return a public-safe version of the job object
        res.json({
            id: job.id,
            status: job.status,
            progress: job.progress,
            name: job.name,
            error: job.error,
            path: job.path
        });
    } else {
        res.status(404).json({ error: '任务未找到' });
    }
});

app.get('/healthcheck', (req, res) => {
    res.status(200).send('OK');
});

const isRunningInDocker = process.env.IS_DOCKER === 'true';

app.listen(port, () => {
    log(`Bilibili Downloader backend is running on port ${port}`);
    if (isRunningInDocker) {
        console.log('✅ 服务正在 Docker 容器中运行.');
        console.log(`📹 视频将存储在您映射到 /app/downloaded 的目录中。`);
    } else {
        console.log('✅ 服务已在本地环境启动。');
        console.log(`📹 视频将存储在: ${contentDir}`);
    }
    console.log(`👂 监听端口: ${port}`);
}); 