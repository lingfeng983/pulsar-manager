#!/usr/bin/env bash
# 一键出包 + 发布到 Gitee 发行版
#
# 用法:  ./release.sh [tag] [标题] [正文文件]
#        tag 省略时取 package.json 的 version（1.0.0 -> v1.0.0）
#        tag 已存在且指向当前提交则复用：发行版会被更新、同名附件会被替换
#        tag 已存在但指向别的提交则报错，不会把新包挂到旧标签上
#
# 凭证:  环境变量 GITEE_TOKEN，或仓库根目录 .gitee_token 文件
#        （在 https://gitee.com/profile/personal_access_tokens 创建，勾选 projects 权限）
#
# 可重复执行：任何一步失败，修好后再跑一次即可，不会产生重复发行版或重复附件。
set -euo pipefail
cd "$(dirname "$0")"

OWNER="lingfeng983"
REPO="pulsar-manager"
LOG="release/release.log"

die() { echo "!! $*" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- 0. 前置检查 ----------
TOKEN="${GITEE_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .gitee_token ]; then
  TOKEN="$(tr -d '\r\n' < .gitee_token)"
fi
[ -n "$TOKEN" ] || die "缺少 Gitee 令牌：设置 GITEE_TOKEN 环境变量，或把个人访问令牌写入 .gitee_token"
export GITEE_TOKEN="$TOKEN"

[ -z "$(git status --porcelain)" ] || die "工作区有未提交改动，请先提交"
git fetch -q origin master --tags || die "无法访问 origin（网络/凭证问题？）"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] || die "本地 HEAD 与 origin/master 不一致，请先 push"

VERSION="$(node -p "require('./package.json').version")"
TAG="${1:-v$VERSION}"
TITLE="${2:-Pulsar 管理工具 ${TAG}}"
EXE="release/Pulsar管理工具-安装包-${VERSION}.exe"

REMOTE_SHA="$(git ls-remote --tags origin "refs/tags/${TAG}^{}" | cut -f1)"
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$(git rev-parse HEAD)" ]; then
  die "标签 $TAG 已存在且指向 ${REMOTE_SHA:0:7}，与当前 HEAD 不一致"
fi

# ---------- 1. 静态门 ----------
echo "==> [1/4] 静态检查（类型 / 规范 / 格式）"
mkdir -p release
: > "$LOG"
npx tsc -b --force >> "$LOG" 2>&1 || { tail -30 "$LOG"; die "类型检查失败（完整日志 $LOG）"; }
npx eslint src >> "$LOG" 2>&1 || { tail -30 "$LOG"; die "eslint 失败（完整日志 $LOG）"; }
npm run format:check >> "$LOG" 2>&1 || { tail -30 "$LOG"; die "格式检查失败，先跑 npm run format"; }

# ---------- 2. 出包 ----------
echo "==> [2/4] 构建 + electron-builder 打包（约 2-4 分钟，日志 $LOG）"
rm -f release/*-安装包-*.exe release/*-安装包-*.exe.blockmap
npm run build >> "$LOG" 2>&1 || { tail -40 "$LOG"; die "构建失败（完整日志 $LOG）"; }
npm run electron:dist >> "$LOG" 2>&1 || { tail -40 "$LOG"; die "打包失败（完整日志 $LOG）"; }
[ -f "$EXE" ] || { tail -40 "$LOG"; die "打包结束但没找到 $EXE（electron-builder.json 的 artifactName 与脚本不一致？）"; }

SIZE="$(stat -c %s "$EXE")"
SHA="$(sha256sum "$EXE" | cut -d' ' -f1)"
echo "    产物 $EXE（$((SIZE / 1048576)) MB）"
echo "    sha256 $SHA"
# Gitee 附件硬上限 100MB，留 5MB 余量提前拦截，别让上传阶段才发现
[ "$SIZE" -le 99614720 ] || die "安装包 $((SIZE / 1048576)) MB 超过 Gitee 附件上限（95MB 门禁），检查是否有依赖被错误放回 dependencies"

# ---------- 3. 标签 ----------
echo "==> [3/4] 标签 $TAG"
if [ -z "$REMOTE_SHA" ]; then
  git tag -a "$TAG" -m "Release $TAG"
  git push origin "refs/tags/$TAG" || die "推送标签失败"
else
  echo "    标签已存在且指向当前提交，复用"
fi

# ---------- 4. 发行版 ----------
echo "==> [4/4] 创建或更新发行版 $TAG"
PREV_TAG="$(git tag -l --sort=-v:refname | grep -vx "$TAG" | head -1 || true)"
if [ -n "$PREV_TAG" ]; then
  RANGE_DESC="自 ${PREV_TAG} 以来"
  CHANGES="$(git log --oneline --no-decorate -20 "${PREV_TAG}..HEAD")"
else
  RANGE_DESC="最近 15 次提交"
  CHANGES="$(git log --oneline --no-decorate -15)"
fi
[ -n "$CHANGES" ] || CHANGES="（无）"

if [ -n "${3:-}" ] && [ -f "${3:-}" ]; then
  cp "$3" "$TMP/rel_body.txt"
else
  cat > "$TMP/rel_body.txt" <<EOF
Pulsar 管理工具 ${TAG}，Windows x64 安装包。

- 附件 \`Pulsar管理工具-安装包-${VERSION}.exe\`（约 $((SIZE / 1048576)) MB），双击安装
- SHA256：\`${SHA}\`
- 对应提交：\`$(git rev-parse --short HEAD)\`（master 分支）
- 已知限制见 README：「TLS + SSH 隧道」因原生客户端无法指定 SNI 会被明确拒绝；应用内「设置→检查更新」可直接升级到本版本

## 变更（${RANGE_DESC}）

${CHANGES}
EOF
fi
printf '%s' "$TITLE" > "$TMP/rel_title.txt"

node scripts/release-publish.mjs "$TAG" "$TMP/rel_title.txt" "$TMP/rel_body.txt" "$EXE"
echo "==> 完成：https://gitee.com/${OWNER}/${REPO}/releases/tag/${TAG}"
