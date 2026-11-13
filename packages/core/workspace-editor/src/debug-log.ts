/* eslint-disable @typescript-eslint/no-empty-function */
const DEBUG = typeof process !== 'undefined' ? process.env.NODE_ENV !== 'production' : true;
export const debugLog = DEBUG ? console.log.bind(console) : ((() => {}) as typeof console.log);
export const debugWarn = DEBUG ? console.warn.bind(console) : ((() => {}) as typeof console.warn);
