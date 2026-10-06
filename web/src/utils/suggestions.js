import { t } from '@/i18n';
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
  { label: '$guid', get detail() { return t('utils.dynGuid'); } },
  { label: '$timestamp', get detail() { return t('utils.dynTimestamp'); } },
  { label: '$timestampMs', get detail() { return t('utils.dynTimestampMs'); } },
  { label: '$isoTimestamp', get detail() { return t('utils.dynIso'); } },
  { label: '$randomInt(1,100)', get detail() { return t('utils.dynRandomInt'); } },
  { label: '$整数(1,100)', get detail() { return t('utils.dynRandomIntCn'); } },
  { label: '$randomPhone', get detail() { return t('utils.dynPhone'); } },
  { label: '$手机号', get detail() { return t('utils.dynPhone'); } },
  { label: '$randomIdCard', get detail() { return t('utils.dynIdCard'); } },
  { label: '$身份证', get detail() { return t('utils.dynIdCard'); } },
  { label: '$randomChineseName', get detail() { return t('utils.dynChineseName'); } },
  { label: '$中文名', get detail() { return t('utils.dynChineseName'); } },
  { label: '$randomEmail', get detail() { return t('utils.dynEmail'); } },
  { label: '$邮箱', get detail() { return t('utils.dynEmail'); } },
  { label: '$randomDate', get detail() { return t('utils.dynDate'); } },
  { label: '$日期', get detail() { return t('utils.dynDate'); } },
  { label: '$randomDateTime', get detail() { return t('utils.dynDateTime'); } },
  { label: '$时间', get detail() { return t('utils.dynDateTime'); } },
  { label: '$randomAddress', get detail() { return t('utils.dynAddress'); } },
  { label: '$地址', get detail() { return t('utils.dynAddress'); } },
  { label: '$randomCompany', get detail() { return t('utils.dynCompany'); } },
  { label: '$公司', get detail() { return t('utils.dynCompany'); } },
  { label: '$randomBankCard', get detail() { return t('utils.dynBankCard'); } },
  { label: '$银行卡', get detail() { return t('utils.dynBankCard'); } },
  { label: '$randomCreditCode', get detail() { return t('utils.dynCreditCode'); } },
  { label: '$信用代码', get detail() { return t('utils.dynCreditCode'); } },
  { label: '$randomPlate', get detail() { return t('utils.dynPlate'); } },
  { label: '$车牌', get detail() { return t('utils.dynPlate'); } },
  { label: '$randomIp', get detail() { return t('utils.dynIp'); } }
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
