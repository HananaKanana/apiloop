// apiloop 原生壳。
//
// 用系统自带的 AppKit + WKWebView 开一个独立窗口，加载本机网关的页面
// （http://127.0.0.1:<端口>/）。它**替换**原来 osacompile 出来的那个启动器：
// 位置（/Applications/apiloop.app）和 bundle id（com.apiloop.launcher）都不变。
//
// 几条刻意的设计（对应计划里的审阅重点）：
//
//   1. **只连 127.0.0.1。** 访问内网和云端都是后台那个官方签名的 Node 干的事，
//      这里一个请求都不往外面发。所以这个 .app 连签名都不需要（ad-hoc 就行），
//      也不会触发 macOS 的「本地网络」授权。
//   2. **菜单里必须有「编辑」。** WKWebView 的 ⌘C / ⌘V / ⌘Z / ⌘A 全靠菜单栏里
//      那几个标准 selector 才生效，漏了用户在输入框里连粘贴都做不到。
//   3. **不占页面自己的快捷键**：⌘S（保存）、⌘K（搜索）、⌘\（侧栏）、⌘Enter（发送）。
//   4. **关窗口 / ⌘Q / ⌘R 之前先问页面**（window.apiloopShell.hasUnsavedChanges()）。
//      问不到（页面还没加载、钩子不存在、JS 报错、1 秒没回答）一律当「没有」，
//      直接关 —— 绝不能因为问不到就把用户锁在窗口里。
//   5. **别的地址不在壳子里打开**：不是网关地址的链接、target=_blank、window.open
//      一律交给系统浏览器，窗口始终停在 apiloop 上。
//   6. **网关没起来不能白屏**：显示一页中文说明 + 「重试」按钮，后台每 2 秒自动重试。
//
// 编译：build.sh 里用 swiftc，不需要 Xcode。

import AppKit
import WebKit

/* ------------------------------------------------------------------ 常量 */

private let kFallbackPort = 47321
private let kAppName = "apiloop"
private let kPortFile = NSHomeDirectory() + "/.apiloop/gateway.port"
private let kGatewayPlist = "/Library/LaunchAgents/com.apiloop.gateway.plist"
private let kRetrySeconds: TimeInterval = 2.0
private let kAutosaveName = "apiloop.main"
private let kZoomKey = "pageZoom"
private let kMessageName = "apiloopRetry"

/// 版本号取自 Info.plist（打包时写进去的 `CFBundleShortVersionString`）。
/// 直接 `swiftc` 跑（没有 bundle）时拿不到，用一个占位值。
private func shellVersion() -> String {
    let value = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    if let value = value, !value.isEmpty { return value }
    return "dev"
}

/* ------------------------------------------------------------------ 网关 */

/// 网关没在 launchd 里（覆盖安装时 bootstrap 没成功、用户手动 bootout 过）就替用户拉起来，
/// 再等它写出端口文件，最多等 5 秒。这段原来在 launcher.applescript 里，原样搬过来。
///
/// 网关进程是 launchd 按 plist 启动的、**不是这个壳的子进程**，所以本地网络权限照样归官方 Node。
private func ensureGateway() {
    let script = """
    uid=$(id -u); svc=gui/$uid/com.apiloop.gateway; \
    if ! launchctl print $svc >/dev/null 2>&1; then \
    rm -f '\(kPortFile)'; \
    launchctl bootstrap gui/$uid '\(kGatewayPlist)' >/dev/null 2>&1; \
    for i in 1 2 3 4 5 6 7 8 9 10; do [ -f '\(kPortFile)' ] && break; sleep 0.5; done; \
    fi; true
    """

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", script]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        // 拉不起来也不要紧：下面读不到端口就用默认的，页面自己会显示「还没启动」
    }
}

/// 端口文件里只有一行数字。读不到、读出来不是数字，都退回 47321。
private func readPort() -> Int {
    guard let raw = try? String(contentsOfFile: kPortFile, encoding: .utf8) else { return kFallbackPort }
    let digits = raw.filter { $0.isNumber }
    if let value = Int(digits), value > 0, value < 65536 { return value }
    return kFallbackPort
}

/* ------------------------------------------------------------------ 壳 */

final class Shell: NSObject, NSApplicationDelegate, NSWindowDelegate,
                   WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, WKDownloadDelegate {

    private var window: NSWindow!
    private var webView: WKWebView!

    /// 当前网关端口。每次重试都重读一遍端口文件 —— 网关重启可能换了端口
    private var port = kFallbackPort
    private var retryTimer: Timer?
    /// 现在显示的是那一页「还没启动」的说明
    private var showingOffline = false

    /// 已经在关窗口 / 退出了，别再问第二遍（`applicationShouldTerminate` 会被调两次）
    private var allowClose = false
    private var allowTerminate = false
    /// 一次「关窗口 / 退出 / 刷新」正在进行（问页面、等用户在确认框里选），直到用户做完决定。
    /// 这期间再按 ⌘W / ⌘Q / ⌘R 一律不理：以前第二下会被当成「没有修改」直接关掉，
    /// 确认框还开着时按 ⌘Q 则会让这次退出请求一直挂着
    private var busy = false

    private var gatewayURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

    /* ---------------------------------------------------------- 启动 */

    func start() {
        ensureGateway()
        port = readPort()
        buildMenu()
        buildWindow()
        loadGateway()
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        // 登录状态、页面的 localStorage 关掉再开都要还在
        configuration.websiteDataStore = .default()
        // 末尾追加 apiloop-shell/<版本>，页面想判断「是不是在壳子里」就能用（现在还没用）
        configuration.applicationNameForUserAgent = "\(kAppName)-shell/\(shellVersion())"
        configuration.userContentController.add(self, name: kMessageName)

        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self

        let savedZoom = UserDefaults.standard.double(forKey: kZoomKey)
        webView.pageZoom = savedZoom > 0 ? CGFloat(savedZoom) : 1.0

        let container = NSView()
        webView.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            webView.topAnchor.constraint(equalTo: container.topAnchor),
            webView.bottomAnchor.constraint(equalTo: container.bottomAnchor)
        ])

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = kAppName
        window.minSize = NSSize(width: 900, height: 600)
        window.contentView = container
        window.delegate = self
        // 记住大小和位置：第一次（没有存过）才居中
        window.setFrameAutosaveName(kAutosaveName)
        if !window.setFrameUsingName(kAutosaveName) { window.center() }
        window.makeKeyAndOrderFront(nil)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.activate(ignoringOtherApps: true)
    }

    /// 关掉最后一个窗口就退出应用。网关是 launchd 管的，不受影响。
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    /* ---------------------------------------------------------- 菜单 */

    /// 审阅重点 1、2：**必须有「编辑」**（不然 ⌘C / ⌘V 全都不生效），
    /// 而且**不许占用** ⌘S / ⌘K / ⌘\ / ⌘Enter —— 那四个是页面自己的。
    private func buildMenu() {
        let mainMenu = NSMenu()

        // ---- apiloop
        let appItem = NSMenuItem(title: kAppName, action: nil, keyEquivalent: "")
        mainMenu.addItem(appItem)
        let appMenu = NSMenu(title: kAppName)
        appMenu.addItem(withTitle: "关于 \(kAppName)",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 \(kAppName)",
                        action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他",
                                         action: #selector(NSApplication.hideOtherApplications(_:)),
                                         keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "显示全部",
                        action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 \(kAppName)",
                        action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // ---- 编辑（**别删**：WKWebView 的复制粘贴、撤销、全选都靠这几个标准 selector）
        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        // ---- 显示
        let viewItem = NSMenuItem(title: "显示", action: nil, keyEquivalent: "")
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        let reload = viewMenu.addItem(withTitle: "重新加载",
                                      action: #selector(reloadPage(_:)), keyEquivalent: "r")
        reload.target = self
        viewMenu.addItem(.separator())
        let actualSize = viewMenu.addItem(withTitle: "实际大小",
                                          action: #selector(zoomActualSize(_:)), keyEquivalent: "0")
        actualSize.target = self
        let zoomIn = viewMenu.addItem(withTitle: "放大",
                                      action: #selector(zoomInPage(_:)), keyEquivalent: "=")
        zoomIn.target = self
        let zoomOut = viewMenu.addItem(withTitle: "缩小",
                                       action: #selector(zoomOutPage(_:)), keyEquivalent: "-")
        zoomOut.target = self
        viewMenu.addItem(.separator())
        // **不给快捷键**：⌘⇧O 之类的也很容易和页面的快捷键撞
        let openBrowser = viewMenu.addItem(withTitle: "在浏览器中打开",
                                           action: #selector(openInBrowser(_:)), keyEquivalent: "")
        openBrowser.target = self
        viewItem.submenu = viewMenu

        // ---- 窗口
        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化",
                           action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "关闭窗口",
                           action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func reloadPage(_ sender: Any?) {
        if busy { return }
        busy = true
        askUnsavedChanges { hasChanges in
            if !hasChanges { self.busy = false; self.reload(); return }
            self.confirmDiscard(actionTitle: "仍然刷新") { discard in
                self.busy = false
                if discard { self.reload() }
            }
        }
    }

    private func reload() {
        // 说明页显示着（网关没起来）时，「重新加载」应该是立刻重试一次
        if showingOffline { retryNow() } else { webView.reload() }
    }

    @objc private func zoomActualSize(_ sender: Any?) { setZoom(1.0) }
    @objc private func zoomInPage(_ sender: Any?) { setZoom(webView.pageZoom + 0.1) }
    @objc private func zoomOutPage(_ sender: Any?) { setZoom(webView.pageZoom - 0.1) }

    private func setZoom(_ value: CGFloat) {
        let clamped = min(max(value, 0.5), 3.0)
        webView.pageZoom = clamped
        UserDefaults.standard.set(Double(clamped), forKey: kZoomKey)
    }

    @objc private func openInBrowser(_ sender: Any?) {
        NSWorkspace.shared.open(gatewayURL)
    }

    /* ---------------------------------------------------------- 加载与重试 */

    private func loadGateway() {
        webView.load(URLRequest(url: gatewayURL))
    }

    private func retryNow() {
        port = readPort()          // 网关可能已经重启到别的端口了
        loadGateway()
    }

    private func startRetryTimer() {
        guard retryTimer == nil else { return }
        let timer = Timer.scheduledTimer(withTimeInterval: kRetrySeconds, repeats: true) { [weak self] _ in
            self?.retryNow()
        }
        retryTimer = timer
    }

    private func stopRetryTimer() {
        retryTimer?.invalidate()
        retryTimer = nil
    }

    /// 网关没起来时显示的那一页。按钮用 `WKScriptMessageHandler` 收消息，
    /// 不开自定义 URL scheme —— 那样会多出一个「什么都能打开」的口子。
    ///
    /// **已经在显示了就什么都不做**：后台每 2 秒重试一次，每次都重新 load 这页 HTML
    /// 的话，用户会看到整页每两秒闪一下。重试失败的「临时导航」本来就不会换掉当前页面。
    private func showOfflinePage() {
        if showingOffline { return }
        showingOffline = true
        webView.loadHTMLString(offlineHTML(), baseURL: nil)
    }

    private func offlineHTML() -> String {
        return """
        <!DOCTYPE html>
        <html lang="zh-CN">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>\(kAppName)</title>
        <style>
          :root { color-scheme: light dark; }
          body {
            margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center;
            font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
            background: #f5f5f7; color: #1d1d1f;
          }
          @media (prefers-color-scheme: dark) {
            body { background: #1e1e20; color: #f5f5f7; }
            button { background: #2c2c2e; border-color: rgba(255,255,255,.22); }
          }
          .card { text-align: center; padding: 40px 44px; }
          h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
          p { font-size: 13px; line-height: 1.7; margin: 0 0 22px; opacity: .72; }
          button {
            font: inherit; font-size: 13px; padding: 7px 24px; border-radius: 6px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.15); background: #fff; color: inherit;
          }
          button:active { opacity: .7; }
          .hint { font-size: 12px; margin: 20px 0 0; opacity: .55; }
        </style>
        </head>
        <body>
          <div class="card">
            <h1>apiloop 本机服务还没启动</h1>
            <p>正在自动重试，连上之后会自己打开。</p>
            <button onclick="window.webkit.messageHandlers.\(kMessageName).postMessage('retry')">重试</button>
            <p class="hint">多次重试仍然不行，请重新安装 apiloop。</p>
          </div>
        </body>
        </html>
        """
    }

    /* ---------------------------------------------------------- 导航 */

    /// 只有网关自己的地址能在壳子里打开。
    private func isGatewayURL(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "about" { return true }
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        guard let host = url.host?.lowercased(), host == "127.0.0.1" || host == "localhost" else { return false }
        let effective = url.port ?? (scheme == "https" ? 443 : 80)
        return effective == port
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url

        // target=_blank / window.open：一律交给系统浏览器，壳子里不开新窗口
        if navigationAction.targetFrame == nil {
            if navigationAction.shouldPerformDownload { decisionHandler(.download); return }
            if url != nil { NSWorkspace.shared.open(url!) }
            decisionHandler(.cancel)
            return
        }

        // `<a download>`、blob 地址（页面导出就是这么做）走这一条
        if navigationAction.shouldPerformDownload { decisionHandler(.download); return }

        // **iframe 里的导航不归这里管**：响应预览是把 HTML 放进 iframe 显示的，那个页面里
        // 自己的 iframe（视频、广告……）一加载就会走到这里，按主窗口的规则处理的话，
        // 光是预览一下就会自己弹出系统浏览器。只有用户在 iframe 里**点了链接**才交给系统浏览器
        if navigationAction.targetFrame?.isMainFrame == false {
            if navigationAction.navigationType == .linkActivated,
               let target = url, !isGatewayURL(target) {
                NSWorkspace.shared.open(target)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
            return
        }

        // about:blank / loadHTMLString 出来的说明页
        guard let target = url else { decisionHandler(.allow); return }
        if isGatewayURL(target) { decisionHandler(.allow); return }

        // 别的 http(s)（还有 mailto: 之类）交给系统；不是 http 的也让它自己处理
        if let scheme = target.scheme?.lowercased(), !scheme.isEmpty {
            NSWorkspace.shared.open(target)
        }
        decisionHandler(.cancel)
    }

    /// 响应侧：`Content-Disposition: attachment` 和「这个类型显示不了」都转成下载
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        // 只看主窗口：预览里的 iframe 加载了一个 PDF / 压缩包，不该弹出「存储为」
        if !navigationResponse.isForMainFrame { decisionHandler(.allow); return }

        if let response = navigationResponse.response as? HTTPURLResponse,
           let disposition = response.value(forHTTPHeaderField: "Content-Disposition"),
           disposition.lowercased().contains("attachment") {
            decisionHandler(.download)
            return
        }
        if !navigationResponse.canShowMIMEType {
            decisionHandler(.download)
            return
        }
        decisionHandler(.allow)
    }

    /// 页面里的 window.open / target=_blank 会走到这里。返回 nil 就是「不开新窗口」。
    func webView(_ webView: WKWebView,
                 createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // 网关页面真的加载出来了 → 说明在线，停掉后台重试。
        // 那一页说明自己是 about:blank，不进这个分支（否则重试会被误判成已连上）。
        guard let scheme = webView.url?.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else { return }
        showingOffline = false
        stopRetryTimer()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    /// 只有「连不上」才显示说明页。被我们 cancel 掉的导航（-999）、
    /// WebKit 自己的错误（WebKitErrorDomain）都不算。
    private func handleLoadFailure(_ error: Error) {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return }
        let connectionFailures = [
            NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorTimedOut,
            NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet,
            NSURLErrorDNSLookupFailed, NSURLErrorResourceUnavailable
        ]
        guard connectionFailures.contains(nsError.code) else { return }

        showOfflinePage()
        startRetryTimer()
    }

    /* ---------------------------------------------------------- 下载 */

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload,
                  decideDestinationUsing response: URLResponse,
                  suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { answer in
            // 取消就给 nil —— WebKit 会把这次下载丢掉，不会写半个文件
            if answer == .OK, let url = panel.url { completionHandler(url) }
            else { completionHandler(nil) }
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        // 存好了不用打扰用户（Finder 的下载文件夹就是他的去处）
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "下载失败"
        alert.informativeText = error.localizedDescription
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    /* ---------------------------------------------------------- 选文件、JS 弹窗 */

    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: window) { answer in
            completionHandler(answer == .OK ? panel.urls : nil)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = kAppName
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = kAppName
        alert.informativeText = message
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "取消")
        alert.buttons.last?.keyEquivalent = "\u{1b}"      // Esc = 取消
        alert.beginSheetModal(for: window) { answer in
            completionHandler(answer == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = kAppName
        alert.informativeText = prompt
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "取消")
        alert.buttons.last?.keyEquivalent = "\u{1b}"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { answer in
            completionHandler(answer == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    /// 说明页上那个「重试」按钮
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == kMessageName else { return }
        retryNow()
    }

    /* ---------------------------------------------------------- 没保存的修改 */

    /// 问页面「有没有没保存的修改」。
    ///
    /// **问不到就当没有**（审阅重点 3）：钩子不存在、JS 抛错、1 秒内没回答，都回调 false。
    /// 页面还没加载出来的时候（比如启动就关窗口）本来也问不到，直接关是对的 ——
    /// 绝不能因为问不到把用户锁在窗口里。
    private func askUnsavedChanges(_ completion: @escaping (Bool) -> Void) {
        var answered = false
        let finish: (Bool) -> Void = { value in
            if answered { return }
            answered = true
            completion(value)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { finish(false) }

        let script = "(function () {"
            + " try {"
            + "  var shell = window.apiloopShell;"
            + "  if (!shell || typeof shell.hasUnsavedChanges !== 'function') { return false; }"
            + "  return Boolean(shell.hasUnsavedChanges());"
            + " } catch (err) { return false; }"
            + "})()"

        webView.evaluateJavaScript(script) { result, error in
            if error != nil { finish(false); return }
            if let value = result as? NSNumber { finish(value.boolValue); return }
            finish(false)
        }
    }

    /// 「还有没保存的修改」的确认框。返回 true 表示用户选了「仍然关闭 / 仍然退出 / 仍然刷新」。
    private func confirmDiscard(actionTitle: String, _ completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "还有没保存的修改"
        alert.informativeText = "关闭后这些修改会丢失。"
        alert.addButton(withTitle: actionTitle)
        alert.addButton(withTitle: "取消")
        alert.buttons.last?.keyEquivalent = "\u{1b}"       // Esc = 取消
        alert.beginSheetModal(for: window) { answer in
            completion(answer == .alertFirstButtonReturn)
        }
    }

    /// 关窗口之前先问一句。返回 false 只是「这次先别关」，问完再自己调 close()。
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if allowClose { return true }
        if busy { return false }
        busy = true

        askUnsavedChanges { hasChanges in
            let close = {
                // 关掉最后一个窗口，应用紧接着就会退出 —— 那一问已经问过了，
                // **两个标记一起置上**，否则 `applicationShouldTerminate` 会再问一遍
                self.allowClose = true
                self.allowTerminate = true
                sender.close()
            }

            if !hasChanges { close(); return }
            self.confirmDiscard(actionTitle: "仍然关闭") { discard in
                if discard { close() } else { self.busy = false }
            }
        }
        return false
    }

    /// ⌘Q 之前同样问一句。
    ///
    /// 返回 `.terminateLater` 之后**必须**回一句 `reply(toApplicationShouldTerminate:)`，
    /// 不能自己再调一次 `NSApp.terminate` —— 那样这一次终止请求会一直挂着，
    /// 用户点了「取消」之后再按 ⌘Q 就没反应了。
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if allowTerminate { return .terminateNow }
        // 关窗口 / 刷新的确认还开着：这次退出先不算（返回 .terminateLater 又不回话会一直挂着）
        if busy { return .terminateCancel }
        busy = true

        askUnsavedChanges { hasChanges in
            if !hasChanges {
                self.allowTerminate = true
                NSApp.reply(toApplicationShouldTerminate: true)
                return
            }
            self.confirmDiscard(actionTitle: "仍然退出") { discard in
                self.allowTerminate = discard
                if !discard { self.busy = false }
                NSApp.reply(toApplicationShouldTerminate: discard)
            }
        }
        return .terminateLater
    }
}

/* ------------------------------------------------------------------ 入口 */

let application = NSApplication.shared
let shell = Shell()

application.delegate = shell
application.setActivationPolicy(.regular)
shell.start()
application.run()
