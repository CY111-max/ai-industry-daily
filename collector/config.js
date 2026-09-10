'use strict';
/** 运行时配置（全部可用环境变量覆盖，密钥只从环境注入，不写进仓库）。 */
const path = require('node:path');

module.exports = {
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, ''),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    temperature: 0.3,
    timeout: 90000,
  },
  dataDir: path.join(__dirname, '..', 'data'),
  /** 历史数据保留天数（超出会被清理）。 */
  retentionDays: Number(process.env.RETENTION_DAYS || 30),
  /** 每个源每次最多补抓多少条详情页。 */
  maxDetailPerSource: Number(process.env.MAX_DETAIL_PER_SOURCE || 15),
  /** 详情页抓取并发数。 */
  concurrency: Number(process.env.FETCH_CONCURRENCY || 4),
  /** 单条资讯送进大模型的最大正文字数。 */
  textLimit: 500,
};
