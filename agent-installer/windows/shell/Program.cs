// apiloop 的 Windows 窗口程序（和 Mac 的 agent-installer/mac/shell/main.swift 对应）。
//
// 一个 exe 三种用法：
//   apiloop.exe              打开窗口（WebView2 加载 http://127.0.0.1:<网关端口>/）
//   apiloop.exe --gateway    后台守护网关：拉起 node 网关，退了就重启（开机自启动用的就是它）
//   apiloop.exe --uninstall  卸载（「设置 → 应用」里点卸载走的就是它）
//
// 和 Mac 壳一样的几条约定：
//   1. 只连 127.0.0.1。访问内网和云端都是网关（官方 node）的事。
//   2. 关窗口前先问页面有没有没保存的修改（window.apiloopShell.hasUnsavedChanges()），
//      问不到（页面没加载、钩子不存在、出错、1 秒没回答）一律当「没有」。
//   3. 不是网关地址的链接、新窗口一律交给系统浏览器，窗口始终停在 apiloop 上。
//   4. 网关没起来不能白屏：显示一页中文说明 + 「重试」，后台每 2 秒自动重试。
//
// 刷新（F5 / Ctrl+R）不用自己拦：WebView2 会照页面的 beforeunload 弹「离开此页？」。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Microsoft.Win32;

namespace Apiloop
{
    internal static class Paths
    {
        public const int FallbackPort = 47321;

        /// <summary>apiloop.exe 所在目录，也就是安装目录（%LOCALAPPDATA%\Programs\apiloop）</summary>
        public static string InstallDir => Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);

        public static string Exe => Assembly.GetExecutingAssembly().Location;

        /// <summary>网关写端口文件的地方：和 Mac 一样是 ~/.apiloop/gateway.port</summary>
        public static string PortFile =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".apiloop", "gateway.port");

        /// <summary>窗口自己的数据（WebView2 的缓存、窗口位置）</summary>
        public static string LocalData =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "apiloop");

        public static int ReadPort()
        {
            try
            {
                var digits = new string(File.ReadAllText(PortFile).Where(char.IsDigit).ToArray());
                if (int.TryParse(digits, out var port) && port > 0 && port < 65536) return port;
            }
            catch
            {
                // 读不到就用默认端口
            }
            return FallbackPort;
        }
    }

    internal static class Program
    {
        /// <summary>网关守护进程持有的互斥量：窗口靠它判断网关在不在</summary>
        public const string GatewayMutex = @"Local\apiloop-gateway";
        private const string WindowMutex = @"Local\apiloop-window";
        /// <summary>第二个窗口实例用它叫第一个把自己翻到最前面</summary>
        public const string ShowEvent = @"Local\apiloop-window-show";

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Contains("--gateway")) return Gateway.Run();
            if (args.Contains("--uninstall")) return Uninstaller.Run(args.Contains("--quiet"));

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            // 只开一个窗口：已经开着就叫它翻到前面
            using (var mutex = new Mutex(true, WindowMutex, out var created))
            {
                if (!created)
                {
                    try { EventWaitHandle.OpenExisting(ShowEvent).Set(); } catch { }
                    return 0;
                }

                Gateway.EnsureRunning();
                Application.Run(new ShellForm());
            }
            return 0;
        }
    }

    /* ------------------------------------------------------------------ 网关守护 */

    internal static class Gateway
    {
        /// <summary>
        /// 后台守护：拉起 node 网关，退了就重启（相当于 Mac 上 launchd 的 KeepAlive）。
        /// 连续很快就退（比如端口被占）时等待时间翻倍，最多 30 秒，免得空转。
        /// </summary>
        public static int Run()
        {
            using (var mutex = new Mutex(true, Program.GatewayMutex, out var created))
            {
                if (!created) return 0;   // 已经有一个在守护了

                var node = Path.Combine(Paths.InstallDir, "node", "node.exe");
                var server = Path.Combine(Paths.InstallDir, "app", "bin", "server");
                var delay = 1000;

                while (true)
                {
                    var startedAt = DateTime.UtcNow;
                    try
                    {
                        var info = new ProcessStartInfo(node, "\"" + server + "\" gateway")
                        {
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            WorkingDirectory = Path.Combine(Paths.InstallDir, "app")
                        };
                        using (var process = Process.Start(info))
                        {
                            process.WaitForExit();
                        }
                    }
                    catch
                    {
                        // node.exe 不见了之类：等一会儿再试（可能正在覆盖安装）
                    }

                    delay = (DateTime.UtcNow - startedAt).TotalSeconds > 60 ? 1000 : Math.Min(delay * 2, 30000);
                    Thread.Sleep(delay);
                }
            }
        }

        /// <summary>窗口启动时：网关守护不在就拉起来，再等它写出端口文件（最多 10 秒）</summary>
        public static void EnsureRunning()
        {
            if (Mutex.TryOpenExisting(Program.GatewayMutex, out var existing))
            {
                existing.Dispose();
                return;
            }

            try { File.Delete(Paths.PortFile); } catch { }
            try
            {
                Process.Start(new ProcessStartInfo(Paths.Exe, "--gateway") { UseShellExecute = false, CreateNoWindow = true });
            }
            catch
            {
                return;   // 拉不起来：窗口会显示「本机服务还没启动」
            }

            for (var i = 0; i < 40 && !File.Exists(Paths.PortFile); i++) Thread.Sleep(250);
        }
    }

    /* ------------------------------------------------------------------ 窗口 */

    internal sealed class ShellForm : Form
    {
        private const string RetryMessage = "apiloop-retry";
        private const string UnsavedScript =
            "(function () { try { var s = window.apiloopShell;" +
            " if (!s || typeof s.hasUnsavedChanges !== 'function') { return false; }" +
            " return Boolean(s.hasUnsavedChanges()); } catch (e) { return false; } })()";

        private readonly WebView2 web = new WebView2();
        private readonly System.Windows.Forms.Timer retryTimer = new System.Windows.Forms.Timer { Interval = 2000 };
        private int port = Paths.ReadPort();
        private bool showingOffline;
        private bool allowClose;
        private bool asking;

        private string GatewayUrl => "http://127.0.0.1:" + port + "/";
        private string StateFile => Path.Combine(Paths.LocalData, "window.txt");

        public ShellForm()
        {
            Text = "apiloop";
            try { Icon = Icon.ExtractAssociatedIcon(Paths.Exe); } catch { }
            MinimumSize = new Size(900, 600);
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1280, 800);
            RestoreWindowState();

            web.Dock = DockStyle.Fill;
            Controls.Add(web);

            retryTimer.Tick += (s, e) => RetryNow();
            Load += async (s, e) => await InitAsync();
            FormClosing += OnFormClosing;

            ListenForShowRequests();
        }

        private async Task InitAsync()
        {
            try
            {
                CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch (WebView2RuntimeNotFoundException)
            {
                // Windows 11 自带；少数 Windows 10 没有，要装一次
                MessageBox.Show(this,
                    "这台电脑缺少 Microsoft Edge WebView2 运行库，apiloop 需要它来显示界面。\n\n点「确定」打开下载页面，装好后重新打开 apiloop。",
                    "apiloop", MessageBoxButtons.OK, MessageBoxIcon.Information);
                OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703");
                allowClose = true;
                Close();
                return;
            }

            var options = new CoreWebView2EnvironmentOptions();
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Paths.LocalData, "WebView2"), options);
            await web.EnsureCoreWebView2Async(environment);

            var core = web.CoreWebView2;
            var version = Assembly.GetExecutingAssembly().GetName().Version;
            core.Settings.UserAgent = core.Settings.UserAgent + " apiloop-shell/" + version.ToString(3);
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;

            web.ZoomFactor = ReadZoom();
            web.ZoomFactorChanged += (s, e) => SaveZoom(web.ZoomFactor);

            core.NavigationStarting += OnNavigationStarting;
            core.NewWindowRequested += OnNewWindowRequested;
            core.NavigationCompleted += OnNavigationCompleted;
            core.WebMessageReceived += (s, e) =>
            {
                if (e.TryGetWebMessageAsString() == RetryMessage) RetryNow();
            };

            core.Navigate(GatewayUrl);
        }

        /* ---------------------------------------------------------- 导航 */

        private bool IsGatewayUrl(string value)
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return false;
            if (uri.Scheme == "about" || uri.Scheme == "data") return true;
            if (uri.Scheme != "http" && uri.Scheme != "https") return false;
            var host = uri.Host.ToLowerInvariant();
            return (host == "127.0.0.1" || host == "localhost") && uri.Port == port;
        }

        /// <summary>主窗口只放行网关自己的地址；别的交给系统浏览器（iframe 走的是另一个事件，不受影响）</summary>
        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            if (IsGatewayUrl(e.Uri)) return;
            e.Cancel = true;
            OpenExternal(e.Uri);
        }

        /// <summary>target=_blank / window.open：一律交给系统浏览器，不开新窗口</summary>
        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            OpenExternal(e.Uri);
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                var url = web.CoreWebView2.Source ?? "";
                if (url.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                {
                    showingOffline = false;
                    retryTimer.Stop();
                }
                return;
            }

            switch (e.WebErrorStatus)
            {
                case CoreWebView2WebErrorStatus.CannotConnect:
                case CoreWebView2WebErrorStatus.ConnectionAborted:
                case CoreWebView2WebErrorStatus.ConnectionReset:
                case CoreWebView2WebErrorStatus.Disconnected:
                case CoreWebView2WebErrorStatus.HostNameNotResolved:
                case CoreWebView2WebErrorStatus.Timeout:
                case CoreWebView2WebErrorStatus.ServerUnreachable:
                    ShowOfflinePage();
                    retryTimer.Start();
                    break;
            }
        }

        private void RetryNow()
        {
            port = Paths.ReadPort();   // 网关重启可能换了端口
            Gateway.EnsureRunning();
            web.CoreWebView2?.Navigate(GatewayUrl);
        }

        /// <summary>已经显示着就不再加载，否则每 2 秒整页闪一下</summary>
        private void ShowOfflinePage()
        {
            if (showingOffline) return;
            showingOffline = true;
            web.CoreWebView2.NavigateToString(@"<!DOCTYPE html><html lang=""zh-CN""><head><meta charset=""utf-8""><title>apiloop</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         font-family:'Microsoft YaHei UI','Segoe UI',sans-serif; background:#f5f5f7; color:#1d1d1f; }
  @media (prefers-color-scheme: dark) { body { background:#1e1e20; color:#f5f5f7; } button { background:#2c2c2e; } }
  .card { text-align:center; padding:40px 44px; }
  h1 { font-size:20px; font-weight:600; margin:0 0 12px; }
  p { font-size:13px; line-height:1.7; margin:0 0 22px; opacity:.72; }
  button { font:inherit; font-size:13px; padding:7px 24px; border-radius:6px; cursor:pointer;
           border:1px solid rgba(128,128,128,.4); background:#fff; color:inherit; }
  .hint { font-size:12px; margin:20px 0 0; opacity:.55; }
</style></head><body><div class=""card"">
  <h1>apiloop 本机服务还没启动</h1>
  <p>正在自动重试，连上之后会自己打开。</p>
  <button onclick=""window.chrome.webview.postMessage('" + RetryMessage + @"')"">重试</button>
  <p class=""hint"">多次重试仍然不行，请重新安装 apiloop。</p>
</div></body></html>");
        }

        private static void OpenExternal(string url)
        {
            if (string.IsNullOrEmpty(url)) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        /* ---------------------------------------------------------- 关窗口 */

        private void OnFormClosing(object sender, FormClosingEventArgs e)
        {
            SaveWindowState();
            if (allowClose) return;
            // 关机、注销、任务管理器结束：不拦
            if (e.CloseReason == CloseReason.WindowsShutDown || e.CloseReason == CloseReason.TaskManagerClosing) return;

            e.Cancel = true;
            if (asking) return;
            asking = true;
            BeginInvoke(new Action(async () =>
            {
                var dirty = await HasUnsavedChangesAsync();
                var close = !dirty || MessageBox.Show(this,
                    "还有没保存的修改，关闭后这些修改会丢失。\n\n仍然关闭吗？", "apiloop",
                    MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) == DialogResult.OK;
                asking = false;
                if (close)
                {
                    allowClose = true;
                    Close();
                }
            }));
        }

        /// <summary>问页面有没有没保存的修改。问不到一律当「没有」</summary>
        private async Task<bool> HasUnsavedChangesAsync()
        {
            if (web.CoreWebView2 == null) return false;
            try
            {
                var task = web.ExecuteScriptAsync(UnsavedScript);
                if (await Task.WhenAny(task, Task.Delay(1000)) != task) return false;
                return task.Result == "true";
            }
            catch
            {
                return false;
            }
        }

        /* ---------------------------------------------------------- 单实例 */

        /// <summary>再次点图标时（第二个实例发信号），把已有窗口翻到最前面</summary>
        private void ListenForShowRequests()
        {
            var signal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEvent);
            var thread = new Thread(() =>
            {
                while (true)
                {
                    signal.WaitOne();
                    try
                    {
                        BeginInvoke(new Action(() =>
                        {
                            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                            Activate();
                            BringToFront();
                        }));
                    }
                    catch
                    {
                        return;   // 窗口已经关了
                    }
                }
            }) { IsBackground = true };
            thread.Start();
        }

        /* ---------------------------------------------------------- 记住窗口和缩放 */

        private void RestoreWindowState()
        {
            try
            {
                var parts = File.ReadAllText(StateFile).Split(',');
                var bounds = new Rectangle(int.Parse(parts[0]), int.Parse(parts[1]), int.Parse(parts[2]), int.Parse(parts[3]));
                // 显示器换过、拔掉了：存下来的位置不在任何屏幕上就不用它
                if (Screen.AllScreens.Any(screen => screen.WorkingArea.IntersectsWith(bounds)))
                {
                    StartPosition = FormStartPosition.Manual;
                    Bounds = bounds;
                }
                if (parts.Length > 4 && parts[4] == "max") WindowState = FormWindowState.Maximized;
            }
            catch
            {
                // 第一次打开：居中
            }
        }

        private void SaveWindowState()
        {
            try
            {
                Directory.CreateDirectory(Paths.LocalData);
                var bounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                File.WriteAllText(StateFile, string.Join(",", bounds.X, bounds.Y, bounds.Width, bounds.Height,
                    WindowState == FormWindowState.Maximized ? "max" : "normal"));
            }
            catch
            {
            }
        }

        private double ReadZoom()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\apiloop"))
                {
                    if (key?.GetValue("PageZoom") is string text && double.TryParse(text,
                            System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var zoom)
                        && zoom >= 0.25 && zoom <= 5) return zoom;
                }
            }
            catch
            {
            }
            return 1.0;
        }

        private static void SaveZoom(double zoom)
        {
            try
            {
                using (var key = Registry.CurrentUser.CreateSubKey(@"Software\apiloop"))
                {
                    key.SetValue("PageZoom", zoom.ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
            }
            catch
            {
            }
        }
    }

    /* ------------------------------------------------------------------ 卸载 */

    internal static class Uninstaller
    {
        public static int Run(bool quiet)
        {
            if (!quiet && MessageBox.Show(
                    "确定要卸载 apiloop 吗？\n\n你的数据（项目、接口、历史记录）保留在 " +
                    Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".apiloop") +
                    "，不需要的话可以手动删掉。",
                    "卸载 apiloop", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK)
            {
                return 1;
            }

            var dir = Paths.InstallDir;
            Installation.StopRunning(dir);
            Installation.Unregister();

            // 自己正在运行，删不掉自己：交给一个隐藏的 cmd，等这个进程退出后再删整个目录
            try
            {
                Process.Start(new ProcessStartInfo("cmd.exe",
                    "/c ping 127.0.0.1 -n 3 > nul & rmdir /s /q \"" + dir + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true
                });
            }
            catch
            {
            }

            if (!quiet) MessageBox.Show("apiloop 已卸载。", "apiloop", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }
    }
}
