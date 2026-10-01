// apiloop 图标生成器。
//
// 打包时跑一次，画一张 1024×1024 的 PNG（build.sh 再用 sips + iconutil 出 .icns）。
// 用 AppKit 画，不需要设计软件，也不需要仓库里存一份二进制图标 —— 图标改了就改这个文件。
//
// 样子：圆角方块（macOS 的图标惯例：四周留白、圆角约 22.4%），
// 品牌色（前端那个 #ff6c37 主色）渐变，中间一个白色的环形箭头 —— apiloop 的
// 「loop」就是本机与云端来回同步的意思。
//
// 用法：make-icon <输出.png>

import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write("用法：make-icon <输出.png>\n".data(using: .utf8)!)
    exit(1)
}
let outputPath = arguments[1]

let side = 1024
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
) else {
    FileHandle.standardError.write("没法建 1024×1024 的位图\n".data(using: .utf8)!)
    exit(1)
}

NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)

let canvas = NSRect(x: 0, y: 0, width: CGFloat(side), height: CGFloat(side))

// 透明底（图标本身不是方的，圆角外面必须透出去）
NSColor.clear.setFill()
canvas.fill()

// ---- 圆角方块 + 品牌色渐变
let margin: CGFloat = 44
let body = canvas.insetBy(dx: margin, dy: margin)
let cornerRadius = body.width * 0.2237
let plate = NSBezierPath(roundedRect: body, xRadius: cornerRadius, yRadius: cornerRadius)

let brandGradient = NSGradient(colors: [
    NSColor(srgbRed: 1.00, green: 0.53, blue: 0.28, alpha: 1),   // #ff8747
    NSColor(srgbRed: 0.92, green: 0.32, blue: 0.11, alpha: 1)    // #eb521c
])!
brandGradient.draw(in: plate, angle: -70)

// 上半层一层很淡的白，像顶光（没有它整块是平的，缩到 16px 会糊成一团）
NSGraphicsContext.saveGraphicsState()
plate.addClip()
let sheen = NSGradient(colors: [
    NSColor(white: 1, alpha: 0.20),
    NSColor(white: 1, alpha: 0.0)
])!
sheen.draw(in: NSRect(x: body.minX, y: body.midY, width: body.width, height: body.height / 2), angle: -90)
NSGraphicsContext.restoreGraphicsState()

// ---- 中间的环形箭头
let center = NSPoint(x: body.midX, y: body.midY)
let ringRadius: CGFloat = 238
let strokeWidth: CGFloat = 92
let startDegrees: CGFloat = -58
let endDegrees: CGFloat = 226
let toRadians = CGFloat.pi / 180

let ring = NSBezierPath()
ring.appendArc(withCenter: center, radius: ringRadius,
               startAngle: startDegrees, endAngle: endDegrees, clockwise: false)
ring.lineWidth = strokeWidth
ring.lineCapStyle = .butt
NSColor.white.setStroke()
ring.stroke()

// 箭头放在圆弧的终点，朝着画线的方向（逆时针 → 切线角 = 该点角度 + 90°）。
// 三角形**从圆弧里面一点起底**，把圆弧那个平头的断口盖住，看着才是一笔画下来的。
let endRadians = endDegrees * toRadians
let anchor = NSPoint(x: center.x + cos(endRadians) * ringRadius,
                     y: center.y + sin(endRadians) * ringRadius)
let tangent = endRadians + CGFloat.pi / 2
let normal = NSPoint(x: -sin(tangent), y: cos(tangent))
let headLength = strokeWidth * 1.6
let halfWidth = strokeWidth * 0.98
let base = anchor
let tip = NSPoint(x: anchor.x + cos(tangent) * headLength,
                  y: anchor.y + sin(tangent) * headLength)

let head = NSBezierPath()
head.move(to: tip)
head.line(to: NSPoint(x: base.x + normal.x * halfWidth, y: base.y + normal.y * halfWidth))
head.line(to: NSPoint(x: base.x - normal.x * halfWidth, y: base.y - normal.y * halfWidth))
head.close()
NSColor.white.setFill()
head.fill()

// ---- 落盘
NSGraphicsContext.restoreGraphicsState()

guard let png = bitmap.representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("PNG 编码失败\n".data(using: .utf8)!)
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: outputPath))
} catch {
    FileHandle.standardError.write("写不进 \(outputPath)：\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
print("已生成 \(outputPath)（\(side)×\(side)）")
