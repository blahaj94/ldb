// 실제 native 호출을 전달하며 수명 counter만 관측한다. Media/OCR 결과를 대체하지 않는다.
export const installObservation = `(() => {
  const tracks = [];
  const counts = { requests: 0, streams: 0, stops: 0, workers: 0, terminated: 0, clearedVideos: 0, width: 0, height: 0, mediaFailure: null };
  const getDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getDisplayMedia = async (...args) => {
    counts.requests += 1;
    let stream;
    try { stream = await getDisplayMedia(...args); }
    catch (error) {
      const allowedNames = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'AbortError', 'OverconstrainedError', 'InvalidStateError'];
      counts.mediaFailure = allowedNames.includes(error.name) ? error.name : 'other';
      throw error;
    }
    const settings = stream.getVideoTracks()[0]?.getSettings();
    counts.width = settings?.width ?? 0;
    counts.height = settings?.height ?? 0;
    counts.streams += 1;
    for (const track of stream.getTracks()) {
      tracks.push(track);
      const stop = track.stop.bind(track);
      track.stop = () => { counts.stops += 1; stop(); };
    }
    return stream;
  };
  const NativeWorker = window.Worker;
  window.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); counts.workers += 1; }
    terminate() { counts.terminated += 1; return super.terminate(); }
  };
  const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    ...descriptor,
    set(value) {
      const isCleared = value == null && descriptor.get.call(this) != null;
      if (isCleared) counts.clearedVideos += 1;
      descriptor.set.call(this, value);
    }
  });
  window.captureObservation = () => ({ ...counts, ended: tracks.every(track => track.readyState === 'ended') });
  return true;
})()`
