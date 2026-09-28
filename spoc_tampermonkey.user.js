// ==UserScript==
// @name         北师大SPOC自动刷视频(雨课堂)
// @namespace    spoc-bnu-autoplay
// @version      4.2
// @description  雨课堂(北师大SPOC)视频半自动助手:2x强制保持/防暂停自动恢复/播完跳下一视频节(跳过作业图文考试)/手动做作业时让路。面板一键启动/暂停,回看课程零干扰。
// @author       wfcsilence
// @match        *://spoc.bnu.edu.cn/*
// @match        *://*.yuketang.cn/*
// @match        *://*.xuetangx.com/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // 仅顶层窗口运行(避免 iframe 重复注入)
    if (window.top !== window) return;

    const CONFIG = {
        pollMs: 1200,          // 主循环轮询间隔(ms)
        endToleranceSec: 1.5,  // 距结尾小于该值视为播完
        targetRate: 2,         // 固定 2 倍速
        resumeGapMs: 2500,     // 暂停恢复重试间隔(ms)
        waitDoneRounds: 30,    // 播完等"已完成"的最大轮数(约 36 秒)
        navCooldownMs: 3000,   // 跳转冷却:两次目录跳转最小间隔
    };

    // ---------------- 状态 ----------------
    let panel = null;                 // 面板元素引用 {el, msg, bStart, bPause}
    let lastMsg = '';                 // 面板消息缓存(避免重复写 DOM)
    let enabled = false;              // 总开关:是否接管(点 ▶ 启动 变 true)
    let pausedByUser = false;         // 用户按了 ⏸(此时脚本不抢恢复)
    let userActivated = false;        // 页面是否已有真实用户手势
    let userClickedNonVideo = false;  // 用户手动点进作业/图文/考试
    let manualNotified = false;       // 手动模式提示只发一次
    let currentKey = null;            // 当前视频标识(src 尾部)
    let missCount = 0;                // 播完等"已完成"计数
    let pauseRounds = 0;              // 暂停恢复计数
    let lastResumeAt = 0;             // 上次恢复时间
    let lastNavAt = 0;                // 上次跳转时间(冷却)
    let skipGuard = 0;                // 非视频节自动跳过计数
    let rateFixCount = 0;             // 2x 抢回次数
    let rejectedOnce = false;         // play() 被拒提示只发一次
    const patched = new WeakSet();    // 已打补丁的 video

    // ---------------- 面板 ----------------
    function createPanel() {
        const el = document.createElement('div');
        el.id = 'spoc-panel';
        el.style.cssText = [
            'position:fixed', 'right:12px', 'bottom:12px', 'z-index:999999',
            'background:rgba(20,20,20,.9)', 'color:#ffd54f',
            'font:13px/1.6 Consolas,monospace', 'padding:10px 14px',
            'border-radius:10px', 'max-width:480px',
            'border:2px solid #ffb300', 'box-shadow:0 4px 16px rgba(0,0,0,.4)',
        ].join(';');
        el.innerHTML =
            '<div id="spoc-msg" style="margin-bottom:8px"><b>[SPOC]</b> 未启动 — 点 ▶ 启动 接管</div>' +
            '<div style="display:flex;gap:8px">' +
            '<button id="spoc-btn-start" style="flex:1;padding:7px 0;cursor:pointer;border:none;border-radius:6px;background:#2e7d32;color:#fff;font-weight:bold">▶ 启动</button>' +
            '<button id="spoc-btn-pause" style="flex:1;padding:7px 0;cursor:pointer;border:none;border-radius:6px;background:#555;color:#ccc">⏸ 暂停脚本</button>' +
            '</div>';
        (document.body || document.documentElement).appendChild(el);
        return {
            el,
            msg: el.querySelector('#spoc-msg'),
            bStart: el.querySelector('#spoc-btn-start'),
            bPause: el.querySelector('#spoc-btn-pause'),
        };
    }

    function setMsg(html, color) {
        // 缓存:内容相同不重复写 DOM
        if (lastMsg === html) return;
        lastMsg = html;
        panel.msg.innerHTML = html;
        if (color) panel.msg.style.color = color;
    }

    function log(msg) {
        const t = new Date().toTimeString().slice(0, 8);
        console.log(`[SPOC] ${t} ${msg}`);
    }

    // ---------------- 用户手势检测 ----------------
    // 浏览器规定:页面无真实手势(sticky activation)时,脚本 play() 一律被拒。
    // 关键:手势是页面级的——点页面任意位置(含面板按钮)即可解锁,不必点播放键。
    ['pointerdown', 'keydown'].forEach(t =>
        document.addEventListener(t, (e) => {
            if (!userActivated) {
                userActivated = true;
                log('检测到用户手势,自动播放解锁 ✓');
            }
            // 检测用户点目录中的非视频节(作业/图文/考试)→ 手动模式,脚本让路
            const leaf = e.target && e.target.closest ? e.target.closest('.leaf-item') : null;
            if (leaf) {
                const tagEl = leaf.querySelector('.leaf-item-tag');
                const tag = tagEl ? tagEl.textContent.trim() : '视频';
                if (tag !== '视频') {
                    if (!userClickedNonVideo) log(`用户手动进入"${tag}"节 → 脚本让路`);
                    userClickedNonVideo = true;
                } else if (userClickedNonVideo) {
                    log('用户回到视频节,恢复自动模式');
                    userClickedNonVideo = false;
                    manualNotified = false;
                }
            }
        }, { capture: true, passive: true }));

    // ---------------- 工具 ----------------
    function findVideo() {
        for (const v of document.querySelectorAll('video')) {
            const r = v.getBoundingClientRect();
            if (r.width > 200 && r.height > 120 &&
                v.duration && isFinite(v.duration) && v.duration > 30) {
                return v;
            }
        }
        return null;
    }

    function getUnitTag() {
        const el = document.querySelector('.control-left .unit-tag');
        return el ? el.textContent.trim() : '';
    }

    function getUnitStatus() {
        const el = document.querySelector('.rate-detail .text');
        return el ? el.textContent.trim() : '';
    }

    // ---------------- 2x 强制保持(实例级 playbackRate 拦截) ----------------
    // 播放器核心以固定频率把 video.playbackRate 同步回菜单档(1x),
    // 直接赋值会被覆盖。实例级重写 setter:播放器写任何值一律落地为 2。
    function patchVideo(v) {
        if (patched.has(v)) return;
        try {
            const desc =
                Object.getOwnPropertyDescriptor(Object.getPrototypeOf(v), 'playbackRate') ||
                Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
            if (desc && desc.set && desc.get) {
                const nativeSet = desc.set.bind(v);
                const nativeGet = desc.get.bind(v);
                Object.defineProperty(v, 'playbackRate', {
                    configurable: true,
                    get() { return nativeGet(); },
                    set(val) {
                        if (!enabled) { nativeSet(val); return; } // 停用时放行原值
                        if (Math.abs(nativeGet() - CONFIG.targetRate) > 0.001) {
                            nativeSet(CONFIG.targetRate);
                            rateFixCount++;
                        }
                    },
                });
                patched.add(v);
                log('视频已打 2x 保持补丁');
            } else {
                // 降级:高频轮询抢回(descriptor 拿不到的极端情况)
                setInterval(() => {
                    try {
                        if (enabled && Math.abs(v.playbackRate - CONFIG.targetRate) > 0.01) {
                            v.playbackRate = CONFIG.targetRate;
                            rateFixCount++;
                        }
                    } catch (e) { }
                }, 300);
                patched.add(v);
            }
        } catch (e) {
            console.error('[SPOC] patch 失败', e);
        }
    }

    // ---------------- 启动/恢复播放 ----------------
    function tryStart(v) {
        // 若暂停遮罩可见,点大播放键(带坐标完整事件序列)
        const big = document.querySelector('xt-bigbutton.pause_show');
        if (big) {
            const btn = big.querySelector('button') || big;
            const r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : big.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
            ['pointerdown', 'pointerup', 'click'].forEach(t => {
                try { btn.dispatchEvent(new PointerEvent(t, { ...opts, pointerId: 1, isPrimary: true })); }
                catch (e) { btn.dispatchEvent(new MouseEvent(t, opts)); }
            });
            btn.click();
        }
        // 原生 play(有手势必成功)
        const p = v.play();
        if (p && p.catch) {
            p.catch((err) => {
                if (!rejectedOnce) {
                    rejectedOnce = true;
                    log(`play() 被拒(${err && err.name ? err.name : err}),请再点一次页面任意位置`);
                }
            });
        }
    }

    // 暂停视频(用户点 ⏸ 时调用):点面板键 + 原生 pause 双保险
    function pauseVideo(v) {
        const big = document.querySelector('xt-bigbutton');
        if (big && !big.classList.contains('pause_show')) {
            const btn = big.querySelector('button') || big;
            const r = btn.getBoundingClientRect ? btn.getBoundingClientRect() : big.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
            ['pointerdown', 'pointerup', 'click'].forEach(t => {
                try { btn.dispatchEvent(new PointerEvent(t, { ...opts, pointerId: 1, isPrimary: true })); }
                catch (e) { btn.dispatchEvent(new MouseEvent(t, opts)); }
            });
            btn.click();
        }
        try {
            HTMLMediaElement.prototype.pause.call(v);
        } catch (e) {
            try { v.pause(); } catch (e2) { }
        }
    }

    // ---------------- 跳转:目录优先,跳过非视频节 ----------------
    function clickNext() {
        const leaves = [...document.querySelectorAll('.leaf-item')];
        const activeIdx = leaves.findIndex(li => li.classList.contains('is-active'));

        // 策略1(主):目录点选,精确落到下一个"视频"节
        if (activeIdx >= 0) {
            for (let j = activeIdx + 1; j < leaves.length; j++) {
                const leaf = leaves[j];
                const tagEl = leaf.querySelector('.leaf-item-tag');
                const tag = tagEl ? tagEl.textContent.trim() : '视频';
                if (tag !== '视频') continue; // 跳过作业/图文/考试
                if (leaf.querySelector('.icon-suoding')) {
                    return { ok: false, wait: true, why: `第 ${j + 1} 节被锁定` };
                }
                const titleEl = leaf.querySelector('.leaf-item-title');
                const skipped = j - activeIdx - 1;
                leaf.click();
                return {
                    ok: true,
                    how: `目录跳转 "${(titleEl ? titleEl.textContent : '').trim().slice(0, 20)}"` +
                         (skipped > 0 ? `(跳过 ${skipped} 个非视频节)` : ''),
                };
            }
            return { ok: false, wait: true, why: '后面已无视频节(接近课程尾)' };
        }

        // 策略2(兜底):播放器上方"下一单元"箭头
        const nextArrow = document.querySelector('i.unit-arrow.arrow-reverse');
        if (nextArrow) {
            const r = nextArrow.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
                nextArrow.click();
                return { ok: true, how: '下一单元箭头' };
            }
        }
        return { ok: false, wait: false };
    }

    // ================= 主循环 =================
    setInterval(() => {
        try {
            // 总开关关闭:仅提示,不干预任何行为
            if (!enabled) {
                if (findVideo()) {
                    setMsg('<b>[SPOC]</b> 未启动 — 点 ▶ 启动 接管(2x/防暂停/自动跳节)');
                }
                return;
            }

            const unitTag = getUnitTag();
            const onNonVideo = unitTag !== '' && unitTag !== '视频';

            // ---- 非视频节:区分手动/自动 ----
            if (onNonVideo) {
                if (userClickedNonVideo) {
                    // 用户手动点进作业/图文/考试:完全让路(写作业不被打扰)
                    if (!manualNotified) {
                        manualNotified = true;
                        setMsg(`<b>[SPOC]</b> 手动模式:当前节="${unitTag}",脚本不干预。<br>写完点目录里任意<b>视频</b>节,自动模式恢复`, '#ffd54f');
                        log(`手动模式:当前节="${unitTag}",脚本暂停一切自动行为`);
                    }
                    return;
                }
                // 脚本跳转落点为非视频节 → 自动跳下一个视频节(带冷却防连点)
                const now = Date.now();
                if (now - lastNavAt < CONFIG.navCooldownMs) return;
                skipGuard++;
                if (skipGuard % 3 === 1) log(`落在"${unitTag}"节,自动跳下一个视频节`);
                lastNavAt = now;
                const r = clickNext();
                if (r.ok) {
                    skipGuard = 0;
                    currentKey = null;
                    log(`已跳转: ${r.how}`);
                } else if (r.wait && skipGuard % 3 === 1) {
                    log(`暂不能跳: ${r.why || ''}`);
                }
                return;
            }

            const v = findVideo();
            if (!v) {
                setMsg('<b>[SPOC]</b> 未发现视频,等待...', '#ffd54f');
                return;
            }

            patchVideo(v);

            const key = (v.currentSrc || v.src || '').slice(-80) || location.href;
            if (key !== currentKey) {
                currentKey = key;
                missCount = 0;
                pauseRounds = 0;
                skipGuard = 0;
                log(`新视频 @ ${Math.round(v.currentTime)}/${Math.round(v.duration)}s`);
            }

            // ---- 用户面板暂停:脚本不抢恢复;用户手动播放后自动解除 ----
            if (pausedByUser) {
                if (!v.paused) {
                    // 用户自己点播放了:解除暂停标记,回接管模式
                    pausedByUser = false;
                    log('检测到播放,解除回看模式');
                } else {
                    setMsg('<b>[SPOC]</b> 回看模式 — 脚本已停用。点 ▶ 启动 恢复接管', '#ffd54f');
                    return;
                }
            }

            // ---- 播完 → 等"已完成" → 跳下一视频节 ----
            const remain = v.duration - v.currentTime;
            if (v.ended || remain < CONFIG.endToleranceSec) {
                const statusText = getUnitStatus();
                if (statusText && statusText !== '已完成' && missCount < CONFIG.waitDoneRounds) {
                    missCount++;
                    if (missCount % 5 === 1) log(`已播完但状态="${statusText}",等待"已完成"(${missCount})`);
                    setMsg(`<b>[SPOC]</b> 已播完,等待状态"已完成"...(当前:${statusText || '?'})`, '#69f069');
                    return;
                }
                const now = Date.now();
                if (now - lastNavAt < CONFIG.navCooldownMs) return;
                log(`播完(${Math.round(v.duration)}s, 状态=${statusText || '?'}),跳下一视频节...`);
                lastNavAt = now;
                const r = clickNext();
                if (r.ok) {
                    log(`已跳转: ${r.how}`);
                    missCount = 0;
                    currentKey = null;
                } else if (r.wait) {
                    missCount++;
                    if (missCount % 5 === 1) log(`暂不跳转: ${r.why || ''}`);
                } else {
                    missCount++;
                    if (missCount === 1) log('未找到跳转入口,持续重试...');
                }
                return;
            }

            // ---- 保持播放 ----
            if (v.paused) {
                pauseRounds++;
                const now = Date.now();
                if (now - lastResumeAt > CONFIG.resumeGapMs) {
                    lastResumeAt = now;
                    log(`检测到暂停,自动恢复(第 ${pauseRounds} 次)`);
                    tryStart(v);
                }
                setMsg(`<b>[SPOC]</b> 检测到暂停,自动恢复中(第 ${pauseRounds} 次)...`, '#ffd54f');
            } else {
                if (pauseRounds > 0) log('播放中 ✓');
                pauseRounds = 0;
                setMsg(`<b>[SPOC]</b> 2x 播放中 ✓ ${Math.round(v.currentTime)}/${Math.round(v.duration)}s` +
                       (rateFixCount > 0 ? ` · 拦截改速 ${rateFixCount}` : ''), '#69f069');
            }

            // ---- 2x 兜底校验 ----
            if (Math.abs(v.playbackRate - CONFIG.targetRate) > 0.01) {
                try { v.playbackRate = CONFIG.targetRate; } catch (e) { }
            }

        } catch (e) {
            console.error('[SPOC]', e);
        }
    }, CONFIG.pollMs);

    // ---------------- 初始化 ----------------
    panel = createPanel();

    // ▶ 启动:接管模式
    panel.bStart.addEventListener('click', () => {
        enabled = true;
        pausedByUser = false;
        rejectedOnce = false;
        panel.bStart.textContent = '▶ 已启动';
        setMsg('<b>[SPOC]</b> 已接管 ✓ 2x保持 / 防暂停 / 自动跳节', '#69f069');
        log('脚本已启动,接管模式');
        const v = findVideo();
        if (v && v.paused) tryStart(v);
    });

    // ⏸ 暂停脚本:回看模式(停用自动行为 + 暂停视频)
    panel.bPause.addEventListener('click', () => {
        enabled = false;
        pausedByUser = true;
        panel.bStart.textContent = '▶ 启动';
        setMsg('<b>[SPOC]</b> 已停用 — 可正常回看。点 ▶ 启动 恢复接管', '#ffd54f');
        log('脚本已停用(回看模式),视频已暂停');
        const v = findVideo();
        if (v && !v.paused) pauseVideo(v);
    });

    log('脚本就绪。点面板 ▶ 启动 接管;⏸ 停用回看');
})();
