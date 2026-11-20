#!/usr/bin/env python3
"""Headless L1-L4 smoke: model loads, idle->sprint->jump->vault, no console errors, 3 screenshots."""
import asyncio, functools, http.server, json, os, socket, sys, threading, traceback
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "shots"
SHOTS.mkdir(exist_ok=True)
# noreflect/nopost keep the software-GL run fast; noai keeps soldiers from interrupting the movement checks
URL = "http://127.0.0.1:8765/index.html?shots=1&debug=1&noai=1&noreflect=1" + ("" if os.environ.get("AEGIS_GPU") else "&nopost=1")


def ensure_server(port=8765):
    """Serve the repo root on :port unless something already listens there."""
    with socket.socket() as s:
        if s.connect_ex(("127.0.0.1", port)) == 0:
            return None
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    handler.log_message = lambda *a, **k: None
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv

async def main():
    errs = []
    ensure_server()
    async with async_playwright() as p:
        # AEGIS_CHROME=1 uses the installed Chrome instead of Playwright's bundled Chromium
        # AEGIS_GPU=1 renders on the real GPU (D3D11) instead of swiftshader
        gl = ["--use-angle=d3d11", "--enable-gpu"] if os.environ.get("AEGIS_GPU") else ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
        browser = await p.chromium.launch(channel="chrome" if os.environ.get("AEGIS_CHROME") else None, args=gl + ["--ignore-gpu-blocklist"])
        page = await browser.new_page(viewport={"width": 1280, "height": 720})
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        def on_console(m):
            if m.type in ("error", "warning") and "Failed to load resource" not in (m.text or ""):
                errs.append(m.type + ": " + m.text)
        page.on("console", on_console)
        await page.goto(URL, wait_until="domcontentloaded")
        await page.wait_for_function("window.AG && AG.ready", timeout=60000)
        await page.wait_for_timeout(800)

        st = await page.evaluate("() => AG.state()")
        bones = await page.evaluate("""() => {
          const b = AG.player && AG.player.loco && AG.player.loco.bones;
          if (!b) return null;
          const keys = ["hips","spine","chest","upperChest","leftUpperLeg","leftFoot","rightUpperLeg","rightFoot"];
          const o = {};
          for (const k of keys) o[k] = b[k] ? b[k].name : null;
          o.map = b._map || null;
          return o;
        }""")
        print("BOOT", json.dumps(st))
        print("BONES", json.dumps(bones))
        if not (st.get("modelLoaded") or st.get("level") == "rooftop"):
            print("FAIL boot state unexpected", st)
            await browser.close()
            return 1

        # Face the amuNet tower / city (camera yaw PI looks toward -Z)
        await page.evaluate("() => { AG.cam(Math.PI + 0.55, 0.18, 6.2); AG.setInput({forward:0,right:0,sprint:false}); }")
        await page.wait_for_timeout(900)
        await page.screenshot(path=str(SHOTS / "01_idle_rooftop.png"))
        idle = await page.evaluate("() => AG.state()")
        print("IDLE", json.dumps(idle))

        await page.evaluate("() => { AG.tp(0, 2, 0); AG.face(Math.PI); AG.cam(Math.PI + 0.35, 0.22, 6.2); AG.setInput({forward:1,right:0,sprint:true}); }")
        await page.wait_for_timeout(2800)
        sprint = await page.evaluate("() => AG.state()")
        print("SPRINT", json.dumps(sprint))
        await page.screenshot(path=str(SHOTS / "02_sprint.png"))
        if sprint["speed"] < 5.0:
            print("WARN sprint speed low:", sprint["speed"])

        # jump from a known rooftop spot, then vault the crate at z=7
        await page.evaluate("() => { AG.tp(0, 3.2, 0); AG.face(0); AG.cam(0.05, 0.28); AG.setInput({forward:1,right:0,sprint:false}); }")
        await page.wait_for_timeout(300)
        await page.evaluate("() => AG.jump()")
        await page.wait_for_timeout(250)
        midair = await page.evaluate("() => AG.state()")
        print("JUMP", json.dumps(midair))
        await page.wait_for_timeout(800)

        await page.evaluate("""() => {
          AG.tp(0, 5.5, 0);
          AG.face(0);
          AG.cam(0.0, 0.28);
          AG.setInput({forward:1,right:0,sprint:false});
        }""")
        await page.wait_for_timeout(300)
        vaulted = await page.evaluate("() => AG.tryVault()")
        print("TRYVAULT", vaulted)
        # wait until vault finishes (headless fps is low)
        for _ in range(20):
            stv = await page.evaluate("() => AG.state()")
            if stv["state"] != "vault":
                break
            await page.wait_for_timeout(200)
        await page.evaluate("() => { AG.cam(-0.9, 0.22, 6.5); AG.setInput({forward:0,right:0,sprint:false}); }")
        await page.wait_for_timeout(400)
        after = await page.evaluate("() => AG.state()")
        print("AFTER_VAULT", json.dumps(after))
        await page.screenshot(path=str(SHOTS / "03_vault.png"))

        # combat + dodge: sample the state every frame in the page so slow frames cannot hide a state
        seen = await page.evaluate("""async () => {
          const seen = new Set();
          const watch = (ms) => new Promise((res) => { const t0 = performance.now(); (function f() { seen.add(AG.player.state); if (performance.now() - t0 < ms) requestAnimationFrame(f); else res(); })(); });
          AG.tp(3.2, 3.6); AG.face(0); AG.clearInput();
          await watch(300);
          AG.attack(); await watch(200); AG.attack(); await watch(250); AG.attack(); await watch(900);
          AG.blast(); await watch(900);
          AG.dodge(); await watch(700);
          AG.setInput({forward:1}); await watch(300); AG.dodge(); await watch(700); AG.clearInput();
          return [...seen];
        }""")
        print("STATES", json.dumps(seen))
        missing = [s for s in ("melee1", "melee2", "melee3", "blast", "dodge") if s not in seen]
        clips = await page.evaluate("() => ['jump','fall','land','landRoll','vault','melee1','melee2','melee3','blast','hit','death','dodge','dodgeBack','castGround','castThrow','blinkIn','dash','guard'].filter((n) => !AG.player.loco.hasClip(n))")
        print("MISSING_CLIPS", json.dumps(clips))

        print("ERRORS", len(errs))
        for e in errs[:25]:
            print(" ", e[:400])
        await browser.close()

        fatal = [e for e in errs if e.startswith("PAGEERROR:") or e.startswith("error:")]
        if not st.get("modelLoaded"):
            print("FAIL model did not load (capsule fallback)")
            return 1
        if sprint["speed"] < 4.0:
            print("FAIL sprint did not reach run speed")
            return 1
        if midair["state"] not in ("jump", "fall") and midair.get("grounded") is True:
            print("WARN jump may not have left the ground:", midair)
        if fatal:
            print("FAIL console/page errors")
            return 1
        if missing:
            print("FAIL combat states never seen:", missing)
            return 1
        if clips:
            print("FAIL animation clips missing:", clips)
            return 1
        if after["pos"][2] < 7.4:
            print("FAIL vault did not clear the crate:", after["pos"])
            return 1
        print("OK")
        return 0

if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except Exception:
        traceback.print_exc()
        sys.exit(2)
