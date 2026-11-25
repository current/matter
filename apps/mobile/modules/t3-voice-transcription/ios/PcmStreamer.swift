import AVFoundation
import Foundation

/// Live 16 kHz mono Int16 PCM from the microphone for streaming speech recognition. Apple's voice
/// processing (hardware echo cancellation) is turned on when the route supports it, so the
/// assistant's own reply does not reach the recognizer while the user talks over it.
final class PcmStreamer: @unchecked Sendable {
  struct Started {
    let voiceProcessing: Bool
  }

  private static let sampleRate = 16_000.0
  /// 80 ms of 16-bit mono audio.
  private static let chunkBytes = Int(sampleRate) * 2 * 80 / 1000

  private let lock = NSLock()
  private let onChunk: (Data, Double) -> Void
  private var engine: AVAudioEngine?
  private var converter: AVAudioConverter?
  private var configurationObserver: NSObjectProtocol?
  private var pending = Data()
  private var sumSquares = 0.0
  private var sampleCount = 0
  private var voiceProcessing = false
  private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16, sampleRate: PcmStreamer.sampleRate, channels: 1,
    interleaved: true)!

  init(onChunk: @escaping (Data, Double) -> Void) {
    self.onChunk = onChunk
  }

  var isRunning: Bool {
    lock.lock()
    defer { lock.unlock() }
    return engine?.isRunning == true
  }

  func start() throws -> Started {
    lock.lock()
    defer { lock.unlock() }
    if let engine, engine.isRunning {
      return Started(voiceProcessing: voiceProcessing)
    }
    let engine = AVAudioEngine()
    let input = engine.inputNode
    do {
      try input.setVoiceProcessingEnabled(true)
      voiceProcessing = true
      // Keep the assistant's reply at full volume instead of ducking it like a phone call.
      input.voiceProcessingOtherAudioDuckingConfiguration =
        AVAudioVoiceProcessingOtherAudioDuckingConfiguration(
          enableAdvancedDucking: false, duckingLevel: .min)
    } catch {
      voiceProcessing = false
    }
    // Voice processing runs on the I/O unit, which needs the output side of the graph wired.
    _ = engine.mainMixerNode
    try installTap(on: engine)
    engine.prepare()
    try engine.start()
    self.engine = engine
    configurationObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in
      self?.restartAfterRouteChange()
    }
    return Started(voiceProcessing: voiceProcessing)
  }

  func stop() {
    lock.lock()
    defer { lock.unlock() }
    if let configurationObserver {
      NotificationCenter.default.removeObserver(configurationObserver)
    }
    configurationObserver = nil
    if let engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      if voiceProcessing { try? engine.inputNode.setVoiceProcessingEnabled(false) }
    }
    engine = nil
    converter = nil
    pending.removeAll(keepingCapacity: false)
    sumSquares = 0
    sampleCount = 0
  }

  /// A new headset or CarPlay route changes the input format and stops the engine.
  private func restartAfterRouteChange() {
    lock.lock()
    defer { lock.unlock() }
    guard let engine else { return }
    engine.inputNode.removeTap(onBus: 0)
    do {
      try installTap(on: engine)
      engine.prepare()
      try engine.start()
    } catch {
      engine.stop()
    }
  }

  private func installTap(on engine: AVAudioEngine) throws {
    let input = engine.inputNode
    let inputFormat = input.outputFormat(forBus: 0)
    guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
      let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
    else { throw CocoaError(.featureUnsupported) }
    // Voice processing can report several input channels; the first is the processed voice.
    converter.channelMap = [0]
    self.converter = converter
    input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { [weak self] buffer, _ in
      self?.handle(buffer)
    }
  }

  private func handle(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    guard let converter else {
      lock.unlock()
      return
    }
    let ratio = targetFormat.sampleRate / buffer.format.sampleRate
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 32
    guard let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: capacity) else {
      lock.unlock()
      return
    }
    var supplied = false
    var conversionError: NSError?
    converter.convert(to: output, error: &conversionError) { _, status in
      if supplied {
        status.pointee = .noDataNow
        return nil
      }
      supplied = true
      status.pointee = .haveData
      return buffer
    }
    guard conversionError == nil, output.frameLength > 0, let samples = output.int16ChannelData?[0]
    else {
      lock.unlock()
      return
    }
    let frames = Int(output.frameLength)
    for index in 0..<frames {
      let sample = Double(samples[index]) / 32_768.0
      sumSquares += sample * sample
    }
    sampleCount += frames
    pending.append(UnsafeBufferPointer(start: samples, count: frames))
    var ready: [(Data, Double)] = []
    while pending.count >= Self.chunkBytes {
      let chunk = pending.prefix(Self.chunkBytes)
      pending.removeFirst(Self.chunkBytes)
      let rms = sampleCount > 0 ? (sumSquares / Double(sampleCount)).squareRoot() : 0
      ready.append((Data(chunk), min(1, rms)))
      sumSquares = 0
      sampleCount = 0
    }
    lock.unlock()
    for (chunk, level) in ready {
      onChunk(chunk, level)
    }
  }
}
