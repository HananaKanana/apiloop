/**
 * 英文翻译：网关与同步（第十六轮）。
 *
 * 键是中文原文（见 `lib/i18n/index.js`）。这一块的消息基本都出现在**状态栏 / 同步提示**
 * 里，语气要像在跟用户解释「刚才发生了什么」，而不是系统日志。
 */

module.exports = {
    /* ---------------- 登录 / 注册 / 转发 ---------------- */
    '连不上云端，登录需要联网。不登录也可以继续在本机使用':
        'Cannot reach the cloud; signing in needs a network. You can keep using the local copy without signing in',
    '连不上云端，注册需要联网': 'Cannot reach the cloud; signing up needs a network',
    '连不上云端，稍后再试': 'Cannot reach the cloud; try again later',
    '云端返回的登录结果看不懂': 'The cloud sent a sign-in result that cannot be read',
    '登录成功了，但本机数据切换失败：{reason}': 'Signed in, but switching the local data failed: {reason}',
    '云端地址不合法：{url}': 'Invalid cloud address: {url}',
    '云端响应超时': 'The cloud response timed out',
    '已取消': 'Cancelled',
    '连不上云端（{url}）：{reason}': 'Cannot reach the cloud ({url}): {reason}',
    '已经是最新版本（{version}）': 'Already on the latest version ({version})',
    '本机数据打不开，请重试或重新安装': 'The local data cannot be opened; try again or reinstall',

    /* ---------------- 安全闸门（网关只接受本机页面的请求） ---------------- */
    '网关不接受跨域预检请求': 'The gateway does not accept CORS preflight requests',
    'Host 不合法：只接受 127.0.0.1:{port} 或 localhost:{port}':
        'Invalid Host: only 127.0.0.1:{port} or localhost:{port} is accepted',
    '不允许跨站请求': 'Cross-site requests are not allowed',
    'Origin 不合法：只接受网关自己的地址': 'Invalid Origin: only the gateway’s own address is accepted',
    '缺少请求头 X-Apiloop: 1': 'Missing the X-Apiloop: 1 header',

    /* ---------------- 冲突处理 ---------------- */
    '缺少 entity / id': 'Missing entity / id',
    'choice 只能是 mine / theirs / copy': 'choice can only be mine / theirs / copy',
    '这条冲突已经处理过了': 'This conflict has already been handled',
    '只有接口能另存为副本': 'Only an API can be saved as a copy',
    '本机已经没有这一行了': 'That row is gone from this machine',

    /* ---------------- 同步状态 ---------------- */
    '登录已过期': 'Your session expired',
    '需要重新下载': 'Needs a full re-download',
    '同步出错：{reason}': 'Sync failed: {reason}',
    '太久没有同步，需要重新下载': 'It has been too long since the last sync; a full re-download is needed',
    '一次最多推送 {max} 条，收到 {got} 条': 'At most {max} rows can be pushed at a time, got {got}',
    '每条必须是一个对象': 'Every entry must be an object',
    '未知的实体类型：{entity}': 'Unknown entity type: {entity}',
    '这个{label}不属于它声称的项目': 'This {label} does not belong to the project it claims',
    '找不到它属于哪个项目': 'Cannot tell which project it belongs to',
    '父目录不存在：{id}': 'Parent folder not found: {id}',
    '父目录不属于这个项目': 'The parent folder is not part of this project',
    '目录不存在：{id}': 'Folder not found: {id}',
    '目录不属于这个项目': 'The folder is not part of this project',
    '接口不存在：{id}': 'API not found: {id}',
    '示例不存在：{id}': 'Example not found: {id}',
    '这个示例不属于该接口': 'That example does not belong to this API',

    /* ---------------- 同步提示（状态栏里那几句） ---------------- */
    '有 {n} 行没能应用，已跳过（第一条：{first}）': '{n} rows could not be applied and were skipped (first: {first})',
    '{label} {id}，{reason}': '{label} {id}: {reason}',
    '本机自动建的空项目「{name}」没用过，账号里已经有项目了，已经去掉':
        'The empty project “{name}” that was created automatically was never used and has been removed, since the account already has projects',
    '项目「{name}」已不能访问，{n} 项本机修改没能同步': 'Project “{name}” is no longer accessible; {n} local changes could not be synced',
    '项目「{name}」已不能访问，已从本机删除': 'Project “{name}” is no longer accessible and has been removed from this machine',
    '升级后补下载了 {n} 条{labels}（以前的版本不认识它们）': 'After the upgrade, {n} more {labels} were downloaded (older versions did not know about them)',
    '、': ', ',
    '云端一直说还有更多变更，这一轮先停在第 {n} 条': 'The cloud keeps saying there are more changes; this round stopped at {n}',
    '你删掉的这个{label}云端已经改过，按云端的样子恢复了': 'This {label} that you deleted was changed in the cloud, so it was restored from the cloud version',
    '云端删掉过这个{label}，本机改过的版本已经重新建出来': 'This {label} was deleted in the cloud; your edited version has been created again',
    '{label} {id}：{reason}': '{label} {id}: {reason}',
    '云端拒绝了这一行': 'the cloud rejected this row',
    '「{name}」和云端改到了同一处，等你选一下': '“{name}” and the cloud changed the same fields; pick one',
    '「{name}」两边改的字段不一样，已经自动合并，马上推上去': '“{name}” was changed differently on both sides; it was merged automatically and will be pushed right away',
    '「{name}」两边改的字段不一样，已经自动合并，下一轮推上去': '“{name}” was changed differently on both sides; it was merged automatically and will be pushed next round',
    '你在项目「{name}」里是只读成员，修改没有保存到云端': 'You are a read-only member of project “{name}”, so the change was not saved to the cloud',
    '云端已经没有这个账号的同步记录了，已经重新下载了一遍；': 'The cloud no longer has sync records for this account, so everything was downloaded again; ',
    '本机没同步的 {n} 行也留下来了，下一轮推上去': '{n} unsynced rows on this machine were kept and will be pushed next round',
    '本机没有待同步的修改': 'There were no local changes waiting to be synced',
    '；本机删掉但还没同步的 {n} 项恢复了，需要的话请再删一次': '; {n} items deleted locally but not yet synced were restored — delete them again if you meant to',

    /* ---------------- 一键更新 ---------------- */
    '这个系统还不支持自动更新，请手动下载安装包': 'This system does not support automatic updates; download the installer yourself',
    '没有云端地址，没法下载新版本': 'There is no cloud address, so the new version cannot be downloaded',
    '建不了下载目录 {dir}：{reason}': 'Cannot create the download folder {dir}: {reason}',
    '云端还没有放 {version} 版的安装包（{name}），请联系管理员':
        'The cloud does not have the installer for version {version} ({name}) yet; ask your administrator',
    '下载失败：云端返回 {status}': 'Download failed: the cloud returned {status}',
    '下载中断：{reason}': 'The download was interrupted: {reason}',
    '写不进下载目录：{reason}': 'Cannot write to the download folder: {reason}',
    '下载不完整（{received} / {total} 字节），请重试': 'The download is incomplete ({received} / {total} bytes); try again',
    '下载好了但存不下来：{reason}': 'The download finished but cannot be saved: {reason}',
    '超过 {n} 秒没有收到数据': 'No data received for {n} seconds',
    '连不上云端：{reason}': 'Cannot reach the cloud: {reason}',
    '打不开安装程序：{reason}': 'Cannot open the installer: {reason}',
    '。可能被杀毒软件锁住了，请稍后再点一次，或手动运行 {file}':
        '. Antivirus software may be holding the file; click again in a moment, or run {file} yourself',
    '处理失败': 'Processing failed',
    '本机 Mock 里没有匹配的接口：{method} {path}': 'No API in the local Mock matches {method} {path}'
};
