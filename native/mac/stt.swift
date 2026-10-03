// stt.swift — on-device transcription of an audio file.
// usage:
//   stt locales                         # list SpeechTranscriber/DictationTranscriber/SFSpeechRecognizer locales
//   stt analyzer   <file.wav> [locale]  # macOS 26 SpeechAnalyzer + SpeechTranscriber
//   stt dictation  <file.wav> [locale]  # macOS 26 SpeechAnalyzer + DictationTranscriber
//   stt sf         <file.wav> [locale]  # legacy SFSpeechRecognizer, requiresOnDeviceRecognition = true
//   stt install    <locale>             # AssetInventory download (Apple-hosted model)
// build: swiftc -O stt.swift -o stt
import Foundation
import Speech
import AVFoundation

func now() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1e6 }
func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
let a = CommandLine.arguments
let mode = a.count > 1 ? a[1] : "locales"
let t0 = now()

func ensureAssets(_ modules: [any SpeechModule]) async throws {
  let st = await AssetInventory.status(forModules: modules)
  log("asset status: \(st)")
  if st < .installed, let req = try await AssetInventory.assetInstallationRequest(supporting: modules) {
    log("downloading model assets…")
    let td = now()
    try await req.downloadAndInstall()
    log(String(format: "download+install took %.0f ms", now() - td))
  }
}

func runAnalyzer(file: String, localeId: String, dictation: Bool) async throws {
  let locale = Locale(identifier: localeId)
  let module: any SpeechModule
  if dictation {
    module = DictationTranscriber(locale: locale, preset: .shortDictation)
  } else {
    module = SpeechTranscriber(locale: locale, preset: .transcription)
  }
  log("SpeechTranscriber.isAvailable=\(SpeechTranscriber.isAvailable)")
  try await ensureAssets([module])
  let tLoad = now()
  let audio = try AVAudioFile(forReading: URL(fileURLWithPath: file))
  let collector = Task { () -> String in
    var text = ""
    if let m = module as? SpeechTranscriber { for try await r in m.results { text += String(r.text.characters) } }
    if let m = module as? DictationTranscriber { for try await r in m.results { text += String(r.text.characters) } }
    return text
  }
  let analyzer = try await SpeechAnalyzer(inputAudioFile: audio, modules: [module], finishAfterFile: true)
  _ = analyzer
  let text = try await collector.value
  let dt = now() - tLoad
  print(String(format: "{\"engine\":\"%@\",\"locale\":\"%@\",\"ms\":%.0f,\"total_ms\":%.0f,\"text\":%@}",
               dictation ? "DictationTranscriber" : "SpeechTranscriber", localeId, dt, now() - t0,
               String(data: try JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed), encoding: .utf8)!))
}

func runSF(file: String, localeId: String) async throws {
  let st = SFSpeechRecognizer.authorizationStatus()
  log("SFSpeechRecognizer.authorizationStatus=\(st.rawValue) (0=notDetermined 1=denied 2=restricted 3=authorized)")
  if st == .notDetermined {
    let got = await withCheckedContinuation { c in SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) } }
    log("requestAuthorization -> \(got.rawValue)")
  }
  guard let rec = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else { log("no recognizer for \(localeId)"); exit(3) }
  log("isAvailable=\(rec.isAvailable) supportsOnDeviceRecognition=\(rec.supportsOnDeviceRecognition)")
  let req = SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: file))
  req.requiresOnDeviceRecognition = true
  req.shouldReportPartialResults = false
  let t1 = now()
  let text: String = try await withCheckedThrowingContinuation { c in
    var done = false
    rec.recognitionTask(with: req) { res, err in
      if done { return }
      if let err { done = true; c.resume(throwing: err); return }
      if let res, res.isFinal { done = true; c.resume(returning: res.bestTranscription.formattedString) }
    }
  }
  print(String(format: "{\"engine\":\"SFSpeechRecognizer(onDevice)\",\"locale\":\"%@\",\"ms\":%.0f,\"text\":\"%@\"}", localeId, now() - t1, text))
}

let task = Task {
  do {
    switch mode {
    case "locales":
      let st = await SpeechTranscriber.supportedLocales.map(\.identifier).sorted()
      let inst = await SpeechTranscriber.installedLocales.map(\.identifier).sorted()
      let dt = await DictationTranscriber.supportedLocales.map(\.identifier).sorted()
      let sf = SFSpeechRecognizer.supportedLocales().map(\.identifier).sorted()
      print("SpeechTranscriber.isAvailable:", SpeechTranscriber.isAvailable)
      print("SpeechTranscriber supported (\(st.count)):", st.joined(separator: " "))
      print("SpeechTranscriber installed:", inst.joined(separator: " "))
      print("DictationTranscriber supported (\(dt.count)):", dt.joined(separator: " "))
      print("SFSpeechRecognizer supported (\(sf.count)):", sf.joined(separator: " "))
      for id in ["zh-HK", "yue-CN", "zh-TW", "en-HK", "en-US"] {
        let e1 = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: id))?.identifier ?? "nil"
        let e2 = await DictationTranscriber.supportedLocale(equivalentTo: Locale(identifier: id))?.identifier ?? "nil"
        let sfr = SFSpeechRecognizer(locale: Locale(identifier: id))
        print("  \(id): SpeechTranscriber≈\(e1)  DictationTranscriber≈\(e2)  SF onDevice=\(sfr?.supportsOnDeviceRecognition.description ?? "nil")")
      }
      print("AssetInventory.maximumReservedLocales:", AssetInventory.maximumReservedLocales,
            "reserved:", await AssetInventory.reservedLocales.map(\.identifier))
    case "analyzer": try await runAnalyzer(file: a[2], localeId: a.count > 3 ? a[3] : "en-US", dictation: false)
    case "dictation": try await runAnalyzer(file: a[2], localeId: a.count > 3 ? a[3] : "en-US", dictation: true)
    case "sf": try await runSF(file: a[2], localeId: a.count > 3 ? a[3] : "en-US")
    case "install":
      try await ensureAssets([SpeechTranscriber(locale: Locale(identifier: a[2]), preset: .transcription)])
    default: log("unknown mode")
    }
  } catch { log("ERROR: \(error)"); exit(1) }
  exit(0)
}
RunLoop.main.run()
