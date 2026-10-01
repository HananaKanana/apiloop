// apiloop 图标生成器。
//
// 打包时跑一次，画一张 1024×1024 的 PNG（build.sh 再用 sips + iconutil 出 .icns）。
// 用 CoreGraphics 画，不需要设计软件，也不需要仓库里存一份二进制图标 —— 图标改了就改这个文件。
//
// 样子（用户 2026-10-01 从几版候选里选定，要求「立体、精致、体现 API 调用」）：
//   - 品牌橙（前端主色 #ff6c37 一带）的圆角底板，按 Apple 的图标网格：1024 画布、主体 824、四周留 100；
//   - 中间一张白色请求卡片：绿色「GET」标签 + 地址栏，下面几行 JSON（橙色的键、灰色的值）；
//   - 右下角压着一个深色圆形发送按钮，里面一架白色纸飞机（底板已经是橙色，按钮用深色才压得住）。
// 立体感靠三样：投影、顶部高光、上亮下暗的内描边（倒角）。
//
// 用法：make-icon <输出.png>

import AppKit

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    FileHandle.standardError.write("用法：make-icon <输出.png>\n".data(using: .utf8)!)
    exit(1)
}
let outputPath = arguments[1]

let side: CGFloat = 1024
let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(data: nil, width: Int(side), height: Int(side), bitsPerComponent: 8, bytesPerRow: 0,
                          space: colorSpace, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
    FileHandle.standardError.write("没法建 1024×1024 的位图\n".data(using: .utf8)!)
    exit(1)
}

/* ------------------------------------------------------------------ 小工具 */

func rgb(_ hex: UInt32, _ alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255, alpha: alpha)
}

func gradient(_ colors: [CGColor], _ locations: [CGFloat]? = nil) -> CGGradient {
    CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: locations)!
}

func roundedRect(_ rect: CGRect, _ radius: CGFloat) -> CGPath {
    CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
}

/// 竖直渐变填充，可带投影（shadow = 下移、模糊、不透明度）
func fill(_ path: CGPath, top: UInt32, bottom: UInt32, shadow: (CGFloat, CGFloat, CGFloat)? = nil) {
    let box = path.boundingBox
    ctx.saveGState()
    if let s = shadow {
        ctx.setShadow(offset: CGSize(width: 0, height: -s.0), blur: s.1, color: rgb(0x000000, s.2))
        ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    }
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.drawLinearGradient(gradient([rgb(top), rgb(bottom)]),
                           start: CGPoint(x: box.midX, y: box.maxY), end: CGPoint(x: box.midX, y: box.minY), options: [])
    ctx.restoreGState()
    if shadow != nil { ctx.endTransparencyLayer() }
    ctx.restoreGState()
}

/// 上半截一层渐隐的白：顶光
func gloss(_ path: CGPath, alpha: CGFloat) {
    let box = path.boundingBox
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.drawLinearGradient(gradient([rgb(0xffffff, alpha), rgb(0xffffff, 0)]),
                           start: CGPoint(x: box.midX, y: box.maxY), end: CGPoint(x: box.midX, y: box.midY), options: [])
    ctx.restoreGState()
}

/// 沿边缘一圈上亮下暗的内描边：倒角
func bevel(_ path: CGPath, width: CGFloat) {
    let box = path.boundingBox
    let edge = path.copy(strokingWithWidth: width * 2, lineCap: .round, lineJoin: .round, miterLimit: 10)
    ctx.saveGState()
    ctx.addPath(path)
    ctx.clip()
    ctx.addPath(edge)
    ctx.clip()
    ctx.drawLinearGradient(gradient([rgb(0xffffff, 0.55), rgb(0xffffff, 0), rgb(0x000000, 0.18)], [0, 0.5, 1]),
                           start: CGPoint(x: box.midX, y: box.maxY), end: CGPoint(x: box.midX, y: box.minY), options: [])
    ctx.restoreGState()
}

func drawText(_ string: String, size: CGFloat, color: CGColor, center: CGPoint) {
    var font = NSFont.systemFont(ofSize: size, weight: .heavy)
    if let rounded = font.fontDescriptor.withDesign(.rounded) { font = NSFont(descriptor: rounded, size: size) ?? font }
    let text = NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: NSColor(cgColor: color)!])
    let line = CTLineCreateWithAttributedString(text)
    let bounds = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
    ctx.textPosition = CGPoint(x: center.x - bounds.midX, y: center.y - bounds.midY)
    CTLineDraw(line, ctx)
}

/// 纸飞机：三块面（上翼白、折痕浅橙、下翼米白），中心 center，大小 k
func paperPlane(center: CGPoint, k: CGFloat) {
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: center.x + x * k, y: center.y + y * k) }

    let upper = CGMutablePath()
    upper.move(to: p(-1.0, 0.05)); upper.addLine(to: p(1.0, 0.75)); upper.addLine(to: p(-0.15, -0.2)); upper.closeSubpath()
    let crease = CGMutablePath()
    crease.move(to: p(-0.15, -0.2)); crease.addLine(to: p(1.0, 0.75)); crease.addLine(to: p(-0.35, -0.75)); crease.closeSubpath()
    let lower = CGMutablePath()
    lower.move(to: p(-0.15, -0.2)); lower.addLine(to: p(1.0, 0.75)); lower.addLine(to: p(0.1, -0.95)); lower.closeSubpath()

    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -k / 10), blur: 18, color: rgb(0x000000, 0.35))
    ctx.beginTransparencyLayer(auxiliaryInfo: nil)
    ctx.addPath(upper); ctx.setFillColor(rgb(0xffffff)); ctx.fillPath()
    ctx.addPath(crease); ctx.setFillColor(rgb(0xffd2bd)); ctx.fillPath()
    ctx.addPath(lower); ctx.setFillColor(rgb(0xfff0e8)); ctx.fillPath()
    ctx.endTransparencyLayer()
    ctx.restoreGState()
}

/* ------------------------------------------------------------------ 画 */

// 底板（Apple 图标网格：主体 824，圆角 185）
let plate = roundedRect(CGRect(x: 100, y: 100, width: 824, height: 824), 185)
fill(plate, top: 0xff9a5c, bottom: 0xee4a1c, shadow: (14, 30, 0.35))
gloss(plate, alpha: 0.10)
bevel(plate, width: 4)

// 请求卡片
let card = roundedRect(CGRect(x: 200, y: 260, width: 560, height: 520), 64)
fill(card, top: 0xffffff, bottom: 0xf1f3f8, shadow: (22, 44, 0.4))
bevel(card, width: 3)

// 顶栏：GET 标签 + 地址栏
let method = roundedRect(CGRect(x: 248, y: 650, width: 168, height: 82), 41)
fill(method, top: 0x34d399, bottom: 0x10a56c, shadow: (4, 8, 0.25))
gloss(method, alpha: 0.35)
drawText("GET", size: 50, color: rgb(0xffffff), center: CGPoint(x: 332, y: 691))
fill(roundedRect(CGRect(x: 440, y: 672, width: 272, height: 38), 19), top: 0xdfe3ea, bottom: 0xd3d8e1)

// 分隔线
ctx.setFillColor(rgb(0xe3e6ed))
ctx.fill(CGRect(x: 248, y: 616, width: 464, height: 4))

// JSON：每行一个橙色的键、一个灰色的值（y、键宽、值宽）
let jsonRows: [(CGFloat, CGFloat, CGFloat)] = [(560, 120, 170), (496, 96, 210), (432, 140, 120), (368, 100, 160)]
for (y, keyWidth, valueWidth) in jsonRows {
    fill(roundedRect(CGRect(x: 288, y: y, width: keyWidth, height: 30), 15), top: 0xffb08a, bottom: 0xff8f60)
    fill(roundedRect(CGRect(x: 288 + keyWidth + 22, y: y, width: valueWidth, height: 30), 15),
         top: 0xc9ced8, bottom: 0xbcc2ce)
}

// 右下角的发送按钮（深色）+ 纸飞机
let button = CGPath(ellipseIn: CGRect(x: 600, y: 170, width: 260, height: 260), transform: nil)
fill(button, top: 0x3a3f55, bottom: 0x15171f, shadow: (16, 34, 0.4))
gloss(button, alpha: 0.4)
bevel(button, width: 4)
paperPlane(center: CGPoint(x: 726, y: 300), k: 82)

/* ------------------------------------------------------------------ 落盘 */

guard let image = ctx.makeImage(),
      let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
    FileHandle.standardError.write("PNG 编码失败\n".data(using: .utf8)!)
    exit(1)
}
do {
    try png.write(to: URL(fileURLWithPath: outputPath))
} catch {
    FileHandle.standardError.write("写不进 \(outputPath)：\(error.localizedDescription)\n".data(using: .utf8)!)
    exit(1)
}
print("已生成 \(outputPath)（\(Int(side))×\(Int(side))）")
