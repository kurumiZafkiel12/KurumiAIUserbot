// 内置 TTS（免 Key）：微软 Edge 朗读接口（msedge-tts），无需任何 API Key。
// 只在号主没配自定义 TTS 接口时兜底使用；网络不可达时抛错，调用方记日志跳过，不影响文字回答。

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export const EDGE_DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

const SYNTH_TIMEOUT_MS = 20_000;

/**
 * 合成一段语音，返回 MP3 Buffer。
 * @param {string} text 要朗读的文本（内部截断到 800 字，防超长合成卡死）
 * @param {string} [voice] Edge 音色名，如 zh-CN-XiaoxiaoNeural
 */
export async function synthesizeEdgeTts(text, voice) {
  const tts = new MsEdgeTTS();
  const work = (async () => {
    await tts.setMetadata(voice || EDGE_DEFAULT_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(String(text || "").slice(0, 800));
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on("data", (c) => chunks.push(c));
      audioStream.on("end", resolve);
      audioStream.on("error", reject);
    });
    return Buffer.concat(chunks);
  })();
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Edge TTS 合成超时")), SYNTH_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    try {
      tts.close();
    } catch {
      // 关闭失败无所谓。
    }
  }
}
