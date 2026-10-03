// ptt-helper.swift — hold Right-Option to talk. Prints JSON lines on stdout:
//   {"event":"status",...}  {"event":"down","t":...}  {"event":"up","t":...,"wav":"/path.wav","ms":...}
// Listen-only CGEventTap on flagsChanged (no events are modified or posted).
// usage: ptt-helper [--out-dir DIR] [--check]
// build: swiftc -O ptt-helper.swift -o ptt-helper
import Foundation
import CoreGraphics
import ApplicationServices
import AVFoundation

setvbuf(stdout, nil, _IOLBF, 0)
func emit(_ d: [String: Any]) {
  let j = try! JSONSerialization.data(withJSONObject: d, options: [.sortedKeys, .withoutEscapingSlashes])
  print(String(data: j, encoding: .utf8)!)
}
let args = CommandLine.arguments
let outDir = args.firstIndex(of: "--out-dir").map { args[$0 + 1] } ?? NSTemporaryDirectory()
let kRightOption: Int64 = 61   // kVK_RightOption

// Preflight only — never calls CGRequestListenEventAccess / AXIsProcessTrustedWithOptions(prompt) here.
let mic: String = {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "authorized"; case .denied: return "denied"
  case .restricted: return "restricted"; case .notDetermined: return "notDetermined"
  @unknown default: return "unknown" }
}()
emit(["event": "status",
      "inputMonitoring_preflight": CGPreflightListenEventAccess(),   // Input Monitoring (kTCCServiceListenEvent)
      "postEvent_preflight": CGPreflightPostEventAccess(),          // Accessibility-ish (kTCCServicePostEvent)
      "accessibility_AXIsProcessTrusted": AXIsProcessTrusted(),
      "microphone": mic])
if args.contains("--check") { exit(0) }

var recorder: AVAudioRecorder?
var downAt = 0.0
var isDown = false
func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

func startRecording() {
  let url = URL(fileURLWithPath: outDir).appendingPathComponent("ptt-\(Int(nowMs())).wav")
  let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000,
                                 AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16,
                                 AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
  recorder = try? AVAudioRecorder(url: url, settings: settings)
  let ok = recorder?.record(forDuration: 30) ?? false   // hard cap
  if !ok { emit(["event": "error", "msg": "recorder failed to start (Microphone permission?)"]) }
}

let callback: CGEventTapCallBack = { _, type, event, _ in
  if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
    emit(["event": "tap_disabled", "type": Int(type.rawValue)]); return Unmanaged.passUnretained(event)
  }
  guard type == .flagsChanged, event.getIntegerValueField(.keyboardEventKeycode) == kRightOption else {
    return Unmanaged.passUnretained(event)
  }
  let pressed = event.flags.contains(.maskAlternate)
  if pressed && !isDown {
    isDown = true; downAt = nowMs(); startRecording()
    emit(["event": "down", "t": downAt])
  } else if !pressed && isDown {
    isDown = false
    recorder?.stop()
    emit(["event": "up", "t": nowMs(), "ms": nowMs() - downAt, "wav": recorder?.url.path ?? ""])
    recorder = nil
  }
  return Unmanaged.passUnretained(event)   // listen-only: never modify
}

let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                  options: .listenOnly, eventsOfInterest: mask,
                                  callback: callback, userInfo: nil) else {
  emit(["event": "fatal", "msg": "CGEvent.tapCreate returned nil — grant Input Monitoring to the launching app (Terminal/iTerm/etc.) and restart it"])
  exit(1)
}
let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
emit(["event": "ready", "key": "RightOption"])
CFRunLoopRun()
