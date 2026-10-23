import AppKit
import Foundation
func draw(_ size: Int, tray: Bool = false) -> Data {
    let image = NSImage(size: NSSize(width: size, height: size))
    image.lockFocus()
    let s = CGFloat(size)
    if !tray {
        NSColor(calibratedRed: 0.396, green: 0.376, blue: 0.847, alpha: 1).setFill()
        NSBezierPath(roundedRect: NSRect(x: s*0.05, y: s*0.05, width:s*0.9, height:s*0.9), xRadius:s*0.22, yRadius:s*0.22).fill()
        NSColor(calibratedRed: 1.0, green: 1.0, blue: 1.0, alpha: 1).setStroke()
    } else { NSColor.black.setStroke() }
    let heights: [CGFloat] = [0.13,0.39,0.6,0.32,0.18]
    for (i,h) in heights.enumerated() {
        let path = NSBezierPath(); path.lineWidth = tray ? s*0.095 : s*0.065; path.lineCapStyle = .round
        let x = s * (0.24 + CGFloat(i)*0.13)
        path.move(to: NSPoint(x:x,y:s*(0.5-h/2))); path.line(to:NSPoint(x:x,y:s*(0.5+h/2))); path.stroke()
    }
    image.unlockFocus()
    return NSBitmapImageRep(data:image.tiffRepresentation!)!.representation(using:.png,properties:[:])!
}
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let iconset = root.appendingPathComponent("assets/icon.iconset")
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories:true)
for n in [16,32,128,256,512] {
    try draw(n).write(to:iconset.appendingPathComponent("icon_\(n)x\(n).png"))
    try draw(n*2).write(to:iconset.appendingPathComponent("icon_\(n)x\(n)@2x.png"))
}
try draw(36,tray:true).write(to:root.appendingPathComponent("renderer/tray.png"))
