#!/usr/bin/env bash
# 生成 SSH 隧道自检用的主机密钥、客户端密钥与自签证书（全部只在本机使用）。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
cd certs

if [ ! -f ssh_host_ed25519 ]; then
    ssh-keygen -q -t ed25519 -N '' -f ssh_host_ed25519 -C selftest-host
fi

if [ ! -f selftest_key ]; then
    ssh-keygen -q -t ed25519 -N '' -f selftest_key -C selftest-key
fi

if [ ! -f ca.crt ]; then
    MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -sha256 -days 2 -nodes \
        -keyout ca.key -out ca.crt -subj '/CN=selftest-ca'
fi

if [ ! -f broker.key ]; then
    MSYS_NO_PATHCONV=1 openssl req -newkey rsa:2048 -sha256 -nodes \
        -keyout broker.key -out broker.csr -subj '/CN=broker.selftest'
    cat > broker.ext <<'EOF'
subjectAltName = DNS:broker.selftest
extendedKeyUsage = serverAuth
EOF
    MSYS_NO_PATHCONV=1 openssl x509 -req -in broker.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
        -days 2 -sha256 -extfile broker.ext -out broker.crt
    rm -f broker.csr broker.ext ca.srl
fi

echo "certs ready: $(ls)"
