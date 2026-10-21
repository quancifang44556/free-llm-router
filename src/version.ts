/**
 * 应用版本号（面板顶栏显示用）。
 *
 * ⚠️ 必须与 package.json 的 version 一致 —— tests/panel.test.ts 有断言钉住。
 * 不直接 import package.json：Workers 构建不开 resolveJsonModule，
 * 且没必要把整个 package.json 打进 Worker。
 */
export const APP_VERSION = '0.9.0'
