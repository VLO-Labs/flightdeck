// Draws Flightdeck's app icon (1024×1024 PNG): a blue rounded square with a white airplane.
// Usage: swift icon.swift <out.png>
import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let inset = size * 0.1
let rect = NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset)
let shape = NSBezierPath(roundedRect: rect, xRadius: size * 0.18, yRadius: size * 0.18)
NSGradient(starting: NSColor(red: 0.30, green: 0.45, blue: 0.95, alpha: 1),
           ending: NSColor(red: 0.13, green: 0.20, blue: 0.55, alpha: 1))!.draw(in: shape, angle: -90)
let config = NSImage.SymbolConfiguration(pointSize: size * 0.42, weight: .semibold)
if let plane = NSImage(systemSymbolName: "airplane", accessibilityDescription: nil)?.withSymbolConfiguration(config) {
  let tinted = NSImage(size: plane.size)
  tinted.lockFocus()
  plane.draw(at: .zero, from: .zero, operation: .sourceOver, fraction: 1)
  NSColor.white.set()
  NSRect(origin: .zero, size: plane.size).fill(using: .sourceAtop)
  tinted.unlockFocus()
  let s = tinted.size
  tinted.draw(in: NSRect(x: (size - s.width) / 2, y: (size - s.height) / 2, width: s.width, height: s.height))
}
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
