# Atelier 工坊

一台按需开关机的云 GPU，四种能力轮流上卡：**视频生成（MiniMax-H3）· 白模渲染 · 语音（合成 / 克隆 / 转写）· 本地大模型**。
浏览器里用，也给 agent 留了 OpenAI 兼容的接口。

一张 32 GB 的卡装不下所有模型，所以这套东西的核心不是"跑模型"，而是**编排**：谁该在显存里、什么时候开机、
素材怎么进去、结果怎么回来、闲着了什么时候关机。

```
浏览器 ──────────────────────────┐
                                 │ 直传素材（同国家，最快）
   ┌─────────────┐  反向 SSH 隧道  ▼
   │  控制面 (VPS) │◄────────────  GPU 机器（按小时租）
   │  Node 22     │   Hysteria2   ├─ ComfyUI + MiniMax-H3
   │  Express 5   │──────────────►├─ llama.cpp（Qwen 等）
   └─────────────┘   备份/同步    ├─ 语音服务（IndexTTS-2 / Qwen3-TTS / Kokoro / SenseVoice）
                                  └─ 素材服务（TLS，浏览器直传落点）
```

## 它解决的问题

**显存仲裁。** 视频与大模型互斥，语音可以和大模型共存，白模谁都不挤。切换时自动腾显存，
上下文长度按当前这张卡能装多少自动定——同一套配置在 24 / 32 / 48 / 96 GB 的机器上都对。

**按需开关机。** 提交任务自动开机，空闲到点自动关机，并且**先确认没人在用**：别的会话的队列、
别人的进程、正在传的数据都会拦住关机。

**跨国链路。** 控制面在海外、GPU 在国内时，普通 TCP 每条流只有约 24 KB/s。这套东西给出的答案是
BBR + Hysteria2 隧道 + 让 GPU 主动拉，实测把 24 KB/s 提到 6 MB/s。素材优先走浏览器直传（不经控制面），
结果走 GPU→控制面（本来就快的方向）。

**多机切换。** 一个区域租不到卡是常态，所以机器是参数不是常量：一条命令接入新机器（4–6 分钟），
开不了机自动换下一台。

**提示词。** H3 的官方格式很啰嗦且有一堆实测出来的硬约束，`PROMPT_RULES.md` 是唯一的事实来源；
站内助手拿它当 system prompt，你也可以把链接丢给自己的 agent，两边产出一致。

## 目录

| 路径 | 是什么 |
| --- | --- |
| `server/` | 控制面：Express 5，无框架前端。`models.js` 显存仲裁、`power.js` 开关机、`jobs.js` 任务、`direct.js` 素材直传与隧道 |
| `web/` | 单文件前端，无构建步骤 |
| `gpu/` | 装在 GPU 机器上的东西：`gpuctl.sh`（状态/程序控制）、`assets/`（直传落点）、`voice/`（语音路由）、`whitemodel/`（ComfyUI 自定义节点）、`hytunnel/`（加速隧道） |
| `deploy/` | `add-gpu.sh` 一条命令接入新机器；`push.sh` 发布控制面 |
| `test/` | `e2e.mjs` 接口全链路；`browser.mjs` 零依赖的 Chrome DevTools 驱动，89 项断言 |
| `skills/atelier/` | 给 agent 用的命令行客户端 |
| `PROMPT_RULES.md` | MiniMax-H3 提示词规则 |

## 跑起来

需要 Node 22+、ffmpeg、一台能跑 ComfyUI 的 GPU 机器。

```bash
cp deploy/env.example /etc/atelier/env    # 填 PUBLIC_ORIGIN / TOKEN_PEPPER / 云厂商密钥
npm install
node server/src/index.js
```

本地开发（mock 掉 ComfyUI、GPU 和外部 AI，不需要真机）：

```bash
node test/dev.mjs          # http://localhost:18790/dev-login?token=dev
node test/e2e.mjs          # 接口
node test/browser.mjs      # 浏览器
```

接入一台新的 GPU 机器（在控制面上跑）：

```bash
sh deploy/add-gpu.sh <名字> '<云厂商给的 ssh 命令>' <端口基数> '<密码>'
```

## 机器随时会没

租来的卡是临时的，24 GB 的卡和抢占式实例还**做不了镜像**——用完就消失，下次只能从上一次烤的
基础镜像重新开一台。所以这套东西的前提是：**ssh 上去手敲的改动等于没做过**。

控制面上存着一个有序的**层**仓库：每层一个幂等脚本（可带负载包），机器记着自己应用到哪一层，
差额由 `gpu/restore.sh` 补齐，开机自动跑。

```bash
vim deploy/layers/310-你的改动.sh     # 层写在仓库里，事实来源是 git
sh deploy/layer.sh sync              # 摊到控制面
gpuctl restore                       # 盒子补差额（幂等，重复跑只跳过）
```

版本管理就是「一个有序表 + 每台机器一个水位线」：`make-image.sh` 打快照前先 `layer.sh bake`，
把当时的层全集写进机器的账本；用这个镜像开的机器天生「已应用」，只补之后新增的几层。
隔一段时间重做镜像，开机要补的就更少。

数据另走一条路，因为它一直在变：素材控制面有全份，换机时只补差额；用户克隆出来的音色只存在
盒子里，所以控制面把它们拉回来（盒子 → 控制面是快的方向），开机时再补回去。

## 几个设计上的选择

**没有前端框架，没有构建步骤。** `web/app.js` 是一个文件，改完刷新就是最新的。

**没有数据库。** 一个 JSON 状态文件加文件系统。任务、素材、提示词都是文件，可以直接看、直接备份。

**认证只有 Passkey。** 没有密码。agent 用单独发的 API key，权限等同网页登录，可随时吊销。

**测试对着真东西跑。** 浏览器测试驱动真的 Chrome 走完每个页面；接口测试跑完整的任务生命周期。
两套都不依赖任何 npm 包。

## 已知的边界

- 云厂商的接口是按 CompShare（优云智算）写的，换厂商要改 `server/src/compshare.js`。
- H3 的权重不在仓库里，需要自己准备（`gpu/install-comfyui.sh` 里是软链到共享盘的路径）。
- 24 GB 卡的 GGUF 量化路径已经写好但**没有在真机上验证过**。

MIT License.
