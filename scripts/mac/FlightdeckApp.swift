// Flightdeck.app: a normal Mac app that owns the local Flightdeck server.
//   Open      starts the server (as this app's child) and opens it in the browser
//   Dock icon opens the browser again
//   Quit      stops the server (asks first if Claude is working for it)
// Settings come from the bundle's Info.plist (written by install.sh): FDNode, FDAppDir, FDData,
// FDClaude, FDPort, FDForwardPort, FDHost, FDBareHost, FDLog.
import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
  private let info = Bundle.main.infoDictionary ?? [:]
  private func setting(_ key: String) -> String { info[key] as? String ?? "" }
  private var port: String { setting("FDPort") }
  private var host: String { setting("FDHost") }

  private var server: Process?          // the server this app started
  private var adoptedPid: Int32?        // or one that was already answering when the app opened
  private var quitting = false

  func applicationDidFinishLaunching(_ notification: Notification) {
    buildMenu()
    if serverUp() {
      adoptedPid = listenerPid()
      openBrowser()
    } else {
      startServer()
    }
  }

  // Clicking the Dock icon (or opening the app again) shows the page again.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    openBrowser()
    return false
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if !quitting, let pid = server?.processIdentifier ?? adoptedPid, claudeRunning(under: pid) {
      let alert = NSAlert()
      alert.messageText = "Claude is working in Flightdeck"
      alert.informativeText = "A chat turn or map refresh is running. Quitting stops the server and cuts it off."
      alert.addButton(withTitle: "Keep Running")
      alert.addButton(withTitle: "Quit Anyway")
      NSApp.activate(ignoringOtherApps: true)
      if alert.runModal() == .alertFirstButtonReturn { return .terminateCancel }
    }
    return .terminateNow
  }

  func applicationWillTerminate(_ notification: Notification) {
    quitting = true
    if let s = server, s.isRunning {
      s.terminate() // SIGTERM; the server marks any run in flight as stopped on its next start
      let deadline = Date().addingTimeInterval(5)
      while s.isRunning && Date() < deadline { usleep(100_000) }
      if s.isRunning { kill(s.processIdentifier, SIGKILL) }
    } else if let pid = adoptedPid {
      kill(pid, SIGTERM)
    }
  }

  // --- Server ------------------------------------------------------------------------------------

  private func startServer() {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: setting("FDNode"))
    p.arguments = ["--import", "tsx", "src/server/main.ts"]
    p.currentDirectoryURL = URL(fileURLWithPath: setting("FDAppDir"))
    var env = ProcessInfo.processInfo.environment
    // An API key would silently replace the subscription login in `claude -p`.
    env.removeValue(forKey: "ANTHROPIC_API_KEY")
    env.removeValue(forKey: "ANTHROPIC_AUTH_TOKEN")
    let home = NSHomeDirectory()
    let nodeDir = (setting("FDNode") as NSString).deletingLastPathComponent
    env["PATH"] = "\(home)/.local/bin:\(nodeDir):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    env["FLIGHTDECK_PORT"] = port
    env["FLIGHTDECK_FORWARD_PORT"] = setting("FDForwardPort") // the port-80 forwarding's target
    env["FLIGHTDECK_DATA"] = setting("FDData")
    env["CLAUDE_BIN"] = setting("FDClaude")
    p.environment = env
    let logPath = setting("FDLog")
    if !FileManager.default.fileExists(atPath: logPath) { FileManager.default.createFile(atPath: logPath, contents: nil) }
    if let log = FileHandle(forWritingAtPath: logPath) {
      log.seekToEndOfFile()
      p.standardOutput = log
      p.standardError = log
    }
    p.standardInput = FileHandle.nullDevice
    // If the server dies on its own, say so and quit: the app should never claim it's running.
    p.terminationHandler = { [weak self] proc in
      DispatchQueue.main.async {
        guard let self, !self.quitting else { return }
        let alert = NSAlert()
        alert.messageText = "Flightdeck's server stopped"
        alert.informativeText = "It exited with code \(proc.terminationStatus). The log is at \(logPath)."
        alert.runModal()
        self.quitting = true
        NSApp.terminate(nil)
      }
    }
    do {
      try p.run()
      server = p
    } catch {
      let alert = NSAlert()
      alert.messageText = "Couldn't start Flightdeck"
      alert.informativeText = error.localizedDescription
      alert.runModal()
      quitting = true
      NSApp.terminate(nil)
      return
    }
    // Open the page as soon as the server answers.
    DispatchQueue.global().async {
      for _ in 0..<75 {
        if self.serverUp() {
          DispatchQueue.main.async { self.openBrowser() }
          return
        }
        usleep(200_000)
      }
    }
  }

  // --- Helpers -----------------------------------------------------------------------------------

  private func openBrowser() {
    let bareHost = setting("FDBareHost")
    // The port-less address exists when scripts/mac/port80.sh has set it up (an /etc/hosts entry).
    let hosts = (try? String(contentsOfFile: "/etc/hosts", encoding: .utf8)) ?? ""
    let hasBare = !bareHost.isEmpty && hosts.contains(bareHost)
    DispatchQueue.global().async {
      var target = "http://\(self.host):\(self.port)"
      if hasBare {
        // Its listener comes up a moment after the main one: give it a couple of seconds.
        for _ in 0..<15 {
          if self.healthy("http://\(bareHost)/health") { target = "http://\(bareHost)"; break }
          usleep(200_000)
        }
      }
      DispatchQueue.main.async { if let url = URL(string: target) { NSWorkspace.shared.open(url) } }
    }
  }

  private func serverUp() -> Bool { healthy("http://127.0.0.1:\(port)/health") }

  private func healthy(_ urlString: String) -> Bool {
    guard let url = URL(string: urlString) else { return false }
    var request = URLRequest(url: url)
    request.timeoutInterval = 1
    let done = DispatchSemaphore(value: 0)
    var ok = false
    URLSession.shared.dataTask(with: request) { _, response, _ in
      ok = (response as? HTTPURLResponse)?.statusCode == 200
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 1.5)
    return ok
  }

  private func run(_ path: String, _ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return "" }
    p.waitUntilExit()
    return String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  }

  private func listenerPid() -> Int32? {
    Int32(run("/usr/sbin/lsof", ["-ti", "tcp:\(port)", "-sTCP:LISTEN"]).split(separator: "\n").first ?? "")
  }

  // Claude runs as the server's child while a chat turn or map refresh is in flight.
  private func claudeRunning(under pid: Int32) -> Bool {
    !run("/usr/bin/pgrep", ["-P", String(pid), "-f", "claude"]).isEmpty
  }

  private func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Open Flightdeck in Browser", action: #selector(openFromMenu), keyEquivalent: "o")
    appMenu.addItem(.separator())
    appMenu.addItem(withTitle: "Quit Flightdeck", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    NSApp.mainMenu = main
  }

  @objc private func openFromMenu() { openBrowser() }

  func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
    let menu = NSMenu()
    menu.addItem(withTitle: "Open in Browser", action: #selector(openFromMenu), keyEquivalent: "")
    return menu
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
