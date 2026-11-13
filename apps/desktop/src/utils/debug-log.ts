const DEBUG = import.meta.env.DEV;
export const debugLog = DEBUG ? console.log.bind(console) : ((() => {}) as typeof console.log);
export const debugWarn = DEBUG ? console.warn.bind(console) : ((() => {}) as typeof console.warn);
