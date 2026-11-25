import {
  BlobSource, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, Mp4OutputFormat, Output, StreamTarget, type StreamTargetChunk
} from 'mediabunny';

/** Repackage the two Bilibili DASH tracks without decoding or changing their quality. */
export async function muxDashTracks(video: Blob, audio: Blob, writable: FileSystemWritableFileStream, onProgress?: (fraction: number) => void): Promise<void> {
  const videoInput = new Input({ source: new BlobSource(video), formats: [MP4] });
  const audioInput = new Input({ source: new BlobSource(audio), formats: [MP4] });
  let output: Output | null = null;
  try {
    const [videoTrack, audioTrack] = await Promise.all([videoInput.getPrimaryVideoTrack(), audioInput.getPrimaryAudioTrack()]);
    if (!videoTrack || !audioTrack || !videoTrack.codec || !audioTrack.codec) {
      throw new Error('缓存的音轨或视频轨缺少可封装的媒体数据。');
    }
    const [videoConfig, audioConfig, videoDuration, audioDuration] = await Promise.all([
      videoTrack.getDecoderConfig(), audioTrack.getDecoderConfig(),
      videoTrack.getDurationFromMetadata(), audioTrack.getDurationFromMetadata()
    ]);
    if (!videoConfig || !audioConfig) throw new Error('无法读取音视频编码参数。');
    const videoSource = new EncodedVideoPacketSource(videoTrack.codec);
    const audioSource = new EncodedAudioPacketSource(audioTrack.codec);
    const stream = new WritableStream<StreamTargetChunk>({
      write: async (chunk) => { await writable.write({ type: 'write', position: chunk.position, data: chunk.data }); },
      // The cache writer closes the temporary OPFS file after the mux finishes.
      close: () => {}
    });
    output = new Output({ format: new Mp4OutputFormat(), target: new StreamTarget(stream) });
    output.addVideoTrack(videoSource);
    output.addAudioTrack(audioSource);
    await output.start();

    const videoSink = new EncodedPacketSink(videoTrack);
    const audioSink = new EncodedPacketSink(audioTrack);
    let [videoPacket, audioPacket] = await Promise.all([videoSink.getFirstPacket(), audioSink.getFirstPacket()]);
    if (!videoPacket || !audioPacket) throw new Error('音轨或视频轨没有媒体数据。');
    const duration = Math.max(1, videoDuration || 0, audioDuration || 0);
    let videoFirst = true;
    let audioFirst = true;
    let count = 0;
    while (videoPacket || audioPacket) {
      if (videoPacket && (!audioPacket || videoPacket.timestamp <= audioPacket.timestamp)) {
        const current = videoPacket;
        await videoSource.add(current, videoFirst ? { decoderConfig: videoConfig } : undefined);
        videoFirst = false;
        videoPacket = await videoSink.getNextPacket(current);
      } else if (audioPacket) {
        const current = audioPacket;
        await audioSource.add(current, audioFirst ? { decoderConfig: audioConfig } : undefined);
        audioFirst = false;
        audioPacket = await audioSink.getNextPacket(current);
      }
      if (++count % 250 === 0) onProgress?.(Math.min(0.99, Math.max(videoPacket?.timestamp || 0, audioPacket?.timestamp || 0) / duration));
    }
    await output.finalize();
    onProgress?.(1);
  } catch (error) {
    if (output && output.state !== 'finalized' && output.state !== 'canceled') await output.cancel().catch(() => {});
    throw error;
  } finally {
    videoInput.dispose();
    audioInput.dispose();
  }
}
