#!/usr/bin/env bash
# 一键出包 + 发布到 Gitee 发行版
#
# 用法:  ./release.sh [tag] [标题] [正文文件]
#        tag 省略时取 package.json 的 version（1.0.0 -> v1.0.0）
#        tag 已存在且指向当前提交则复用：发行版会被更新、同名附件会被替换
#        tag 已存在但指向别的提交则报错，不会把新包挂到旧标签上
#
# 出包目录: OUT_DIR 环境变量，默认 release
#        IDE 的文件索引器可能长期锁住旧输出目录里的 app.asar，electron-builder
#        清空目录时会直接失败。换个空目录即可绕开：OUT_DIR=release-next ./release.sh
#
# 凭证:  环境变量 GITEE_TOKEN，或仓库根目录 .gitee_token 文件，
#        再否则取 Windows 凭据管理器里 gitee.com 那份（git push 用的同一令牌，API 也认）
#        在 https://gitee.com/profile/personal_access_tokens 创建，勾选 projects 权限
#        任何一级都不落仓库：脚本会随 dist 进 asar，内嵌令牌等于随安装包分发凭据
#
# 分发仓: 唯一的发版处。安装包发布到 GITEE_DIST_REPO（默认 pulsar-manager-dist，公开），
#        不存在时由脚本创建；只保留最近 GITEE_DIST_KEEP（默认 3）个版本的安装包。
#        源码仓 ${OWNER}/pulsar-manager 保持私有，只留提交与标签、不挂发行版。
#
# 可重复执行：任何一步失败，修好后再跑一次即可，不会产生重复发行版或重复附件。
set -euo pipefail
cd "$(dirname "$0")"

OWNER="lingfeng983"
REPO="pulsar-manager"
# 安装包与发行版发布到这个公开仓库，应用内「检查更新」读它：公开仓库读取不需要
# access_token，用户不用再自备令牌；源码仓保持私有。
DIST_REPO="${GITEE_DIST_REPO:-pulsar-manager-dist}"
OUT_DIR="${OUT_DIR:-release}"
LOG="${OUT_DIR}/release.log"

die() { echo "!! $*" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---------- 0. 前置检查 ----------
# 令牌来源依次：GITEE_TOKEN 环境变量 → 仓库根 .gitee_token → Windows 凭据管理器。
# 凭据管理器里存的就是 git push 用的那份私人令牌，Gitee 的 API 同样认它，所以本机
# 发版不需要再准备第二份凭证。不把它写进代码：本脚本与 scripts/ 会随 dist 进 asar，
# 内嵌（哪怕加密）等于把凭据交给每一个装了安装包的人。
token_from_credential_manager() {
  command -v git-credential-manager >/dev/null 2>&1 || return 0
  # GCM_INTERACTIVE=never：没存过这条记录时直接失败返回，而不是弹窗要用户登录，
  # 否则发版脚本会卡在一个看不见的交互提示上。
  # 只取 password 那一行；不回显、不进日志，git 找不到 helper 时静默返回空
  printf 'protocol=https\nhost=gitee.com\n\n' \
    | GCM_INTERACTIVE=never git credential-manager get 2>/dev/null \
    | sed -n 's/^password=//p' | tr -d '\r\n'
}

TOKEN="${GITEE_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f .gitee_token ]; then
  TOKEN="$(tr -d '\r\n' < .gitee_token)"
fi
if [ -z "$TOKEN" ]; then
  TOKEN="$(token_from_credential_manager)"
fi
[ -n "$TOKEN" ] || die "缺少 Gitee 令牌：设置 GITEE_TOKEN 环境变量、把个人访问令牌写入 .gitee_token，或先用 git 拉取一次让 Windows 凭据管理器存有该仓库的令牌"
export GITEE_TOKEN="$TOKEN"

# 令牌失效要在出包之前就说：electron-builder 要跑两三分钟，别让用户等完才在第 4 步吃 401
API_OK="$(curl -s -o /dev/null -w '%{http_code}' "https://gitee.com/api/v5/user?access_token=${TOKEN}" || echo 000)"
[ "$API_OK" = "200" ] || die "Gitee 令牌不可用（HTTP $API_OK）：到 https://gitee.com/profile/personal_access_tokens 重新生成（勾选 projects 权限）后覆盖 .gitee_token"

[ -z "$(git status --porcelain)" ] || die "工作区有未提交改动，请先提交"
git fetch -q origin master --tags || die "无法访问 origin（网络/凭证问题？）"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] || die "本地 HEAD 与 origin/master 不一致，请先 push"

VERSION="$(node -p "require('./package.json').version")"
TAG="${1:-v$VERSION}"
TITLE="${2:-Pulsar 管理工具 ${TAG}}"
EXE="${OUT_DIR}/Pulsar管理工具-安装包-${VERSION}.exe"

REMOTE_SHA="$(git ls-remote --tags origin "refs/tags/${TAG}^{}" | cut -f1)"
if [ -n "$REMOTE_SHA" ] && [ "$REMOTE_SHA" != "$(git rev-parse HEAD)" ]; then
  die "标签 $TAG 已存在且指向 ${REMOTE_SHA:0:7}，与当前 HEAD 不一致"
fi

# ---------- 1. 静态门 ----------
echo "==> [1/4] 静态检查（类型 / 规范 / 格式）"
mkdir -p "$OUT_DIR"
: > "$LOG"
npx tsc -b --force >> "$LOG" 2>&1 || { tail -30 "$LOG"; die "类型检查失败（完整日志 $LOG）"; }
npx eslint src >> "$LOG" 2>&1 || { tail -30 "$LOG"; die "eslint 失败（完整日志 $LOG）"; }
npm run format:check >> "$LOG" 2>&1 || { tail -30 "$LOG"; die "格式检查失败，先跑 npm run format"; }

# ---------- 2. 出包 ----------
echo "==> [2/4] 构建 + electron-builder 打包（约 2-4 分钟，日志 $LOG）"
# 清掉上一代的同名产物：artifactName 是「Pulsar管理工具-安装包-<版本>.exe」，
# 模式必须带产品名前缀，写成 "-安装包-*" 从来匹配不到任何文件（旧包会一直留在目录里）
rm -f "${OUT_DIR}"/Pulsar管理工具-安装包-*.exe "${OUT_DIR}"/Pulsar管理工具-安装包-*.exe.blockmap
# 先单独 build（避免"改了源码却把上一代 dist 打进安装包"），再按 OUT_DIR 打包，
# 最后跑 verify-package：electron-builder 在输出目录被锁住时可能只写出
# resources/app.asar 就以 0 退出，安装包能生成但装出来是打不开的半成品，必须在这里拦下
npm run build >> "$LOG" 2>&1 || { tail -40 "$LOG"; die "构建失败（完整日志 $LOG）"; }
npx electron-builder -c.directories.output="$OUT_DIR" >> "$LOG" 2>&1 || { tail -40 "$LOG"; die "打包失败（完整日志 $LOG）"; }
node scripts/verify-package.mjs "$OUT_DIR" >> "$LOG" 2>&1 || { tail -40 "$LOG"; die "产物完整性校验失败（完整日志 $LOG）"; }
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

# 分发仓（公开）先确保存在并有一条 master：Gitee 的发行版必须挂在真实提交上，
# 而新建的空仓库没有分支可指，所以推一个只含 README 的提交过去当锚点。
DIST_URL="https://gitee.com/${OWNER}/${DIST_REPO}.git"
DIST_SHA="$(node scripts/release-publish.mjs ensure-dist | tail -1)"
if [ -z "$DIST_SHA" ]; then
  echo "    $DIST_REPO 是空仓库，初始化 master"
  DIST_INIT="$(mktemp -d)"
  git init -q "$DIST_INIT"
  git -C "$DIST_INIT" checkout -q -b master
  {
    echo "# ${DIST_REPO}"
    echo
    echo "Pulsar 管理工具的安装包分发仓库，只放发行版与安装包；源码在私有仓库 ${OWNER}/${REPO}。"
    echo "本仓库由 ${OWNER}/${REPO} 的 release.sh 自动发布，请勿手工提交。"
  } > "${DIST_INIT}/README.md"
  git -C "$DIST_INIT" add README.md
  git -C "$DIST_INIT" commit -q -m "init: 安装包分发仓库（只放发行版与安装包）"
  git -C "$DIST_INIT" push -q "$DIST_URL" master || die "无法初始化 $DIST_URL（Gitee 令牌对新建仓库没写权限？）"
  rm -rf "$DIST_INIT"
fi

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
  # 应用内「检查更新」的校验值只从发行说明正文里那一行取（update-service.ts 的
  # sha256FromNotes），自定义正文漏了它就等于给所有旧客户端发一条"发现新版本但拒绝
  # 下载"的更新——更新通道发出去收不回来，所以在这里拦住。
  grep -Eq 'SHA256[：:] *`?[0-9a-fA-F]{64}' "$TMP/rel_body.txt" \
    || die "正文文件 $3 缺少「- SHA256：\`<64 位十六进制>\`」这一行，应用内更新无法校验安装包（本次构建的 SHA256：${SHA}）"
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

# 安装包只上传到公开的分发仓（应用内更新读它，用户不需要令牌）；
# 源码仓不再发版，脚本会把它上面残留的历史发行版连附件一起删掉。
node scripts/release-publish.mjs "$TAG" "$TMP/rel_title.txt" "$TMP/rel_body.txt" "$EXE"
echo "==> 完成：https://gitee.com/${OWNER}/${DIST_REPO}/releases/tag/${TAG}（分发，应用内更新读这里）"
