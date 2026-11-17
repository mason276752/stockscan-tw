// TWSE industry codes (上市公司「產業別」, as the listed-company table of the
// TWSE OpenAPI gives them) grouped into a few divisions for the browse pages
// and the screener - data only, usable from the browser build as well as the
// server. Same shape the pages were written against: { divisions, codes }.

export const INDUSTRY = {
  divisions: [
    { id: 'A', title: 'Materials', zh: '原物料' },
    { id: 'B', title: 'Machinery & autos', zh: '機械與汽車' },
    { id: 'C', title: 'Consumer', zh: '民生消費' },
    { id: 'D', title: 'Electronics & tech', zh: '電子科技' },
    { id: 'E', title: 'Biotech & medical', zh: '生技醫療' },
    { id: 'F', title: 'Finance & insurance', zh: '金融保險' },
    { id: 'G', title: 'Construction & shipping', zh: '營建與航運' },
    { id: 'H', title: 'Energy & environment', zh: '能源與環保' },
    { id: 'I', title: 'Other', zh: '其他' },
  ],
  codes: [
    { code: '01', title: 'Cement', zh: '水泥工業', division: 'A' },
    { code: '03', title: 'Plastics', zh: '塑膠工業', division: 'A' },
    { code: '04', title: 'Textiles', zh: '紡織纖維', division: 'A' },
    { code: '08', title: 'Glass & ceramics', zh: '玻璃陶瓷', division: 'A' },
    { code: '09', title: 'Paper & pulp', zh: '造紙工業', division: 'A' },
    { code: '10', title: 'Iron & steel', zh: '鋼鐵工業', division: 'A' },
    { code: '11', title: 'Rubber', zh: '橡膠工業', division: 'A' },
    { code: '21', title: 'Chemicals', zh: '化學工業', division: 'A' },
    { code: '05', title: 'Electric machinery', zh: '電機機械', division: 'B' },
    { code: '06', title: 'Electrical & cable', zh: '電器電纜', division: 'B' },
    { code: '12', title: 'Automobiles', zh: '汽車工業', division: 'B' },
    { code: '02', title: 'Foods', zh: '食品工業', division: 'C' },
    { code: '16', title: 'Tourism & hospitality', zh: '觀光餐旅', division: 'C' },
    { code: '18', title: 'Trading & retail', zh: '貿易百貨', division: 'C' },
    { code: '32', title: 'Cultural & creative', zh: '文化創意業', division: 'C' },
    { code: '33', title: 'Agricultural technology', zh: '農業科技業', division: 'C' },
    { code: '37', title: 'Sports & leisure', zh: '運動休閒', division: 'C' },
    { code: '38', title: 'Household', zh: '居家生活', division: 'C' },
    { code: '24', title: 'Semiconductors', zh: '半導體業', division: 'D' },
    { code: '25', title: 'Computers & peripherals', zh: '電腦及週邊設備業', division: 'D' },
    { code: '26', title: 'Optoelectronics', zh: '光電業', division: 'D' },
    { code: '27', title: 'Communications & networking', zh: '通信網路業', division: 'D' },
    { code: '28', title: 'Electronic components', zh: '電子零組件業', division: 'D' },
    { code: '29', title: 'Electronics distribution', zh: '電子通路業', division: 'D' },
    { code: '30', title: 'Information services', zh: '資訊服務業', division: 'D' },
    { code: '31', title: 'Other electronics', zh: '其他電子業', division: 'D' },
    { code: '34', title: 'E-commerce', zh: '電子商務', division: 'D' },
    { code: '36', title: 'Digital & cloud', zh: '數位雲端', division: 'D' },
    { code: '22', title: 'Biotech & medical care', zh: '生技醫療業', division: 'E' },
    { code: '17', title: 'Finance & insurance', zh: '金融保險業', division: 'F' },
    { code: '14', title: 'Building materials & construction', zh: '建材營造', division: 'G' },
    { code: '15', title: 'Shipping & transportation', zh: '航運業', division: 'G' },
    { code: '23', title: 'Oil, gas & electricity', zh: '油電燃氣業', division: 'H' },
    { code: '35', title: 'Green energy & environmental', zh: '綠能環保', division: 'H' },
    { code: '19', title: 'Conglomerates', zh: '綜合', division: 'I' },
    { code: '20', title: 'Others', zh: '其他', division: 'I' },
    { code: '91', title: 'Depositary receipts', zh: '存託憑證', division: 'I' },
  ],
};

const BY_CODE = new Map(INDUSTRY.codes.map((c) => [c.code, c]));

// '24' -> { code, title, zh, division }; an unknown code keeps its number
export function industryInfo(code) {
  if (!code) return null;
  const c = String(code).padStart(2, '0');
  return BY_CODE.get(c) || { code: c, title: null, zh: null, division: 'I' };
}
