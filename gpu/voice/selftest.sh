#!/bin/bash
# Exercise every TTS engine through the router on the GPU box and print timings / VRAM. Run detached:
#   supervisorctl start voicetest   (conf points here; log /root/voice-selftest.log)
R=http://127.0.0.1:8600
say() { echo "[$(date +%H:%M:%S)] $*"; }
dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null; }
vram() { nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits; }
tts() { # name out json
  local t0=$(date +%s); local code; code=$(curl -s -o "$2" -w "%{http_code}" --max-time 900 -H "content-type: application/json" -X POST $R/tts -d "$3"); say "$1: http $code $(( $(date +%s) - t0 ))s audio=$(dur "$2")s vram=$(vram)MiB"; [ "$code" = 200 ] || head -c 300 "$2"; echo; }
say "router health: $(curl -s $R/health | head -c 200)"
VID=$(curl -s $R/voices | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['saved'][0]['id'] if d['saved'] else '')")
say "saved voice for clone tests: ${VID:-none}"
say "== Kokoro"
tts "kokoro zf_001 speed1.2" /root/t_kokoro1.wav '{"text":"你好，这是 Kokoro 的中文内置音色，语速一点二倍，还有 English words 混排。","model":"kokoro","voice":"zf_001","speed":1.2}'
tts "kokoro zm_010 warm" /root/t_kokoro2.wav '{"text":"第二句，看看热启动有多快。","model":"kokoro","voice":"zm_010"}'
tts "kokoro af_heart en" /root/t_kokoro3.wav '{"text":"The quick brown fox jumps over the lazy dog.","model":"kokoro","voice":"af_heart"}'
say "kokoro voices: $(curl -s $R/engines | python3 -c "import json,sys; e=[x for x in json.load(sys.stdin) if x['id']=='kokoro'][0]; print(len(e['voices']), [v['id'] for v in e['voices']][:5])")"
say "== Qwen3-TTS"
tts "qwen builtin Vivian" /root/t_qwen1.wav '{"text":"大家好，我是 Qwen 的内置音色 Vivian。","model":"qwen3-tts","voice":"Vivian","language":"Chinese"}'
tts "qwen builtin Eric 四川腔+指令" /root/t_qwen2.wav '{"text":"今天的火锅安排上了没有？","model":"qwen3-tts","voice":"Eric","language":"Chinese","instruct":"用非常兴奋的语气说"}'
[ -n "$VID" ] && tts "qwen clone saved voice (Base)" /root/t_qwen3.wav "{\"text\":\"这是 Qwen3-TTS 的克隆版本，用保存的音色说话。\",\"model\":\"qwen3-tts\",\"voice\":\"$VID\",\"language\":\"Chinese\"}"
tts "qwen voice design" /root/t_qwen4.wav '{"text":"用文字描述造出来的声音，听起来像不像？","model":"qwen3-tts","language":"Chinese","design":"二十多岁的女声，清亮、语速偏快、带一点笑意"}'
say "== IndexTTS-2 back (LRU should reload it)"
tts "indextts emotion 悲伤" /root/t_idx1.wav '{"text":"他走的那天，天一直在下雨。","model":"indextts-2","voice":"sample:voice_05","emotion":"悲伤，低落","emo_alpha":0.9}'
say "== ASR roundtrips"
for f in t_kokoro1 t_qwen1 t_idx1; do [ -s /root/$f.wav ] && say "$f → $(curl -s -F "file=@/root/$f.wav" $R/asr | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('text','?')[:60], d.get('language'))" 2>/dev/null)"; done
say "health: $(curl -s $R/health | head -c 300)"
say "SELFTEST_DONE"
