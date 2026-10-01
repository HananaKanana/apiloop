-- apiloop 启动器。
--
-- 它做两件事：网关没在运行就先拉起来；然后读 ~/.apiloop/gateway.port（读不到就用默认的 47321），
-- 然后用默认浏览器打开 http://127.0.0.1:<端口>/。
--
-- **刻意不发任何网络请求**：真正访问内网的是后台那个官方 Node 进程。
-- 这个 .app 连签名都不需要，也就不必为它去申请开发者证书。

on run
	set portFile to (POSIX path of (path to home folder)) & ".apiloop/gateway.port"
	ensureGateway(portFile)
	set thePort to readPort(portFile)

	open location "http://127.0.0.1:" & thePort & "/"
end run

-- 网关没在 launchd 里（比如覆盖安装时 bootstrap 没成功、用户手动 bootout 过），
-- 就替用户拉起来，再等它写出端口文件，最多等 5 秒。
-- 网关进程是 launchd 按 plist 启动的，不是这个启动器的子进程，所以本地网络权限照样归官方 Node。
on ensureGateway(portFile)
	set script_ to "uid=$(id -u); svc=gui/$uid/com.apiloop.gateway; " & ¬
		"if ! launchctl print $svc >/dev/null 2>&1; then " & ¬
		"rm -f " & quoted form of portFile & "; " & ¬
		"launchctl bootstrap gui/$uid /Library/LaunchAgents/com.apiloop.gateway.plist >/dev/null 2>&1; " & ¬
		"for i in 1 2 3 4 5 6 7 8 9 10; do [ -f " & quoted form of portFile & " ] && break; sleep 0.5; done; " & ¬
		"fi; true"
	try
		do shell script script_
	end try
end ensureGateway

-- 端口文件里只有一行数字。读不到、读出来不是数字，都退回 47321。
on readPort(portFile)
	set fallback to "47321"
	try
		set rawText to do shell script "cat " & quoted form of portFile & " 2>/dev/null || true"
		-- 只留数字：文件末尾可能有换行，将来也可能被别的工具写脏
		set digits to do shell script "printf %s " & quoted form of rawText & " | tr -dc '0-9'"
	on error
		return fallback
	end try

	if digits is "" then return fallback
	return digits
end readPort
