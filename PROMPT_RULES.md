# MiniMax-H3 提示词规则（写任何 H3 提示词前先读完这一页）

目标：让 agent 写出 H3 能稳定执行、分段生成也不漂的提示词。规则来自 MiniMax 官方
`VIDEO_PROMPT_WRITING_GUIDE_{base,ref}_en.md` 和实测（2026-09-05）。

## 0. 先判断能不能靠提示词

| 提示词管得住 | 提示词管不住 |
|---|---|
| 谁是谁（脸绑哪张图）、服装、发型、眼镜、小道具、左右关系、表情动作、台词和时长、声音、相机动不动 | **机位和构图**——完全跟着参考图走。要换景别只能换一张对应景别的参考图（母图裁剪或再生成），写再多 "close-up / not in frame" 都无效 |

## 1. 格式（六段，顺序不能变，全英文，只有台词保留原语言）

```text
subject_definitions:
<Subject 1> is CHARACTER A, the older sister. Her face and identity come from <Picture 1>: <脸的客观描述：脸型、发型、耳环、有无眼镜>. Her wardrobe comes from <Picture 3>: <固定服装>. She is the woman standing on the left in <Picture 3>.
<Subject 2> is CHARACTER B, … from <Picture 2> … always keeps her black round-frame glasses on …
<Subject 3> is the apartment living room in <Picture 3>: LEFT background = small open kitchen; CENTER background = kitchen island with two stools; RIGHT background = large window with night city lights; beige sofa center foreground; brown wooden coffee table in front; floor lamp LEFT of sofa; side table RIGHT of sofa.
<Picture 3> is also the composition anchor: camera directly in front of the sofa at seated eye level, <Subject 1> screen-left, <Subject 2> screen-right.

summary:
[reference generation] One static two-shot of <Subject 1> and <Subject 2> inside <Subject 3>: <一句话剧情>.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - facial identity, proportions, apparent age, hairstyle, earring, cream sweater, blue jeans, white socks are retained unchanged.
<Subject 2> (appears in [Shot 1]): fully_preserved - … black round-frame glasses … retained unchanged.
<Subject 3> (appears in [Shot 1]): fully_preserved - layout, furniture, colors and lamp lighting are retained and never mirrored, rotated or rearranged.

detailed_description:
The target video is a realistic live-action multi-camera sitcom scene inside <Subject 3>, clean digital cinema camera, 24 fps, natural skin texture, no beauty filter; night, warm tungsten light from the floor lamp on camera-left, window stays dark blue. No subtitles, no on-screen text, no additional people.
[Shot 1] A static medium-wide two-shot, 35mm lens, camera directly in front of the sofa at seated eye level, framing the room exactly as in <Picture 3>. <Subject 2> sits on the RIGHT side of the sofa reading a hardcover book. <Subject 1> walks in from the kitchen on the LEFT, checks the coffee table, looks at <Subject 2>. <Subject 1> (S1) asks in a calm young adult female voice, <d>[English] Have you seen my phone charger?</d> <Subject 2> keeps reading and does not answer. The camera holds a static shot.

overall_soundscape:
Quiet apartment room tone, faint refrigerator hum, distant city traffic; soft fabric rustle and page turns.

non_diegetic_music:
N/A
```

无参考图（t2v）时只写后三段，字段名改成 `integrated_multimodal_description:`；
首帧驱动（i2v）在最前面加一行
`For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`

## 2. 标签速查

| 标签 | 含义 |
|---|---|
| `<Picture N>` `<Video N>` `<Audio N>` | 按传入顺序 1 起编号，三类各自编号（官方是 Picture，不是 Image） |
| `<Subject N>` | 要在片里出现的东西（人/房间/道具/风格），可以来自多张图：脸来自 Picture 1、衣服来自 Picture 3 |
| 单独一行 `<Picture N> is …` | 只在图本身是首帧/尾帧/关键帧/构图锚点时写；只用来定义人或风格的图写进 Subject 里引用 |
| `[reference generation]` 等 | summary 前缀；还有 keyframe completion / video editing / video continuation / audio reuse / audio reference，多个用 ` + ` |
| `fully_preserved` `partially_preserved` `attribute_transfer` `weak_reference` | retention 标记（画面）；音频用 fully_copy / partially_copy / reference / weak_reference |
| `[Shot 1]` / `[Shot 2] At 00:03.500, the camera cuts to …` | 首镜无时间，后面时间严格递增 |
| `(S1)` `(S2)` | 说话人 ID，按**本段第一次出声的顺序**编，参考主体说话写 `<Subject 2> (S1)` |
| `<d>[English] …</d>` `<d>[Chinese] …</d>` | 台词，只放语言标签和原话；音色、情绪、语速写在 `<d>` 外面 |
| `The camera holds a static shot` / `pushes in with small amplitude at slow speed` | 运镜写成自然句；不写就会自己慢推 |
| `non_diegetic_music: N/A` | 不要配乐；比 `no music.` 可靠 |

## 3. 分段一致性的写法（每段都照做）

1. **每段都是完整世界**：六段全量重述，别写 "continues from the previous shot"，模型没看过上一段。
2. **一个主体多个来源**：脸来自照片，服装/站位/房间来自母图，"谁提供什么"拆开写，照片里的衣服就不会被带进片子。
3. **房间写方位不写形容词**：LEFT / CENTER / RIGHT background 各放什么，沙发左边灯、右边边桌，加 never mirrored, rotated or rearranged。
4. **左右关系每段重申**；单人镜头也写 "sits on the RIGHT side of the sofa, window behind and to screen-right"，另一人写 off-screen to the left，retention 标 weak_reference。
5. **小特征点名**（眼镜、刘海方向、耳环、无 logo）写进 subject，再在 retention 里 retained。
6. **道具靠文字**（杂志、交叉手臂、书下露出的充电线）写在镜头里即可，别要求道具跨段一致。
7. **动作段内自足**，不跨段继承（上一段拿起、下一段还拿着 = 一定不一致）。
8. **台词宁短勿长**：5 秒 1–2 句；沉默 + 眼神比长对白稳。
9. **相机明说不动**；**风格句放 [Shot 1] 前**（live-action / sitcom / 35mm / natural skin / no beauty filter）。
10. **seed 固定**，重拍换 take 不换随机。

## 4. 换脸（整段重画：源片当 <Video 1> + 多角度母图）

视频给场景、动作、机位、台词（`--video-audio` 连原声，`fully_copy`）；参考图给身份。每个人**照片 + 正面/侧面/四分之三三张 H3 自渲染母图**一起喂，每段同一套、同一 seed。

```text
subject_definitions:
<Subject 1> is a completely different person from the dark-haired man in the white shirt in <Video 1>. The face, hair and glasses come from <Picture 1>, <Picture 2>, <Picture 3>, <Picture 4>, several views of the same person: <脸的描述>. Everything else comes from the man in the white shirt in <Video 1>: his white long-sleeved shirt, the body, the positions in the frame, the gestures, the head and mouth movements, the timing and the expressions.
<Video 1> is the source video for the target video edit; every other person in it is kept exactly as they are. Its camera, framing, cuts, lighting, background and timing are kept.
<Audio 1> is the synchronized audio track of <Video 1> and is reused in the target video.

summary:
[video editing + audio reuse] The target video is an edited version of <Video 1>: the referenced people are replaced by <Subject 1>, with the face and hair from the reference pictures. Everyone else, all clothing, the scene, the camera, the cuts and the original dialogue from <Audio 1> stay exactly the same.

retention_analysis:
<Subject 1>: fully_preserved - the facial identity, face shape, eyes, nose, lips, skin tone, apparent age, side-parted black hair and glasses from <Picture 1>–<Picture 4> are retained in every frame; the original man's face and hair are not retained; <Subject 1> does not keep the black T-shirt or background of the photo.
<Video 1> (source video): partially_preserved - shots, cuts, camera, framing, background, lighting, timing, all clothing, bodies, positions, gestures, head and mouth movements are retained; only the referenced people's faces and hair are replaced.
<Audio 1>: fully_copy - reused 1:1 as the complete final audio track.

detailed_description:
The target video is the live-action footage of <Video 1>, same look, same lighting.
[Shot 1] … <Subject 1> (S1) says, <d>[English] 原台词</d>
[Shot 2] At 00:01.318, the shot cuts to …

overall_soundscape: The complete original soundtrack of <Audio 1> continues throughout.
non_diegetic_music: N/A
```

- **脸 + 头发（+ 眼镜）必须一起来自参考图**：只换脸保留原发型 → 模型整段复制源视频，脸不变；脸糊掉再喂 → 原脸被修复回来。
- 和原演员长得像的替换者（都是短黑发）只给一张照片换不动，要加 H3 自渲染母图（`masters.py`）；**母图裁成只有头**，
  否则它的姿态和背景会被抄进输出；每人照片 + 1–2 张就够，给多了压过视频。
- 纯侧脸镜头这条路线换不动（侧脸母图、镜头级绑定都无效），要么接受不换，要么那一镜单独走 inpaint。
- 侧面母图靠"strict left profile"静态摆姿势出不来（构图跟参考图走）；让人物在一条片里**从正对镜头缓慢转到全侧脸**再抽帧才稳（`masters.py` 默认已这样做）。
- 母图的背景会漏进换脸结果（三张同场景母图一起喂时整段变成母图构图、不跟源片）：母图用**纯灰背景**再裁头肩，retention 里把 "the plain grey backdrop of the reference pictures" 也排除。
- 补到 17k+5 帧用**定格最后一帧**，别借下一镜头的帧：源片尾巴切到另一个人而提示词没写，模型会提前约 1 秒放弃跟源片、漂回母图构图。
- 不换的人点名 "kept exactly as they are"；"does not keep the clothing or background of the photo" 必写。
- 段 ≤15 秒，24fps，先裁掉界面字幕（`h3g.py prep`）；段内切镜按源片时间写 `[Shot 2] At MM:SS.mmm`；帧数 17k+5 不够就借帧再裁回。
- 视频 inpaint（`native_inpaint` + mask）能保背景逐像素，但脸像贴纸、边缘发暗、脸贴边/脸小会输出灰块——实验性，别拿它出成片。

## 5. 实测无效、别再试

- 把 `<Picture 3>` 在 retention 里降成 `weak_reference` 想改构图 → 无效
- 写 "does NOT reproduce the wide framing" / "the kitchen is outside the frame" → 无效
- 靠 "same apartment as before" 保房间一致 → 每段都是新房子
- 一条提示词只给人脸照片不给母图 → 服装、房间、站位段段不同
- 换脸时只换脸、保留原来的发型（尤其是知名角色）→ 脸不变；把源视频的脸糊掉 → 原脸被修复回来
- 换脸只给一张正面照片就想换和原演员相似的人 → 只加副眼镜；要多角度母图
- 想靠一条静态提示词 "strict left profile / three-quarter view" 出侧面母图 → 出来还是正脸；要转头片抽帧
- 视频 inpaint 想靠 retention 措辞或降低 ControlNet 强度消掉灰块 → 无效
