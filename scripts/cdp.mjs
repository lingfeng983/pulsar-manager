// 开发期 CDP 驱动小工具：连上正在运行的 Electron 页面，执行 eval/click/set/screenshot 等。
// 用法：node scripts/cdp.mjs eval '<expr>' | click '<css 或 :text(文本|选择器)>' | set '<目标>' '<值>' | shot <名字> | state
// 也被 scripts/cdp-tunnel-flow.mjs 复用（openPage）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const LIST = 'http://127.0.0.1:9222/json';

export const HELPERS = `(function(){
  window.__byText = function(sel, text){
    const nodes = Array.from(document.querySelectorAll(sel));
    return nodes.find(n => (n.textContent||'').replace(/\\s+/g,'').includes(text.replace(/\\s+/g,''))) || null;
  };
  window.__rect = function(el){
    if(!el) return null;
    el.scrollIntoView({block:'center', inline:'center'});
    const r = el.getBoundingClientRect();
    return {x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height};
  };
  window.__find = function(spec){
    const row = /^:row\\((.+?)\\|(.+)\\)$/.exec(spec);
    if(row){
      // 同名节点可能同时出现在资源树和表格里，取第一个真正含目标子元素的那个
      const cands = Array.from(document.querySelectorAll('tr,.ant-tree-treenode,.ant-list-item'))
        .filter(r => (r.textContent||'').includes(row[1]));
      for (const c of cands) {
        const el = c.querySelector(row[2]);
        if (el) return el;
      }
      return null;
    }
    const m = /^:text\\((.+?)(?:\\|(.+))?\\)$/.exec(spec);
    if(m) return window.__byText(m[2]||'*', m[1]);
    return document.querySelector(spec);
  };
  window.__setField = function(labelText, val){
    const item = Array.from(document.querySelectorAll('.ant-modal .ant-form-item')).find(i => {
      const l = i.querySelector('.ant-form-item-label label');
      return l && l.textContent.trim() === labelText;
    });
    const el = item && item.querySelector('input,textarea');
    if(!el) return 'missing:' + labelText;
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
    el.dispatchEvent(new Event('input', {bubbles:true}));
    return 'ok:' + el.value;
  };
  return true;
})()`;

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 0;
        this.pending = new Map();
        ws.on('message', raw => {
            const msg = JSON.parse(raw.toString());
            if (msg.id && this.pending.has(msg.id)) {
                const {resolve, reject} = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) {
                    reject(new Error(JSON.stringify(msg.error)));
                } else {
                    resolve(msg.result);
                }
            }
            if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                console.log('[PAGE EXCEPTION]', d.exception && (d.exception.description || d.exception.value));
            }
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            this.pending.set(id, {resolve, reject});
            this.ws.send(JSON.stringify({id, method, params}));
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`timeout: ${method}`));
                }
            }, 40000).unref?.();
        });
    }

    async eval(expression) {
        const r = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (r.exceptionDetails) {
            throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
        }
        return r.result.value;
    }

    async ensureHelpers() {
        // 无条件重注入：页面上下文会跨进程存活，按"存在与否"判断会一直用旧版本
        await this.eval(HELPERS);
    }

    async click(spec) {
        await this.ensureHelpers();
        const rect = await this.eval(`window.__rect(window.__find(${JSON.stringify(spec)}))`);
        if (!rect || !rect.w) {
            throw new Error(`element not found or invisible: ${spec}`);
        }
        for (const type of ['mousePressed', 'mouseReleased']) {
            await this.send('Input.dispatchMouseEvent', {
                type,
                x: rect.x,
                y: rect.y,
                button: 'left',
                clickCount: 1,
                modifiers: 0,
            });
        }
        return `${spec} @ ${Math.round(rect.x)},${Math.round(rect.y)}`;
    }

    async evalInPage(expression) {
        // 页面里异步求值（awaitPromise 只在求值那一刻生效，不会跨调用保留状态），
        // 返回 {ok, value}，value 一律是 JSON 字符串。
        const wrapped = `(async()=>{try{return JSON.stringify({ok:true,value:await (${expression})});}catch(e){return JSON.stringify({ok:false,error:String(e&&e.message||e)});}})()`;
        const raw = await this.eval(wrapped);
        const parsed = JSON.parse(raw);
        if (!parsed.ok) {
            throw new Error(parsed.error);
        }
        return parsed.value;
    }

    async waitFor(expression, timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = await this.eval(expression);
            if (value) {
                return value;
            }
            if (Date.now() > deadline) {
                throw new Error(`timeout waiting for ${expression}`);
            }
            await new Promise(resolve => setTimeout(resolve, 400));
        }
    }

    async shot(name) {
        const shot = await this.send('Page.captureScreenshot', {format: 'png'});
        const file = path.join(os.tmpdir(), `cdp-${name}.png`);
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        return file;
    }
}

export async function openPage() {
    const res = await fetch(LIST);
    const targets = await res.json();
    const page = targets.find(t => t.type === 'page' && /^http:\/\/localhost:5173/.test(t.url));
    if (!page) {
        throw new Error(`no dev page target: ${targets.map(t => `${t.type} ${t.url}`).join(' | ')}`);
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl, {perMessageDeflate: false});
    await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    // 窗口被遮挡或最小化时 Chromium 把页面判成 hidden，requestAnimationFrame 会被冻结，
    // 于是依赖 rAF 的绘制（ECharts 的 lazyUpdate、CSS 动画）在验证时永远不落地——
    // 表现是"图表容器和 echarts 实例都在、就是没有 canvas"。焦点模拟让页面拿到
    // visible+focused，rAF 恢复正常。
    await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: true});
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 920,
        deviceScaleFactor: 1,
        mobile: false,
    });
    await cdp.eval(HELPERS);
    return {cdp, close: () => ws.close()};
}

async function main() {
    const [cmd, ...args] = process.argv.slice(2);
    const {cdp, close} = await openPage();
    try {
        if (cmd === 'eval') {
            console.log(JSON.stringify(await cdp.eval(args[0]), null, 1));
        } else if (cmd === 'click') {
            console.log(`clicked ${await cdp.click(args[0])}`);
        } else if (cmd === 'set') {
            console.log(await cdp.eval(`window.__setField(${JSON.stringify(args[0])}, ${JSON.stringify(args[1] ?? '')})`));
        } else if (cmd === 'shot') {
            console.log(await cdp.shot(args[0] || 'shot'));
        } else if (cmd === 'state') {
            console.log(
                JSON.stringify(
                    await cdp.eval(
                        `({visibility: document.visibilityState, w: innerWidth, h: innerHeight, modal: (function(){const el=document.querySelector(".ant-modal-wrap");return el?getComputedStyle(el).display:"none";})(), step: (document.querySelector(".ant-steps-item-process .ant-steps-item-title")||{}).textContent, tabs: Array.from(document.querySelectorAll("[role=\\"tab\\"]")).map(t=>t.textContent.trim()).slice(0,12), buttons: Array.from(document.querySelectorAll("button")).map(b=>b.textContent.replace(/\\s+/g,'')).filter(Boolean).slice(0,40)})`,
                    ),
                    null,
                    1,
                ),
            );
        } else {
            throw new Error(`unknown command ${cmd}`);
        }
    } finally {
        await cdp.send('Emulation.setFocusEmulationEnabled', {enabled: false}).catch(() => undefined);
        await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
        close();
        process.exit(0);
    }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/cdp.mjs')) {
    main().catch(error => {
        console.error('CDP FAILED', error.message);
        process.exit(1);
    });
}
