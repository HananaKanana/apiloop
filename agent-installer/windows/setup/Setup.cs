// apiloop 的 Windows 安装程序。
//
//   apiloop-gateway-<版本>-win-x64.exe           双击安装：一个小窗口显示「正在安装」，装完打开 apiloop
//   apiloop-gateway-<版本>-win-x64.exe /update   一键更新时网关调用的：不显示窗口，装完重新打开 apiloop
//
// 做的事：退掉正在运行的 apiloop → 换掉安装目录里的程序文件（数据在 ~/.apiloop，不动）→
// 登记开机自启动、开始菜单 / 桌面快捷方式、「设置 → 应用」里的卸载入口 → 拉起网关和窗口。
// 全程不需要管理员权限。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Apiloop
{
    internal static class Setup
    {
        [STAThread]
        private static int Main(string[] args)
        {
            var silent = args.Any(arg => arg.Equals("/update", StringComparison.OrdinalIgnoreCase)
                                      || arg.Equals("/silent", StringComparison.OrdinalIgnoreCase));

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (silent)
            {
                try
                {
                    Install();
                    return 0;
                }
                catch (Exception err)
                {
                    MessageBox.Show("apiloop 更新失败：" + err.Message + "\n\n可以重新下载安装包，双击安装。",
                        "apiloop", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return 1;
                }
            }

            var form = new ProgressForm();
            form.Shown += async (s, e) =>
            {
                try
                {
                    await Task.Run(Install);
                    form.Close();
                }
                catch (Exception err)
                {
                    form.Hide();
                    MessageBox.Show("apiloop 安装失败：" + err.Message, "apiloop",
                        MessageBoxButtons.OK, MessageBoxIcon.Error);
                    form.Close();
                }
            };
            Application.Run(form);
            return 0;
        }

        private static string Version
        {
            get
            {
                var version = Assembly.GetExecutingAssembly().GetName().Version;
                return version.ToString(3);
            }
        }

        private static void Install()
        {
            var dir = Installation.DefaultDir;
            var firstInstall = !Installation.IsInstalled();

            // 1. 退掉正在运行的（窗口、网关守护、node 网关），文件才换得了
            Installation.StopRunning(dir);
            Directory.CreateDirectory(dir);

            // 2. 清掉旧的程序文件。只清我们自己放的东西，安装目录里别的不碰
            Installation.DeleteWithRetry(Path.Combine(dir, "app"));
            Installation.DeleteWithRetry(Path.Combine(dir, "node"));
            Installation.DeleteWithRetry(Path.Combine(dir, "runtimes"));
            foreach (var file in Directory.GetFiles(dir))
            {
                var name = Path.GetFileName(file).ToLowerInvariant();
                if (name.EndsWith(".exe") || name.EndsWith(".dll") || name.EndsWith(".config")) DeleteFileWithRetry(file);
            }

            // 3. 解出新的
            var root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            {
                if (stream == null) throw new InvalidOperationException("安装包损坏：里面没有程序文件");
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
                {
                    foreach (var entry in zip.Entries)
                    {
                        var target = Path.GetFullPath(Path.Combine(dir, entry.FullName.Replace('/', '\\')));
                        // 防「../」跑出安装目录（安装包是自己打的，多一道防线而已）
                        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;

                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(target);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        entry.ExtractToFile(target, true);
                    }
                }
            }

            var exe = Path.Combine(dir, "apiloop.exe");
            if (!File.Exists(exe)) throw new InvalidOperationException("安装包损坏：缺少 apiloop.exe");

            // 4. 自启动、快捷方式、卸载入口
            Installation.Register(dir, Version, firstInstall);

            // 5. 拉起网关守护和窗口
            Process.Start(new ProcessStartInfo(exe, "--gateway") { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = dir });
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = dir });
        }

        private static void DeleteFileWithRetry(string file)
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    File.Delete(file);
                    return;
                }
                catch when (attempt < 9)
                {
                    System.Threading.Thread.Sleep(500);
                }
            }
        }
    }

    /// <summary>第一次安装时那个小窗口：一行字 + 一根走马灯进度条</summary>
    internal sealed class ProgressForm : Form
    {
        public ProgressForm()
        {
            Text = "安装 apiloop";
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetExecutingAssembly().Location); } catch { }
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(420, 110);
            Font = new Font("Microsoft YaHei UI", 9F);

            var label = new Label
            {
                Text = "正在安装 apiloop，装好后会自动打开……",
                AutoSize = false,
                Location = new Point(24, 24),
                Size = new Size(372, 24)
            };
            var bar = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 30,
                Location = new Point(24, 60),
                Size = new Size(372, 18)
            };
            Controls.Add(label);
            Controls.Add(bar);
        }
    }
}
