// ==UserScript==
// @name         Bilibili downloader
// @namespace    https://github.com/foamzou/bilibili-downloader
// @version      0.4.1
// @description  哔哩哔哩（b站）音视频下载脚本，支持本地Docker部署，提供更强大的下载体验。
// @author       foamzou
// @match        https://www.bilibili.com/video/*
// @icon         https://www.google.com/s2/favicons?domain=bilibili.com
// @grant        GM_xmlhttpRequest
// ==/UserScript==

var playInfo = null;
const VIDEO_NAME = 'video.m4s';
const AUDIO_NAME = 'audio.m4s';

let userConfig = {
    fileNameFormat: '{title}',
    serverUrl: 'http://localhost:5577'
};
let downloadHistory = [];
const activePolls = new Set();

const LOCK_KEY = 'bili_downloader_history_lock';
const LOCK_TIMEOUT = 5000; // 5 seconds

// 封装 GM_xmlhttpRequest 为类似 fetch 的 API，解决 Mixed Content 问题
function gmFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        const {
            method = 'GET',
            headers = {},
            body = null
        } = options;

        GM_xmlhttpRequest({
            method: method,
            url: url,
            headers: headers,
            data: body,
            onload: function(response) {
                // 创建一个类似 fetch Response 的对象
                const fetchLikeResponse = {
                    ok: response.status >= 200 && response.status < 300,
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.responseHeaders,
                    json: function() {
                        try {
                            return Promise.resolve(JSON.parse(response.responseText));
                        } catch (e) {
                            return Promise.reject(new Error('Invalid JSON response'));
                        }
                    },
                    text: function() {
                        return Promise.resolve(response.responseText);
                    }
                };
                resolve(fetchLikeResponse);
            },
            onerror: function(error) {
                reject(new Error(error.message || 'Network error'));
            },
            ontimeout: function() {
                reject(new Error('Request timeout'));
            }
        });
    });
}

async function acquireLock() {
    const startTime = Date.now();
    while (Date.now() - startTime < LOCK_TIMEOUT) {
        const lockTimestamp = localStorage.getItem(LOCK_KEY);
        // 如果锁不存在或已超时，则获取锁
        if (!lockTimestamp || (Date.now() - parseInt(lockTimestamp, 10) > LOCK_TIMEOUT)) {
            localStorage.setItem(LOCK_KEY, Date.now().toString());
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 100)); // 随机延迟避免活锁
    }
    console.warn('获取历史记录锁超时。');
    return false;
}

function releaseLock() {
    localStorage.removeItem(LOCK_KEY);
}

(function() {
    'use strict';
    // 增加延时以确保B站页面元素加载完毕
    setTimeout(() => {
        initUI();
    }, 3000);

})();

function initUI() {
    loadConfig();
    loadHistory();
    injectStyles();
    createModal();
    createTriggerButton();
    populateConfigUI();
}

function createTriggerButton() {
    const button = document.createElement('div');
    button.innerHTML = '下载';
    button.id = 'bili-downloader-btn';
    button.addEventListener('click', () => {
        document.getElementById('bili-downloader-modal').style.display = 'block';
        checkServerStatus(); // 打开时检查服务器状态
        checkFileExists(); // 新增：打开时检查文件是否存在
        renderHistory(); // 打开时渲染历史记录
    });
    // 将按钮插入到视频操作工具栏中，这是一个更稳定的选择器
    document.querySelector('.video-toolbar-left').appendChild(button);
}

function createModal() {
    const modal = document.createElement('div');
    modal.id = 'bili-downloader-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <div class="modal-header">
                <div class="modal-title-group">
                    <h2>Bilibili 下载器</h2>
                    <a href="https://github.com/foamzou/bilibili-downloader" target="_blank" id="github-link" title="查看项目源码">[项目源码]</a>
                </div>
                <span class="close-btn">&times;</span>
            </div>
            <div class="modal-body">
                <div id="onboarding-tooltip" style="display: none;"></div>

                <div class="modal-tabs">
                    <button class="tab-btn active" data-tab="download">下载</button>
                    <button class="tab-btn" data-tab="history">下载记录</button>
                </div>

                <div class="tab-pane active" data-pane="download">
                    <div class="actions-container">
                        <div class="section">
                            <h3>下载操作</h3>
                            <button id="btnDownloadAudio">下载音频</button>
                            <button id="btnDownloadVideo">下载视频</button>
                        </div>
                        <div class="section">
                            <h3>复制代码 (本地)</h3>
                            <button id="btnCopyCodeAudio">音频命令</button>
                            <button id="btnCopyCodeVideo">视频命令</button>
                        </div>
                    </div>
                    <div class="section">
                        <h3>时间裁剪 (格式 00:00:00)</h3>
                        <input type="text" id="audioStartTime" placeholder="开始时间">
                        <input type="text" id="audioEndTime" placeholder="结束时间">
                    </div>
                    <details class="section">
                        <summary><h3>高级设置</h3></summary>
                        <div id="config-section">
                            <!-- 配置项将在这里动态添加 -->
                        </div>
                    </details>
                </div>

                <div class="tab-pane" data-pane="history">
                    <div class="section" id="history-section">
                        <div class="section-header">
                            <h3>下载记录</h3>
                            <button id="btnClearHistory">清除所有记录</button>
                        </div>
                        <div id="history-list"></div>
                    </div>
                </div>

                <div id="downloader-status" class="status-panel">
                    <p>状态：准备就绪</p>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('.close-btn').addEventListener('click', () => {
        modal.style.display = 'none';
    });

    window.addEventListener('click', (event) => {
        if (event.target == modal) {
            modal.style.display = 'none';
        }
    });

    // Tab switching logic
    modal.querySelectorAll('.tab-btn').forEach(button => {
        button.addEventListener('click', () => {
            modal.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            const tabName = button.dataset.tab;
            modal.querySelectorAll('.tab-pane').forEach(pane => {
                pane.style.display = pane.dataset.pane === tabName ? 'block' : 'none';
                if (pane.dataset.pane === 'history') {
                    renderHistory();
                }
            });
        });
    });

    // Bind events
    document.getElementById("btnDownloadAudio").addEventListener("click", () => downloadMedia('audio'));
    document.getElementById("btnDownloadVideo").addEventListener("click", () => downloadMedia('video'));
    document.getElementById("btnCopyCodeAudio").addEventListener("click", copyCodeAudio);
    document.getElementById("btnCopyCodeVideo").addEventListener("click", copyCodeVideo);
    document.getElementById("btnClearHistory").addEventListener("click", clearAllHistory);
}

function getFileName(info) {
    if (!info) return '';
    const now = new Date();
    // 替换非法文件名字符
    const safeTitle = info.name.replace(/[\\/:*?"<>|%&+]/g, '_');
    return userConfig.fileNameFormat
        .replace('{title}', safeTitle)
        .replace('{vid}', info.vid)
        .replace('{year}', now.getFullYear())
        .replace('{month}', String(now.getMonth() + 1).padStart(2, '0'))
        .replace('{day}', String(now.getDate()).padStart(2, '0'));
}

function populateConfigUI() {
    const configSection = document.getElementById('config-section');
    configSection.innerHTML = `
        <div style="margin-top: 10px;">
            <label for="configFileNameFormat">文件名格式:</label>
            <input type="text" id="configFileNameFormat" value="${userConfig.fileNameFormat}" title="可用占位符: {title}, {vid}, {year}, {month}, {day}">
        </div>
        <div style="margin-top: 10px;">
            <label for="configServerUrl">后端服务地址:</label>
            <input type="text" id="configServerUrl" value="${userConfig.serverUrl}">
        </div>
        <div class="help-text">
            <p><strong>文件名格式占位符:</strong> {title}, {vid}, {year}, {month}, {day}</p>
        </div>
    `;

    document.getElementById('configFileNameFormat').addEventListener('input', (e) => {
        userConfig.fileNameFormat = e.target.value;
        saveConfig();
    });
    document.getElementById('configServerUrl').addEventListener('input', (e) => {
        userConfig.serverUrl = e.target.value;
        saveConfig();
        checkServerStatus(); // 服务器地址变更后，立即重新检查状态
        checkFileExists(); // 配置变更时重新检查
    });
}

async function checkServerStatus() {
    const tooltip = document.getElementById('onboarding-tooltip');
    try {
        const response = await gmFetch(`${userConfig.serverUrl}/healthcheck`);
        if (response.ok) {
            tooltip.style.display = 'none';
        } else {
            throw new Error('Server not OK');
        }
    } catch (error) {
        const dockerCmd = `git clone https://github.com/foamzou/bilibili-downloader.git
cd bilibili-downloader
docker-compose up -d`;
        const sourceCmd = `git clone https://github.com/foamzou/bilibili-downloader.git
cd bilibili-downloader
npm install
node server.js`;

        tooltip.innerHTML = `
            <h3>欢迎使用！</h3>
            <p>看起来您的本地下载服务尚未运行。请按照以下步骤启动：</p>
            <div class="onboarding-tabs">
                <button class="onboarding-tab-btn active" data-tab="docker">Docker 部署</button>
                <button class="onboarding-tab-btn" data-tab="source">源码启动</button>
            </div>
            <div class="onboarding-pane active" data-pane="docker">
                <p>如果您已安装 Docker，这是最推荐的方式：</p>
                <pre id="docker-commands">${dockerCmd}</pre>
                <button class="copy-btn" data-copy-target="docker-commands">一键复制命令</button>
            </div>
            <div class="onboarding-pane" data-pane="source">
                <p>如果您熟悉 Node.js，可以从源码启动 (需要先安装 <a href="https://nodejs.org/" target="_blank">Node.js</a> 和 <a href="https://ffmpeg.org/download.html" target="_blank">FFmpeg</a>)：</p>
                <pre id="source-commands">${sourceCmd}</pre>
                <button class="copy-btn" data-copy-target="source-commands">一键复制命令</button>
            </div>
        `;
        tooltip.style.display = 'block';

        tooltip.addEventListener('click', e => {
            // Tab switching
            if (e.target.matches('.onboarding-tab-btn')) {
                const targetTab = e.target.dataset.tab;
                tooltip.querySelectorAll('.onboarding-tab-btn').forEach(btn => btn.classList.remove('active'));
                e.target.classList.add('active');
                tooltip.querySelectorAll('.onboarding-pane').forEach(pane => {
                    pane.classList.toggle('active', pane.dataset.pane === targetTab);
                });
            }
            // Copy button
            if (e.target.matches('.copy-btn')) {
                const targetId = e.target.dataset.copyTarget;
                const textToCopy = document.getElementById(targetId).textContent;
                navigator.clipboard.writeText(textToCopy).then(() => {
                    toast('部署命令已复制!', 1500);
                }, () => {
                    toast('复制失败!', 1500);
                });
            }
        });
    }
}

async function checkFileExists() {
    try {
        const playInfo = getMediaInfo();
        const { name, vid } = playInfo;

        const checkPayload = (isVideo) => ({
            fileNameFormat: userConfig.fileNameFormat,
            name,
            vid,
            isVideo
        });

        const audioExistsPromise = gmFetch(`${userConfig.serverUrl}/check-exists`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(checkPayload(false))
        }).then(res => res.json());

        const videoExistsPromise = gmFetch(`${userConfig.serverUrl}/check-exists`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(checkPayload(true))
        }).then(res => res.json());

        const [audioRes, videoRes] = await Promise.all([audioExistsPromise, videoExistsPromise]);

        const audioBtn = document.getElementById('btnDownloadAudio');
        if (audioRes.exists) {
            audioBtn.disabled = true;
            audioBtn.textContent = '音频已存在';
        } else {
            audioBtn.disabled = false;
            audioBtn.textContent = '下载音频';
        }

        const videoBtn = document.getElementById('btnDownloadVideo');
        if (videoRes.exists) {
            videoBtn.disabled = true;
            videoBtn.textContent = '视频已存在';
        } else {
            videoBtn.disabled = false;
            videoBtn.textContent = '下载视频';
        }

    } catch (e) {
        // 后端未连接时，不做处理，保留按钮可用状态
        document.getElementById('btnDownloadAudio').disabled = false;
        document.getElementById('btnDownloadAudio').textContent = '下载音频';
        document.getElementById('btnDownloadVideo').disabled = false;
        document.getElementById('btnDownloadVideo').textContent = '下载视频';
    }
}

function updateStatus(message, type = 'info') {
    const statusPanel = document.getElementById('downloader-status');
    statusPanel.innerHTML = `<p class="${type}">${message}</p>`;
}

function saveConfig() {
    localStorage.setItem('bili_downloader_config', JSON.stringify(userConfig));
}

function loadConfig() {
    const savedConfig = localStorage.getItem('bili_downloader_config');
    if (savedConfig) {
        const loadedConfig = JSON.parse(savedConfig);
        userConfig.fileNameFormat = loadedConfig.fileNameFormat || '{title}';
        userConfig.serverUrl = loadedConfig.serverUrl || 'http://localhost:5577';
    }
}

function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
        #bili-downloader-btn {
            background-color: #00aeec;
            color: white;
            padding: 5px 15px;
            border-radius: 5px;
            cursor: pointer;
            font-size: 14px;
            margin-left: 15px;
            transition: background-color 0.3s;
        }
        #bili-downloader-btn:hover {
            background-color: #00c1ff;
        }
        #bili-downloader-modal {
            display: none;
            position: fixed;
            z-index: 10000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            overflow: auto;
            background-color: rgba(0,0,0,0.5);
        }
        .modal-content {
            background-color: #fefefe;
            margin: 10% auto;
            padding: 20px;
            border: 1px solid #888;
            width: 600px;
            border-radius: 8px;
            box-shadow: 0 4px 8px 0 rgba(0,0,0,0.2);
        }
        .modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid #ddd;
            padding-bottom: 10px;
        }
        .modal-title-group {
            display: flex;
            align-items: center;
        }
        .modal-header h2 {
            margin: 0;
        }
        #github-link {
            margin-left: 10px;
            color: #00a1d6;
            transition: color 0.2s;
            text-decoration: none;
            font-size: 14px;
        }
        #github-link:hover {
            color: #00b5e5;
            text-decoration: underline;
        }
        .close-btn {
            color: #aaa;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
        }
        .close-btn:hover, .close-btn:focus {
            color: black;
        }
        .modal-body {
            padding-top: 15px;
        }
        .section {
            margin-bottom: 20px;
        }
        .section h3 {
            margin-top: 0;
            margin-bottom: 10px;
            font-size: 16px;
            border-left: 3px solid #00a1d6;
            padding-left: 8px;
        }
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .section-header h3 {
            margin-bottom: 10px;
        }
        #btnClearHistory {
            background-color: #d32f2f !important;
            color: white;
            font-size: 12px;
            padding: 5px 10px !important;
            margin-right: 0 !important;
        }
        #btnClearHistory:hover {
            background-color: #c62828 !important;
        }
        .actions-container {
            display: flex;
            justify-content: space-between;
            gap: 20px;
        }
        .actions-container .section {
            flex-grow: 1;
        }
        #bili-downloader-modal button {
            background-color: #00a1d6;
            color: white;
            border: none;
            padding: 10px 15px;
            border-radius: 4px;
            cursor: pointer;
            transition: background-color 0.3s;
            margin-right: 10px;
        }
        #bili-downloader-modal button:hover {
            background-color: #00b5e5;
        }
        #bili-downloader-modal button:disabled {
            background-color: #ccc;
            cursor: not-allowed;
        }
        #bili-downloader-modal input[type="text"] {
            width: calc(50% - 22px);
            padding: 8px;
            border-radius: 4px;
            border: 1px solid #ccc;
        }
        #config-section input[type="text"] {
            width: 100%;
            box-sizing: border-box; /*
            padding: 8px;
            border-radius: 4px;
            border: 1px solid #ccc; */
        }
        .help-text {
            font-size: 12px;
            color: #666;
            margin-top: 10px;
        }
        #onboarding-tooltip {
            background-color: #fff3cd;
            border: 1px solid #ffeeba;
            border-radius: 4px;
            padding: 15px;
            margin-bottom: 20px;
        }
        #onboarding-tooltip h3 {
            margin-top: 0;
            color: #856404;
        }
        #onboarding-tooltip pre {
            background-color: #f8f9fa;
            border: 1px solid #dee2e6;
            padding: 10px;
            border-radius: 4px;
            white-space: pre-wrap;
            word-wrap: break-word;
        }
        #onboarding-tooltip .copy-btn {
             background-color: #28a745 !important;
             margin-top: 5px;
        }
        .onboarding-tabs {
            border-bottom: 1px solid #ddd;
            margin-bottom: 15px;
        }
        .onboarding-tab-btn {
            background: none !important;
            border: none !important;
            padding: 10px 15px !important;
            cursor: pointer;
            color: #666 !important;
            font-size: 14px;
            margin-bottom: -1px;
        }
        .onboarding-tab-btn.active {
            color: #00a1d6 !important;
            border-bottom: 2px solid #00a1d6 !important;
        }
        .onboarding-pane {
            display: none;
        }
        .onboarding-pane.active {
            display: block;
        }
        #copy-cmd-btn {
            background-color: #28a745 !important;
        }
        .modal-tabs {
            border-bottom: 1px solid #ddd;
            margin-bottom: 15px;
        }
        .tab-btn {
            background: none !important;
            border: none !important;
            padding: 10px 15px !important;
            cursor: pointer;
            color: #666 !important;
            font-size: 16px;
        }
        .tab-btn.active {
            color: #00a1d6 !important;
            border-bottom: 2px solid #00a1d6 !important;
        }
        .tab-pane {
            display: none;
        }
        .tab-pane.active {
            display: block;
        }
        #history-list {
            max-height: 300px;
            overflow-y: auto;
        }
        .history-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 10px;
            border-bottom: 1px solid #eee;
        }
        .history-item:last-child {
            border-bottom: none;
        }
        .history-info {
            flex-grow: 1;
        }
        .history-info p {
            margin: 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 300px;
        }
        .history-status {
            width: 150px;
            text-align: right;
        }
        .progress-bar {
            width: 100px;
            height: 10px;
            background-color: #e0e0e0;
            border-radius: 5px;
            overflow: hidden;
            display: inline-block;
            margin-left: 10px;
        }
        .progress-bar-inner {
            height: 100%;
            background-color: #4caf50;
            width: 0%;
            transition: width 0.3s ease-in-out;
        }
        .status-completed { color: green; }
        .status-failed { color: red; }
        .status-downloading { color: #00a1d6; }
        .retry-btn {
            background-color: #ffc107 !important;
            color: black !important;
            margin-left: 10px;
        }
        .status-panel p.error { color: red; }
        .status-panel p.success { color: green; }
    `;
    document.head.appendChild(style);
}

async function downloadMedia(type) {
    const info = await getMediaInfo();
    if (!info) {
        toast('获取视频信息失败，请刷新页面重试');
        return;
    }
    handleDownload(info, type);
}

async function handleDownload(info, type) {
    try {
        if (!info) {
            throw new Error("无效的媒体信息，无法重试任务。");
        }
        const fileName = getFileName(info);

        const existingJob = downloadHistory.find(job =>
            job.name === fileName &&
            job.type === type &&
            ['pending', 'downloading', 'merging'].includes(job.status)
        );

        if (existingJob) {
            toast(`任务 "${fileName}" 已经在下载队列中。`);
            return;
        }

        const startTime = document.getElementById('audioStartTime').value;
        const endTime = document.getElementById('audioEndTime').value;
        const isVideoDownload = type === 'video';

        const payload = {
            vid: info.vid,
            name: fileName,
            videoUrl: isVideoDownload ? info.videoUrl : info.audioUrl,
            audioUrl: isVideoDownload ? info.audioUrl : null,
            startTime,
            endTime,
            fileNameFormat: userConfig.fileNameFormat,
        };

        const response = await gmFetch(`${userConfig.serverUrl}/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || '请求失败');
        }
        toast(`已开始任务 "${fileName}"`);
        await addToHistory({
            jobId: data.data.jobId,
            name: fileName,
            status: 'pending',
            progress: 0,
            timestamp: Date.now(),
            info: info,
            type: type
        });
        pollJobStatus(data.data.jobId);
    } catch (e) {
        toast(`创建下载任务失败: ${e.message}`, 5000);
        updateStatus(`创建下载任务失败: ${e.message}`, 'error');
    }
}

function copyCode(code) {
    navigator.clipboard.writeText(code).then(() => {
        toast('已复制到剪贴板');
    }, (err) => {
        toast('复制失败: ' + err);
    });
}

async function addToHistory(jobData) {
    if (!await acquireLock()) {
        toast('无法更新历史记录，另一个标签页可能正在操作。', 3000);
        return;
    }
    try {
        const currentHistory = JSON.parse(localStorage.getItem('bili_downloader_history') || '[]');
        // 避免重复添加
        if (currentHistory.some(j => j.jobId === jobData.jobId)) return;

        currentHistory.unshift(jobData);
        localStorage.setItem('bili_downloader_history', JSON.stringify(currentHistory));

        downloadHistory = currentHistory;
        renderHistory();
    } finally {
        releaseLock();
    }
}

async function updateHistory(jobId, status, progress, error, finalPath) {
    if (!await acquireLock()) {
        toast('无法更新历史记录，另一个标签页可能正在操作。', 3000);
        return;
    }
    try {
        const currentHistory = JSON.parse(localStorage.getItem('bili_downloader_history') || '[]');
        const job = currentHistory.find(j => j.jobId === jobId);
        if (job) {
            job.status = status;
            job.progress = progress;
            job.error = error || null;
            job.path = finalPath || job.path;
            localStorage.setItem('bili_downloader_history', JSON.stringify(currentHistory));

            downloadHistory = currentHistory;
            renderHistory(); // 重新渲染以更新UI
        }
    } finally {
        releaseLock();
    }
}

function loadHistory() {
    const storedHistory = localStorage.getItem('bili_downloader_history') || '[]';
    try {
        downloadHistory = JSON.parse(storedHistory);
        // 启动时为所有正在进行的任务恢复轮询
        downloadHistory.forEach(job => {
            if (['pending', 'downloading', 'merging'].includes(job.status)) {
                pollJobStatus(job.jobId);
            }
        });
    } catch(e) {
        downloadHistory = [];
    }
}

function saveHistory() {
    // GM_setValue('bili_downloader_history', JSON.stringify(downloadHistory)); // Removed GM_setValue
}

function renderHistory() {
    const historyList = document.getElementById('history-list');
    if (!historyList) return;

    if (downloadHistory.length === 0) {
        historyList.innerHTML = '<p>还没有下载记录。</p>';
        return;
    }

    historyList.innerHTML = downloadHistory.map(job => {
        let statusDisplay = '';
        const progress = Math.round(job.progress || 0);
        const icon = job.type === 'video' ? '📹' : '🎵';
        switch (job.status) {
            case 'downloading':
            case 'merging':
                statusDisplay = `
                    <span class="status-downloading">${job.status === 'merging' ? '合并中...' : `下载中... ${progress}%`}</span>
                    <div class="progress-bar">
                        <div class="progress-bar-inner" style="width: ${progress}%;"></div>
                    </div>`;
                break;
            case 'completed':
                statusDisplay = '<span class="status-completed">已完成</span>';
                break;
            case 'failed':
                statusDisplay = `<span class="status-failed" title="${job.error || '未知错误'}">失败</span>
                                 <button class="retry-btn" data-job-id="${job.jobId}">重试</button>`;
                break;
            case 'pending':
                statusDisplay = '<span>等待中...</span>';
                break;
            default:
                statusDisplay = `<span>${job.status}</span>`;
        }

        return `
            <div class="history-item" data-job-id="${job.jobId}">
                <div class="history-info">
                    <p title="${job.name}">${icon} ${job.name}</p>
                    <small>${new Date(job.timestamp).toLocaleString()}</small>
                </div>
                <div class="history-status">
                    ${statusDisplay}
                </div>
            </div>
        `;
    }).join('');

    // Add event listeners for retry buttons
    historyList.querySelectorAll('.retry-btn').forEach(button => {
        button.addEventListener('click', async (e) => {
            e.stopPropagation(); // 防止触发其他事件
            const jobId = e.target.dataset.jobId;

            const jobToRetry = downloadHistory.find(j => j.jobId === jobId);
            if (!jobToRetry) return;

            // 为了重试，我们需要一个原子性的“删除并添加”操作
            if (!await acquireLock()) {
                toast('无法重试任务，另一个标签页可能正在操作。', 3000);
                return;
            }
            try {
                const currentHistory = JSON.parse(localStorage.getItem('bili_downloader_history') || '[]');
                const historyWithoutOldJob = currentHistory.filter(j => j.jobId !== jobId);
                localStorage.setItem('bili_downloader_history', JSON.stringify(historyWithoutOldJob));
                downloadHistory = historyWithoutOldJob;
            } finally {
                releaseLock();
            }

            toast(`正在重试任务: ${jobToRetry.name}`);
            await handleDownload(jobToRetry.info, jobToRetry.type);
        });
    });
}

async function clearAllHistory() {
    if (!confirm('确定要清除所有下载记录吗？此操作不可恢复。')) {
        return;
    }

    if (!await acquireLock()) {
        toast('无法清除历史记录，另一个标签页可能正在操作。', 3000);
        return;
    }

    try {
        localStorage.setItem('bili_downloader_history', '[]');
        downloadHistory = [];
        renderHistory();
        toast('所有下载记录已清除。');
    } finally {
        releaseLock();
    }
}


function pollJobStatus(jobId) {
    if (activePolls.has(jobId)) {
        return;
    }
    activePolls.add(jobId);

    const intervalId = setInterval(async () => {
        try {
            const response = await gmFetch(`${userConfig.serverUrl}/status/${jobId}`);
            if (!response.ok) {
                // 如果服务器返回404，说明任务ID不存在（可能服务器重启了），停止轮询
                if (response.status === 404) {
                    updateHistory(jobId, 'failed', 0, '任务ID在服务器上未找到，可能服务已重启');
                    activePolls.delete(jobId);
                    clearInterval(intervalId);
                }
                return; // 其他错误暂时忽略，继续轮询
            }
            const data = await response.json();
            updateHistory(jobId, data.status, data.progress, data.error, data.path);

            if (data.status === 'completed' || data.status === 'failed') {
                activePolls.delete(jobId);
                clearInterval(intervalId);
                if (data.status === 'completed') {
                    toast(`"${data.name}" 已完成`);
                    checkFileExists(); // 下载完成后更新文件存在状态
                } else {
                    toast(`"${data.name}" 下载失败: ${data.error}`, 5000);
                }
            }
        } catch (e) {
            // 网络错误等，暂时不停止轮询，可能只是临时问题
            console.error(`Polling error for job ${jobId}:`, e);
        }
    }, 3000);
}

function copyCodeAudio() {
    const code = genMp3Cmd();
    copyCode(code);
}

function copyCodeVideo() {
    const code = genMp4Cmd();
    copyCode(code);
}

function getMediaInfo() {
    if (playInfo !== null) {
        return playInfo;
    }
    const html = document.getElementsByTagName('html')[0].innerHTML;
    const playinfo = JSON.parse(html.match(/window.__playinfo__=(.+?)<\/script/)[1]);

    playInfo = {
        videoUrl: playinfo.data.dash.video[0].baseUrl,
        audioUrl: playinfo.data.dash.audio[0].baseUrl,
        name: document.title.replace('_哔哩哔哩_bilibili', '').replace(/[ |.|\/]/g, '-'),
        vid: window.location.href.split('video/')[1].split('?')[0],
        startTime: document.getElementById('audioStartTime').value.trim(),
        endTime: document.getElementById('audioEndTime').value.trim(),
    };
    return playInfo;
}

function genMp4Cmd() {
    const playInfo = getMediaInfo();
    const startTime = document.getElementById('audioStartTime').value.trim();
    const endTime = document.getElementById('audioEndTime').value.trim();

    const videoCmd = genCurlCmd(playInfo.videoUrl, VIDEO_NAME);
    const audioCmd = genCurlCmd(playInfo.audioUrl, AUDIO_NAME);
    const mp4Cmd = ffmpegMp4(playInfo.name, startTime, endTime);
    return `mkdir "${playInfo.name}" ; cd "${playInfo.name}" ; ${videoCmd} ; ${audioCmd} ; ${mp4Cmd}`;
}

function genMp3Cmd() {
    const playInfo = getMediaInfo();
    const startTime = document.getElementById('audioStartTime').value.trim();
    const endTime = document.getElementById('audioEndTime').value.trim();

    const audioCmd = genCurlCmd(playInfo.audioUrl, AUDIO_NAME);
    const mp3Cmd = ffmpegMp3(playInfo.name, startTime, endTime);
    return `mkdir "${playInfo.name}" ; cd "${playInfo.name}" ; ${audioCmd} ; ${mp3Cmd}`;
}

function genCurlCmd(url, filename) {
    return `curl '${url}' \
  -H 'user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/94.0.4606.61 Safari/537.36' \
  -H 'referer: ${window.location.href}' \
  --compressed -o '${filename}' -Lv -s`;
}

function ffmpegMp4(name, startTime, endTime) {
    let timeArgs = '';

    if (startTime) {
        timeArgs += ` -ss ${startTime}`;
    }
    if (endTime) {
        timeArgs += ` -to ${endTime}`;
    }

    return `ffmpeg -i ${VIDEO_NAME} -i ${AUDIO_NAME}${timeArgs} -c:v copy -strict experimental '${name}.mp4'`;
}

function ffmpegMp3(name, startTime, endTime) {
    let timeArgs = '';

    if (startTime) {
        timeArgs += ` -ss ${startTime}`;
    }
    if (endTime) {
        timeArgs += ` -to ${endTime}`;
    }

    return `ffmpeg -i ${AUDIO_NAME}${timeArgs} -c:v copy -strict experimental '${name}.mp3'`;
}

function toast(msg, duration = 3000) {
    const toastContainer = document.getElementById('bili-toast-container') || (() => {
        const container = document.createElement('div');
        container.id = 'bili-toast-container';
        container.style.position = 'fixed';
        container.style.top = '20px';
        container.style.right = '20px';
        container.style.zIndex = '10001';
        document.body.appendChild(container);
        return container;
    })();

    const toast = document.createElement('div');
    toast.textContent = msg;
    toast.style.backgroundColor = '#333';
    toast.style.color = 'white';
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '5px';
    toast.style.marginBottom = '10px';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.5s, transform 0.5s';
    toast.style.transform = 'translateX(100%)';

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
    }, 10);


    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => {
            toast.remove();
            if (toastContainer.children.length === 0) {
                toastContainer.remove();
            }
        }, 500);
    }, duration);
}
