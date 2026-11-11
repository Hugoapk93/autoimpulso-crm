const getTimestamp = () => {
    const mxDate = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Matamoros"}));
    const h = String(mxDate.getHours()).padStart(2, '0');
    const m = String(mxDate.getMinutes()).padStart(2, '0');
    const s = String(mxDate.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
};

const logger = {
    info: (...args) => console.log(`\x1b[90m[${getTimestamp()}]\x1b[0m`, ...args),
    warn: (...args) => console.warn(`\x1b[33m[${getTimestamp()}] [WARN]\x1b[0m`, ...args),
    error: (...args) => console.error(`\x1b[31m[${getTimestamp()}] [ERROR]\x1b[0m`, ...args)
};

module.exports = logger;