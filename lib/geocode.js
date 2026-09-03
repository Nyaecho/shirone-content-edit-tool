/**
 * 定位：→ 省份名。
 * 三个 provider（.env 的 GEOCODE_PROVIDER 选择）：
 * - nominatim：OpenStreetMap 免费 API，无需 key；国内直连常不可达，海外服务器可用
 * - amap：高德 Web 服务 API（国内推荐，需 AMAP_KEY，免费额度足够个人用）
 * - ip-api（默认）：IP 地理定位兜底，无需浏览器授权、无 key、国内可达；精度到省/市
 *
 * IP 定位说明：以服务器出口 IP 为准；单人自用场景下服务器与用户通常同地域，
 * 若经代理访问服务器则取决于代理出口。省级粒度下通常正确，不准时可手动改。
 */
import { config } from "./config.js";

const CN_PROVINCES = [
  "北京", "天津", "河北", "山西", "内蒙古", "辽宁", "吉林", "黑龙江", "上海", "江苏",
  "浙江", "安徽", "福建", "江西", "山东", "河南", "湖北", "湖南", "广东", "广西",
  "海南", "重庆", "四川", "贵州", "云南", "西藏", "陕西", "甘肃", "青海", "宁夏", "新疆",
  "香港", "澳门", "台湾",
];

/** 从地址组件里提取"省"级名称；非中国坐标返回国家名 */
function extractProvince(address, fallbackCountry = "") {
  // 高德返回 province 字段；Nominatim 返回 address.{state,province,region} + country
  const raw = address.province || address.state || address["state-district"] || address.region || "";
  if (raw) {
    const hit = CN_PROVINCES.find((p) => raw.startsWith(p) || raw.includes(p));
    return hit ? hit : raw.replace(/(省|市|自治区|特别行政区|维吾尔|回族|壮族|族)/g, "").slice(0, 6);
  }
  return address.country || fallbackCountry || "";
}

/**
 * 定位入口。
 * 有坐标（lat/lon）时走逆地理；无坐标时走 IP 定位。
 * 返回 { place, source } 或 null。
 */
export async function locate({ lat, lon, ip } = {}) {
  const provider = config.geocode.provider;

  if (lat != null && lon != null) {
    if (provider === "amap" && config.geocode.amapKey) {
      const place = await amapReverse(lat, lon);
      return place ? { place, source: "gps+amap" } : null;
    }
    const place = await nominatimReverse(lat, lon);
    return place ? { place, source: "gps+nominatim" } : null;
  }

  // IP 定位（默认兜底）
  const ipPlace = await ipApiLocate(ip);
  return ipPlace ? { place: ipPlace, source: "ip" } : null;
}

async function nominatimReverse(lat, lon) {
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=8&accept-language=zh-CN`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "shirone-admin/1.0 (blog writing tool)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return extractProvince(data.address || {}) || null;
  } catch {
    return null;
  }
}

async function amapReverse(lat, lon) {
  // 高德坐标系是 GCJ-02，浏览器 GPS 是 WGS-84；省级粒度下偏移可忽略
  const url = `https://restapi.amap.com/v3/geocode/regeo?key=${config.geocode.amapKey}&location=${Number(lon).toFixed(6)},${Number(lat).toFixed(6)}&extensions=base`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const data = await res.json();
    const comp = data?.regeocode?.addressComponent;
    if (!comp) return null;
    const province = typeof comp.province === "string" ? comp.province : "";
    if (!province || province.includes("[]")) return null;
    const hit = CN_PROVINCES.find((p) => province.includes(p));
    return hit || province.replace(/(省|市|自治区|特别行政区)$/, "");
  } catch {
    return null;
  }
}

/** ip-api.com 免费端点（http，60 req/min），返回省级行政区 */
async function ipApiLocate(ip) {
  const target = ip && isPublicIp(ip) ? ip : "";
  const url = `http://ip-api.com/json/${target}?lang=zh-CN&fields=status,regionName,country`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== "success") return null;
    const region = data.regionName || "";
    const hit = CN_PROVINCES.find((p) => region.includes(p));
    return hit || region || data.country || null;
  } catch {
    return null;
  }
}

function isPublicIp(ip) {
  if (!ip || ip === "::1" || ip === "127.0.0.1" || ip.startsWith("::ffff:127.")) return false;
  if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) return false;
  return true;
}
