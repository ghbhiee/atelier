# 车队隧道（Hysteria2 客户端）

13 在洛杉矶，GPU 在大陆。**13 → GPU 方向的普通 TCP 每条流只有约 24 KB/s**，不管哪一侧发起连接，
16 路并行也只到 254–538 KB/s。同一条路径换成 Hysteria2（QUIC + 无视丢包的 Brutal 拥塞控制）实测
**6.0–6.3 MB/s 持续**（2026-09-08，13 → 腾讯云上海，200 MB）。

所以素材不再由 13 推，而是 GPU 自己经隧道去 13 的本机端口拉：

    13: systemd atelier-hy2  →  /etc/atelier/hy2-fleet.yaml（listen :7100，ACL 只放行 127.0.0.1）
    GPU: supervisor hytunnel →  hysteria client，SOCKS5 落在 127.0.0.1:11080
    素材服务 POST /a/<id>/fetch?url=http://127.0.0.1:18790/gpu/_fleet/blob/<一次性 token>

ACL 把隧道钉死在 13 自己身上，密码泄露也变不成一台免费的美国代理。
