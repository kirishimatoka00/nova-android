import json, os, subprocess, sys, wave, asyncio, glob
from vosk import Model, KaldiRecognizer
M = 'vosk-model-small-cn-0.22'
print('FILES', sorted(os.listdir(M)), sorted(os.listdir(M + '/graph')))
wt = M + '/graph/words.txt'
print('words.txt exists', os.path.isfile(wt))
model = Model(M)
WORDS = ['嘿','黑','嗨','喂','小','希','西','溪','晓','曉','小希','小西','小溪','希望','嘿嘿','你好','息','吸','喜','洗','细','系','戏','夕','稀','惜','熙','兮','晰','锡','嘻','小溪','小新','小心','小细','小喜','消息','小戏','休息','小姐','笑','校','诺','娃','诺瓦','挪','哇','瓦','NOVA','nova']
if os.path.isfile(wt):
    v = set(l.split(' ')[0] for l in open(wt, encoding='utf-8'))
    print('VOCAB size', len(v)); print('IN', [w for w in WORDS if w in v]); print('OUT', [w for w in WORDS if w not in v])
    print('startswith 小', [w for w in v if w.startswith('小')][:200])
    print('contains 希', [w for w in v if '希' in w][:80])
    print('contains 嘿', [w for w in v if '嘿' in w or '嗨' in w][:40])
voices = ['zh-TW-HsiaoChenNeural','zh-TW-YunJheNeural','zh-TW-HsiaoYuNeural','zh-CN-XiaoxiaoNeural','zh-CN-YunxiNeural']
texts = {'w1':'嘿，小希','w2':'嘿小希','w3':'小希','w4':'嘿！小希！','n1':'今天天氣怎麼樣','n2':'我想要去吃晚餐，你覺得呢','n3':'小心一點，不要跌倒','n4':'這個消息是真的嗎','n5':'我們休息一下吧','n6':'嘿，你好嗎','n7':'他是一個很細心的人','n8':'西瓜很好吃','n9':'小朋友希望明天放假','n10':'請幫我打開電視'}
import edge_tts
async def synth():
    for vn in voices:
        for k, t in texts.items():
            mp3 = f'a_{vn}_{k}.mp3'
            for attempt in range(3):
                try:
                    await edge_tts.Communicate(t, vn).save(mp3); break
                except Exception as e:
                    print('tts fail', vn, k, e); await asyncio.sleep(2)
            if os.path.isfile(mp3):
                subprocess.run(['ffmpeg','-loglevel','error','-y','-i',mp3,'-af','adelay=600|600,apad=pad_dur=1.2','-ar','16000','-ac','1',mp3[:-4]+'.wav'])
asyncio.run(synth())
# espeak 備援
for k, t in texts.items():
    subprocess.run(['espeak-ng','-v','cmn','-s','150','-w',f'e_{k}.wav',t]);
    if os.path.isfile(f'e_{k}.wav'): subprocess.run(['ffmpeg','-loglevel','error','-y','-i',f'e_{k}.wav','-af','adelay=600|600,apad=pad_dur=1.2','-ar','16000','-ac','1',f'a_espeak_{k}.wav'])
def run(path, grammar=None):
    wf = wave.open(path, 'rb')
    r = KaldiRecognizer(model, 16000, grammar) if grammar else KaldiRecognizer(model, 16000)
    r.SetWords(True); out = []
    while True:
        d = wf.readframes(1600)
        if not d: break
        if r.AcceptWaveform(d): out.append(json.loads(r.Result()))
    out.append(json.loads(r.FinalResult()))
    return [(o.get('text',''), [(w['word'], round(w['conf'],2)) for w in o.get('result',[])]) for o in out if o.get('text')]
G = {
 'A_now': ["嘿 小 希","嘿 小 西","黑 小 希","嘿 小 溪","嘿 曉 希","小 希","小 西","小 溪","曉 希","嘿 小希","嘿 小西","小希","小西","[unk]"],
 'B_simpl': ["嘿 小 希","嘿 小 西","黑 小 希","嘿 小 溪","嗨 小 希","嗨 小 西","小 希","小 西","小 溪","[unk]"],
}
for name, g in G.items():
    print('== grammar', name, file=sys.stderr); sys.stderr.flush()
for f in sorted(glob.glob('a_*.wav')):
    print('###', f)
    print('   free:', run(f))
    for name, g in G.items():
        print('  ', name, run(f, json.dumps(g, ensure_ascii=False)))
