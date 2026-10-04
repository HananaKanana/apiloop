/**
 * 输入时的补全候选。请求头名字这类固定清单、以及内置动态变量的清单都放这里，
 * 别在每个表格里各写一份。
 *
 * **动态变量这份清单要和后端 `lib/variables.js` 的 `DYNAMIC` 保持一致**
 * （前端拿不到后端的代码，只能各存一份）：名字对不上，前端就会把 `{{$手机号}}`
 * 当成「未定义」标红，而发送时其实能替换出来。
 */

/** 常用的请求头名字（「键」那一列输入时提示） */
export const HEADER_NAMES = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Connection',
  'Content-Length',
  'Content-Type',
  'Cookie',
  'Host',
  'Origin',
  'Pragma',
  'Referer',
  'User-Agent',
  'X-Requested-With'
].map(function (name) { return { label: name }; });

/**
 * 内置动态变量（第十轮第 2 节）。`label` 就是插进编辑器里的写法，`detail` 是中文说明。
 *
 * 中英文两种写法都列出来，因为后端两种都认。带参数的（`$randomInt`）把参数写在
 * 插入文本里 —— 插进去之后用户自己改数字就行。
 */
export const DYNAMIC_VARIABLES = [
  { label: '$guid', detail: '随机 UUID' },
  { label: '$timestamp', detail: '当前时间戳（秒）' },
  { label: '$timestampMs', detail: '当前毫秒时间戳' },
  { label: '$isoTimestamp', detail: '当前时间（ISO 格式）' },
  { label: '$randomInt(1,100)', detail: '区间内的随机整数，不带参数时 0~1000' },
  { label: '$整数(1,100)', detail: '区间内的随机整数（中文写法）' },
  { label: '$randomPhone', detail: '11 位手机号（真实号段）' },
  { label: '$手机号', detail: '11 位手机号（真实号段）' },
  { label: '$randomIdCard', detail: '18 位身份证号（校验位正确）' },
  { label: '$身份证', detail: '18 位身份证号（校验位正确）' },
  { label: '$randomChineseName', detail: '中文姓名' },
  { label: '$中文名', detail: '中文姓名' },
  { label: '$randomEmail', detail: '邮箱' },
  { label: '$邮箱', detail: '邮箱' },
  { label: '$randomDate', detail: '近一年内的日期 YYYY-MM-DD' },
  { label: '$日期', detail: '近一年内的日期 YYYY-MM-DD' },
  { label: '$randomDateTime', detail: '近一年内的日期时间 YYYY-MM-DD HH:mm:ss' },
  { label: '$时间', detail: '近一年内的日期时间 YYYY-MM-DD HH:mm:ss' },
  { label: '$randomAddress', detail: '省市区 + 详细地址' },
  { label: '$地址', detail: '省市区 + 详细地址' },
  { label: '$randomCompany', detail: '公司名' },
  { label: '$公司', detail: '公司名' },
  { label: '$randomBankCard', detail: '16 / 19 位银行卡号（Luhn 校验正确）' },
  { label: '$银行卡', detail: '16 / 19 位银行卡号（Luhn 校验正确）' },
  { label: '$randomCreditCode', detail: '18 位统一社会信用代码（校验位正确）' },
  { label: '$信用代码', detail: '18 位统一社会信用代码（校验位正确）' },
  { label: '$randomPlate', detail: '车牌号' },
  { label: '$车牌', detail: '车牌号' },
  { label: '$randomIp', detail: 'IPv4 地址' }
];

/**
 * 动态变量的**名字**（小写），用来判断 `{{$xxx}}` 是不是内置动态变量。
 * `$randomInt(1,100)` 这种带参数的，只取括号前的名字。
 */
export const DYNAMIC_NAMES = new Set(
  DYNAMIC_VARIABLES.map(function (item) {
    return String(item.label).replace(/\(.*$/, '').toLowerCase();
  })
);
