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
  /**
   * 批次数据保留天数（超出会被清理）。
   * 必须大于 briefingIntervalDays：生成简报要回头读最近 30 天的批次，
   * 保留期短于这个窗口就会把自己的输入删掉。简报本身永久保存，不受此限制。
   */
  retentionDays: Number(process.env.RETENTION_DAYS || 90),
  /** 距上一份简报满多少天生成新的一份。 */
  briefingIntervalDays: Number(process.env.BRIEFING_INTERVAL_DAYS || 30),
  /**
   * 一级汇总单块最多多少条资讯（超过会拆块，防止单次调用超上下文）。
   * 取 180 是因为一次采集约 180 条（3 天 × 60 条/天），
   * 这样「一个批次 ≈ 一个块」，批次本身就是自然的语义单元，不需要额外切分逻辑。
   */
  briefingChunkMax: Number(process.env.BRIEFING_CHUNK_MAX || 180),
  /** 每个源每次最多补抓多少条详情页。 */
  maxDetailPerSource: Number(process.env.MAX_DETAIL_PER_SOURCE || 15),
  /** 详情页抓取并发数。 */
  concurrency: Number(process.env.FETCH_CONCURRENCY || 4),
  /** 单条资讯送进大模型的最大正文字数。 */
  textLimit: 500,
};
