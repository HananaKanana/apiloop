var path = require('path');
var bodyParser = require('body-parser');
var express = require('express');
var fs = require('fs');
var pwd = process.cwd();
var filecopy = require('filecopy');
var chalk = require('chalk');
var open = require('open');

var storeModule = require('./routes-store');
var runtimeModule = require('./mock-runtime');
var adminModule = require('./admin');
var pkg = require('../package.json');

var app;
var server;
var port;
var tpl;
var viewsPath;
var publicPath;
var configFile;
var mode;

var success = chalk.gray.bgGreen('Success');
var warning = chalk.gray.bgYellow('Warning');
var error = chalk.white.bgRed('Error');

function command(opts) {
	var args = opts.args || {};
	var name = args['$0'] || 'mock';

	if (opts.command === 'start' || opts.command === 'open' || opts.command === 'web') {
		startServer(opts.command, args, name);
	} else if (opts.command === 'init') {
		initSample(name);
	}
}

/**
 * 读取接口配置；库文件打不开等异常都不影响服务启动
 * @returns {object} routes-store 实例
 */
function loadRouteStore() {
	var store = storeModule.createStore({ file: configFile });

	// 监听器要先挂上。EventEmitter 在没有 error 监听器时 emit('error') 会把进程
	// 直接抛掉，而 startWatching 之后文件事件随时可能来。
	store.on('error', function (err) {
		console.log(warning + ': ' + path.basename(configFile) + ' 监听异常：' + err.message);
	});

	try {
		store.load();
	} catch (err) {
		console.log(warning + ': ' + path.basename(configFile) + ' 读取失败，已按空配置启动：' + err.message);
	}

	// 首次启动时如果旁边有旧的 routes.json，store 会自动导入，这里把结果说清楚
	var migrated = store.getMigratedFrom();
	if (migrated) {
		console.log(success + ': 已把旧配置 ' + path.basename(migrated) + ' 导入到 ' +
			path.basename(configFile) + chalk.gray('（原文件保留，可自行删除）'));
	}
	store.getMigrationWarnings().forEach(function (message) {
		console.log(warning + ': ' + message);
	});

	store.startWatching();
	return store;
}

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

function startServer(commandName, args, name) {
	mode = commandName;
	port = args.port || 8080;
	tpl = args.tpl || 'ejs';
	viewsPath = args.views ? path.join(pwd, args.views) : pwd;
	publicPath = args.public ? path.join(pwd, args.public) : pwd;
	configFile = path.resolve(pwd, args.config || storeModule.DEFAULT_FILE);

	var store = loadRouteStore();

	app = express();
	app.use(bodyParser.json());
	app.use(bodyParser.urlencoded({ extended: true }));

	if (mode === 'web') {
		var admin = adminModule.createAdmin({ store: store, version: pkg.version });
		app.use(admin.apiPath, admin.api);
		// 管理台就是默认界面：根路径下放一份静态资源，/index.html 直接打开管理台
		app.use(admin.rootStatic);
		// 访问根路径自动跳到管理台。
		// 注册在这里而不是最后，是为了先于 routes.json / router.js 生效——否则使用者
		// 只要配了一条 ALL /* 之类的兜底路由，入口就会被吃掉、跳转再也走不到。
		app.get('/', function (req, res) {
			res.redirect(302, admin.defaultPage);
		});
	}

	// routes.json 先注册；它没匹配上的请求再交给 router.js
	app.use(runtimeModule.createRuntime(store).middleware);
	var hasRouterFile = mountRouterFile();

	app.use(express.static(publicPath));
	app.set('views', viewsPath);
	app.set('view engine', tpl);

	server = app.listen(port);
	server.on('error', function (err) {
		if (err.code === 'EADDRINUSE') {
			console.log(error + ': 端口 ' + port + ' 已被占用，换个端口试试：' +
				chalk.bold.green(name + ' ' + mode + ' --port ' + (port + 1)));
		} else {
			console.log(error + ': ' + err.message);
		}
		process.exit(1);
	});

	var enabled = store.getRoutes().filter(function (route) { return route.enabled; }).length;
	var base = 'http://localhost:' + port;

	if (enabled > 0 || hasRouterFile) {
		var detail = [];
		if (enabled > 0) detail.push(chalk.bold(enabled) + ' 条来自 ' + path.basename(configFile));
		if (hasRouterFile) detail.push('router.js');
		console.log(chalk.gray('已加载 mock 路由：') + detail.join(' + '));
	} else {
		console.log(warning + ': 还没有任何 mock 路由，运行 ' + chalk.bold.green(name + ' init') +
			' 生成示例，或 ' + chalk.bold.green(name + ' web') + ' 打开可视化管理台');
	}

	if (mode === 'web') {
		console.log(success + ': 管理台已启动 ' + chalk.underline.yellow(base + adminModule.DEFAULT_PAGE) +
			chalk.gray('（访问 ' + base + ' 会自动跳转）'));
		console.log(chalk.gray('配置源：') + configFile);
	} else if (mode === 'open') {
		var htmlFiles = fs.readdirSync(path.resolve(pwd)).filter(function (file) {
			return /.html$/.test(file);
		});
		if (htmlFiles.length > 0) {
			var url = base + (htmlFiles.indexOf('index.html') > -1 ? '' : '/' + htmlFiles[0]);
			open(url);
		}
	}

	console.log(success + ': server start success, open the link ' + chalk.underline.yellow(base) + ' in browser');
	if (mode !== 'web' && enabled === 0 && !hasRouterFile) {
		console.log(chalk.gray('提示：' + name + ' web 可以在浏览器里配置接口'));
	}
}

function initSample(name) {
	filecopy(path.join(__dirname, '../sample/*'), process.cwd(), {}, function (err) {
		if (err) {
			console.log(error + ': 示例文件创建失败：' + (err.message || err));
			return;
		}
		console.log('Init sample files success, run ' + chalk.bold.green(name + ' start') + ' to start server');
		seedSampleRoutes(name);
	});
}

/**
 * 往库里灌一份示例接口，让管理台打开就有东西可看。
 * 库里已经有接口就不动它 —— init 是初始化，不是重置。
 */
function seedSampleRoutes(name) {
	var target = path.resolve(pwd, storeModule.DEFAULT_FILE);
	var store = storeModule.createStore({ file: target });

	try {
		store.load();
	} catch (loadError) {
		console.log(warning + ': 示例数据初始化失败：' + loadError.message);
		return;
	}

	if (store.getRoutes().length > 0) {
		console.log(chalk.gray('已存在 ' + path.basename(target) + ' 且其中有接口，未覆盖'));
		store.close();
		return;
	}

	store.replaceAll(storeModule.createSampleRoutes().routes);
	store.close();
	console.log('已生成示例接口数据 ' + chalk.bold(path.basename(target)) +
		'，运行 ' + chalk.bold.green(name + ' web') + ' 打开可视化管理台');
}

module.exports = command;
