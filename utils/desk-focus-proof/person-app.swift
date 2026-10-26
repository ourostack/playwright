// A small labeled app that stands in for the app the person is working in
// during the Desk focus proof on a test machine. It comes to the front once,
// at launch, and keeps a text view as the keyboard focus.
import AppKit

final class Delegate: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  func applicationDidFinishLaunching(_ notification: Notification) {
    window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 640, height: 360), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    window.title = "Desk focus test: the person's app (keep me in front)"
    let text = NSTextView(frame: window.contentView!.bounds)
    text.string = "Desk focus test. The person is typing here; no browser may take the keyboard."
    text.autoresizingMask = [.width, .height]
    window.contentView!.addSubview(text)
    window.makeKeyAndOrderFront(nil)
    window.makeFirstResponder(text)
    NSApp.activate(ignoringOtherApps: true)
  }
}

let app = NSApplication.shared
let delegate = Delegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
