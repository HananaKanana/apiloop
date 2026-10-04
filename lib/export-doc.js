/**
 * 导出接口文档（第九轮第 2 节）。
 *
 * 三件事分开：
 * 1. **取数据**：`buildDoc` 直接把分享文档页那份数据（`lib/api/shares.js` 的 `publicDoc`）
 *    拿来用 —— 内容和打码规则**必须**和分享页一模一样，两边各写一份迟早一个遮了一个没遮；
 * 2. **中间结构**：章节 → 接口 → 各块，三种格式共用这一份，不在渲染函数里读库；
 * 3. **渲染**：`renderMarkdown` / `renderHtml` / `renderDocx` 各一个纯函数。
 *
 * 打码不用管：`publicDoc` 出来的东西已经过 `maskJsonText` / `maskUrlQuery` /
 * `isSensitiveHeaderName` 了（密码、token、cookie 一律 `******`）。
 */

var shares = require('./api/shares');
var dto = require('./api/dto');
var apisRepo = require('./db/repos/apis');
var urlUtils = require('./url-utils');
var foldersRepo = require('./db/repos/folders');

var STATUS_LABELS = {
    designing: '设计中',
    developing: '开发中',
    done: '已完成',
    deprecated: '已废弃'
};

function str(value) {
    return value === undefined || value === null ? '' : String(value);
}

/** `2026-10-04`（文件名用）/ `2026-10-04 09:12`（文档里用） */
function stamp(ts, withTime) {
    var date = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, '0'); };

    var text = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
    if (!withTime) return text;
    return text + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

/** 目录的完整路径（父 / 子），章节标题用它 —— 嵌套目录在文档里排成一列比缩进好读 */
function folderPaths(handle, projectId) {
    var folders = foldersRepo.list(handle, projectId);
    var byId = {};
    folders.forEach(function (folder) { byId[folder.id] = folder; });

    var paths = {};
    folders.forEach(function (folder) {
        var names = [];
        var current = folder;
        var guard = 0;

        while (current && guard < 32) {
            guard += 1;
            names.unshift(current.name || '未命名目录');
            current = current.parentId ? byId[current.parentId] : null;
        }
        paths[folder.id] = names.join(' / ');
    });

    return paths;
}

/**
 * 组装要写进文档的那份数据。
 *
 * @param {object} handle
 * @param {object} ctx
 * @param {{project: object, folderId?: string|null, options?: object}} input
 * @returns {object} 中间结构（三种渲染函数都吃它）
 */
function buildDoc(handle, ctx, input) {
    var options = input.options || {};
    var project = input.project;

    // 借分享页那份数据：内容和打码规则完全一致（`share` 只用得到 projectId / folderId）
    var raw = shares.publicDoc(handle, ctx, {
        projectId: project.id,
        folderId: input.folderId || null,
        title: '',
        createdAt: Date.now(),
        expiresAt: null
    });
    if (!raw) return null;

    var mockPaths = {};
    apisRepo.list(handle, project.id).forEach(function (api) {
        // 没存 mockPath 的（老数据、直接写库造出来的）按地址推一个 —— 界面上新建 / 改地址时
        // 也是这么推的（见 lib/api/tree.js），不然文档里这一行会莫名其妙地空着
        mockPaths[api.id] = dto.str(api.mockPath) || urlUtils.deriveMockPath(api.url);
    });

    var paths = folderPaths(handle, project.id);
    var apis = raw.apis.filter(function (api) {
        // 「只导出已完成的接口」：状态不是 done 的都去掉（没设状态的也算没完成）
        if (options.doneOnly) return api.status === 'done';
        return true;
    });

    /* 按目录分章节：目录顺序按树（父在前），没分组的放最后 */
    var chapters = [];
    var byFolder = {};

    raw.folders.forEach(function (folder) {
        var chapter = {
            id: folder.id,
            name: paths[folder.id] || folder.name,
            description: dto.str(folder.description),
            apis: []
        };
        byFolder[folder.id] = chapter;
        chapters.push(chapter);
    });

    var loose = { id: null, name: '（未分组）', description: '', apis: [] };

    apis.forEach(function (api) {
        var item = Object.assign({}, api, {
            statusLabel: STATUS_LABELS[api.status] || (api.status ? api.status : '未设置'),
            mockUrl: ''
        });

        if (options.mock && input.mockBase && mockPaths[api.id]) {
            item.mockUrl = String(input.mockBase).replace(/\/+$/, '') + mockPaths[api.id];
        }
        if (!options.examples) item.examples = [];

        var chapter = api.folderId ? byFolder[api.folderId] : null;
        if (chapter) chapter.apis.push(item);
        else loose.apis.push(item);
    });

    if (loose.apis.length) chapters.push(loose);

    var used = chapters.filter(function (chapter) { return chapter.apis.length; });

    return {
        project: { name: raw.project.name, description: dto.str(project.description) },
        scope: {
            folderId: input.folderId || null,
            name: input.folderId ? (paths[input.folderId] || '') : ''
        },
        exportedAt: Date.now(),
        exportedAtText: stamp(Date.now(), true),
        includeExamples: options.examples !== false,
        includeMock: options.mock === true,
        mockBase: dto.str(input.mockBase),
        stats: {
            apis: used.reduce(function (sum, chapter) { return sum + chapter.apis.length; }, 0),
            folders: used.length
        },
        chapters: used
    };
}

/** 文件名里不能有的字符去掉，再拼上日期 */
function fileName(projectName, format, ts) {
    var cleaned = str(projectName).replace(/[/\\:*?"<>|\u0000-\u001f]/g, '').trim() || '项目';
    return cleaned + '-接口文档-' + stamp(ts || Date.now()).replace(/-/g, '') +
        (format === 'docx' ? '.docx' : (format === 'html' ? '.html' : '.md'));
}

/* ================================================================== Markdown */

function mdCell(value) {
    // 表格里 `|` 会把列切断，换行会把行切断
    return str(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function mdTable(headers, rows) {
    if (!rows.length) return '';

    var lines = [
        '| ' + headers.join(' | ') + ' |',
        '| ' + headers.map(function () { return '---'; }).join(' | ') + ' |'
    ];
    rows.forEach(function (row) {
        lines.push('| ' + row.map(mdCell).join(' | ') + ' |');
    });
    return lines.join('\n') + '\n';
}

function anchorOf(text) {
    return 'api-' + str(text).toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '');
}

function renderMarkdown(doc) {
    var out = [];

    out.push('# ' + doc.project.name + ' 接口文档');
    out.push('');
    if (doc.project.description) {
        out.push(doc.project.description);
        out.push('');
    }
    out.push('- 导出时间：' + doc.exportedAtText);
    out.push('- 接口数量：' + doc.stats.apis + ' 个（' + doc.stats.folders + ' 个目录）');
    if (doc.scope.folderId) out.push('- 范围：目录「' + doc.scope.name + '」');
    out.push('');
    out.push('> 密码、token 这类值已自动遮住；环境变量的值、脚本不会出现在文档里。');
    out.push('');

    out.push('## 目录');
    out.push('');
    doc.chapters.forEach(function (chapter) {
        out.push('- ' + chapter.name);
        chapter.apis.forEach(function (api) {
            out.push('  - [' + api.name + '](' + '#' + anchorOf(chapter.name + ' ' + api.name) + ')');
        });
    });
    out.push('');

    doc.chapters.forEach(function (chapter) {
        out.push('## ' + chapter.name);
        out.push('');
        if (chapter.description) {
            out.push(chapter.description);
            out.push('');
        }

        chapter.apis.forEach(function (api) {
            out.push('### ' + api.name);
            out.push('');
            out.push('```http');
            out.push(api.method + ' ' + api.url);
            out.push('```');
            out.push('');
            out.push('- 状态：' + api.statusLabel + (api.ownerName ? '　负责人：' + api.ownerName : ''));
            if (api.authType && api.authType !== 'none') out.push('- 鉴权：' + api.authType);
            if (api.mockUrl) out.push('- Mock 地址：' + api.mockUrl);
            out.push('');

            if (api.description) {
                out.push(api.description);
                out.push('');
            }

            if (api.params.path.length) {
                out.push('**路径参数**');
                out.push('');
                out.push(mdTable(['名字', '示例值', '必填', '说明'],
                    api.params.path.map(function (row) {
                        return [row.key, row.value, row.required ? '是' : '', row.desc];
                    })));
            }
            if (api.params.query.length) {
                out.push('**查询参数**');
                out.push('');
                out.push(mdTable(['名字', '示例值', '必填', '说明'],
                    api.params.query.map(function (row) {
                        return [row.key, row.value, row.required ? '是' : '', row.desc];
                    })));
            }
            if (api.headers.length) {
                out.push('**请求头**');
                out.push('');
                out.push(mdTable(['名字', '示例值', '必填', '说明'],
                    api.headers.map(function (row) {
                        return [row.key, row.value, row.required ? '是' : '', (row.common ? '（继承）' : '') + row.desc];
                    })));
            }

            var body = api.body || { mode: 'none' };
            if (body.mode === 'raw' && body.raw) {
                out.push('**请求体**');
                out.push('');
                out.push('```' + (body.language === 'json' ? 'json' : ''));
                out.push(body.raw);
                out.push('```');
                out.push('');
            } else if (body.form && body.form.length) {
                out.push('**请求体（' + (body.mode === 'formdata' ? 'form-data' : '表单') + '）**');
                out.push('');
                out.push(mdTable(['名字', '值', '说明'],
                    body.form.map(function (row) { return [row.key, row.value, row.desc]; })));
            } else if (body.mode === 'graphql' && body.graphql && body.graphql.query) {
                out.push('**请求体（GraphQL）**');
                out.push('');
                out.push('```graphql');
                out.push(body.graphql.query);
                out.push('```');
                out.push('');
                if (body.graphql.variables) {
                    out.push('变量：');
                    out.push('');
                    out.push('```json');
                    out.push(body.graphql.variables);
                    out.push('```');
                    out.push('');
                }
            }

            (api.examples || []).forEach(function (example) {
                out.push('**示例响应' + (example.name ? '（' + example.name + '）' : '') + ' · HTTP ' + example.status + '**');
                out.push('');
                out.push('```' + (example.responseType === 'json' ? 'json' : ''));
                out.push(example.body);
                out.push('```');
                out.push('');
            });

            if ((api.responseFields || []).length) {
                out.push('**响应字段说明**');
                out.push('');
                out.push(mdTable(['字段', '类型', '说明'],
                    api.responseFields.map(function (row) {
                        return [row.path, row.type, (row.required ? '（必有）' : '') + row.desc];
                    })));
            }

            out.push('');
        });
    });

    return out.join('\n');
}

/* ================================================================== HTML */

function escapeHtml(value) {
    return str(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function htmlTable(headers, rows) {
    if (!rows.length) return '';

    var head = '<tr>' + headers.map(function (name) {
        return '<th>' + escapeHtml(name) + '</th>';
    }).join('') + '</tr>';

    var body = rows.map(function (row) {
        return '<tr>' + row.map(function (cell) {
            return '<td>' + escapeHtml(cell) + '</td>';
        }).join('') + '</tr>';
    }).join('');

    return '<table><thead>' + head + '</thead><tbody>' + body + '</tbody></table>';
}

function renderHtml(doc) {
    var toc = doc.chapters.map(function (chapter, chapterIndex) {
        var items = chapter.apis.map(function (api, apiIndex) {
            return '<li><a href="#' + anchorOf(chapter.name + ' ' + api.name + '-' + chapterIndex + '-' + apiIndex) + '">' +
                escapeHtml(api.name) + '</a> <span class="m">' + escapeHtml(api.method) + '</span></li>';
        }).join('');
        return '<li class="chapter"><a href="#chapter-' + chapterIndex + '">' + escapeHtml(chapter.name) + '</a>' +
            '<ul>' + items + '</ul></li>';
    }).join('');

    var body = doc.chapters.map(function (chapter, chapterIndex) {
        var apis = chapter.apis.map(function (api, apiIndex) {
            var blocks = [];

            blocks.push('<h3 id="' + anchorOf(chapter.name + ' ' + api.name + '-' + chapterIndex + '-' + apiIndex) + '">' +
                escapeHtml(api.name) + '</h3>');
            blocks.push('<pre class="code">' + escapeHtml(api.method + ' ' + api.url) + '</pre>');
            blocks.push('<p class="meta">状态：' + escapeHtml(api.statusLabel) +
                (api.ownerName ? '　负责人：' + escapeHtml(api.ownerName) : '') +
                (api.authType && api.authType !== 'none' ? '　鉴权：' + escapeHtml(api.authType) : '') + '</p>');
            if (api.mockUrl) blocks.push('<p class="meta">Mock 地址：' + escapeHtml(api.mockUrl) + '</p>');
            if (api.description) blocks.push('<p class="desc">' + escapeHtml(api.description) + '</p>');

            if (api.params.path.length) {
                blocks.push('<h4>路径参数</h4>' + htmlTable(['名字', '示例值', '必填', '说明'],
                    api.params.path.map(function (row) { return [row.key, row.value, row.required ? '是' : '', row.desc]; })));
            }
            if (api.params.query.length) {
                blocks.push('<h4>查询参数</h4>' + htmlTable(['名字', '示例值', '必填', '说明'],
                    api.params.query.map(function (row) { return [row.key, row.value, row.required ? '是' : '', row.desc]; })));
            }
            if (api.headers.length) {
                blocks.push('<h4>请求头</h4>' + htmlTable(['名字', '示例值', '必填', '说明'],
                    api.headers.map(function (row) {
                        return [row.key, row.value, row.required ? '是' : '', (row.common ? '（继承）' : '') + row.desc];
                    })));
            }

            var payload = api.body || { mode: 'none' };
            if (payload.mode === 'raw' && payload.raw) {
                blocks.push('<h4>请求体</h4><pre class="code">' + escapeHtml(payload.raw) + '</pre>');
            } else if (payload.form && payload.form.length) {
                blocks.push('<h4>请求体（' + (payload.mode === 'formdata' ? 'form-data' : '表单') + '）</h4>' +
                    htmlTable(['名字', '值', '说明'],
                        payload.form.map(function (row) { return [row.key, row.value, row.desc]; })));
            } else if (payload.mode === 'graphql' && payload.graphql && payload.graphql.query) {
                blocks.push('<h4>请求体（GraphQL）</h4><pre class="code">' + escapeHtml(payload.graphql.query) + '</pre>');
                if (payload.graphql.variables) {
                    blocks.push('<h4>变量</h4><pre class="code">' + escapeHtml(payload.graphql.variables) + '</pre>');
                }
            }

            (api.examples || []).forEach(function (example) {
                blocks.push('<h4>示例响应' + (example.name ? '（' + escapeHtml(example.name) + '）' : '') +
                    ' · HTTP ' + escapeHtml(example.status) + '</h4>' +
                    '<pre class="code">' + escapeHtml(example.body) + '</pre>');
            });

            if ((api.responseFields || []).length) {
                blocks.push('<h4>响应字段说明</h4>' + htmlTable(['字段', '类型', '说明'],
                    api.responseFields.map(function (row) {
                        return [row.path, row.type, (row.required ? '（必有）' : '') + row.desc];
                    })));
            }

            return '<section class="api">' + blocks.join('\n') + '</section>';
        }).join('\n');

        return '<section class="chapter">' +
            '<h2 id="chapter-' + chapterIndex + '">' + escapeHtml(chapter.name) + '</h2>' +
            (chapter.description ? '<p class="desc">' + escapeHtml(chapter.description) + '</p>' : '') +
            apis + '</section>';
    }).join('\n');

    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
        '<title>' + escapeHtml(doc.project.name) + ' 接口文档</title>\n' +
        '<style>\n' +
        'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;' +
        'margin:0;padding:0;color:#1f2937;background:#fff;font-size:14px;line-height:1.7}\n' +
        '.wrap{display:flex;align-items:flex-start;max-width:1180px;margin:0 auto;padding:28px 24px}\n' +
        'nav{position:sticky;top:28px;flex:0 0 240px;max-height:calc(100vh - 56px);overflow:auto;' +
        'padding-right:16px;border-right:1px solid #eee;font-size:13px}\n' +
        'nav ul{list-style:none;margin:0;padding-left:12px}\n' +
        'nav>ul{padding-left:0}\n' +
        'nav li{margin:2px 0}\n' +
        'nav a{color:#374151;text-decoration:none}\n' +
        'nav a:hover{color:#2563eb;text-decoration:underline}\n' +
        '.m{color:#6b7280;font-size:12px;font-family:ui-monospace,Menlo,monospace}\n' +
        'main{flex:1;min-width:0;padding-left:28px}\n' +
        'h1{font-size:24px;margin:0 0 6px}\n' +
        'h2{font-size:19px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid #eee}\n' +
        'h3{font-size:16px;margin:24px 0 8px}\n' +
        'h4{font-size:13px;margin:14px 0 6px;color:#6b7280}\n' +
        '.meta{color:#6b7280;margin:2px 0;font-size:13px}\n' +
        '.desc{white-space:pre-wrap;margin:6px 0}\n' +
        'pre.code{background:#f7f8fa;border-radius:6px;padding:10px 12px;overflow:auto;' +
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all}\n' +
        'table{border-collapse:collapse;width:100%;margin:6px 0;font-size:13px}\n' +
        'th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #eee;vertical-align:top}\n' +
        'th{color:#6b7280;font-weight:500;background:#fafafa}\n' +
        '.note{color:#6b7280;font-size:13px;background:#fafafa;border-radius:6px;padding:8px 12px}\n' +
        '@media print{nav{display:none}main{padding-left:0}}\n' +
        '</style>\n</head>\n<body>\n<div class="wrap">\n' +
        '<nav><strong>目录</strong><ul>' + toc + '</ul></nav>\n' +
        '<main>\n' +
        '<h1>' + escapeHtml(doc.project.name) + ' 接口文档</h1>\n' +
        (doc.project.description ? '<p class="desc">' + escapeHtml(doc.project.description) + '</p>\n' : '') +
        '<p class="meta">导出时间：' + escapeHtml(doc.exportedAtText) +
        '　接口数量：' + doc.stats.apis + ' 个（' + doc.stats.folders + ' 个目录）' +
        (doc.scope.folderId ? '　范围：目录「' + escapeHtml(doc.scope.name) + '」' : '') + '</p>\n' +
        '<p class="note">密码、token 这类值已自动遮住；环境变量的值、脚本不会出现在文档里。</p>\n' +
        body + '\n</main>\n</div>\n</body>\n</html>\n';
}

/* ================================================================== Word */

/**
 * Word（`.docx`）。
 *
 * `docx` 这个包用到时才 require：云端和网关每次启动都去加载一个文档库不划算
 * （和 mysql2 / socket.io-client 那些一个道理，见计划第 0 节）。
 *
 * 目录用 Word 自己的目录域（`TableOfContents`）：打开文档时 Word 会提示更新域，
 * 更新之后就带页码了 —— 我们自己拼一份静态目录反而没有页码。
 */
async function renderDocx(doc) {
    var docx = require('docx');

    var Document = docx.Document;
    var Packer = docx.Packer;
    var Paragraph = docx.Paragraph;
    var TextRun = docx.TextRun;
    var HeadingLevel = docx.HeadingLevel;
    var Table = docx.Table;
    var TableRow = docx.TableRow;
    var TableCell = docx.TableCell;
    var WidthType = docx.WidthType;
    var TableOfContents = docx.TableOfContents;
    var AlignmentType = docx.AlignmentType;

    var MONO = 'Menlo';

    function text(value, options) {
        return new Paragraph(Object.assign({
            children: [new TextRun(Object.assign({ text: str(value) }, (options || {}).run || {}))],
            spacing: { before: 40, after: 40 }
        }, (options || {}).paragraph || {}));
    }

    /** 等宽 + 浅灰底的代码块（一行一个段落，段落底纹拼起来才像一块） */
    function codeBlock(value) {
        var lines = str(value).split(/\r?\n/);
        return lines.map(function (line, index) {
            return new Paragraph({
                children: [new TextRun({ text: line || ' ', font: MONO, size: 18 })],
                shading: { fill: 'F5F5F5' },
                spacing: { before: index === 0 ? 60 : 0, after: index === lines.length - 1 ? 120 : 0 },
                indent: { left: 120, right: 120 }
            });
        });
    }

    function table(headers, rows) {
        if (!rows.length) return [];

        function cell(value, bold) {
            return new TableCell({
                width: { size: 100 / headers.length, type: WidthType.PERCENTAGE },
                children: [new Paragraph({
                    children: [new TextRun({ text: str(value), bold: bold === true, size: 18 })]
                })]
            });
        }

        return [new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ children: headers.map(function (name) { return cell(name, true); }) })]
                .concat(rows.map(function (row) {
                    return new TableRow({ children: row.map(function (value) { return cell(value); }) });
                }))
        }), new Paragraph({ text: '', spacing: { after: 80 } })];
    }

    var children = [];

    children.push(new Paragraph({
        children: [new TextRun({ text: doc.project.name + ' 接口文档', bold: true, size: 36 })],
        spacing: { after: 120 }
    }));
    if (doc.project.description) children.push(text(doc.project.description));
    children.push(text('导出时间：' + doc.exportedAtText + '　接口数量：' + doc.stats.apis +
        ' 个（' + doc.stats.folders + ' 个目录）' +
        (doc.scope.folderId ? '　范围：目录「' + doc.scope.name + '」' : '')));
    children.push(text('密码、token 这类值已自动遮住；环境变量的值、脚本不会出现在文档里。'));

    children.push(new Paragraph({ text: '', spacing: { after: 120 } }));
    children.push(new Paragraph({ children: [new TextRun({ text: '目录', bold: true, size: 28 })] }));
    children.push(new TableOfContents('目录', { hyperlink: true, headingStyleRange: '1-3' }));
    children.push(new Paragraph({ text: '', pageBreakBefore: true }));

    doc.chapters.forEach(function (chapter) {
        children.push(new Paragraph({ text: chapter.name, heading: HeadingLevel.HEADING_1 }));
        if (chapter.description) children.push(text(chapter.description));

        chapter.apis.forEach(function (api) {
            children.push(new Paragraph({ text: api.name, heading: HeadingLevel.HEADING_2 }));
            children.push(new Paragraph({
                children: [new TextRun({ text: api.method + ' ' + api.url, font: MONO, bold: true })],
                spacing: { after: 60 }
            }));
            children.push(text('状态：' + api.statusLabel + (api.ownerName ? '　负责人：' + api.ownerName : '') +
                (api.authType && api.authType !== 'none' ? '　鉴权：' + api.authType : '')));
            if (api.mockUrl) children.push(text('Mock 地址：' + api.mockUrl));
            if (api.description) children.push(text(api.description));

            if (api.params.path.length) {
                children.push(new Paragraph({ text: '路径参数', heading: HeadingLevel.HEADING_3 }));
                table(['名字', '示例值', '必填', '说明'], api.params.path.map(function (row) {
                    return [row.key, row.value, row.required ? '是' : '', row.desc];
                })).forEach(function (node) { children.push(node); });
            }
            if (api.params.query.length) {
                children.push(new Paragraph({ text: '查询参数', heading: HeadingLevel.HEADING_3 }));
                table(['名字', '示例值', '必填', '说明'], api.params.query.map(function (row) {
                    return [row.key, row.value, row.required ? '是' : '', row.desc];
                })).forEach(function (node) { children.push(node); });
            }
            if (api.headers.length) {
                children.push(new Paragraph({ text: '请求头', heading: HeadingLevel.HEADING_3 }));
                table(['名字', '示例值', '必填', '说明'], api.headers.map(function (row) {
                    return [row.key, row.value, row.required ? '是' : '', (row.common ? '（继承）' : '') + row.desc];
                })).forEach(function (node) { children.push(node); });
            }

            var payload = api.body || { mode: 'none' };
            if (payload.mode === 'raw' && payload.raw) {
                children.push(new Paragraph({ text: '请求体', heading: HeadingLevel.HEADING_3 }));
                codeBlock(payload.raw).forEach(function (node) { children.push(node); });
            } else if (payload.form && payload.form.length) {
                children.push(new Paragraph({
                    text: '请求体（' + (payload.mode === 'formdata' ? 'form-data' : '表单') + '）',
                    heading: HeadingLevel.HEADING_3
                }));
                table(['名字', '值', '说明'], payload.form.map(function (row) {
                    return [row.key, row.value, row.desc];
                })).forEach(function (node) { children.push(node); });
            } else if (payload.mode === 'graphql' && payload.graphql && payload.graphql.query) {
                children.push(new Paragraph({ text: '请求体（GraphQL）', heading: HeadingLevel.HEADING_3 }));
                codeBlock(payload.graphql.query).forEach(function (node) { children.push(node); });
            }

            (api.examples || []).forEach(function (example) {
                children.push(new Paragraph({
                    text: '示例响应' + (example.name ? '（' + example.name + '）' : '') + ' · HTTP ' + example.status,
                    heading: HeadingLevel.HEADING_3
                }));
                codeBlock(example.body).forEach(function (node) { children.push(node); });
            });

            if ((api.responseFields || []).length) {
                children.push(new Paragraph({ text: '响应字段说明', heading: HeadingLevel.HEADING_3 }));
                table(['字段', '类型', '说明'], api.responseFields.map(function (row) {
                    return [row.path, row.type, (row.required ? '（必有）' : '') + row.desc];
                })).forEach(function (node) { children.push(node); });
            }
        });
    });

    var document = new Document({
        creator: 'apiloop',
        title: doc.project.name + ' 接口文档',
        sections: [{
            properties: {},
            children: children
        }]
    });

    return Packer.toBuffer(document);
}

module.exports = {
    buildDoc: buildDoc,
    renderMarkdown: renderMarkdown,
    renderHtml: renderHtml,
    renderDocx: renderDocx,
    fileName: fileName,
    STATUS_LABELS: STATUS_LABELS
};
