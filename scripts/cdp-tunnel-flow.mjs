// SSH 隧道实机验证流程（配合 scripts/dev-ssh-bridge.js 与本机 broker 192.168.222.121）。
// 用法：node scripts/cdp-tunnel-flow.mjs [keep]   keep=验证完不删除测试集群
import {openPage} from './cdp.mjs';

const BROKER = '192.168.222.121';
const CLUSTER_NAME = '隧道测试集群';

let failures = 0;
function check(name, ok, detail) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) {
        failures += 1;
    }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const {cdp, close} = await openPage();

const alertTexts = `Array.from(document.querySelectorAll(".ant-modal .ant-alert")).map(a=>a.textContent)`;
const listClusters = `window.electronAPI.cluster.list().then(r=>JSON.stringify((r.data||[]).map(c=>({name:c.name,id:c.id,status:c.status,tunnel:c.useSshTunnel,ssh:c.ssh&&{host:c.ssh.host,port:c.ssh.port,user:c.ssh.username,remoteHost:c.ssh.remoteHost,active:c.ssh.tunnelActive}}))))`;

try {
    await cdp.ensureHelpers();
    // 幂等：清掉上一次遗留的同名测试集群
    const leftovers = JSON.parse(await cdp.eval(`${listClusters}.then(s=>s)`));
    for (const old of leftovers.filter(c => c.name === CLUSTER_NAME)) {
        await cdp.eval(`window.electronAPI.cluster.delete("${old.id}").then(r=>r.success)`);
    }
    await sleep(1200);
    // 起始：关掉可能残留的弹窗
    const modalOpen = await cdp.eval(
        `(function(){const w=document.querySelector(".ant-modal-wrap");return w && getComputedStyle(w).display!=="none";})()`,
    );
    if (modalOpen) {
        await cdp.click(':text(取消|.ant-modal-footer button)');
        await sleep(800);
    }

    await cdp.click(`:text(添加集群|button)`);
    await cdp.waitFor(`(function(){const w=document.querySelector(".ant-modal-wrap");return w && getComputedStyle(w).display!=="none";})()`);
    check(
        '集群表单含 SSH 隧道步骤',
        JSON.stringify(await cdp.eval(`Array.from(document.querySelectorAll(".ant-steps-item-title")).map(t=>t.textContent.trim())`)).includes(
            'SSH 隧道',
        ),
    );

    // 分步表单在切换时高度会变，footer 跟着移动；每次点击后确认步骤真的变了，
    // 否则可能点到动画中途的旧坐标上。
    const stepTitle = `(document.querySelector(".ant-steps-item-process .ant-steps-item-title")||{}).textContent`;
    async function goTo(title) {
        for (let i = 0; i < 5; i++) {
            if ((await cdp.eval(stepTitle)) === title) {
                return true;
            }
            await cdp.click(':text(下一步|.ant-modal-footer button)');
            await sleep(900);
        }
        return (await cdp.eval(stepTitle)) === title;
    }

    await cdp.ensureHelpers();
    await cdp.eval(
        `JSON.stringify([window.__setField("集群名称","${CLUSTER_NAME}"),window.__setField("Broker Service URL","pulsar://${BROKER}:6650"),window.__setField("Admin API URL","http://${BROKER}:8080")])`,
    );
    check('进入 SSH 隧道步骤', await goTo('SSH 隧道'), await cdp.eval(stepTitle));
    await cdp.click('.ant-modal .ant-switch');
    await cdp.waitFor(`Array.from(document.querySelectorAll(".ant-modal .ant-form-item-label label")).some(l=>l.textContent.trim()==="SSH 主机")`);
    await cdp.ensureHelpers();
    await cdp.eval(
        `JSON.stringify([window.__setField("SSH 主机","127.0.0.1"),window.__setField("端口","2222"),window.__setField("SSH 用户名","pmuser"),window.__setField("SSH 密码","pmtunnel"),window.__setField("远端 Pulsar 主机","${BROKER}")])`,
    );
    await cdp.shot('tunnel-form');

    await cdp.click(':text(测试 SSH 隧道|.ant-modal button)');
    const tunnelAlert = await cdp.waitFor(`${alertTexts}.find(t=>/隧道|失败/.test(t)) || ""`, 25000);
    check('表单内测试 SSH 隧道成功', /隧道已建立/.test(tunnelAlert), tunnelAlert);
    await cdp.shot('tunnel-tested');

    check('进入高级配置步骤', await goTo('高级配置'), await cdp.eval(stepTitle));
    await cdp.click(':text(测试连接|.ant-modal button)');
    const connAlert = await cdp.waitFor(`${alertTexts}.find(t=>/连接成功|连接失败/.test(t)) || ""`, 30000);
    check('经隧道测试集群连接成功', /连接成功/.test(connAlert), connAlert);
    await cdp.shot('tunnel-conn');

    await cdp.click(':text(添加|.ant-modal-footer button)');
    let saved = null;
    try {
        saved = await cdp.waitFor(
            `(async()=>{const r=await window.electronAPI.cluster.list();const c=(r.data||[]).find(x=>x.name==="${CLUSTER_NAME}");return c?JSON.stringify({name:c.name,id:c.id,status:c.status,tunnel:c.useSshTunnel,ssh:c.ssh}):"";})()`,
            15000,
        );
    } catch {
        saved = null;
    }
    check('保存后集群出现在列表', !!saved, saved || '未保存');
    if (saved) {
        const parsed = JSON.parse(saved);
        check(
            '集群带隧道标记与摘要',
            parsed.tunnel === true && parsed.ssh?.host === '127.0.0.1' && parsed.ssh?.username === 'pmuser',
            saved,
        );
        check('隧道配置回显远端主机', parsed.ssh.remoteHost === BROKER, saved);

        // 经隧道浏览资源树（列表由 React 状态渲染，可能比 IPC 结果晚一拍）
        await cdp.waitFor(
            `(function(){const r=Array.from(document.querySelectorAll("tr")).find(x=>x.textContent.includes("${CLUSTER_NAME}"));return !!(r&&r.querySelector("button"));})()`,
            15000,
        );
        await cdp.click(`:row(${CLUSTER_NAME}|button)`);
        const TREE_TEXT = `(function(){const s=document.querySelector(".ant-tree")||document.body;return s.textContent;})()`;
        await cdp.waitFor(`(${TREE_TEXT}.includes("${CLUSTER_NAME}"))`, 15000);
        // 「查看」应当顺带展开该集群节点；没展开就手动点它的折叠开关
        const expanded = await cdp
            .waitFor(`(${TREE_TEXT}.includes("public"))`, 8000)
            .then(() => true)
            .catch(() => false);
        if (!expanded) {
            await cdp.eval(
                `(function(){const n=Array.from(document.querySelectorAll(".ant-tree-treenode")).find(x=>x.textContent.includes("${CLUSTER_NAME}"));const s=n&&n.querySelector(".ant-tree-switcher");if(s)s.click();return !!s;})()`,
            );
        }
        const hasPublic =
            expanded ||
            (await cdp.waitFor(`(${TREE_TEXT}.includes("public"))`, 20000).then(() => true).catch(() => false));
        const treeText = await cdp.eval(`(${TREE_TEXT}.slice(0,300))`);
        check('经隧道加载资源树（含 public 租户）', hasPublic, `${treeText.slice(0, 120)}...`);
        await cdp.shot('tunnel-tree');

        const active = JSON.parse(await cdp.eval(listClusters)).find(c => c.name === CLUSTER_NAME);
        check('隧道处于活动状态', active.ssh.active === true, JSON.stringify(active.ssh));

        // 收尾：删除测试集群（主进程会连带关掉隧道并清理 ssh_tunnels 记录）
        if (process.argv.includes('keep')) {
            console.log('KEEP 模式：保留测试集群，跳过删除');
        } else {
            const removed = await cdp
                .eval(`window.electronAPI.cluster.delete(${JSON.stringify(parsed.id)}).then(r=>r.success)`)
                .catch(e => String(e.message));
            await sleep(1500);
            const gone = !(await cdp.eval(listClusters)).includes(CLUSTER_NAME);
            check('删除测试集群（连带清理隧道配置）', removed === true && gone, `removed=${removed} gone=${gone}`);
        }
    }
} finally {
    await cdp.shot('tunnel-final').catch(() => undefined);
    await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => undefined);
    close();
}

console.log(failures === 0 ? '\nTUNNEL FLOW: ALL PASS' : `\nTUNNEL FLOW: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
