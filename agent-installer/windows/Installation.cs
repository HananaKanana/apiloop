// 安装程序（setup）和 apiloop.exe --uninstall 共用的那部分：退掉正在运行的 apiloop、
// 登记 / 撤销开机自启动、快捷方式、「设置 → 应用」里的卸载入口。
//
// 全部装在当前用户名下（HKCU、用户自己的开始菜单和桌面），不需要管理员权限。

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using Microsoft.Win32;

namespace Apiloop
{
    internal static class Installation
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunValue = "apiloop";
        private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\apiloop";

        /// <summary>默认安装目录：%LOCALAPPDATA%\Programs\apiloop（和 VS Code 用户版一样的位置）</summary>
        public static string DefaultDir =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "apiloop");

        private static string StartMenuLink =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "apiloop.lnk");

        private static string DesktopLink =>
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "apiloop.lnk");

        /// <summary>
        /// 退掉安装目录里正在运行的所有程序（窗口、网关守护、node 网关），
        /// 当前进程除外。不退的话文件被占着，换不了。
        /// </summary>
        public static void StopRunning(string dir)
        {
            var root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
            var self = Process.GetCurrentProcess().Id;

            foreach (var process in Process.GetProcesses())
            {
                try
                {
                    if (process.Id == self) continue;
                    var name = process.ProcessName.ToLowerInvariant();
                    if (name != "apiloop" && name != "node") continue;
                    var file = process.MainModule?.FileName;
                    if (file == null || !file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) continue;
                    process.Kill();
                    process.WaitForExit(5000);
                }
                catch
                {
                    // 别的用户的进程、刚好退出了：跳过
                }
                finally
                {
                    process.Dispose();
                }
            }
        }

        /// <summary>开机自启动 + 卸载入口 + 快捷方式（桌面快捷方式只在第一次安装时建，用户删了就不再加回来）</summary>
        public static void Register(string dir, string version, bool firstInstall)
        {
            var exe = Path.Combine(dir, "apiloop.exe");

            using (var run = Registry.CurrentUser.CreateSubKey(RunKey))
            {
                run.SetValue(RunValue, "\"" + exe + "\" --gateway");
            }

            using (var key = Registry.CurrentUser.CreateSubKey(UninstallKey))
            {
                key.SetValue("DisplayName", "apiloop");
                key.SetValue("DisplayVersion", version);
                key.SetValue("Publisher", "apiloop");
                key.SetValue("DisplayIcon", exe);
                key.SetValue("InstallLocation", dir);
                key.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
                key.SetValue("QuietUninstallString", "\"" + exe + "\" --uninstall --quiet");
                key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                key.SetValue("EstimatedSize", (int)(DirectorySize(dir) / 1024), RegistryValueKind.DWord);
            }

            CreateShortcut(StartMenuLink, exe, dir);
            if (firstInstall) CreateShortcut(DesktopLink, exe, dir);
        }

        public static void Unregister()
        {
            try
            {
                using (var run = Registry.CurrentUser.OpenSubKey(RunKey, true)) run?.DeleteValue(RunValue, false);
            }
            catch { }
            try { Registry.CurrentUser.DeleteSubKeyTree(UninstallKey, false); } catch { }
            try { File.Delete(StartMenuLink); } catch { }
            try { File.Delete(DesktopLink); } catch { }
        }

        /// <summary>有没有装过（决定要不要建桌面快捷方式）</summary>
        public static bool IsInstalled()
        {
            using (var key = Registry.CurrentUser.OpenSubKey(UninstallKey)) return key != null;
        }

        /// <summary>用系统自带的 WScript.Shell 建 .lnk（反射调用，不用额外引用）</summary>
        private static void CreateShortcut(string link, string target, string workingDir)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(link));
                var type = Type.GetTypeFromProgID("WScript.Shell");
                var shell = Activator.CreateInstance(type);
                var shortcut = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
                var shortcutType = shortcut.GetType();
                shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { target });
                shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
                shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { target + ",0" });
                shortcutType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { "apiloop" });
                shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch
            {
                // 建不了快捷方式不影响使用
            }
        }

        private static long DirectorySize(string dir)
        {
            try
            {
                return new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories).Sum(file => file.Length);
            }
            catch
            {
                return 0;
            }
        }

        /// <summary>删目录，被占着时重试几次（刚退掉的进程可能还没完全放手）</summary>
        public static void DeleteWithRetry(string path)
        {
            for (var attempt = 0; attempt < 10; attempt++)
            {
                try
                {
                    if (Directory.Exists(path)) Directory.Delete(path, true);
                    return;
                }
                catch when (attempt < 9)
                {
                    Thread.Sleep(500);
                }
            }
        }
    }
}
