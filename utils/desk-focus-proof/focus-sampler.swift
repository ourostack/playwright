// Samples which app is in front, the active macOS Space and which app owns the
// top on-screen window, and prints one JSON object per line to stdout.
//
// Usage: focus-sampler <interval-ms> [watch-pid,watch-pid,...]   (stdin "watch <pids>" updates the list)
//        focus-sampler --preflight   (prints whether screen capture is already allowed; never prompts)
//
// It also prints an event line the moment macOS reports an app activation or a
// Space change, so short focus grabs between samples are not missed.
// Stops when stdin closes.

import AppKit
import CoreGraphics
import Foundation

@_silgen_name("CGSMainConnectionID") func CGSMainConnectionID() -> Int32
@_silgen_name("CGSGetActiveSpace") func CGSGetActiveSpace(_ cid: Int32) -> Int

setvbuf(stdout, nil, _IOLBF, 0)

let args = CommandLine.arguments
if args.count > 1 && args[1] == "--preflight" {
  print(CGPreflightScreenCaptureAccess() ? "screen-capture: allowed" : "screen-capture: not-allowed")
  exit(0)
}

let intervalMs = args.count > 1 ? (Double(args[1]) ?? 50) : 50
var watchPids: Set<Int32> = args.count > 2 ? Set(args[2].split(separator: ",").compactMap { Int32($0) }) : []

func now() -> Double { Date().timeIntervalSince1970 * 1000 }

func emit(_ obj: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), let s = String(data: data, encoding: .utf8) {
    print(s)
  }
}

func appInfo(_ app: NSRunningApplication?) -> [String: Any] {
  guard let app = app else { return [:] }
  return ["pid": Int(app.processIdentifier), "bundle": app.bundleIdentifier ?? "", "name": app.localizedName ?? ""]
}

func windowInfo() -> [String: Any] {
  guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [:] }
  var result: [String: Any] = [:]
  var normalIndex = 0
  for w in list {
    guard (w[kCGWindowLayer as String] as? Int) == 0 else { continue }
    let pid = (w[kCGWindowOwnerPID as String] as? Int) ?? -1
    if normalIndex == 0 {
      result["topWindowPid"] = pid
      result["topWindowOwner"] = (w[kCGWindowOwnerName as String] as? String) ?? ""
    }
    if !watchPids.isEmpty && watchPids.contains(Int32(pid)) && result["watchedWindowIndex"] == nil {
      result["watchedWindowIndex"] = normalIndex
    }
    normalIndex += 1
  }
  return result
}

func space() -> Int { CGSGetActiveSpace(CGSMainConnectionID()) }

let center = NSWorkspace.shared.notificationCenter
center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
  let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
  var obj: [String: Any] = ["t": now(), "kind": "activate", "app": appInfo(app)]
  if let app = app { obj["watched"] = watchPids.contains(app.processIdentifier) }
  emit(obj)
}
center.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { _ in
  emit(["t": now(), "kind": "space", "space": space()])
}

// stdin: "watch <pid>,<pid>" lines set the watched process ids; EOF stops the sampler.
FileHandle.standardInput.readabilityHandler = { handle in
  let data = handle.availableData
  if data.isEmpty { exit(0) }
  let text = String(data: data, encoding: .utf8) ?? ""
  for line in text.split(separator: "\n") where line.hasPrefix("watch ") {
    let pids = Set(line.dropFirst(6).split(separator: ",").compactMap { Int32($0.trimmingCharacters(in: .whitespaces)) })
    DispatchQueue.main.async {
      watchPids = pids
      emit(["t": now(), "kind": "watch", "watchPids": Array(pids).map { Int($0) }])
    }
  }
}

emit(["t": now(), "kind": "start", "intervalMs": intervalMs, "watchPids": Array(watchPids).map { Int($0) }, "screenCaptureAllowed": CGPreflightScreenCaptureAccess()])
while true {
  RunLoop.main.run(until: Date(timeIntervalSinceNow: intervalMs / 1000))
  let front = NSWorkspace.shared.frontmostApplication
  var obj: [String: Any] = ["t": now(), "kind": "sample", "front": appInfo(front), "space": space()]
  for (k, v) in windowInfo() { obj[k] = v }
  if let front = front { obj["frontWatched"] = watchPids.contains(front.processIdentifier) }
  emit(obj)
}
