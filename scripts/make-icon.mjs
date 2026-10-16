// 应用图标的唯一来源：一个脚本画出全部尺寸，产出 build/icon.ico 与 src/main/app-icon.ts。
//
// 为什么手写光栅化而不是装 sharp / electron-icon-builder：图标只有"圆角方块 + 闪电"两个
// 形状，纯 Node（zlib + 手写 PNG/ICO 容器）就能出图，不必为一张图标引入原生依赖或下载
// 外部工具链；也保证 build/icon.ico 是可复现的——改设计改脚本重跑一次即可，不会出现
// "谁手里那份 PS 源文件才是真的"。
//
// 用法：npm run icon   （改完脚本必须重跑，两个产物都要入库）
import {deflateSync} from 'node:zlib';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 3; // 逐子点判定形状覆盖再盒式降采样，16px 下斜边才不会锯齿成阶梯

// 配色跟着应用主色（index.css 的 --color-primary: #1677ff），不是托盘以前那颗紫色闪电：
// 任务栏、托盘、关于弹窗讲的是同一个颜色
const TOP_COLOR = [0x40, 0x96, 0xff]; // #4096ff
const BOTTOM_COLOR = [0x09, 0x58, 0xd9]; // #0958d9
const MARK_COLOR = [0xff, 0xff, 0xff, 0xff];

const CORNER_RADIUS = 0.22; // 相对边长
// 16/24px 上 0.22 的圆角会啃掉将近三分之一的画面，闪电的细边也直接糊成一团，
// 所以小尺寸单独用一套更小的圆角 + 加粗的闪电（同一形状按中心外扩，不是另画一张）
const SMALL_CORNER_RADIUS = 0.15;
const SMALL_MAX_SIZE = 32;
const BOLD_SCALE = {x: 1.22, y: 1};
const BOLT = [
    [0.55, 0.05],
    [0.3, 0.52],
    [0.48, 0.52],
    [0.42, 0.95],
    [0.72, 0.45],
    [0.53, 0.45],
];

function hex([r, g, b]) {
    return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 圆角方块内判定：按四角圆弧做精确覆盖测试。 */
function insideRoundedSquare(x, y, radius) {
    if (x < 0 || x > 1 || y < 0 || y > 1) {
        return false;
    }
    const cx = Math.max(radius, Math.min(1 - radius, x));
    const cy = Math.max(radius, Math.min(1 - radius, y));
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insidePolygon(x, y, points) {
    let hit = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            hit = !hit;
        }
    }
    return hit;
}

/** 绕闪电自己的包围盒中心放大，只用来加粗笔画，不改变形状。 */
function scalePolygon(points, kx, ky) {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return points.map(([x, y]) => [cx + (x - cx) * kx, cy + (y - cy) * ky]);
}

/** 画一个 size×size 的 RGBA 位图（含抗锯齿）。 */
function render(size) {
    const small = size <= SMALL_MAX_SIZE;
    const radius = small ? SMALL_CORNER_RADIUS : CORNER_RADIUS;
    const bolt = small ? scalePolygon(BOLT, BOLD_SCALE.x, BOLD_SCALE.y) : BOLT;
    const ss = size * SUPERSAMPLE;
    const rgba = Buffer.alloc(size * size * 4);
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let coverage = 0;
            let mark = 0;
            let r = 0;
            let g = 0;
            let b = 0;
            for (let sy = 0; sy < SUPERSAMPLE; sy++) {
                for (let sx = 0; sx < SUPERSAMPLE; sx++) {
                    // 子点取像素中心，y 同时用于纵向渐变（渐变按整图坐标，不受子点影响）
                    const x = (px * SUPERSAMPLE + sx + 0.5) / ss;
                    const y = (py * SUPERSAMPLE + sy + 0.5) / ss;
                    if (!insideRoundedSquare(x, y, radius)) {
                        continue;
                    }
                    coverage += 1;
                    const t = ((py * SUPERSAMPLE + sy) / ss) * 1;
                    r += TOP_COLOR[0] + (BOTTOM_COLOR[0] - TOP_COLOR[0]) * t;
                    g += TOP_COLOR[1] + (BOTTOM_COLOR[1] - TOP_COLOR[1]) * t;
                    b += TOP_COLOR[2] + (BOTTOM_COLOR[2] - TOP_COLOR[2]) * t;
                    if (insidePolygon(x, y, bolt)) {
                        mark += 1;
                    }
                }
            }
            if (!coverage) {
                continue;
            }
            const n = SUPERSAMPLE * SUPERSAMPLE;
            const mix = mark / coverage; // 闪电边缘在底色之上做线性插值
            const baseR = r / coverage;
            const baseG = g / coverage;
            const baseB = b / coverage;
            const offset = (py * size + px) * 4;
            rgba[offset] = Math.round(baseR + (MARK_COLOR[0] - baseR) * mix);
            rgba[offset + 1] = Math.round(baseG + (MARK_COLOR[1] - baseG) * mix);
            rgba[offset + 2] = Math.round(baseB + (MARK_COLOR[2] - baseB) * mix);
            rgba[offset + 3] = Math.round((coverage / n) * 255);
        }
    }
    return rgba;
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (const byte of buf) {
        c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

/** 把 RGBA 位图编成 PNG（8bit RGBA、无过滤、非隔行）。 */
function encodePng(size, rgba) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 6; // color type: RGBA
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y++) {
        raw[y * (size * 4 + 1)] = 0; // filter: none
        rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, {level: 9})),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * 把 RGBA 位图编成 ICO 里的一项：32bpp 未压缩 DIB（BITMAPINFOHEADER + 自下而上的 BGRA +
 * 全 0 的 1bpp AND 掩码）。
 *
 * 为什么不用 Vista 之后允许的"目录项直接挂 PNG"：体积小三倍，但实测 System.Drawing.Icon
 * 这类按 DIB 解析的加载器会把 PNG 字节当位图读，画出来是一片彩色噪点——任务栏、托盘、
 * 文件属性里看到的正是这种加载器的结果。一张应用图标不值这个风险，372 KB 换到处都能画对。
 */
function encodeDib(size, rgba) {
    // 掩码每行按 4 字节对齐；全 0 表示"不擦背景"，透明度由 BGRA 的 A 通道决定
    const maskStride = Math.ceil(size / 32) * 4;
    const mask = Buffer.alloc(maskStride * size); // 全 0
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        // DIB 的行序是自下而上
        const srcRow = y * size * 4;
        const dstRow = (size - 1 - y) * size * 4;
        for (let x = 0; x < size; x++) {
            const o = srcRow + x * 4;
            const d = dstRow + x * 4;
            pixels[d] = rgba[o + 2]; // B
            pixels[d + 1] = rgba[o + 1]; // G
            pixels[d + 2] = rgba[o]; // R
            pixels[d + 3] = rgba[o + 3]; // A
        }
    }
    const header = Buffer.alloc(40);
    header.writeUInt32LE(40, 0); // biSize
    header.writeInt32LE(size, 4); // biWidth
    header.writeInt32LE(size * 2, 8); // biHeight：XOR（颜色）+ AND（掩码）两段
    header.writeUInt16LE(1, 12); // biPlanes
    header.writeUInt16LE(32, 14); // biBitCount
    header.writeUInt32LE(0, 16); // biCompression: BI_RGB
    header.writeUInt32LE(pixels.length + mask.length, 20); // biSizeImage
    return Buffer.concat([header, pixels, mask]);
}

/** ICO 容器：目录项 + 每项一份 DIB。256px 的宽高在目录里写 0。 */
function encodeIco(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2); // 类型 1 = 图标
    header.writeUInt16LE(images.length, 4);
    const offsetOf = 6 + 16 * images.length;
    let cursor = offsetOf;
    const entries = images.map(({size, dib}) => {
        const entry = Buffer.alloc(16);
        entry[0] = size === 256 ? 0 : size;
        entry[1] = size === 256 ? 0 : size;
        entry[4] = 1; // planes
        entry[6] = 32; // bit count
        entry.writeUInt32LE(dib.length, 8);
        entry.writeUInt32LE(cursor, 12);
        cursor += dib.length;
        return entry;
    });
    return Buffer.concat([header, ...entries, ...images.map(i => i.dib)]);
}

const outDir = path.resolve('build');
mkdirSync(outDir, {recursive: true});
mkdirSync(path.resolve('src/main'), {recursive: true});

const bitmaps = SIZES.map(size => {
    const rgba = render(size);
    return {size, png: encodePng(size, rgba), dib: encodeDib(size, rgba)};
});
writeFileSync(path.join(outDir, 'icon.ico'), encodeIco(bitmaps));
// 256px 那份同时给 macOS / Linux 与「关于」弹窗用
writeFileSync(path.join(outDir, 'icon.png'), bitmaps.find(i => i.size === 256).png);

const dataUrl = size => {
    const image = bitmaps.find(i => i.size === size);
    return `data:image/png;base64,${image.png.toString('base64')}`;
};

writeFileSync(
    path.resolve('src/main/app-icon.ts'),
    `// 由 scripts/make-icon.mjs 生成，不要手改：改设计改脚本后跑 npm run icon。
/* eslint-disable max-len -- base64 一行就是一张图，换行会改变数据 */
// 主进程里所有图标（窗口 / 任务栏 / 托盘）都从这里取，避免"托盘换了任务栏没换"。
// 内联而不是读资源文件：打包时 files 只含 dist/**，资源路径要跨 asar 边界，
// 而这两个尺寸的组合也就几十 KB。
export const APP_ICONS = {
    /** 托盘：Windows 按 16px 画，给小图才不糊。 */
    tray: '${dataUrl(16)}',
    /** 窗口与任务栏：给到 256px，由系统按显示比例缩。 */
    window: '${dataUrl(256)}',
};
`,
);

console.log(
    `已生成 build/icon.ico（${SIZES.join('/')} px，圆角方块 ${hex(TOP_COLOR)}→${hex(BOTTOM_COLOR)} + 白色闪电）、build/icon.png 与 src/main/app-icon.ts`,
);
