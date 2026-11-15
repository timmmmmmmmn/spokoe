// Maakt icon/Spotimfy-1024.png: het volledige icoon (draaitafel) als afgeronde tegel in het macOS-raster.
import AppKit
let src = NSImage(contentsOfFile: CommandLine.arguments[1])!
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let tile = NSRect(x: 100, y: 100, width: 824, height: 824)
let path = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185)
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
shadow.shadowOffset = NSSize(width: 0, height: -10)
shadow.shadowBlurRadius = 22
NSGraphicsContext.saveGraphicsState()
shadow.set()
NSColor(srgbRed: 0x0b/255, green: 0x14/255, blue: 0x82/255, alpha: 1).setFill()
path.fill()
NSGraphicsContext.restoreGraphicsState()
path.addClip()
src.draw(in: tile)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
