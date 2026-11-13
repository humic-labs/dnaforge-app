
import AppKit
import CoreGraphics
import Darwin
import Foundation

guard CommandLine.arguments.count == 3 else {
  fputs("usage: prove-background-window.swift APP_DIR ELECTRON_BINARY\n", stderr)
  exit(2)
}

let appDirectory = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
let electronBinary = URL(fileURLWithPath: CommandLine.arguments[2]).standardizedFileURL.path
let workspace = NSWorkspace.shared

func ownedApplications() -> [NSRunningApplication] {
  workspace.runningApplications.filter {
    $0.executableURL?.standardizedFileURL.path == electronBinary
  }
}

func visibleWindows() -> [[String: Any]] {
  let windows = CGWindowListCopyWindowInfo(
    [.optionOnScreenOnly, .excludeDesktopElements],
    kCGNullWindowID
  ) as? [[String: Any]] ?? []
  return windows.filter {
    (($0[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0) > 0.01
  }
}

func owner(_ window: [String: Any]) -> pid_t {
  (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value ?? 0
}

func layer(_ window: [String: Any]) -> Int {
  (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
}

func stopWorktreeAndFail(_ reason: String) -> Never {
  fputs("FAIL: \(reason)\n", stderr)
  let stop = Process()
  stop.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  stop.arguments = ["npm", "run", "dev:stop"]
  stop.currentDirectoryURL = appDirectory
  stop.standardOutput = FileHandle.standardError
  stop.standardError = FileHandle.standardError
  do {
    try stop.run()
    stop.waitUntilExit()
  } catch {
    fputs("Could not run the worktree stop guard: \(error)\n", stderr)
  }
  exit(1)
}

func stopForRelaunch() {
  let stop = Process()
  stop.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  stop.arguments = ["npm", "run", "dev:stop"]
  stop.currentDirectoryURL = appDirectory
  stop.standardOutput = FileHandle.standardOutput
  stop.standardError = FileHandle.standardError
  do {
    try stop.run()
    stop.waitUntilExit()
    if stop.terminationStatus != 0 {
      stopWorktreeAndFail("the guarded stop failed before relaunch")
    }
  } catch {
    stopWorktreeAndFail("could not run the guarded stop before relaunch: \(error)")
  }
}

guard ownedApplications().isEmpty else {
  fputs("refusing proof: this worktree's Electron app is already running\n", stderr)
  exit(2)
}
guard let initialFrontmost = workspace.frontmostApplication else {
  fputs("cannot identify the current frontmost application\n", stderr)
  exit(2)
}

var activationEvents: [pid_t] = []
let observer = workspace.notificationCenter.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: nil
) { notification in
  if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
    activationEvents.append(app.processIdentifier)
  }
}
defer { workspace.notificationCenter.removeObserver(observer) }

var launchEnvironment = ProcessInfo.processInfo.environment
launchEnvironment["DNAFORGE_BACKGROUND_WINDOW"] = "1"
launchEnvironment.removeValue(forKey: "DNAFORGE_FOREGROUND_WINDOW")

func startDevLauncher() -> Process {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
  process.arguments = ["pnpm", "run", "dev"]
  process.currentDirectoryURL = appDirectory
  process.environment = launchEnvironment
  process.standardOutput = FileHandle.standardOutput
  process.standardError = FileHandle.standardError
  do {
    try process.run()
  } catch {
    stopWorktreeAndFail("could not start the desktop dev guard: \(error)")
  }
  return process
}
var launcher = startDevLauncher()

let deadline = Date().addingTimeInterval(150)
var originalPid: pid_t?
var restartedPid: pid_t?
var originalVisibleSince: Date?
var restartedVisibleSince: Date?
var restartRequestedAt: Date?
while Date() < deadline {
  _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
  let apps = ownedApplications()
  let windows = visibleWindows()
  for app in apps {
    let pid = app.processIdentifier
    let appWindows = windows.filter { owner($0) == pid }
    if activationEvents.contains(pid) || workspace.frontmostApplication?.processIdentifier == pid {
      stopWorktreeAndFail("DNAForge activated during background launch or restart (PID \(pid))")
    }
    if !appWindows.isEmpty {
      if app.activationPolicy != .regular {
        stopWorktreeAndFail("DNAForge is not an accessible regular app (PID \(pid))")
      }
      if appWindows.contains(where: { layer($0) >= 0 }) {
        stopWorktreeAndFail("DNAForge drew a visible window at or above the normal window layer (PID \(pid))")
      }
      if let frontmostPid = workspace.frontmostApplication?.processIdentifier {
        let frontmostNormalIndices = windows.indices.filter {
          owner(windows[$0]) == frontmostPid && layer(windows[$0]) == 0
        }
        let dnaforgeIndices = windows.indices.filter { owner(windows[$0]) == pid }
        if let frontmostLast = frontmostNormalIndices.last,
           let dnaforgeFirst = dnaforgeIndices.first,
           dnaforgeFirst <= frontmostLast {
          stopWorktreeAndFail("DNAForge appeared in front of the active app window (PID \(pid))")
        }
      }
    }
  }

  if restartRequestedAt == nil {
    if let app = apps.first,
       windows.contains(where: { owner($0) == app.processIdentifier }) {
      if originalPid != app.processIdentifier {
        originalPid = app.processIdentifier
        originalVisibleSince = nil
      }
      originalVisibleSince = originalVisibleSince ?? Date()
      if let originalVisibleSince, Date().timeIntervalSince(originalVisibleSince) >= 15 {
        print("Initial window stayed behind normal windows for 15 seconds; checking guarded relaunch")
        fflush(stdout)
        stopForRelaunch()
        launcher = startDevLauncher()
        restartRequestedAt = Date()
      }
    }
  } else if let originalPid {
    if let app = apps.first(where: { $0.processIdentifier != originalPid }),
       windows.contains(where: { owner($0) == app.processIdentifier }) {
      if restartedPid != app.processIdentifier {
        restartedPid = app.processIdentifier
        restartedVisibleSince = nil
      }
      restartedVisibleSince = restartedVisibleSince ?? Date()
      if let restartedVisibleSince, Date().timeIntervalSince(restartedVisibleSince) >= 15 {
        print("PASS: regular, visible DNAForge window stayed behind normal windows through launch and guarded relaunch")
        print("Electron PIDs: \(originalPid) -> \(restartedPid!)")
        print("Original frontmost PID: \(initialFrontmost.processIdentifier)")
        print("Current frontmost PID: \(workspace.frontmostApplication?.processIdentifier ?? 0)")
        exit(0)
      }
    } else if Date().timeIntervalSince(restartRequestedAt!) > 45 {
      stopWorktreeAndFail("the guarded relaunch did not produce a visible background window")
    }
  }
  if !launcher.isRunning && apps.isEmpty { break }
}

stopWorktreeAndFail("no regular visible DNAForge window passed the background launch and relaunch check")
