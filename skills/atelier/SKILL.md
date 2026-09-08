---
name: atelier
description: 通过 Atelier 工坊（原 H3 Studio，https://atelier.example.com/gpu/，一张 5090 上按需切换模型的 GPU 工作台）的外部 API 生成/查询/下载视频、上传素材、语义搜索提示词库、把实拍视频转成白模、用 GPU 上的本地 LLM（Qwen3.8-27B，OpenAI 兼容端点）聊天、查看/切换显存里的模型。当用户说「用 atelier / 工坊 / studio 生成视频」「让 H3 Studio 跑一条」「查一下 studio 的任务」「搜提示词库」「把这张图传到 studio」「做个白模」「问一下 GPU 上的 Qwen」「GPU 现在装了什么模型」时使用；任务在服务端排队、自动开关 GPU、视频任务优先（会把 LLM 挤出显存）、出片自带缩略图与分享链接。需要 ~/.config/atelier/config.json 里的 base + key（在网页「设置 → API Keys」创建）。
---

# Atelier（原 H3 Studio）API skill

```bash
S=~/.claude/skills/atelier/scripts/atl.py
python3 $S status                                   # GPU / 队列 / 费用
python3 $S models                                   # 显存里有什么、模型目录（tested 的可一键加载）
python3 $S models --task chat|video|tts|asr         # 按任务加载默认模型（仲裁显存，视频↔LLM 互斥）
python3 $S models --load qwen3-32b-q4 | --unload llm|voice|all
python3 $S chat "问题" [--system …] [--model qwen3.8-27b-q4] [--think]   # GPU 上的 Qwen；首次会自动开机+加载（1–4 分钟）
python3 $S whitemodel clip.mp4 [--preset clay|sculpt|soft|toon] [--relief 6] [--photo 0.3] [--ao 0.55] [--no-audio] [--wait]  # 实拍 → 白模
python3 $S upload face.jpg [--project default]      # 上传素材 → 打印 assetId
python3 $S gen "提示词或 @file" [--wait] [-w native_t2v|native_i2v|native_ref2va] [-i 图片或assetId ...] [-v 视频或assetId ...] [--audio 音频] [--seconds 5] [--width 832 --height 448] [--steps N] [--seed N] [--ref-size max|match] [--project default] [--title 名字]
python3 $S jobs [--limit 20] [--project P]          # 任务列表
python3 $S get <jobId>                              # 详情（status/progress/refCheck/output）
python3 $S wait <jobId>                             # 轮询到结束，打印结果
python3 $S download <jobId> [-o out.mp4]            # 下载成片
python3 $S share <jobId> [--permanent]              # 免登录分享链接
python3 $S cancel <jobId>
python3 $S search "雨夜霓虹街头 女孩" [--h3] [-k 10] # 提示词库语义搜索（含溯源链接）
python3 $S prompt <promptId>                        # 提示词原文
python3 $S draft "中文想法" [--mode t2v|i2v|ref|swap] [--seconds 5]   # AI 助手写成官方格式
```

- `-i/-v/--audio` 给本地文件会先上传成素材；给 `a_xxxx` 形式的 id 则直接用。参考图顺序 = 提示词里的 `<Picture N>`。
- 提示词必须按官方格式写，规则在 https://atelier.example.com/h3 ；`draft` 子命令可以让服务端的 AI 助手代写。
- 宽高 32 的倍数，一条 ≤15 秒；`--wait` 会打印进度并在完成后给出本地下载路径与分享链接。
- 配置文件 `~/.config/atelier/config.json`：`{"base": "https://atelier.example.com/studio", "key": "h3s_…"}`（0600）。网页「设置 → API Keys」创建密钥；服务器上也可 `atelier keys create <label>`。
- 完整端点见 https://atelier.example.com/studio/api/v1/docs 。
- **LLM 直连**：任何 OpenAI 兼容客户端把 base_url 设为 `https://atelier.example.com/studio/llm/v1`、api_key 用工作台的 `h3s_…` 即可（`/v1/models` 列目录不触发加载；`/v1/chat/completions` 会自动开机 + 加载默认 Qwen，支持 `stream:true`）。
- **白模**是 GPU 上的 Depth Anything V2 + 浮雕着色，不是 H3 生成；只暴露 relief / photo / ao 三个旋钮，720p 73 秒约 2.5 分钟（上传源视频走隧道较慢）。
- **显存规则**：视频(H3) 与 LLM 互斥，视频任务来了会先卸掉 LLM/语音；语音可与 LLM 共存；白模可与任何组合共存。空闲到阈值先全部卸载再关机。
