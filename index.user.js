// ==UserScript==
// @name         Bilibili downloader
// @namespace    https://github.com/foamzou/bilibili-downloader
// @version      0.3.1
// @description  哔哩哔哩（b站）音视频下载脚本
// @author       foamzou
// @match        https://www.bilibili.com/video/*
// @icon         https://www.google.com/s2/favicons?domain=bilibili.com
// @grant        none
// ==/UserScript==

var playInfo = null;
const VIDEO_NAME = 'video.m4s';
const AUDIO_NAME = 'audio.m4s';

(function() {
    'use strict';
    setTimeout(() => {
        initUI();
    }, 2300);

})();

function initUI() {
    createBtn();
}

function createBtn() {

    const heads = document.querySelector('head');
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.innerHTML = `
    .down-nav ul {
      list-style: none;
      padding:0;
      margin:0;
    }

    .down-nav ul li {
      display: block;
      float: left;
    }

	.down-nav li ul {
      display: none;
    }

    .down-nav ul li span {
	  display: block;
      font-family:helvetica;
      font-size:20px;
      padding: 10px;
      text-decoration: none;
      color: black;
      width:100px;
      border-radius:5%;
    }

    .down-nav ul li span:hover {
      background:deepskyblue;
      color:white;
    }

    .down-nav li:hover ul {
      display: block;
      position: absolute;
    }

    .down-nav li:hover li {
      float: none;
    }

    .down-nav li:hover span {
      background-color:white;
      color:black;
    }

    .down-nav li:hover li span:hover {
      width:100px;
    }`;
    heads.append(style);

    const node = document.createElement('span');
    node.setAttribute('style', 'width: 70px;z-index: 9999;');
    node.setAttribute('class', 'down-nav');
    node.innerHTML = `
      <ul>
        <li>
          <span style="width: 50px;"><i style="font-size:28px;" class="van-icon-download"></i></span>
          <ul style="line-height: 15px; font-size:10px;">
            <li><span style="font-size:10px;" id="btnDownloadAudio">下载音频</span></li>
            <li><span style="font-size:10px;" id="btnCopyCodeAudio">复制代码：获取音频</span></li>
            <li><span style="font-size:10px;" id="btnCopyCodeVideo">复制代码：获取视频</span></li>
            <li>
              <div style="padding: 5px;">
                <input type="text" id="audioStartTime" placeholder="开始时间(00:00)" style="width: 90px; margin: 2px; font-size: 12px;">
                <input type="text" id="audioEndTime" placeholder="结束时间(00:00)" style="width: 90px; margin: 2px; font-size: 12px;">
              </div>
            </li>
          </ul>
        </li>
      </ul>
    `;
    document.getElementsByClassName('video-toolbar-left')[0].appendChild(node);

    document.getElementById("btnDownloadAudio").addEventListener("click", downloadAudio);
    document.getElementById("btnCopyCodeAudio").addEventListener("click", copyCodeAudio);
    document.getElementById("btnCopyCodeVideo").addEventListener("click", copyCodeVideo);
}

function insertAfter(newNode, referenceNode) {
    referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
}

async function downloadAudio() {
    if (!document.getElementById('IdDownloadAudio')) {
        const node = document.createElement('div');
        node.innerHTML = `<a id="IdDownloadAudio" target="_blank" style="color: #00a3db;font-size: 16px;">音频转码中，请稍等...</a><div></div>`;
        insertAfter(node, document.getElementById('arc_toolbar_report'));
    }
    const aNode = document.getElementById('IdDownloadAudio');
    const playInfo = getMediaInfo();
    const responsePayload = await fetch(`https://foamzou.com/tools/bilibili/fetchAudio.php?url=${encodeURIComponent(playInfo.audioUrl)}&name=${playInfo.name}&vid=${playInfo.vid}`);
    const response = await responsePayload.json();
    if (response.code != 0) {
        const tip = '音频转码失败，建议复制代码：获取音频';
        aNode.text = tip;
        toast(tip);
        return;
    }
    aNode.href = response.data;
    toast("音频转码成功，点击链接下载");
    aNode.text = "音频转码成功，点击下载";
}
function copyCode(code) {
    navigator.clipboard.writeText(code).then(() => {
        toast('复制到剪贴板，确保本地安装了ffmpeg后，粘贴运行', 900);
    }).catch(function (err) {
        toast('复制失败', 900);
      throw (err !== undefined ? err : new DOMException('The request is not allowed', 'NotAllowedError'))
    });
}
function copyCodeAudio() {
    copyCode(genMp3Cmd());
}

function copyCodeVideo() {
    copyCode(genMp4Cmd());
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

function toast(msg, duration) {
	duration = isNaN(duration) ? 3000 : duration;
	var m = document.createElement('div');
	m.innerHTML = msg;
	m.style.cssText = "font-family:siyuan;max-width:60%;min-width: 150px;padding:0 14px;height: 40px;color: rgb(255, 255, 255);line-height: 40px;text-align: center;border-radius: 4px;position: fixed;top: 50%;left: 50%;transform: translate(-50%, -50%);z-index: 999999;background: rgba(0, 0, 0,.7);font-size: 16px;";
	document.body.appendChild(m);
	setTimeout(function() {
		var d = 0.5;
		m.style.webkitTransition = '-webkit-transform ' + d + 's ease-in, opacity ' + d + 's ease-in';
		m.style.opacity = '0';
		setTimeout(function() {
			document.body.removeChild(m)
		}, d * 1000);
	}, duration);
}
