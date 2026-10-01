-- apiloop 启动器。
--
-- 它只做一件事：读 ~/.apiloop/gateway.port（读不到就用默认的 47321），
-- 然后用默认浏览器打开 http://127.0.0.1:<端口>/。
--
-- **刻意不发任何网络请求**：真正访问内网的是后台那个官方 Node 进程。
-- 这个 .app 连签名都不需要，也就不必为它去申请开发者证书。

on run
	set portFile to (POSIX path of (path to home folder)) & ".apiloop/gateway.port"
	set thePort to readPort(portFile)

	open location "http://127.0.0.1:" & thePort & "/"
end run

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
