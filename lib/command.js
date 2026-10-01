/**
 * CLI 命令实现：start / open / web / init / user。
 *
 * 启动顺序是固定的，顺序错了会出难查的问题：
 *   解析库路径 → 开库 → 建初始管理员 → 确定根项目 → 挂管理台与 mock → 轮询 → 监听。
 * 比如管理员必须早于管理台挂载，否则第一个请求进来时 users 表还是空的。
 */

var path = require('path');
var bodyParser = require('body-parser');
var express = require('express');
var fs = require('fs');
var pwd = process.cwd();
var filecopy = require('filecopy');
var chalk = require('chalk');
var open = require('open');

var appInfo = require('./app-info');
var db = require('./db');
var auth = require('./auth');
var access = require('./access');
var adminModule = require('./admin');
var mockHostModule = require('./mock-host');
var mockWsModule = require('./mock-ws');
var storeModule = require('./routes-store');
var projectStores = require('./project-stores');
var projectsRepo = require('./db/repos/projects');
var usersRepo = require('./db/repos/users');
var sessionsRepo = require('./db/repos/sessions');
var legacyImport = require('./legacy-import');
var pkg = require('../package.json');

var USERNAME_PATTERN = /^[a-zA-Z0-9_.-]{2,32}$/;

var app;
var server;
var handle;

var success = chalk.gray.bgGreen('Success');
var warning = chalk.gray.bgYellow('Warning');
var error = chalk.white.bgRed('Error');

function command(opts) {
	var args = opts.args || {};
	var name = args['$0'] || appInfo.APP_NAME;

	if (opts.command === 'start' || opts.command === 'open' || opts.command === 'web') {
		startServer(opts.command, args, name);
	} else if (opts.command === 'gateway') {
		startGateway(args);
	} else if (opts.command === 'init') {
		initSample(name, args);
	} else if (opts.command === 'user') {
		runUserCommand(args, name);
	}
}

/* ------------------------------------------------------------ 库路径 */

/** 优先级：--db 参数 > 环境变量 > 默认值 */
function resolveDbPath(args) {
	var fromArgs = args && args.db;
	if (fromArgs) return path.resolve(pwd, String(fromArgs));

	var fromEnv = process.env[appInfo.ENV_DB];
	if (fromEnv) return path.resolve(pwd, String(fromEnv));

	return appInfo.DEFAULT_DB;
}

/* ------------------------------------------------------------ 兼容老的 router.js */

/**
 * 兼容老的 router.js：读出来包成 setRouter 再注册
 */
function mountRouterFile() {
	var routerFile = path.join(pwd, 'router.js');
	var hiddenRouterFile = path.join(pwd, '.router.js');

	if (!fs.existsSync(routerFile)) {
		return false;
	}

	var userRouterStr = fs.readFileSync(routerFile, 'utf-8');
	// router.js 里应该只写路由（形如 router.get(...)），包装由本工具负责。
	// 但如果它已经被包装过（例如把生成的 .router.js 内容复制回了 router.js），
	// 就不能再包一层：两层 setRouter 会让外层函数体只剩一个「只声明、从不调用」的内层函数，
	// 结果是 app.listen 照常执行、服务能起来，但一条路由都没注册，接口全部 404。
	var wrapped = /module\.exports\.setRouter/.test(userRouterStr);
	if (wrapped) {
		console.log(warning + ': router.js 看起来已经包含 setRouter 包装，将按原样使用。请确认 router.js 里只写路由');
	}
	var routerStr = wrapped
		? userRouterStr
		: 'function setRouter(app){ \n var router = app; \n\n' + userRouterStr + '}\n module.exports.setRouter = setRouter';
	fs.writeFileSync(hiddenRouterFile, routerStr);
	require(hiddenRouterFile).setRouter(app);
	return true;
}

/* ------------------------------------------------------------ 确定根项目 */

/**
 * 根项目就是挂在根路径（而不是 /mock-<项目ID>）的那个项目，作用是兼容老用法 ——
 * 老用户把接口配在 /api/xxx 下，升级后不该改 URL。
 *
 * @param {string|null} ownerId 建出来的项目要写上谁当 owner（最早创建的 admin）。
 *   还没有任何用户时是 null，启动流程后面会用 fillMissingOwners 补。
 */
function resolveRootProject(args, name, ownerId) {
	if (args.project) {
		var wanted = projectsRepo.getBySlug(handle, String(args.project));
		if (!wanted) {
			// 括号不能省：`a + b || c` 会先算 `a + b`，`||` 永远拿不到左边的空串
			var slugs = projectsRepo.list(handle).map(function (item) { return item.slug; }).join(', ');
			console.log(error + ': 找不到项目 ' + chalk.bold(String(args.project)) +
				'，现有项目：' + (slugs || '（一个都没有）'));
			process.exit(1);
		}
		return wanted;
	}

	// 当前目录有旧配置就导入成一个项目。导入是原子的：中途出错整体回滚，
	// 这里只负责把错误说清楚，然后按「没有旧配置」继续启动。
	var imported = null;
	try {
		imported = legacyImport.importLegacyDir(handle, pwd,
			args.config ? { file: args.config, userId: ownerId } : { userId: ownerId });
	} catch (err) {
		console.log(error + ': 导入旧配置失败，已跳过：' + err.message);
		console.log(chalk.gray('  （原文件没有改动，改好之后重启会自动重试）'));
	}

	if (imported && imported.project) {
		imported.warnings.forEach(function (message) {
			console.log(warning + ': ' + message);
		});
		if (imported.importedFrom) {
			console.log(success + ': 已把 ' + path.basename(imported.importedFrom) + ' 导入为项目 ' +
				chalk.bold(imported.project.name) + chalk.gray('（/mock-' + imported.project.id + '，原文件保留）'));
		}
		return imported.project;
	}

	var existing = projectsRepo.getDefault(handle);
	if (existing) return existing;

	var created = handle.transaction(function () {
		var project = projectsRepo.create(handle, {
			name: '默认项目',
			slug: 'default',
			is_default: true,
			created_by: ownerId || null
		});
		access.addOwner(handle, project.id, ownerId);
		return project;
	});
	console.log(chalk.gray('已创建默认项目：' + created.name + '（/mock-' + created.id + '）'));
	return created;
}

/* ------------------------------------------------------------ 启动 */

function startServer(commandName, args, name) {
	var mode = commandName;
	var port = args.port || 8080;
	var host = args.host || '127.0.0.1';
	var tpl = args.tpl || 'ejs';
	var viewsPath = args.views ? path.join(pwd, args.views) : pwd;
	var publicPath = args.public ? path.join(pwd, args.public) : pwd;
	var dbPath = resolveDbPath(args);

	try {
		handle = db.open(dbPath);
	} catch (err) {
		console.log(error + ': 打开数据库失败：' + err.message);
		process.exit(1);
	}

	// 初始管理员必须早于任何请求处理
	var bootstrapped = auth.bootstrapAdmin(handle);
	if (bootstrapped) {
		console.log(success + ': 已创建管理员 ' + chalk.bold(bootstrapped.username) +
			'，初始密码：' + chalk.bold.yellow(bootstrapped.password));
		console.log(chalk.gray('  （只显示这一次，登录后请尽快修改）'));
	}

	// 「仅成员可见」上线后，一个 owner 都没有的项目谁都管不了。
	// 项目可能在还没有任何用户的时候就建出来了（`init` 就是这种顺序），
	// 所以这里用最早创建的 admin 兜一次。
	var firstAdmin = usersRepo.firstAdmin(handle);
	var ownerId = firstAdmin ? firstAdmin.id : null;

	var rootProject = resolveRootProject(args, name, ownerId);

	var repaired = access.fillMissingOwners(handle, ownerId);
	if (repaired > 0) {
		console.log(chalk.gray('已把 ' + repaired + ' 个没有成员的项目交给 ' + firstAdmin.username + ' 管理'));
	}

	var store = projectStores.get(handle, rootProject.id);

	app = express();

	if (mode === 'web') {
		var admin = adminModule.createAdmin({
			handle: handle,
			store: store,
			version: pkg.version,
			// 新接口要知道哪个项目挂在根路径（/meta 的 rootProject、删项目的校验都用它）
			rootProjectId: rootProject.id
		});
		app.use(admin.apiPath, admin.api);
		// 安装包下载。单独一条前缀，**在 requireLogin 之前挂**（它就是给人直接下安装包的，
		// 链接要能转发给同事）。必须排在下面的 rootStatic 之前，否则会被静态资源兜成 404。
		app.use(admin.downloadsPath, admin.downloads);
		// 管理台就是默认界面：根路径下放一份静态资源，/index.html 直接打开管理台
		app.use(admin.rootStatic);
		// 访问根路径自动跳到管理台。
		// 注册在这里而不是最后，是为了先于 routes / router.js 生效——否则使用者
		// 只要配了一条 ALL /* 之类的兜底路由，入口就会被吃掉、跳转再也走不到。
		app.get('/', function (req, res) {
			res.redirect(302, admin.defaultPage);
		});
	}

	// body 解析放在管理台之后：它只该对 mock 接口和 router.js 生效。
	// 管理台自己挂了 express.json({ limit: '4mb' })，如果这两行在前面执行，
	// 默认 100KB 的上限会先生效，导入大一点的 OpenAPI 直接 413。
	app.use(bodyParser.json());
	app.use(bodyParser.urlencoded({ extended: true }));

	// mock-host 要留一个引用：WebSocket 的 mock 服务端要靠它按地址找项目，
	// 两边的项目解析规则必须一致（见 mock-host 的 resolve）
	var mockHost = mockHostModule.createMockHost(handle, { rootProjectId: rootProject.id });
	app.use(mockHost.middleware);
	var hasRouterFile = mountRouterFile();

	app.use(express.static(publicPath));
	app.set('views', viewsPath);
	app.set('view engine', tpl);

	server = app.listen(port, host);

	/**
	 * WebSocket 的 mock 服务端（契约第 17 节）：以 `noServer` 模式挂在同一个 HTTP 服务器的
	 * `upgrade` 事件上。没挂这个监听时 Node 会直接把 upgrade 的 socket 销毁，
	 * 所以「WS 接口连不上」时先看这里。
	 */
	var mockWs = mockWsModule.createMockWs({
		handle: handle,
		mockHost: mockHost,
		rootProjectId: rootProject.id
	});
	server.on('upgrade', mockWs.handleUpgrade);
	server.on('close', function () { mockWs.closeAll(); });

	server.on('error', function (err) {
		if (err.code === 'EADDRINUSE') {
			console.log(error + ': 端口 ' + port + ' 已被占用，换个端口试试：' +
				chalk.bold.green(name + ' ' + mode + ' --port ' + (port + 1)));
		} else {
			console.log(error + ': ' + err.message);
		}
		process.exit(1);
	});

	handle.startPolling();

	var enabled = store.getRoutes().filter(function (route) { return route.enabled; }).length;
	var base = 'http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port;

	if (enabled > 0 || hasRouterFile) {
		var detail = [];
		if (enabled > 0) detail.push(chalk.bold(enabled) + ' 条来自项目「' + rootProject.name + '」');
		if (hasRouterFile) detail.push('router.js');
		console.log(chalk.gray('已加载 mock 路由：') + detail.join(' + '));
	} else {
		console.log(warning + ': 这个项目还没有任何 mock 路由，运行 ' + chalk.bold.green(name + ' web') +
			' 打开可视化管理台新建接口');
	}

	if (mode === 'web') {
		console.log(success + ': 管理台已启动 ' + chalk.underline.yellow(base + adminModule.DEFAULT_PAGE) +
			chalk.gray('（访问 ' + base + ' 会自动跳转）'));
	} else if (mode === 'open') {
		var htmlFiles = fs.readdirSync(path.resolve(pwd)).filter(function (file) {
			return /.html$/.test(file);
		});
		if (htmlFiles.length > 0) {
			var url = base + (htmlFiles.indexOf('index.html') > -1 ? '' : '/' + htmlFiles[0]);
			open(url);
		}
	}

	console.log(chalk.gray('根项目：') + rootProject.name + chalk.gray('（挂在 ' + base + '）') +
		chalk.gray('  其他项目挂在 /mock-<项目ID>'));
	console.log(chalk.gray('数据库：') + dbPath);

	if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
		console.log(warning + ': 正在监听 ' + host + '，局域网内可访问，请确认账号密码强度');
	}

	console.log(success + ': ' + appInfo.APP_NAME + ' start success, open the link ' + chalk.underline.yellow(base) + ' in browser');
}

/* ------------------------------------------------------------ 网关 */

/**
 * 本地网关（设计稿 `2026-10-01-local-agent.md` 第 3 节）。
 *
 * 和 `web` 是同一套代码的另一种运行模式：页面照样由本机提供，但管理台接口转发给云端，
 * 发请求在本机执行 —— Mac 上正是靠「官方 Node 进程来发」才拿得到本地网络授权。
 *
 * 这里**不开库**：数据还在云端，本地只存一个云端地址和实际用的端口。
 *
 * 日志由网关自己写到用户家目录（G0 审阅 N4）：交给 launchd 的 StandardOutPath 时，
 * 多用户共用一个 /tmp 路径会打不开、网关根本起不来。所以**先把日志挂上**再起服务，
 * 这样启动阶段（端口被占、云端地址不合法）的报错也留得下痕迹。
 */
function startGateway(args) {
	var gateway = require('./gateway');

	var logState = gateway.installGatewayLog(args.logFile);
	var logLine = function (line) {
		logState.write(line + '\n');
	};

	if (logState.file) {
		console.log(chalk.gray('日志文件：') + logState.file);
	}

	gateway.createGateway({
		cloudUrl: args.cloud,
		port: args.port,
		log: logLine
	}).then(function (instance) {
		var base = 'http://127.0.0.1:' + instance.port;

		console.log(success + ': ' + appInfo.APP_NAME + ' gateway 已启动 ' + chalk.underline.yellow(base));
		console.log(chalk.gray('数据目录：') + instance.dataDir);
		console.log(chalk.gray('端口文件：') + path.join(instance.dataDir, 'gateway.port'));

		if (instance.cloudUrl) {
			console.log(chalk.gray('云端地址：') + instance.cloudUrl);
		} else {
			console.log(warning + ': 还没有配置云端地址，打开上面的地址会看到设置页');
		}

		console.log(chalk.gray('只监听 127.0.0.1；管理台接口转发给云端，发请求在本机执行'));
	}).catch(function (err) {
		console.log(error + ': 网关启动失败：' + err.message);
		logState.close(function () { process.exit(1); });
	});
}

/* ------------------------------------------------------------ init */

function initSample(name, args) {
	filecopy(path.join(__dirname, '../sample/*'), process.cwd(), {}, function (err) {
		if (err) {
			console.log(error + ': 示例文件创建失败：' + (err.message || err));
			return;
		}
		console.log('Init sample files success, run ' + chalk.bold.green(name + ' start') + ' to start server');
		seedSampleRoutes(name, args);
	});
}

/**
 * 给「绑定到当前目录的项目」灌一份示例接口，让管理台打开就有东西可看。
 * 注意不再往 cwd 写 routes.db —— 库是全局一份的，这里只建项目。
 */
function seedSampleRoutes(name, args) {
	try {
		handle = db.open(resolveDbPath(args || {}));
	} catch (err) {
		console.log(warning + ': 数据库打不开，示例接口未生成：' + err.message);
		return;
	}

	var project = projectsRepo.getBySourceDir(handle, pwd);
	if (!project) {
		var owner = usersRepo.firstAdmin(handle);
		project = handle.transaction(function () {
			var created = projectsRepo.create(handle, {
				name: path.basename(pwd) || '默认项目',
				source_dir: pwd,
				created_by: owner ? owner.id : null
			});
			// init 先于 web 跑时库里还没有用户，这里就什么也不写；
			// 等 web 启动建出管理员之后，由 access.fillMissingOwners 补上
			access.addOwner(handle, created.id, owner ? owner.id : null);
			return created;
		});
	}

	var store = projectStores.get(handle, project.id);
	if (store.getRoutes().length > 0) {
		console.log(chalk.gray('项目「' + project.name + '」里已有接口，未覆盖'));
		handle.close();
		return;
	}

	store.replaceAll(storeModule.createSampleRoutes().routes);
	handle.close();
	console.log('已为项目「' + chalk.bold(project.name) + '」生成示例接口，运行 ' +
		chalk.bold.green(name + ' web') + ' 打开可视化管理台');
}

/* ------------------------------------------------------------ user 子命令 */

function runUserCommand(args, name) {
	var rest = (args._ || []).slice(1);
	var action = rest[0];
	var username = rest[1];

	var dbPath = resolveDbPath(args);
	try {
		handle = db.open(dbPath);
	} catch (err) {
		console.log(error + ': 打开数据库失败：' + err.message);
		process.exit(1);
	}

	if (action === 'list') return listUsers();
	if (action === 'add') return addUser(username, args);
	if (action === 'reset-password') return resetPassword(username);
	if (action === 'passwd') return resetPassword(username);

	console.log(error + ': 不认识的用法。可用：' + chalk.bold(name + ' user add <用户名> [--admin] [--password xx]') +
		'、' + chalk.bold(name + ' user list') + '、' + chalk.bold(name + ' user reset-password <用户名>'));
	process.exit(1);
}

function listUsers() {
	var users = usersRepo.list(handle);
	if (!users.length) {
		console.log(chalk.gray('还没有任何用户'));
	} else {
		users.forEach(function (user) {
			console.log([
				user.username + (user.role === 'admin' ? chalk.gray(' (admin)') : ''),
				user.disabled ? chalk.red('已禁用') : chalk.green('正常'),
				user.displayName || ''
			].join('  '));
		});
	}
	handle.close();
}

function addUser(username, args) {
	if (!username) {
		console.log(error + ': 请给出用户名，例如 ' + chalk.bold('user add alice'));
		process.exit(1);
	}
	// 和 /users 接口用同一套规则，否则命令行能建出管理台接口不认的用户名
	if (!USERNAME_PATTERN.test(String(username))) {
		console.log(error + ': 用户名只能用字母、数字、下划线、点、连字符，长度 2~32');
		process.exit(1);
	}
	if (usersRepo.getByUsername(handle, username)) {
		console.log(error + ': 用户名已存在：' + username);
		process.exit(1);
	}

	var password = args.password ? String(args.password) : auth.randomPassword(16);
	var user = handle.transaction(function () {
		return usersRepo.create(handle, {
			username: String(username),
			password_hash: auth.hashPassword(password),
			display_name: args.displayName ? String(args.displayName) : '',
			role: args.admin ? 'admin' : 'member',
			// 管理员替别人定的密码，第一次登录要先改掉
			must_change_password: true
		});
	});

	console.log(success + ': 已创建用户 ' + chalk.bold(user.username) +
		(user.role === 'admin' ? chalk.gray(' (admin)') : ''));
	console.log('密码：' + chalk.bold.yellow(password) + chalk.gray(args.password ? '' : '（随机生成，只显示这一次）'));
	handle.close();
}

function resetPassword(username) {
	if (!username) {
		console.log(error + ': 请给出用户名，例如 ' + chalk.bold('user reset-password alice'));
		process.exit(1);
	}

	var user = usersRepo.getByUsername(handle, username);
	if (!user) {
		console.log(error + ': 用户不存在：' + username);
		process.exit(1);
	}

	var password = auth.randomPassword(16);
	handle.transaction(function () {
		usersRepo.update(handle, user.id, { passwordHash: auth.hashPassword(password) });
		// 重置密码多半是因为怀疑密码泄露，旧会话必须一起失效 ——
		// 管理台接口里的重置就是这么做的，命令行版本不能漏。
		sessionsRepo.removeByUser(handle, user.id);
	});

	console.log(success + ': 已重置 ' + chalk.bold(user.username) + ' 的密码');
	console.log('新密码：' + chalk.bold.yellow(password) + chalk.gray('（只显示这一次）'));
	handle.close();
}

module.exports = command;
