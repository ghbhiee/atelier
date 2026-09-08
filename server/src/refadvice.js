// Pre-flight for reference jobs: catch the ways a reference silently fails to steer the result.
//
// The reference keys arriving in ComfyUI (jobs.refCheck) only proves the file was attached. Everything
// below is about whether the prompt can actually use it — the failures we have seen in practice:
//   * an image is attached but never mentioned, so the model has no reason to look at it
//   * <Picture N> is referenced but no such image was attached
//   * one picture is asked to define both a person and a location, which it cannot
//   * the prompt describes the person in words, which competes with the photo for the identity
//   * the photo is a raw phone shot, so the face is a small part of it and identity comes out weak
const PIC = /<Picture (\d+)>/g;
const VID = /<Video (\d+)>/g;

const nums = (text, re) => { const out = new Set(); let m; const r = new RegExp(re.source, "g"); while ((m = r.exec(text))) out.add(Number(m[1])); return [...out]; };

/** @returns {{level:"error"|"warn"|"info", text:string, fix?:string}[]} */
export function refAdvice({ prompt = "", images = [], videos = [], assets = [], width = 0, height = 0 } = {}) {
  const out = [];
  const usedPics = nums(prompt, PIC), usedVids = nums(prompt, VID);

  for (const n of usedPics) if (n > images.length) out.push({ level: "error", text: `提示词里写了 <Picture ${n}>，但只挂了 ${images.length} 张参考图`, fix: "补一张图，或把提示词里的编号改掉" });
  for (const n of usedVids) if (n > videos.length) out.push({ level: "error", text: `提示词里写了 <Video ${n}>，但只挂了 ${videos.length} 段参考视频`, fix: "补一段视频，或改编号" });
  for (let i = 1; i <= images.length; i++) if (!usedPics.includes(i)) out.push({ level: "warn", text: `第 ${i} 张参考图在提示词里没被提到（<Picture ${i}>）`, fix: "在人物或场景定义里写上 <Picture " + i + ">，否则模型没有理由去看它" });
  for (let i = 1; i <= videos.length; i++) if (!usedVids.includes(i)) out.push({ level: "warn", text: `第 ${i} 段参考视频没被提到（<Video ${i}>）`, fix: "在提示词里引用 <Video " + i + ">" });

  // one picture asked to be two different things
  const defs = [...prompt.matchAll(/<Subject (\d+)>\s*is\s*([^\n]{0,160})/g)].map((m) => ({ n: m[1], body: m[2] }));
  for (const n of usedPics) {
    const owners = defs.filter((d) => d.body.includes(`<Picture ${n}>`));
    const person = owners.filter((d) => /人物|anchor|woman|man|person|girl|boy|face|她|他/i.test(d.body));
    const place = owners.filter((d) => /studio|room|scene|background|场景|房间|背景|studio/i.test(d.body));
    if (person.length && place.length) {
      out.push({ level: "warn", text: `<Picture ${n}> 同时被用来定义人物和场景`, fix: "一张图只承担一件事：人物用人物图，场景另给一张母图，否则模型会在两者之间折中" });
    }
  }

  // words competing with the photo for the identity
  for (const n of usedPics) {
    const d = defs.find((x) => x.body.includes(`<Picture ${n}>`));
    if (d && /(young|adult|woman|man|girl|年轻|中年|女性|男性)[^\n]{0,60}(appearance|features|face|长相|面容|五官)/i.test(d.body)) {
      out.push({ level: "info", text: `人物描述里又用文字写了长相（“${d.body.slice(0, 40)}…”）`, fix: "身份交给图，文字只写动作、服装、镜头；文字描述会和照片抢主导权" });
    }
  }

  // geometry: a raw phone photo puts the face in a small part of the frame
  for (const [i, a] of assets.entries()) {
    if (!a || a.kind !== "image") continue;
    const long = Math.max(a.width || 0, a.height || 0), short = Math.min(a.width || 0, a.height || 0);
    if (!long) continue;
    const ar = long / Math.max(1, short);
    if (long > 2200 && ar > 1.2) out.push({ level: "warn", text: `第 ${i + 1} 张参考图是 ${a.width}×${a.height} 的整张照片`, fix: "人脸参考请先用素材里的「裁剪」裁成头肩（短边 1024）；脸在画面里越小，身份越抓不住" });
    if (width && height && a.width && a.height) {
      const want = width / height, got = a.width / a.height;
      if (want > 1 && got < 1 && long > 1500) out.push({ level: "info", text: `参考图是竖构图、要出的是横画面`, fix: "构图跟母图走：横片就用横构图的母图，否则人物容易被裁掉或变形" });
    }
  }
  return out;
}
