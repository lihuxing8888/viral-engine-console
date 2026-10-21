# -*- coding: utf-8 -*-
"""
视频文字提取器：只做「媒体 -> 文字」这一件事，不做任何业务判断。

两种模式：
  ocr  抽好的帧目录 -> 每帧的文字框（位置 + 置信度）
  asr  抽好的音频   -> 逐段转写文本（带时间戳）

业务判断（哪一行是字幕、要不要合并、有没有字幕）全部放在 Node 侧，
这样判断逻辑能用假数据离线断言 —— Python 只负责它擅长的模型推理。

用法：
  python3 extract.py ocr --frames <dir> --out <json>
  python3 extract.py asr --audio <wav> --out <json> [--model base]
  python3 extract.py probe                # 只报告本机装了哪些引擎
"""
import sys, os, json, time, glob, argparse

sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

# 国内下载 whisper 模型必须走镜像，且 hf-mirror 不支持 Xet 协议
os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
os.environ.setdefault('HF_HUB_DISABLE_XET', '1')
os.environ.setdefault('OMP_NUM_THREADS', os.environ.get('OCR_THREADS', '2'))


def log(*a):
    print('[extract]', *a, file=sys.stderr, flush=True)


# ------------------------------------------------------------------ OCR

_ocr_engine = None


def get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
        log('OCR 引擎就绪')
    return _ocr_engine


def run_ocr(frames_dir, out_path, fps=1.0):
    from PIL import Image
    eng = get_ocr()
    files = sorted(glob.glob(os.path.join(frames_dir, '*.png')),
                   key=lambda p: _num(os.path.basename(p)))
    if not files:
        raise SystemExit('帧目录为空：' + frames_dir)

    items = []
    size = None
    t0 = time.time()
    for fp in files:
        # ffmpeg 的 fps 滤镜从第 0 秒开始取，所以 1.png 是 t=0，2.png 是 t=1/fps
        try:
            n = int(os.path.basename(fp)[:-4])
        except ValueError:
            n = 1
        t = round((n - 1) / fps, 2)
        if size is None:
            with Image.open(fp) as im:
                size = im.size  # (W, H)
        w, h = size
        res, _ = eng(fp)
        boxes = []
        for box, txt, sc in (res or []):
            txt = (txt or '').strip()
            if not txt:
                continue
            xs = [p[0] for p in box]
            ys = [p[1] for p in box]
            # 归一化坐标：Node 侧不用关心视频分辨率，换素材也不会错位
            boxes.append({
                'text': txt,
                'conf': round(float(sc), 4),
                'cy': round(((min(ys) + max(ys)) / 2) / h, 4),
                'h': round((max(ys) - min(ys)) / h, 4),
                'cx': round(((min(xs) + max(xs)) / 2) / w, 4),
                'w': round((max(xs) - min(xs)) / w, 4),
            })
        boxes.sort(key=lambda b: b['cy'])
        items.append({'t': t, 'boxes': boxes})

    payload = {
        'ok': True,
        'mode': 'ocr',
        'engine': 'rapidocr-onnxruntime',
        'frames': len(files),
        'width': size[0] if size else 0,
        'height': size[1] if size else 0,
        'seconds': round(time.time() - t0, 2),
        'items': items,
    }
    _write(out_path, payload)
    log(f'OCR 完成 {len(files)} 帧 / {payload["seconds"]}s')


# ------------------------------------------------------------------ ASR

_asr_model = None


def get_asr(model_name):
    global _asr_model
    if _asr_model is None:
        from faster_whisper import WhisperModel
        root = os.environ.get('WHISPER_CACHE') or os.path.join(
            os.path.expanduser('~'), '.cache', 'fw')
        _asr_model = WhisperModel(model_name, device='cpu', compute_type='int8',
                                  download_root=root)
        log('ASR 模型就绪：' + model_name)
    return _asr_model


def _read_wav(path, expect_sr=16000):
    """自己读 wav，不走 PyAV —— faster-whisper 内部用 av 解码，
    但新版 av 的 open() 是 C 实现，不认 metadata_errors 参数，直接崩。
    我们本来就是 ffmpeg 转好的 16k 单声道 PCM，用标准库读最稳。"""
    import wave
    import numpy as np
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sr != expect_sr or ch != 1 or sw != 2:
        raise SystemExit(f'音频格式不对：{sr}Hz {ch}ch {sw*8}bit，需要 16000Hz 单声道 16bit')
    return np.frombuffer(raw, dtype=np.int16).astype('float32') / 32768.0


def run_asr(audio_path, out_path, model_name):
    m = get_asr(model_name)
    audio = _read_wav(audio_path)
    t0 = time.time()
    segs, info = m.transcribe(
        audio, language='zh', vad_filter=True, beam_size=5,
        condition_on_previous_text=False,
    )
    segs_out = []
    for s in segs:
        txt = (s.text or '').strip()
        if not txt:
            continue
        # whisper 会把整段平均置信度放在 avg_logprob（负值，越接近 0 越可信）
        # no_speech_prob 高的段基本是「静音段被脑补成文字」，交给 Node 侧判掉
        segs_out.append({
            't0': round(s.start, 2),
            't1': round(s.end, 2),
            'text': txt,
            'logprob': round(getattr(s, 'avg_logprob', -1.0), 3),
            'noSpeech': round(getattr(s, 'no_speech_prob', 0.0), 3),
        })

    payload = {
        'ok': True,
        'mode': 'asr',
        'engine': 'faster-whisper/' + model_name,
        'duration': round(info.duration, 2),
        'seconds': round(time.time() - t0, 2),
        'segments': segs_out,
    }
    _write(out_path, payload)
    log(f'ASR 完成 {len(segs_out)} 段 / {payload["seconds"]}s')


# ------------------------------------------------------------------ 公共

def _num(name):
    try:
        return (0, float(name[:-4]))
    except ValueError:
        return (1, name)


def _write(path, payload):
    if path:
        tmp = path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, path)
    else:
        print(json.dumps(payload, ensure_ascii=False))


def probe():
    out = {'ocr': False, 'asr': False, 'ocr_error': None, 'asr_error': None}
    try:
        get_ocr()
        out['ocr'] = True
    except Exception as e:
        out['ocr_error'] = str(e)[:200]
    try:
        from faster_whisper import WhisperModel  # noqa: F401
        out['asr'] = True
    except Exception as e:
        out['asr_error'] = str(e)[:200]
    print(json.dumps(out, ensure_ascii=False))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['ocr', 'asr', 'probe'])
    ap.add_argument('--frames')
    ap.add_argument('--audio')
    ap.add_argument('--out')
    ap.add_argument('--model', default=os.environ.get('WHISPER_MODEL', 'base'))
    a = ap.parse_args()

    if a.mode == 'probe':
        return probe()
    if a.mode == 'ocr':
        if not a.frames:
            raise SystemExit('需要 --frames')
        return run_ocr(a.frames, a.out)
    if not a.audio:
        raise SystemExit('需要 --audio')
    return run_asr(a.audio, a.out, a.model)


if __name__ == '__main__':
    main()
