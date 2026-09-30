import { get } from './client';

/** /meta 里的东西：品牌名、版本、库路径、占位符与模板、当前用户等 */
export function getMeta() {
  return get('/meta');
}
