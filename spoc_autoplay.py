# -*- coding: utf-8 -*-
"""
北师大 SPOC(雨课堂)自动刷视频脚本 v2
功能:自动倍速播放当前小节视频 -> 播完后自动跳到下一小节
特点:
  - CDP 附加已登录 Chrome(自动带调试端口重启,登录态保留)
  - 全 iframe 扫描(雨课堂播放器常嵌在跨域 iframe 中)
  - 倍速自动探测:先试 16x,实测播放头推进速率不足则自动降档
  - "下一节"按钮多选择器探测,失败自动存截图+DOM 快照
"""
import asyncio
import os
import subprocess
import sys
import time
from pathlib import Path

from playwright.async_api import async_playwright

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 关键:屏蔽代理环境变量,否则 CDP 对 127.0.0.1:9222 的请求会被系统代理截走(返回 502)
for _k in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]:
    os.environ.pop(_k, None)
os.environ["NO_PROXY"] = "127.0.0.1,localhost"
os.environ["no_proxy"] = "127.0.0.1,localhost"

# ---------------- 配置 ----------------
LOG = Path(__file__).parent / "spoc_log.txt"
SNAP_DIR = Path(__file__).parent / "snapshots"
SNAP_DIR.mkdir(exist_ok=True)
DEBUG_PORT = 9222
DEFAULT_SPEED = 16.0
POLL_SEC = 2


def log(msg: str):
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def find_chrome() -> str:
    # 1) 注册表 App Paths(最可靠,覆盖自定义安装路径)
    try:
        import winreg
        for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
            try:
                with winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe") as k:
                    val = winreg.QueryValue(k, None)
                    if val and os.path.exists(val):
                        return val
            except OSError:
                continue
    except Exception:
        pass
    # 2) 常见路径
    for p in [
        os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ]:
        if os.path.exists(p):
            return p
    raise FileNotFoundError("未找到 Chrome,请手动指定路径")


def restart_chrome_with_debug():
    """启动带调试端口的专用 Chrome 实例(独立 profile,与日常 Chrome 并存)。
    注意:Chrome 136+ 禁止默认 profile 开远程调试,必须用独立 user-data-dir。
    首次运行需在该窗口登录一次雨课堂,之后免登录。"""
    chrome = find_chrome()
    profile = Path(__file__).parent / "chrome_profile"
    profile.mkdir(exist_ok=True)
    log(f"启动专用 Chrome(profile={profile.name}, 端口={DEBUG_PORT}) ...")
    subprocess.Popen(
        [
            chrome,
            f"--remote-debugging-port={DEBUG_PORT}",
            "--remote-allow-origins=*",
            f"--user-data-dir={profile}",
            "--no-first-run",
            "--no-default-browser-check",
            "about:blank",
        ],
        # CREATE_BREAKAWAY_FROM_JOB:脱离父进程 Job 对象,父进程(python)退出后 Chrome 不被连带杀死
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP
        | subprocess.DETACHED_PROCESS
        | subprocess.CREATE_BREAKAWAY_FROM_JOB,
    )
    for _ in range(30):
        try:
            s = __import__("socket").create_connection(("127.0.0.1", DEBUG_PORT), timeout=1)
            s.close()
            log("调试端口就绪")
            return
        except OSError:
            time.sleep(1)
    raise RuntimeError("Chrome 调试端口启动失败")


async def snapshot(page, name: str):
    """保存当前页面截图 + DOM 摘要,供后续迭代选择器"""
    ts = time.strftime("%Y%m%d_%H%M%S")
    img = SNAP_DIR / f"{ts}_{name}.png"
    try:
        await page.screenshot(path=str(img), full_page=False)
        parts = []
        for i, fr in enumerate(page.frames):
            try:
                body = await fr.evaluate("() => document.body ? document.body.outerHTML.slice(0, 150000) : ''")
                parts.append(f"===== frame[{i}] url={fr.url[:120]} =====\n{body}")
            except Exception:
                continue
        (SNAP_DIR / f"{ts}_{name}.html").write_text("\n\n".join(parts), encoding="utf-8")
        log(f"已保存快照: {img.name}")
    except Exception as e:
        log(f"快照失败 {name}: {e}")


# ---------- 页面内 JS ----------
JS_FIND_VIDEO = """
() => {
    const vs = [...document.querySelectorAll('video')];
    return vs.map(v => ({
        src: (v.currentSrc || v.src || ''),
        duration: v.duration || 0,
        currentTime: v.currentTime,
        paused: v.paused,
        ended: v.ended,
        playbackRate: v.playbackRate,
        rect: (() => { const r = v.getBoundingClientRect();
            return {w: r.width, h: r.height, visible: r.width > 100 && r.height > 80}; })(),
    }));
}
"""

JS_NEXT_BUTTON = """
() => {
    // 1) class/标题含 next 的可见元素(允许图标无文字)
    const sels = ['a[class*="next"]', 'button[class*="next"]', 'div[class*="next"]',
                  'a[title*="下一"]', 'button[title*="下一"]', '[class*="next_link"]'];
    for (const s of sels) {
        for (const el of document.querySelectorAll(s)) {
            const txt = (el.innerText || el.title || '').trim();
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 &&
                (txt.includes('下一') || txt.toLowerCase().includes('next') || txt === '')) {
                return {found: true, selector: s, text: txt.slice(0, 40)};
            }
        }
    }
    // 2) 兜底:按文字扫描
    const all = [...document.querySelectorAll('a,button,div[onclick],span,li')];
    for (const el of all) {
        const txt = (el.innerText || '').trim();
        if (txt && txt.length < 25 &&
            (txt.includes('下一节') || txt.includes('下一小节') || txt.includes('下一个'))) {
            const r = el.getBoundingClientRect();
            if (r.width > 0) return {found: true, selector: 'text-scan', text: txt};
        }
    }
    return {found: false};
}
"""


async def find_video(page):
    """在所有 frame 中找可见视频,返回 (frame, 第几个video, 信息)"""
    for frame in page.frames:
        try:
            vids = await frame.evaluate(JS_FIND_VIDEO)
        except Exception:
            continue
        for i, v in enumerate(vids):
            if v["rect"]["visible"] and v["duration"] and v["duration"] > 30:
                return frame, i, v
    return None, None, None


async def try_click_next(page) -> bool:
    """在所有 frame 中找并点击'下一节'。返回是否成功"""
    for frame in page.frames:
        try:
            info = await frame.evaluate(JS_NEXT_BUTTON)
        except Exception:
            continue
        if not info.get("found"):
            continue
        sel, txt = info["selector"], info.get("text", "")
        try:
            if sel == "text-scan":
                loc = frame.get_by_text(txt).first
            else:
                loc = frame.locator(sel).first
            await loc.click(timeout=3000)
            log(f"点击'下一节': '{txt}' (frame={frame.url[:60]}, via {sel})")
            return True
        except Exception as e:
            log(f"点击尝试失败({sel} @ {frame.url[:50]}): {type(e).__name__}")
    return False


async def main():
    url = sys.argv[1] if len(sys.argv) > 1 else None
    if not url:
        print("用法: python spoc_autoplay.py <课程视频页URL>")
        return

    restart_chrome_with_debug()

    async with async_playwright() as p:
        try:
            browser = await p.chromium.connect_over_cdp(f"http://127.0.0.1:{DEBUG_PORT}")
        except Exception as e:
            log(f"CDP 连接失败: {e}")
            return
        log("已附加到 Chrome")

        ctx = browser.contexts[0] if browser.contexts else await browser.new_context()

        # 定位/打开课程页
        spoc_pages = [pg for pg in ctx.pages if "spoc.bnu.edu.cn" in pg.url]
        if spoc_pages:
            page = spoc_pages[0]
        else:
            page = ctx.pages[0] if ctx.pages else await ctx.new_page()
            await page.goto(url, wait_until="domcontentloaded")
        await page.bring_to_front()
        log(f"目标页面: {page.url[:100]}")

        # 等待登录:最多等 300 秒,期间轮询是否已出现课程页内容
        if "login" in page.url or "auth" in page.url or page.url in ("about:blank", "chrome://newtab/") or not page.url.startswith("http"):
            await page.goto(url, wait_until="domcontentloaded")
        for i in range(60):
            title = await page.title()
            log(f"等待页面就绪({i}): {title[:60]} | {page.url[:80]}")
            if "spoc.bnu.edu.cn" in page.url and ("ai-workspace" in page.url or "课程" in title or "学习" in title):
                break
            if "login" in page.url.lower():
                log(">>> 检测到登录页:请在弹出的 Chrome 窗口中登录雨课堂,登录后脚本自动继续 <<<")
            await asyncio.sleep(5)
            # 登录后可能跳转,重新打开目标 URL
            if "spoc.bnu.edu.cn" in page.url and "ai-workspace" not in page.url:
                await page.goto(url, wait_until="domcontentloaded")

        # 每个视频的状态: speed(当前倍速) / probe(速率探测数据) / misses(找不到下一节的次数)
        state = {}

        # 心跳文件:用于诊断脚本存活状态
        HEARTBEAT = Path(__file__).parent / "heartbeat.txt"

        def beat(extra: str = ""):
            try:
                HEARTBEAT.write_text(
                    f"{time.strftime('%Y-%m-%d %H:%M:%S')} {extra}", encoding="utf-8"
                )
            except Exception:
                pass

        beat("started")

        while True:
            try:
                beat("alive")
                # 每轮重新找 spoc 页(标签可能变化)
                pages = [pg for pg in ctx.pages if "spoc.bnu.edu.cn" in pg.url]
                page = pages[0] if pages else None
                if page is None:
                    await asyncio.sleep(POLL_SEC)
                    continue

                frame, idx, v = await find_video(page)
                if frame is None:
                    await asyncio.sleep(POLL_SEC)
                    continue

                loc = frame.locator("video").nth(idx)
                key = v["src"][-80:] or f"{page.url[-60:]}#{idx}"
                st = state.setdefault(key, {"speed": None, "probe": None, "misses": 0})

                # ---- 播完 -> 下一节 ----
                if v["ended"] or (v["duration"] and v["duration"] - v["currentTime"] < 2):
                    log(f"视频播完: ...{key[-50:]}  ({v['currentTime']:.0f}/{v['duration']:.0f}s)")
                    if await try_click_next(page):
                        st["misses"] = 0
                        await asyncio.sleep(2)
                        log(f"跳转后 URL: {page.url[:100]}")
                    else:
                        st["misses"] += 1
                        if st["misses"] == 1:
                            await snapshot(page, "next_not_found")
                            log("未找到'下一节'按钮,已存快照,10 秒后重试")
                        await asyncio.sleep(10)
                    continue

                # ---- 被暂停 -> 恢复 ----
                if v["paused"]:
                    log(f"视频暂停,恢复播放 ...{key[-40:]}")
                    try:
                        await loc.evaluate("v => v.play()")
                    except Exception:
                        try:
                            await loc.click()
                        except Exception:
                            pass
                    await asyncio.sleep(1)

                # ---- 倍速管理 ----
                now = time.time()
                if st["speed"] is None:
                    sp = DEFAULT_SPEED
                    try:
                        await loc.evaluate("(v,s)=>{v.muted=true; v.playbackRate=s;}", sp)
                    except Exception:
                        pass
                    st["speed"] = sp
                    st["probe"] = {"wall0": now, "t0": v["currentTime"], "speed": sp}
                    log(f"开始播放(探测 {sp:g}x): {v['currentTime']:.0f}/{v['duration']:.0f}s")
                elif st["probe"] is not None:
                    pr = st["probe"]
                    dt = now - pr["wall0"]
                    dv = v["currentTime"] - pr["t0"]
                    if dt >= 4:
                        rate = dv / dt if dt > 0 else 0
                        if rate < 0.6 * pr["speed"]:
                            new_sp = max(1.0, round(rate * 0.9, 1))
                            log(f"实测推进 {rate:.2f}x < 设定 {pr['speed']:g}x,降为 {new_sp}x")
                            st["speed"] = new_sp
                        else:
                            log(f"倍速 {st['speed']:g}x 实测可用(推进 {rate:.2f}x)")
                        st["probe"] = None
                else:
                    try:
                        await loc.evaluate(
                            "(v,s)=>{v.muted=true; if(Math.abs(v.playbackRate-s)>0.01) v.playbackRate=s;}",
                            st["speed"],
                        )
                    except Exception:
                        pass

                log(f"播放中 @{st['speed']:g}x  {v['currentTime']:.0f}/{v['duration']:.0f}s  ...{key[-40:]}")
                beat(f"@{st['speed']:g}x {v['currentTime']:.0f}/{v['duration']:.0f}s")

            except Exception as e:
                log(f"循环异常: {type(e).__name__}: {e}")
                await asyncio.sleep(3)
                continue

            await asyncio.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as e:
        # 把致命错误落到日志,而不是静默退出
        import traceback
        log(f"致命退出: {type(e).__name__}: {e}")
        log(traceback.format_exc()[-800:])
        raise
