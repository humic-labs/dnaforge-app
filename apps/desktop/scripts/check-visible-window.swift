import AppKit
import CoreGraphics
import Foundation

guard CommandLine.arguments.count == 2,
      let requestedPid = Int32(CommandLine.arguments[1]),
      requestedPid > 1 else {
  fputs("usage: check-visible-window.swift ELECTRON_PID\n", stderr)
  exit(2)
}

let workspace = NSWorkspace.shared
guard let application = workspace.runningApplications.first(where: {
  $0.processIdentifier == requestedPid
}) else {
  fputs("Electron PID \(requestedPid) is not a running macOS application\n", stderr)
  exit(1)
}
guard application.activationPolicy == .regular else {
  fputs("Electron PID \(requestedPid) is not a regular, accessible application\n", stderr)
  exit(1)
}

let windows = CGWindowListCopyWindowInfo(
  [.optionOnScreenOnly, .excludeDesktopElements],
  kCGNullWindowID
) as? [[String: Any]] ?? []
let visible = windows.filter { window in
  let owner = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
  let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 0
  let bounds = window[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let width = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
  let height = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
  return owner == requestedPid && alpha > 0.01 && width >= 100 && height >= 100
}
guard let window = visible.first else {
  fputs("Electron PID \(requestedPid) has no sizable opaque on-screen window\n", stderr)
  exit(1)
}

let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
let frontmostPid = workspace.frontmostApplication?.processIdentifier ?? 0
guard frontmostPid == requestedPid || layer < 0 else {
  fputs("Electron PID \(requestedPid) is behind another app but its window remains at normal-or-higher layer \(layer)\n", stderr)
  exit(1)
}
print("native window: PID \(requestedPid), layer \(layer), frontmost PID \(frontmostPid)")
